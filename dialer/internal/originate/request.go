// Package originate implements T04 — the 5-gate compliance pipeline that
// guards every outbound dial attempt. Gate order is FROZEN:
//
//	gateway_cap → drop_cap → tcpa → dnc → consent
//
// Callers: E02 (pacing), E04 (picker), A04 (manual dial), A07 (transfer), N01 (Phase 4).
// T04 imports T01 (esl); T01 must never import T04.
package originate

import "time"

// OriginateMode enumerates the four dial modes.
type OriginateMode string

const (
	ModeProgressive OriginateMode = "PROGRESSIVE"
	ModePredictive  OriginateMode = "PREDICTIVE"
	ModeManual      OriginateMode = "MANUAL"
	ModePreview     OriginateMode = "PREVIEW"
)

// DialTarget is derived from Mode via the §4 mapping.
type DialTarget string

const (
	DialTargetConference DialTarget = "CONFERENCE"
	DialTargetPark       DialTarget = "PARK"
)

// dialTargetFor returns the DialTarget for the given mode (FROZEN per PLAN §4).
func dialTargetFor(mode OriginateMode) DialTarget {
	if mode == ModePredictive {
		return DialTargetPark
	}
	return DialTargetConference
}

// OriginateOutcome is the terminal outcome written to originate_audit.outcome.
type OriginateOutcome string

const (
	OutcomeSuccess        OriginateOutcome = "SUCCESS"
	OutcomeTCPABlocked    OriginateOutcome = "TCPA_BLOCKED"
	OutcomeDNCBlocked     OriginateOutcome = "DNC_BLOCKED"
	OutcomeConsentBlocked OriginateOutcome = "CONSENT_BLOCKED"
	OutcomeGatewayLimit   OriginateOutcome = "GATEWAY_LIMIT"
	OutcomeRateLimited    OriginateOutcome = "RATE_LIMITED"
	OutcomeGatewayFail    OriginateOutcome = "GATEWAY_FAIL"
	OutcomeTimeout        OriginateOutcome = "TIMEOUT"
	OutcomeJobOrphaned    OriginateOutcome = "JOB_ORPHANED"
	OutcomeOther          OriginateOutcome = "OTHER"
)

// OriginateCidSource documents which waterfall tier supplied the caller-ID.
type OriginateCidSource string

const (
	CidSourcePerCall       OriginateCidSource = "per_call"
	CidSourcePerList       OriginateCidSource = "per_list"
	CidSourceLocalPresence OriginateCidSource = "local_presence"
	CidSourceCampaignDflt  OriginateCidSource = "campaign_default"
)

// CampaignRecordingMode mirrors campaigns.recording_mode.
type CampaignRecordingMode string

const (
	RecordNever    CampaignRecordingMode = "NEVER"
	RecordOnDemand CampaignRecordingMode = "ONDEMAND"
	RecordAll      CampaignRecordingMode = "ALL"
	RecordAllForce CampaignRecordingMode = "ALLFORCE"
)

// OriginateRequest is the typed input to Service.Originate.
// AttemptUUID is REQUIRED: caller-supplied UUIDv4; T04 never generates it.
type OriginateRequest struct {
	// Idempotency + correlation (REQUIRED)
	AttemptUUID string // UUIDv4 lowercase; caller-supplied; rejected if empty
	TenantID    int64
	LeadID      int64
	CampaignID  string // VARCHAR(32)
	ListID      int64
	AgentID     int64 // 0 for PREDICTIVE pre-answer

	// Destination
	DestNumber string // E.164

	// Mode + caller-ID overrides
	Mode             OriginateMode
	CallerIDOverride string // per-call tier-1 override; "" = use waterfall
	CallerIDName     string

	// Carrier hint (optional; T02 picks if 0)
	GatewayID   int64
	GatewayName string
	CarrierID   int64

	// FS affinity (Phase 1: leave empty; X03 wires later)
	FSHost string

	// Compliance bypass (DNC only)
	BypassToken string // empty = no bypass

	// Caller context (audit / forensic)
	RequestID   string // trace correlation id
	IPAddress   string // gRPC peer / forwarded-for
	ActorUserID int64  // who is making this request

	// Campaign configuration (required for gate evaluation)
	DialTimeout    int                   // ring seconds; default 22
	RecordingMode  CampaignRecordingMode // for consent + channel-var assembly
	CallerIDCampaign string              // campaign default CID (E.164)
	ListCallerID   *string               // per-list override (F02 AMENDMENT T04.3)
	LeadState      string                // 2-letter US state code
	CallerState    string                // 2-letter state of caller/agent
	IsAutoDialer   bool                  // campaigns.dial_method != MANUAL
	MaxConcurrent  int                   // gateways.max_concurrent; 0 = unlimited
	DropCapPct     float64               // campaigns.adaptive_drop_pct; 0 = skip Phase-1 stub

	// I05: VM drop fields — propagated from CampaignConfig by E04 picker.
	// When AMDAction="vmdrop" and VMDropRequiresConsent=true, the consent gate
	// treats the call as consent-required even if recording policy is NEVER.
	AMDAction             string // "drop" | "vmdrop" | "message" | "park" | "transfer"
	VMDropRequiresConsent bool   // campaigns.vmdrop_requires_consent (default true)

	// X04: number pool — 0 = no pool; non-zero triggers Tier 3 CID waterfall.
	NumberPoolID int64
	// X05: local-presence area code hint — "" = no filter.
	LocalPresenceAreaCode string
}

