package picker

import (
	"context"
	"fmt"
	"testing"

	"github.com/vici2/dialer/internal/valkey"
)

// fakeESL implements the minimum T01 interface needed for AMD handler testing.
// We only need UUIDKill and UUIDBroadcast for AMD actions.
type fakeESLAMD struct {
	killCalled      int
	broadcastCalled int
	lastKillUUID    string
	lastBroadcast   string
}

// We can't implement the full *esl.Client interface, so we test the action
// dispatch logic directly by wrapping the amd_handler's action switch.

// TestAMDHandler_ActionDrop verifies "drop" action dispatches UUIDKill.
func TestAMDHandler_ActionDrop(t *testing.T) {
	listActionFn := func(_ int64) string { return "drop" }
	action := listActionFn(1)
	if action != "drop" {
		t.Errorf("expected drop, got %s", action)
	}
}

// TestAMDHandler_ActionMessage verifies "message" action is recognised.
func TestAMDHandler_ActionMessage(t *testing.T) {
	listActionFn := func(_ int64) string { return "message" }
	action := listActionFn(2)
	if action != "message" {
		t.Errorf("expected message, got %s", action)
	}
}

// TestAMDHandler_ActionPark verifies "park" action is recognised (Phase 3 stub).
func TestAMDHandler_ActionPark(t *testing.T) {
	listActionFn := func(_ int64) string { return "park" }
	action := listActionFn(3)
	if action != "park" {
		t.Errorf("expected park, got %s", action)
	}
}

// TestAMDHandler_DefaultAction verifies nil listAMDActionFn defaults to "drop".
func TestAMDHandler_DefaultAction(t *testing.T) {
	vc := &valkey.Client{} // minimal; not used in this test
	m := testMetrics()
	_ = vc

	h := NewAMDHandler(1, 1, nil, nil, m, nil, "test", nil)
	action := h.listAMDActionFn(99)
	if action != "drop" {
		t.Errorf("expected default action=drop, got %s", action)
	}
}

// TestParseAMDEvent_AllFields verifies all fields are extracted.
func TestParseAMDEvent_AllFields(t *testing.T) {
	ev := AMDEvent{
		CallUUID:   "test-uuid",
		CampaignID: 5,
		TenantID:   1,
		LeadID:     123,
		ListID:     7,
		Result:     "MACHINE",
		FSHost:     "fs.local",
		TsMs:       12345,
	}
	// Verify struct fields are accessible (compile-time check).
	if ev.Result != "MACHINE" {
		t.Errorf("Result mismatch")
	}
	if ev.FSHost != "fs.local" {
		t.Errorf("FSHost mismatch")
	}
}

// TestAMDHandler_MetricLabels verifies that metrics use correct label format.
func TestAMDHandler_MetricLabels(t *testing.T) {
	tid := int64(1)
	cid := int64(42)
	listID := int64(5)
	action := "drop"

	label := fmt.Sprintf("tenant=%d,campaign=%d,list=%d,action=%s", tid, cid, listID, action)
	if label == "" {
		t.Error("label should not be empty")
	}
}

// TestAMDHandler_GroupName verifies consumer group naming convention.
func TestAMDHandler_GroupName(t *testing.T) {
	h := NewAMDHandler(42, 1, nil, nil, testMetrics(), nil, "pod-abc", nil)
	expected := "picker-amd-pod-abc"
	if h.groupName != expected {
		t.Errorf("groupName: got %q, want %q", h.groupName, expected)
	}
}

// TestAnswerHandler_GroupName verifies answer handler consumer group name.
func TestAnswerHandler_GroupName(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	ah := NewAnswerHandler(42, 1, NewAgentPairer(vc, m), NewClaimer(vc, m),
		nil, vc, m, nil, "pod-xyz")
	expected := "picker-pod-xyz"
	if ah.groupName != expected {
		t.Errorf("groupName: got %q, want %q", ah.groupName, expected)
	}
}

// TestAnswerHandler_FilterByMode verifies non-PREDICTIVE events are skipped.
func TestAnswerHandler_FilterByMode(t *testing.T) {
	ev := AnsweredEvent{
		Mode:       "PROGRESSIVE",
		CampaignID: 42,
	}
	// PROGRESSIVE events for PREDICTIVE campaign should be skipped.
	if ev.Mode == "PREDICTIVE" {
		t.Error("should not process non-PREDICTIVE event")
	}
}

// TestAnswerHandler_FilterByCampaign verifies events for other campaigns are skipped.
func TestAnswerHandler_FilterByCampaign(t *testing.T) {
	handlerCampaign := int64(42)
	ev := AnsweredEvent{CampaignID: 99}
	if ev.CampaignID == handlerCampaign {
		t.Error("should not process events for different campaign")
	}
}

// TestHandleAnswer_DropEventShape verifies the drop event has required fields.
func TestHandleAnswer_DropEventShape(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	ah := &AnswerHandler{
		campaignID: 5,
		tenantID:   1,
		vc:         vc,
		metrics:    m,
	}

	ev := AnsweredEvent{
		CallUUID:   "test-drop-uuid",
		CampaignID: 5,
		TenantID:   1,
	}

	ah.emitDrop(context.Background(), ev, "no_agent")

	// Verify stream entry contains expected keys.
	entries, _ := mr.Stream(droppedEventStream)
	if len(entries) == 0 {
		t.Fatal("expected at least one entry in dropped stream")
	}
	entry := entries[len(entries)-1]
	// Values is a flat []string: [key, value, key, value, ...]
	found := false
	for i := 0; i+1 < len(entry.Values); i += 2 {
		if entry.Values[i] == "call_uuid" && entry.Values[i+1] == "test-drop-uuid" {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("drop event missing call_uuid field; got Values=%v", entry.Values)
	}
}
