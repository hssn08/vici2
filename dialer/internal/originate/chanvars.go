package originate

import (
	"fmt"

	"github.com/vici2/dialer/internal/conference"
)

// buildChannelVars assembles the 16-key channel-var map that T04 hands to T01.
// T01 sorts and serialises deterministically (snapshot tests enforce the wire form).
//
// Groups (per T04 PLAN §9):
//
//	A — Caller-ID (from PickCallerID waterfall)
//	B — Originate behaviour
//	C — Correlation IDs (round-trip on every CHANNEL_* event)
//	D — Recording / consent (for R01)
//	E — SIP X-headers (carrier-specific)
func buildChannelVars(req *OriginateRequest, scratch *GateScratch) map[string]string {
	vars := make(map[string]string, 24)

	// ── Group A: Caller-ID ─────────────────────────────────────────────────────
	if scratch.CallerID != "" {
		vars["origination_caller_id_number"] = scratch.CallerID
		vars["effective_caller_id_number"] = scratch.CallerID
		vars["sip_from_user"] = scratch.CallerID
	}
	if scratch.CallerIDName != "" {
		vars["origination_caller_id_name"] = scratch.CallerIDName
	}

	// ── Group B: Originate behaviour ──────────────────────────────────────────
	vars["ignore_early_media"] = "true"
	timeout := req.DialTimeout
	if timeout <= 0 {
		timeout = 22
	}
	vars["originate_timeout"] = fmt.Sprintf("%d", timeout)
	vars["call_timeout"] = fmt.Sprintf("%d", timeout)

	dt := dialTargetFor(req.Mode)
	if dt == DialTargetConference {
		vars["hangup_after_bridge"] = "true"
	} else {
		vars["hangup_after_bridge"] = "false"
	}

	// ── Group C: Correlation IDs ──────────────────────────────────────────────
	// one-UUID rule: origination_uuid == attempt_uuid
	vars["origination_uuid"] = req.AttemptUUID
	vars["vici2_attempt_uuid"] = req.AttemptUUID
	vars["vici2_tenant_id"] = fmt.Sprintf("%d", req.TenantID)
	vars["vici2_lead_id"] = fmt.Sprintf("%d", req.LeadID)
	vars["vici2_campaign_id"] = req.CampaignID
	if req.AgentID != 0 {
		vars["vici2_agent_id"] = fmt.Sprintf("%d", req.AgentID)
	}
	if scratch.ResolvedCarrierID != 0 {
		vars["vici2_carrier_id"] = fmt.Sprintf("%d", scratch.ResolvedCarrierID)
	}
	if scratch.ResolvedGatewayID != 0 {
		vars["vici2_gateway_id"] = fmt.Sprintf("%d", scratch.ResolvedGatewayID)
	}

	// ── Group D: Recording / consent (for R01) ────────────────────────────────
	consentRequired := "false"
	if scratch.ConsentDecision == "PROMPT" {
		consentRequired = "true"
	}
	vars["vici2_consent_required"] = consentRequired
	if req.LeadState != "" {
		vars["vici2_consent_state"] = req.LeadState
	}
	vars["vici2_recording_mode"] = mapRecordingModeVar(req.RecordingMode, scratch.ConsentDecision)
	vars["RECORD_STEREO"] = "true"

	// ── Group E: SIP X-headers ────────────────────────────────────────────────
	vars["sip_h_X-Vici2-Lead"] = fmt.Sprintf("%d", req.LeadID)
	vars["sip_h_X-Vici2-Campaign"] = req.CampaignID
	vars["sip_h_X-Vici2-Attempt"] = req.AttemptUUID

	// ── Group F: X04 pool tracking ────────────────────────────────────────────
	// vici2_pool_npid carries the number_pool_dids.id when a pool DID was used.
	// The FreeSWITCH event router reads this on CHANNEL_HANGUP_COMPLETE to
	// update per-number health stats asynchronously.
	if scratch.PoolNPID != 0 {
		vars["vici2_pool_npid"] = fmt.Sprintf("%d", scratch.PoolNPID)
	}

	return vars
}

// mapRecordingModeVar converts campaign recording_mode + consent decision to the
// vici2_recording_mode channel-var value consumed by R01.
func mapRecordingModeVar(mode CampaignRecordingMode, consentDecision string) string {
	if consentDecision == "SKIP_RECORDING" {
		return "OFF"
	}
	switch mode {
	case RecordNever:
		return "OFF"
	case RecordAll, RecordAllForce:
		return "ON"
	case RecordOnDemand:
		return "ON"
	default:
		return "ON"
	}
}

// conferenceNameForReq returns the T03-compliant conference FQN for CONFERENCE
// dial targets. T04 never assembles "agent_..." strings directly — this is the
// ONLY call site (RFC-002 lint enforces).
func conferenceNameForReq(req *OriginateRequest) string {
	return conference.ConferenceFQN(req.TenantID, req.AgentID, "default")
}
