package picker

import (
	"context"
	"testing"

	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/originate"
)

// TestParseAnswerEvent verifies that stream message values are parsed correctly.
func TestParseAnswerEvent(t *testing.T) {
	msg := redis.XMessage{
		ID: "1-1",
		Values: map[string]interface{}{
			"call_uuid":   "uuid-abc",
			"campaign_id": "42",
			"tenant_id":   "1",
			"lead_id":     "100",
			"mode":        "PREDICTIVE",
			"fs_host":     "fs1.local:8021",
			"ts_ms":       "1234567890",
		},
	}
	ev := parseAnswerEvent(msg)

	if ev.CallUUID != "uuid-abc" {
		t.Errorf("CallUUID: got %q, want %q", ev.CallUUID, "uuid-abc")
	}
	if ev.CampaignID != 42 {
		t.Errorf("CampaignID: got %d, want 42", ev.CampaignID)
	}
	if ev.TenantID != 1 {
		t.Errorf("TenantID: got %d, want 1", ev.TenantID)
	}
	if ev.LeadID != 100 {
		t.Errorf("LeadID: got %d, want 100", ev.LeadID)
	}
	if ev.Mode != originate.ModePredictive {
		t.Errorf("Mode: got %q, want PREDICTIVE", ev.Mode)
	}
	if ev.FSHost != "fs1.local:8021" {
		t.Errorf("FSHost: got %q", ev.FSHost)
	}
	if ev.TsMs != 1234567890 {
		t.Errorf("TsMs: got %d, want 1234567890", ev.TsMs)
	}
}

// TestParseAnswerEvent_MissingFields verifies graceful handling of missing fields.
func TestParseAnswerEvent_MissingFields(t *testing.T) {
	msg := redis.XMessage{
		ID:     "1-2",
		Values: map[string]interface{}{},
	}
	ev := parseAnswerEvent(msg)
	if ev.CallUUID != "" {
		t.Errorf("expected empty CallUUID, got %q", ev.CallUUID)
	}
	if ev.CampaignID != 0 {
		t.Errorf("expected CampaignID=0, got %d", ev.CampaignID)
	}
}

// TestAnswerHandler_EmitDrop verifies that emitDrop writes to the dropped stream.
func TestAnswerHandler_EmitDrop(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	ah := &AnswerHandler{
		campaignID: 42,
		tenantID:   1,
		pairer:     NewAgentPairer(vc, m),
		claimer:    NewClaimer(vc, m),
		t01:        nil, // not needed for emitDrop
		vc:         vc,
		metrics:    m,
		podID:      "test",
		groupName:  "picker-test",
	}

	ev := AnsweredEvent{
		CallUUID:   "drop-uuid",
		CampaignID: 42,
		TenantID:   1,
	}

	ctx := context.Background()
	ah.emitDrop(ctx, ev, "no_agent")

	// Verify the stream entry was added (miniredis.Stream returns []StreamEntry, error).
	entries, err := mr.Stream(droppedEventStream)
	if err != nil {
		t.Fatalf("mr.Stream error: %v", err)
	}
	if len(entries) == 0 {
		t.Error("expected drop event to be written to stream, got none")
	}
}

// TestParseAMDEvent verifies AMD event parsing.
func TestParseAMDEvent(t *testing.T) {
	msg := redis.XMessage{
		ID: "2-1",
		Values: map[string]interface{}{
			"call_uuid":   "amd-uuid",
			"campaign_id": "7",
			"tenant_id":   "1",
			"lead_id":     "200",
			"list_id":     "5",
			"result":      "MACHINE",
			"fs_host":     "fs2.local",
			"ts_ms":       "9876",
		},
	}
	ev := parseAMDEvent(msg)
	if ev.CallUUID != "amd-uuid" {
		t.Errorf("CallUUID mismatch")
	}
	if ev.CampaignID != 7 {
		t.Errorf("CampaignID: got %d", ev.CampaignID)
	}
	if ev.ListID != 5 {
		t.Errorf("ListID: got %d", ev.ListID)
	}
	if ev.Result != "MACHINE" {
		t.Errorf("Result mismatch")
	}
}
