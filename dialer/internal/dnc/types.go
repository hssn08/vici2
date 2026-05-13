// Package dnc implements D05 DNC (Do-Not-Call) check for the vici2 dialer.
//
// Hot path: Bloom pre-filter via BF.EXISTS pipelined over Valkey,
// with MySQL confirmation only on positive.  Target p99 < 5 ms.
package dnc

// Source represents a DNC list source.
type Source string

const (
	SourceFederal   Source = "federal"
	SourceState     Source = "state"
	SourceInternal  Source = "internal"
	SourceLitigator Source = "litigator"
)

// AllSources is the full set of supported sources (Phase 1; litigator Phase 2).
var AllSources = []Source{SourceFederal, SourceState, SourceInternal, SourceLitigator}

// sourcePriority for audit reason ordering (PLAN §2.3).
// Higher = more specific.
var sourcePriority = map[Source]int{
	SourceInternal:  4,
	SourceLitigator: 3,
	SourceState:     2,
	SourceFederal:   1,
}

// CheckRequest is the input to Check().
type CheckRequest struct {
	PhoneE164  string   // E.164-normalised phone, e.g. "+14155551212"
	TenantID   int64    // real tenant id (never 0)
	CampaignID string   // optional; "" treated as "__GLOBAL__"
	LeadState  string   // CHAR(2) or "" if unknown
	Sources    []Source // which sources to check (from campaign config)
}

// CheckResult is the output of Check().
type CheckResult struct {
	IsDNC             bool
	Sources           []Source // matched sources, sorted by priority
	LatencyMicros     int64
	BloomFalsePositive bool
	Reason            string // "malformed" when phone is invalid
}
