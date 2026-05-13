package picker

import (
	"context"
	"time"

	"github.com/vici2/dialer/internal/originate"
)

// Originator is the interface E04 uses to call T04.
// The concrete implementation is *originate.Service.
// Defined here (consumer-owned) for testability without importing originate
// in the same layer that owns dispatch logic.
type Originator interface {
	Originate(ctx context.Context, req originate.OriginateRequest) (*originate.OriginateResult, error)
}

// DialOutcome is the enumeration of all terminal outcomes from one dispatch
// attempt. It maps T04 typed errors + T01 hangup_cause to D04 status +
// requeue hint. See PLAN §6.1 and retry_policy.go for the 18-row table.
type DialOutcome int

const (
	OutcomeBridged         DialOutcome = iota // T01: CHANNEL_BRIDGE (call answered + bridged)
	OutcomeNoAnswer                           // NO_ANSWER / NO_USER_RESPONSE
	OutcomeBusy                               // USER_BUSY / CALL_REJECTED
	OutcomeAMD                                // Post-bridge AMD detector result
	OutcomeInvalidNumber                      // UNALLOCATED_NUMBER / INVALID_NUMBER_FORMAT
	OutcomeCarrierFail                        // NETWORK_OUT_OF_ORDER / NORMAL_TEMPORARY_FAILURE
	OutcomeGatewayLimit                       // T04.ErrGatewayLimit (gate 1)
	OutcomeTCPABlocked                        // T04.ErrTCPABlocked (gate 3)
	OutcomeDNCBlocked                         // T04.ErrDNCHit (gate 4)
	OutcomeConsentBlocked                     // T04.ErrConsentBlocked (gate 5)
	OutcomeCircuitOpen                        // T04.ErrCarrierFail subtype: circuit open
	OutcomeRateLimited                        // T04.ErrRateLimited (drop-cap gate 2)
	OutcomeMediaTimeout                       // MEDIA_TIMEOUT hangup
	OutcomeTimeout                            // originate_timeout fired
	OutcomeDropAbandon                        // PREDICTIVE: answered but no agent available
	OutcomeAgentDisconnect                    // PREDICTIVE: agent leg dropped pre-bridge
	OutcomeCampaignPaused                     // pre-T04 check: campaign paused/inactive
	OutcomeLeadIneligible                     // pre-T04 check: lead became DNC/dropped
)

// String returns the metric label string for the outcome.
func (o DialOutcome) String() string {
	switch o {
	case OutcomeBridged:
		return "bridged"
	case OutcomeNoAnswer:
		return "no_answer"
	case OutcomeBusy:
		return "busy"
	case OutcomeAMD:
		return "amd"
	case OutcomeInvalidNumber:
		return "invalid_number"
	case OutcomeCarrierFail:
		return "carrier_fail"
	case OutcomeGatewayLimit:
		return "gateway_limit"
	case OutcomeTCPABlocked:
		return "tcpa_blocked"
	case OutcomeDNCBlocked:
		return "dnc_blocked"
	case OutcomeConsentBlocked:
		return "consent_blocked"
	case OutcomeCircuitOpen:
		return "circuit_open"
	case OutcomeRateLimited:
		return "rate_limited"
	case OutcomeMediaTimeout:
		return "media_timeout"
	case OutcomeTimeout:
		return "timeout"
	case OutcomeDropAbandon:
		return "drop_abandon"
	case OutcomeAgentDisconnect:
		return "agent_disconnect"
	case OutcomeCampaignPaused:
		return "campaign_paused"
	case OutcomeLeadIneligible:
		return "lead_ineligible"
	default:
		return "unknown"
	}
}

// LeadClaim contains the information about a successfully claimed lead.
// It is returned by claim.go / valkey.Hopper().Claim and threaded through
// the dispatch loop to E01.Consumer.Release.
type LeadClaim struct {
	LeadID     int64
	CampaignID int64
	LockVal    string
	ListID     int64
	PhoneE164  string
	IsCallback bool
	ClaimTs    time.Time
}

// ManualDispatchRequest is the input to Supervisor.DispatchManual.
// Called by A04 for manual / agent-only callback dials.
// Bypasses the token-bucket since MANUAL is agent-initiated.
type ManualDispatchRequest struct {
	TenantID   int64
	CampaignID int64
	AgentID    int64
	LeadID     int64
	CallbackID int64 // optional; 0 means not a callback
}

// ManualDispatchResult is returned by Supervisor.DispatchManual.
type ManualDispatchResult struct {
	AttemptUUID string
	CallUUID    string
}

// AnsweredEvent represents an entry from the events:vici2.call.answered stream.
// Written by T01 on CHANNEL_ANSWER for PREDICTIVE calls parked to PARK.
type AnsweredEvent struct {
	CallUUID   string
	CampaignID int64
	TenantID   int64
	LeadID     int64
	Mode       originate.OriginateMode
	TsMs       int64
	FSHost     string
}

// AMDEvent represents an entry from the events:vici2.call.amd_detected stream.
type AMDEvent struct {
	CallUUID   string
	CampaignID int64
	TenantID   int64
	LeadID     int64
	ListID     int64
	Result     string // "HUMAN" | "MACHINE" | "UNSURE"
	TsMs       int64
	FSHost     string
}

// DroppedEvent is written to events:vici2.call.dropped when PREDICTIVE finds
// no agent. E05 subscribes to this stream to play safe-harbor.
type DroppedEvent struct {
	CallUUID   string
	CampaignID int64
	TenantID   int64
	Reason     string // "no_agent" | "agent_transfer_failed" | "agent_logged_out"
	TsMs       int64
}

// buildOriginateRequest constructs the T04 OriginateRequest from a dispatch
// context. One-UUID rule: AttemptUUID is caller-generated UUIDv4 (PLAN §4).
func buildOriginateRequest(
	attemptUUID string,
	cfg CampaignConfig,
	claim LeadClaim,
	agentID int64,
	mode originate.OriginateMode,
) originate.OriginateRequest {
	return originate.OriginateRequest{
		AttemptUUID: attemptUUID,
		TenantID:    cfg.TenantID,
		LeadID:      claim.LeadID,
		CampaignID:  cfg.CampaignIDStr,
		ListID:      claim.ListID,
		AgentID:     agentID,
		DestNumber:  claim.PhoneE164,
		Mode:        mode,
		DialTimeout: cfg.DialTimeoutSec,
	}
}

// outcomeFromOriginateError maps a T04 OriginateError to a picker DialOutcome.
func outcomeFromOriginateError(oerr originate.OriginateError) DialOutcome {
	switch oerr.Gate() {
	case "gateway_cap":
		return OutcomeGatewayLimit
	case "drop_cap":
		return OutcomeRateLimited
	case "tcpa":
		return OutcomeTCPABlocked
	case "dnc":
		return OutcomeDNCBlocked
	case "consent":
		return OutcomeConsentBlocked
	case "carrier":
		switch oerr.Outcome() {
		case originate.OutcomeTimeout:
			return OutcomeTimeout
		default:
			if oerr.SubReason() == "circuit_open" {
				return OutcomeCircuitOpen
			}
			return OutcomeCarrierFail
		}
	default:
		return OutcomeCarrierFail
	}
}
