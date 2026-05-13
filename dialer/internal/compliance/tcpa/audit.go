package tcpa

import (
	"context"
	"encoding/json"
	"fmt"
	"time"
)

// CallWindowAuditRow is the structured record written to call_window_audit.
// The StreamSink encodes it as JSON and pushes it onto the Valkey stream
// t:{tid}:audit:tcpa:stream for the api worker to consume and INSERT.
type CallWindowAuditRow struct {
	Ts               time.Time  `json:"ts"`
	TenantID         int64      `json:"tenant_id"`
	LeadID           int64      `json:"lead_id"`
	PhoneE164        string     `json:"phone_e164"`
	CampaignID       int64      `json:"campaign_id"`
	Decision         string     `json:"decision"`          // ALLOW | ALLOW_WARN | SKIP_UNTIL | BLOCK_INVALID
	Reason           string     `json:"reason"`
	TzIANA           string     `json:"tz_iana"`
	TzConfidence     string     `json:"tz_confidence"`
	State            string     `json:"state"`
	Zip              string     `json:"zip"`
	PartyLocal       time.Time  `json:"party_local"`
	PartyDow         int        `json:"party_dow"`
	EffectiveOpenMin int        `json:"effective_open_min"`
	EffectiveCloseMin int       `json:"effective_close_min"`
	RuleApplied      string     `json:"rule_applied"`
	EnforcementPoint string     `json:"enforcement_point"`
	NextOpenAt       *time.Time `json:"next_open_at,omitempty"`
	CallUUID         string     `json:"call_uuid,omitempty"`
}

// Sink is the interface that writes audit rows asynchronously.
// Implementations must be safe for concurrent use.
type Sink interface {
	// Write enqueues an audit row. Returns immediately; never blocks on I/O.
	Write(ctx context.Context, row CallWindowAuditRow) error
}

// StdoutSink writes audit rows as JSON to stdout (dev / test mode).
type StdoutSink struct{}

func (s StdoutSink) Write(_ context.Context, row CallWindowAuditRow) error {
	b, err := json.Marshal(row)
	if err != nil {
		return err
	}
	fmt.Println("tcpa_audit:", string(b))
	return nil
}

// noopSink silently discards audit rows (used in benchmarks).
type noopSink struct{}

func (noopSink) Write(_ context.Context, _ CallWindowAuditRow) error { return nil }
