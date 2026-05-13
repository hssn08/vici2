package conference_test

import (
	"strings"
	"testing"

	"github.com/vici2/dialer/internal/conference"
)

func TestConferenceName(t *testing.T) {
	tests := []struct {
		tid, uid int64
		want     string
	}{
		{1, 1042, "agent_t1_u1042"},
		{1, 1, "agent_t1_u1"},
		{17, 1042, "agent_t17_u1042"},
		{99, 9999, "agent_t99_u9999"},
	}
	for _, tc := range tests {
		got := conference.ConferenceName(tc.tid, tc.uid)
		if got != tc.want {
			t.Errorf("ConferenceName(%d,%d) = %q, want %q", tc.tid, tc.uid, got, tc.want)
		}
		// Must start with agent_ prefix.
		if !strings.HasPrefix(got, "agent_") {
			t.Errorf("ConferenceName(%d,%d) = %q does not start with agent_", tc.tid, tc.uid, got)
		}
	}
}

func TestConferenceFQN(t *testing.T) {
	tests := []struct {
		tid, uid int64
		profile  string
		want     string
	}{
		{1, 1042, "default", "agent_t1_u1042@default"},
		{1, 1042, "hold", "agent_t1_u1042@hold"},
		{17, 5, "default", "agent_t17_u5@default"},
	}
	for _, tc := range tests {
		got := conference.ConferenceFQN(tc.tid, tc.uid, tc.profile)
		if got != tc.want {
			t.Errorf("ConferenceFQN(%d,%d,%q) = %q, want %q",
				tc.tid, tc.uid, tc.profile, got, tc.want)
		}
		// Must contain @<profile>.
		if !strings.HasSuffix(got, "@"+tc.profile) {
			t.Errorf("ConferenceFQN result %q does not end with @%s", got, tc.profile)
		}
	}
}

func TestHoldConferenceName(t *testing.T) {
	tests := []struct {
		tid, uid int64
		want     string
	}{
		{1, 1042, "agent_t1_u1042_hold"},
		{1, 7, "agent_t1_u7_hold"},
		{17, 1042, "agent_t17_u1042_hold"},
	}
	for _, tc := range tests {
		got := conference.HoldConferenceName(tc.tid, tc.uid)
		if got != tc.want {
			t.Errorf("HoldConferenceName(%d,%d) = %q, want %q", tc.tid, tc.uid, got, tc.want)
		}
		// Must end with _hold.
		if !strings.HasSuffix(got, "_hold") {
			t.Errorf("HoldConferenceName(%d,%d) = %q does not end with _hold", tc.tid, tc.uid, got)
		}
	}
}

// TestConferenceFQNIsConferenceName verifies that ConferenceFQN is built
// from ConferenceName + "@" + profile (not a separate implementation).
func TestConferenceFQNIsConferenceName(t *testing.T) {
	tid, uid := int64(1), int64(1042)
	profile := "default"
	want := conference.ConferenceName(tid, uid) + "@" + profile
	got := conference.ConferenceFQN(tid, uid, profile)
	if got != want {
		t.Errorf("ConferenceFQN mismatch: got %q, want %q", got, want)
	}
}

// TestPhase1 asserts the Phase 1 single-tenant constant shape.
func TestPhase1(t *testing.T) {
	const (
		wantTID = int64(1)
		wantUID = int64(1042)
	)
	got := conference.ConferenceFQN(wantTID, wantUID, "default")
	if got != "agent_t1_u1042@default" {
		t.Errorf("Phase 1 FQN = %q, want agent_t1_u1042@default", got)
	}
}
