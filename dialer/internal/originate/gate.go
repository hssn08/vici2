package originate

import "context"

// GateOutcome discriminates the result of a gate check.
type GateOutcome int

const (
	GateAllow GateOutcome = iota
	GateBlock
)

// AuditRowPatch holds gate-specific columns to merge onto the audit row.
// Zero values mean "do not set" — the driver merges non-zero fields only.
type AuditRowPatch struct {
	// Set on gateway_cap gate
	CarrierID   int64
	GatewayID   int64
	GatewayName string

	// Set on tcpa gate
	TCPADecision  string // "ALLOW" | "BLOCK" | "SKIP"
	TCPAReason    string
	TCPATzIANA    string

	// Set on dnc gate
	DNCDecision string   // "ALLOW" | "BLOCK"
	DNCSources  []string // sources on BLOCK

	// Set on consent gate
	ConsentDecision string // "ALLOW" | "PROMPT" | "SKIP_RECORDING" | "BLOCK"
	ConsentState    string // 2-letter called-party state

	// Set on dnc gate when bypass token is redeemed
	BypassToken string

	// Set on any blocking gate
	ErrorMessage string
}

// GateResult is returned by Gate.Check.
type GateResult struct {
	Outcome    GateOutcome
	Block      OriginateError // populated iff Outcome == GateBlock
	AuditPatch AuditRowPatch
}

// GateScratch carries side-band state across gates within one Originate call.
type GateScratch struct {
	CallerID           string
	CallerIDName       string
	CallerIDSource     OriginateCidSource
	ResolvedCarrierID  int64
	ResolvedGatewayID  int64
	ResolvedGatewayName string
	TcpaTzIANA         string
	// ConsentDecision is the final consent mode (for channel-var assembly).
	ConsentDecision    string
}

// Gate represents one compliance check in the 5-gate pipeline.
// Each Gate evaluates a request and returns either ALLOW (with optional
// AuditPatch) or BLOCK (with a typed OriginateError).
type Gate interface {
	Name() string
	Check(ctx context.Context, req *OriginateRequest, scratch *GateScratch) GateResult
}