// OriginateResult is returned on full pipeline pass or idempotent replay.
type OriginateResult struct {
	AttemptUUID string           // echo of req.AttemptUUID
	CallUUID    string           // == AttemptUUID by policy (one-UUID rule)
	AuditRowID  int64            // for cross-table joins
	Outcome     OriginateOutcome
	GateApplied string           // "" if all ALLOW; name of the blocking gate otherwise
}

// OriginateError is the typed error interface for all T04 gate + transport failures.
// Callers inspect Gate() to release the hopper claim with the correct D04 status.
type OriginateError interface {
	error
	Gate() string             // "gateway_cap" / "drop_cap" / "tcpa" / "dnc" / "consent" / "carrier"
	SubReason() string
	RetryAfter() time.Duration
	AttemptUUID() string
	D04Status() string        // D04 lead_statuses.status value
	Outcome() OriginateOutcome
}

// baseErr is the concrete implementation shared by all gate errors.
type baseErr struct {
	gate        string
	subReason   string
	retryAfter  time.Duration
	attemptUUID string
	d04Status   string
	outcome     OriginateOutcome
	msg         string
}

func (e *baseErr) Error() string             { return e.msg }
func (e *baseErr) Gate() string              { return e.gate }
func (e *baseErr) SubReason() string         { return e.subReason }
func (e *baseErr) RetryAfter() time.Duration { return e.retryAfter }
func (e *baseErr) AttemptUUID() string       { return e.attemptUUID }
func (e *baseErr) D04Status() string         { return e.d04Status }
func (e *baseErr) Outcome() OriginateOutcome { return e.outcome }

// Sentinel errors (non-gate).

// ErrMissingAttemptUUID is returned when req.AttemptUUID == "".
var ErrMissingAttemptUUID = &baseErr{
	gate:    "",
	msg:     "originate: AttemptUUID is required (caller must generate UUIDv4)",
	outcome: OutcomeOther,
}

// ErrInProgress is returned when a row with outcome=OTHER already exists for the
// same attempt_uuid (another worker is racing the same intent).
var ErrInProgress = &baseErr{
	gate:       "",
	retryAfter: 1 * time.Second,
	msg:        "originate: attempt already in progress (outcome=OTHER)",
	outcome:    OutcomeOther,
}

// NewGatewayLimitErr creates an ErrGatewayLimit for the given gateway.
func NewGatewayLimitErr(attemptUUID, gwDesc string) OriginateError {
	return &baseErr{
		gate:        "gateway_cap",
		subReason:   gwDesc,
		retryAfter:  0,
		attemptUUID: attemptUUID,
		d04Status:   "GATEWAY_LIMIT_TRY_LATER",
		outcome:     OutcomeGatewayLimit,
		msg:         "originate: gateway concurrent-call cap reached: " + gwDesc,
	}
}

// NewDropCapErr creates an ErrDropCap.
func NewDropCapErr(attemptUUID, subReason string, retryAfter time.Duration) OriginateError {
	return &baseErr{
		gate:        "drop_cap",
		subReason:   subReason,
		retryAfter:  retryAfter,
		attemptUUID: attemptUUID,
		d04Status:   "",
		outcome:     OutcomeRateLimited,
		msg:         "originate: drop-cap exceeded: " + subReason,
	}
}

// NewTCPAErr creates an ErrTCPABlocked.
func NewTCPAErr(attemptUUID, subReason string, retryAfter time.Duration) OriginateError {
	return &baseErr{
		gate:        "tcpa",
		subReason:   subReason,
		retryAfter:  retryAfter,
		attemptUUID: attemptUUID,
		d04Status:   "TCPA",
		outcome:     OutcomeTCPABlocked,
		msg:         "originate: TCPA block: " + subReason,
	}
}

// NewDNCErr creates an ErrDNCHit.
func NewDNCErr(attemptUUID, subReason string) OriginateError {
	return &baseErr{
		gate:        "dnc",
		subReason:   subReason,
		retryAfter:  0,
		attemptUUID: attemptUUID,
		d04Status:   "DNC",
		outcome:     OutcomeDNCBlocked,
		msg:         "originate: DNC hit: " + subReason,
	}
}

// NewConsentBlockErr creates an ErrConsentBlocked.
func NewConsentBlockErr(attemptUUID, subReason string) OriginateError {
	return &baseErr{
		gate:        "consent",
		subReason:   subReason,
		retryAfter:  0,
		attemptUUID: attemptUUID,
		d04Status:   "CONSENT_NOT_OBTAINED",
		outcome:     OutcomeConsentBlocked,
		msg:         "originate: consent blocked: " + subReason,
	}
}

// NewCarrierFailErr creates an ErrCarrierFail wrapping a T01 error.
func NewCarrierFailErr(attemptUUID, subReason string, retryAfter time.Duration, outcome OriginateOutcome) OriginateError {
	return &baseErr{
		gate:        "carrier",
		subReason:   subReason,
		retryAfter:  retryAfter,
		attemptUUID: attemptUUID,
		d04Status:   "CARRIER_FAIL",
		outcome:     outcome,
		msg:         "originate: carrier/transport fail: " + subReason,
	}
}
