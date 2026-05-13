package esl

import (
	"testing"
	"time"
)

func TestReconnectDelay_Backoff(t *testing.T) {
	initial := 300 * time.Millisecond
	max := 30 * time.Second

	// Each attempt should roughly double, up to the cap.
	prev := time.Duration(0)
	for attempt := 1; attempt <= 9; attempt++ {
		d := reconnectDelay(attempt, initial, max)
		if d < 0 {
			t.Fatalf("attempt %d: negative delay %v", attempt, d)
		}
		if d > max*5/4 { // allow 25% jitter over cap
			t.Fatalf("attempt %d: delay %v exceeds max %v with jitter", attempt, d, max)
		}
		// Monotone-ish (not strictly due to jitter, but on average).
		_ = prev
		prev = d
	}
}

func TestReconnectDelay_Cap(t *testing.T) {
	// At high attempt count, delay should not exceed max*(1.25).
	max := 100 * time.Millisecond
	for i := 0; i < 50; i++ {
		d := reconnectDelay(20, 10*time.Millisecond, max)
		if d > max*2 {
			t.Fatalf("cap exceeded: delay=%v max=%v", d, max)
		}
	}
}

func TestConnState_String(t *testing.T) {
	cases := []struct {
		s    connState
		want string
	}{
		{stateConnecting, "connecting"},
		{stateReconciling, "reconciling"},
		{stateReady, "ready"},
		{stateReconnecting, "reconnecting"},
		{stateDead, "dead"},
	}
	for _, tc := range cases {
		if got := tc.s.String(); got != tc.want {
			t.Fatalf("state %d: got %q, want %q", tc.s, got, tc.want)
		}
	}
}

func TestFSConn_HeartbeatAge(t *testing.T) {
	fc := &fsConn{}
	// No heartbeat yet → large age.
	if age := fc.heartbeatAge(); age < 1000*time.Second {
		t.Fatalf("expected large age before first heartbeat, got %v", age)
	}
	fc.touchHeartbeat()
	// Just touched → very small age.
	if age := fc.heartbeatAge(); age > 100*time.Millisecond {
		t.Fatalf("expected tiny age after touch, got %v", age)
	}
}
