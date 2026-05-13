package gates

import (
	"context"
	"fmt"

	"github.com/vici2/dialer/internal/compliance/consent"
	"github.com/vici2/dialer/internal/originate"
)

// ConsentGate evaluates the per-state recording-consent policy via C02.
//
// T04 PLAN §3.5: the gate uses consent.Checker (C02 package) which implements
// the 12-state two-party consent matrix with stricter-state-wins semantics.
// ConsentDecision maps as:
//   - ModeAllow → "ALLOW" (channel var: vici2_consent_required=false)
//   - ModePromptBeep / ModePromptMessage / ModeRequireActive → "PROMPT" (vici2_consent_required=true)
//   - ModeSkip → "SKIP_RECORDING" (vici2_consent_required=false, recording off)
//
// ConsentBlock (future: a US state that bans outbound recording entirely)
// is the only BLOCK path; no current US state triggers it.
type ConsentGate struct {
	Checker *consent.Checker
}

func (g *ConsentGate) Name() string { return "consent" }

func (g *ConsentGate) Check(
	ctx context.Context,
	req *originate.OriginateRequest,
	scratch *originate.GateScratch,
) originate.GateResult {
	consentReq := consent.CheckRequest{
		TenantID:   req.TenantID,
		LeadID:     req.LeadID,
		LeadState:  req.LeadState,
		CallerState: req.CallerState,
		CampaignRecordingPolicy: mapRecordingMode(req.RecordingMode),
	}

	result, err := g.Checker.CheckConsent(ctx, consentReq)
	if err != nil {
		// Treat checker error as conservative PROMPT (do not block the call).
		result = consent.CheckResult{
			Decision:        consent.ModePromptMessage,
			StateApplied:    req.LeadState,
			ConsentRequired: true,
			ConsentRecord:   true,
		}
	}

	decision := consentModeToAuditDecision(result.Decision)
	scratch.ConsentDecision = decision

	patch := originate.AuditRowPatch{
		ConsentDecision: decision,
		ConsentState:    req.LeadState,
	}

	// I05: TCPA VM drop consent gate extension.
	// When amd_action=vmdrop and vmdrop_requires_consent=true, the call is
	// treated as requiring OPTIN consent (FCC 2023 ringless voicemail ruling).
	// If the lead does not have OPTIN (captured via C02 consent_log), block
	// origination with ErrConsentBlocked so no VM drop occurs.
	//
	// We map the C02 consent decision: only "ALLOW" (no-consent-required state)
	// passes. "PROMPT" / "SKIP_RECORDING" are not sufficient for pre-recorded
	// cell phone TCPA compliance.
	if req.AMDAction == "vmdrop" && req.VMDropRequiresConsent {
		// Check if the consent decision indicates OPTIN is absent.
		// A decision of "ALLOW" means the state requires no special consent
		// (e.g., one-party consent, landline). "PROMPT" means consent is
		// required and has not been obtained yet.
		if decision != "ALLOW" {
			patch.ErrorMessage = fmt.Sprintf("vmdrop consent required; lead state=%s decision=%s", req.LeadState, decision)
			patch.ConsentDecision = "BLOCK"
			scratch.ConsentDecision = "BLOCK"
			return originate.GateResult{
				Outcome:    originate.GateBlock,
				Block:      consentBlockErr(req.AttemptUUID, fmt.Sprintf("vmdrop_consent:%s", req.LeadState)),
				AuditPatch: patch,
			}
		}
	}

	// ConsentBlock is reserved for future states — currently unreachable.
	// If we ever return ModeSkip and the campaign policy is ALLFORCE, keep
	// the law: we cannot force recording in a state that bans it.
	// No current US state issues a BLOCK.

	return originate.GateResult{Outcome: originate.GateAllow, AuditPatch: patch}
}

// consentModeToAuditDecision maps C02 Mode to the T04 audit column vocabulary.
func consentModeToAuditDecision(m consent.Mode) string {
	switch m {
	case consent.ModeAllow:
		return "ALLOW"
	case consent.ModeSkip:
		return "SKIP_RECORDING"
	default:
		// ModePromptBeep, ModePromptMessage, ModeRequireActive → PROMPT
		return "PROMPT"
	}
}

// mapRecordingMode converts T04's CampaignRecordingMode to consent.CampaignRecordingPolicy.
func mapRecordingMode(m originate.CampaignRecordingMode) consent.CampaignRecordingPolicy {
	switch m {
	case originate.RecordNever:
		return consent.PolicyNever
	case originate.RecordAll, originate.RecordAllForce:
		return consent.PolicyAlways
	case originate.RecordOnDemand:
		return consent.PolicyOnDemand
	default:
		return consent.PolicyAuto
	}
}

// consentBlockErr is returned if a future state issues a true ConsentBlock.
func consentBlockErr(attemptUUID, state string) originate.OriginateError {
	return originate.NewConsentBlockErr(attemptUUID, fmt.Sprintf("consent_block:%s", state))
}
