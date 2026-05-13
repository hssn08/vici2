package gates

import (
	"context"
	"time"

	"github.com/vici2/dialer/internal/compliance/tcpa"
	"github.com/vici2/dialer/internal/originate"
)

// TCPAGate calls C01.Check to enforce TCPA time-window compliance.
//
// T04 PLAN §3.3: all 8 C01 block reasons map to TCPA_BLOCKED outcome.
// On ALLOW the gate stamps tcpa_decision, tcpa_reason, tcpa_tz_resolved
// so downstream audit rows carry the resolved timezone.
type TCPAGate struct {
	Checker *tcpa.Checker
	NowFn   func() time.Time
}

func (g *TCPAGate) Name() string { return "tcpa" }

func (g *TCPAGate) Check(
	ctx context.Context,
	req *originate.OriginateRequest,
	scratch *originate.GateScratch,
) originate.GateResult {
	if g.NowFn == nil {
		g.NowFn = time.Now
	}
	tcpaReq := tcpa.CheckRequest{
		LeadID:           req.LeadID,
		PhoneE164:        req.DestNumber,
		State:            req.LeadState,
		CampaignID:       0,
		EnforcementPoint: tcpa.PointOriginate,
		When:             g.NowFn(),
		IsAutoDialer:     req.IsAutoDialer,
	}

	result, err := g.Checker.Check(ctx, tcpaReq)
	if err != nil {
		// Treat resolver error as BLOCK_INVALID (no timezone).
		patch := originate.AuditRowPatch{
			TCPADecision: "BLOCK",
			TCPAReason:   "resolver_error",
			ErrorMessage: err.Error(),
		}
		return originate.GateResult{
			Outcome:    originate.GateBlock,
			Block:      originate.NewTCPAErr(req.AttemptUUID, "resolver_error", 24*time.Hour),
			AuditPatch: patch,
		}
	}

	patch := originate.AuditRowPatch{
		TCPATzIANA: result.TzIANA,
	}
	scratch.TcpaTzIANA = result.TzIANA

	switch result.Outcome {
	case tcpa.OutcomeAllow:
		patch.TCPADecision = "ALLOW"
		patch.TCPAReason = result.Reason
		return originate.GateResult{Outcome: originate.GateAllow, AuditPatch: patch}

	default: // OutcomeSkipUntil or OutcomeBlockInvalid
		patch.TCPADecision = "BLOCK"
		patch.TCPAReason = result.Reason
		patch.ErrorMessage = result.Reason

		retryAfter := 24 * time.Hour
		if result.NextOpen != nil {
			if d := time.Until(*result.NextOpen); d > 0 {
				retryAfter = d
			}
		}

		return originate.GateResult{
			Outcome:    originate.GateBlock,
			Block:      originate.NewTCPAErr(req.AttemptUUID, result.Reason, retryAfter),
			AuditPatch: patch,
		}
	}
}
