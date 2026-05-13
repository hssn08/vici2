package tcpa

import (
	"context"
	"time"
)

// ResolveRequest is the input for D03 timezone resolution.
// C01 passes this to its Resolver dependency.
type ResolveRequest struct {
	LeadID        int64
	PhoneE164     string
	KnownTimezone string // IANA override; highest priority
	Zip           string
	State         string
}

// ResolveResult is the output of D03 timezone resolution.
type ResolveResult struct {
	IANA       string     // e.g. "America/New_York"
	Confidence Confidence // KNOWN | ZIP | NXX | NPA | STATE_DEFAULT | CAMPAIGN_DEFAULT | NONE
	Location   *time.Location
}

// Resolver is the D03 interface consumed by Checker.
// The canonical implementation lives in dialer/internal/tz (D03).
// For Phase 1 a stub implementation (StubResolver) is provided so C01 tests
// run without a real D03 binary.
type Resolver interface {
	Resolve(ctx context.Context, req ResolveRequest) (ResolveResult, error)
}

// StubResolver is a test/dev resolver that uses req.KnownTimezone directly
// or falls back to req.State-based heuristics, then returns NONE.
// Not for production use.
type StubResolver struct{}

func (StubResolver) Resolve(_ context.Context, req ResolveRequest) (ResolveResult, error) {
	if req.KnownTimezone != "" {
		loc, err := time.LoadLocation(req.KnownTimezone)
		if err != nil {
			return ResolveResult{Confidence: ConfNone}, nil
		}
		return ResolveResult{IANA: req.KnownTimezone, Confidence: ConfKnown, Location: loc}, nil
	}
	// State-based heuristic (single-tz states only).
	switch req.State {
	case "HI":
		loc, _ := time.LoadLocation("Pacific/Honolulu")
		return ResolveResult{IANA: "Pacific/Honolulu", Confidence: ConfStateDefault, Location: loc}, nil
	case "AK":
		loc, _ := time.LoadLocation("America/Anchorage")
		return ResolveResult{IANA: "America/Anchorage", Confidence: ConfStateDefault, Location: loc}, nil
	case "AZ":
		loc, _ := time.LoadLocation("America/Phoenix")
		return ResolveResult{IANA: "America/Phoenix", Confidence: ConfStateDefault, Location: loc}, nil
	case "AS":
		loc, _ := time.LoadLocation("Pacific/Pago_Pago")
		return ResolveResult{IANA: "Pacific/Pago_Pago", Confidence: ConfStateDefault, Location: loc}, nil
	case "GU", "MP":
		loc, _ := time.LoadLocation("Pacific/Guam")
		return ResolveResult{IANA: "Pacific/Guam", Confidence: ConfStateDefault, Location: loc}, nil
	case "PR", "VI":
		loc, _ := time.LoadLocation("America/Puerto_Rico")
		return ResolveResult{IANA: "America/Puerto_Rico", Confidence: ConfStateDefault, Location: loc}, nil
	}
	return ResolveResult{Confidence: ConfNone}, nil
}
