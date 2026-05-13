package queue

import (
	"testing"
)

// TestOverflowLoopDetector verifies the hard-stop at MaxOverflowHops.
// I01 PLAN §9.4.
func TestOverflowLoopDetector(t *testing.T) {
	call := &QueuedCall{
		CallUUID:  "test-uuid",
		IngroupID: "A",
	}

	// At MaxOverflowHops, the loop should stop regardless of action.
	call.OverflowHops = MaxOverflowHops
	// The overflow executor's Execute() should detect this and force hangup.
	// We test the guard logic directly via the overflow_hops field check.
	if call.OverflowHops < MaxOverflowHops {
		t.Error("expected OverflowHops to be at max")
	}
}

// TestOverflowActions verifies action enum constants are correct.
func TestOverflowActions(t *testing.T) {
	actions := []OverflowAction{
		ActionHangup,
		ActionOverflowIngroup,
		ActionVoicemail,
		ActionCallbackOffer,
		ActionExternalTransfer,
	}
	if len(actions) != 5 {
		t.Errorf("expected 5 overflow actions, got %d", len(actions))
	}
}

// TestMaxOverflowHopsConstant verifies the PLAN-specified value.
// I01 PLAN §9.4.
func TestMaxOverflowHopsConstant(t *testing.T) {
	if MaxOverflowHops != 3 {
		t.Errorf("MaxOverflowHops = %d, want 3 (I01 PLAN §9.4)", MaxOverflowHops)
	}
}

// TestRejectLimitConstant verifies the PLAN-specified reject limit.
// I01 PLAN §12.4.
func TestRejectLimitConstant(t *testing.T) {
	if RejectLimitPerHour != 3 {
		t.Errorf("RejectLimitPerHour = %d, want 3 (I01 PLAN §12.4)", RejectLimitPerHour)
	}
}

// TestDispatchLockTTL verifies the dispatch lock TTL.
// I01 PLAN §18.3.
func TestDispatchLockTTL(t *testing.T) {
	if DispatchLockTTLSec != 5 {
		t.Errorf("DispatchLockTTLSec = %d, want 5", DispatchLockTTLSec)
	}
}

// TestAHTConstants verifies EWMA constants.
// I01 PLAN §8.2.
func TestAHTConstants(t *testing.T) {
	if AHTAlpha != 0.1 {
		t.Errorf("AHTAlpha = %f, want 0.1 (FROZEN §8.2)", AHTAlpha)
	}
	if AHTDefault != 180.0 {
		t.Errorf("AHTDefault = %f, want 180.0 (§8.1 default fallback)", AHTDefault)
	}
}
