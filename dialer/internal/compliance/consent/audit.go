package consent

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// ConsentLogRow is the structured record written to consent_log.
// The StreamSink encodes it as JSON and pushes it onto the Valkey stream
// t:{tid}:audit:consent:stream for the api worker to consume and INSERT.
//
// Two rows are written per call_uuid:
//  1. Decision-time row (ConsentStatus="pending") — emitted by CheckConsent.
//  2. Status-time row — emitted by R01 after call completion with final ConsentStatus.
type ConsentLogRow struct {
	Ts            time.Time `json:"ts"`
	TenantID      int64     `json:"tenant_id"`
	CallUUID      string    `json:"call_uuid"`
	LeadID        int64     `json:"lead_id"`
	CampaignID    int64     `json:"campaign_id"`
	UserID        *int64    `json:"user_id,omitempty"` // nil pre-bridge
	LeadState     string    `json:"lead_state"`
	CallerState   string    `json:"caller_state"`
	Decision      string    `json:"decision"`      // ALLOW | PROMPT_BEEP | PROMPT_MESSAGE | REQUIRE_ACTIVE | SKIP
	Mechanism     string    `json:"mechanism"`     // e.g., "PROMPT_MESSAGE/lead=CA/caller=TX"
	StateApplied  string    `json:"state_applied"` // 2-letter state that drove the decision
	ConsentStatus string    `json:"consent_status"` // "pending" at decision time; updated by R01
	Reason        string    `json:"reason"`         // controlled vocab; see reasons.go
	Citation      string    `json:"citation"`
	RecordedAt    time.Time `json:"recorded_at"` // req.When at decision time
}

// Sink is the interface that writes consent audit rows asynchronously.
// Implementations must be safe for concurrent use.
type Sink interface {
	// Write enqueues an audit row. Returns immediately; never blocks on I/O.
	Write(ctx context.Context, row ConsentLogRow) error
}

// StdoutSink writes audit rows as JSON to stdout (dev / test mode).
type StdoutSink struct{}

func (s StdoutSink) Write(_ context.Context, row ConsentLogRow) error {
	b, err := json.Marshal(row)
	if err != nil {
		return err
	}
	fmt.Println("consent_audit:", string(b))
	return nil
}

// noopSink silently discards audit rows (used in benchmarks and tests).
type noopSink struct{}

func (noopSink) Write(_ context.Context, _ ConsentLogRow) error { return nil }
