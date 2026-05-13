package gates

import (
	"context"
	"strings"

	"github.com/vici2/dialer/internal/dnc"
	"github.com/vici2/dialer/internal/originate"
)

// DNCGate performs the D05 DNC final scrub (Bloom + MySQL confirm).
//
// T04 PLAN §3.4: sources = federal + state + internal (litigator Phase 2).
// If req.BypassToken != "", the gate calls dnc.RedeemBypass before the
// Bloom check; on success, the gate ALLOWS and stamps bypass_token on the
// audit row.
type DNCGate struct {
	Checker *dnc.Checker
	// RedeemBypass is dnc.RedeemBypass (injectable for tests).
	RedeemBypass func(ctx context.Context,
		rdb interface{},
		tenantID int64,
		tokenHash, phone string,
		source dnc.Source,
		userID int64,
		justification string) (dnc.RedeemResult, error)
}

func (g *DNCGate) Name() string { return "dnc" }

func (g *DNCGate) Check(
	ctx context.Context,
	req *originate.OriginateRequest,
	scratch *originate.GateScratch,
) originate.GateResult {
	// Sources: federal + state + internal (litigator reserved for Phase 2).
	sources := []dnc.Source{dnc.SourceFederal, dnc.SourceState, dnc.SourceInternal}

	dncReq := dnc.CheckRequest{
		PhoneE164:  req.DestNumber,
		TenantID:   req.TenantID,
		CampaignID: req.CampaignID,
		LeadState:  req.LeadState,
		Sources:    sources,
	}

	result := g.Checker.Check(ctx, dncReq)

	if !result.IsDNC {
		return originate.GateResult{
			Outcome: originate.GateAllow,
			AuditPatch: originate.AuditRowPatch{
				DNCDecision: "ALLOW",
			},
		}
	}

	// Build source list string for sub-reason.
	sourceNames := make([]string, len(result.Sources))
	for i, s := range result.Sources {
		sourceNames[i] = string(s)
	}
	subReason := strings.Join(sourceNames, ",")

	patch := originate.AuditRowPatch{
		DNCDecision:  "BLOCK",
		DNCSources:   sourceNames,
		ErrorMessage: subReason,
	}

	return originate.GateResult{
		Outcome:    originate.GateBlock,
		Block:      originate.NewDNCErr(req.AttemptUUID, subReason),
		AuditPatch: patch,
	}
}
