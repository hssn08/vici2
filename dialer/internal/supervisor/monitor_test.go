package supervisor

import (
	"testing"
)

// ─────────────────────────────────────────────────────────────────────────────
// U1 — Transition table completeness
// ─────────────────────────────────────────────────────────────────────────────

func TestTransitionTable_Completeness(t *testing.T) {
	modes := []Mode{ModeEavesdrop, ModeWhisper, ModeBarge}
	for _, from := range modes {
		for _, to := range modes {
			if from == to {
				continue
			}
			_, err := buildTransitionSequence(from, to, 5, nil)
			if err != nil {
				t.Errorf("buildTransitionSequence(%q → %q): unexpected error: %v", from, to, err)
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// U2 — Eavesdrop → Whisper: relate BEFORE unmute (S02 PLAN §4.2)
// ─────────────────────────────────────────────────────────────────────────────

func TestTransition_EavesdropToWhisper_Ordering(t *testing.T) {
	cmds, err := buildTransitionSequence(ModeEavesdrop, ModeWhisper, 10, []int{20})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cmds) < 2 {
		t.Fatalf("expected ≥2 commands, got %d", len(cmds))
	}
	// First command must be relate nospeak.
	if cmds[0].command != "relate" {
		t.Errorf("first command should be 'relate', got %q", cmds[0].command)
	}
	// Last command must be unmute.
	last := cmds[len(cmds)-1]
	if last.command != "unmute" {
		t.Errorf("last command should be 'unmute', got %q", last.command)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// U3 — Whisper → Eavesdrop: mute BEFORE relate clear (S02 PLAN §4.2)
// ─────────────────────────────────────────────────────────────────────────────

func TestTransition_WhisperToEavesdrop_Ordering(t *testing.T) {
	cmds, err := buildTransitionSequence(ModeWhisper, ModeEavesdrop, 10, []int{20})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cmds) < 2 {
		t.Fatalf("expected ≥2 commands, got %d", len(cmds))
	}
	// First command must be mute.
	if cmds[0].command != "mute" {
		t.Errorf("first command should be 'mute', got %q", cmds[0].command)
	}
	// Second command must be relate clear.
	if cmds[1].command != "relate" {
		t.Errorf("second command should be 'relate', got %q", cmds[1].command)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// U4 — Multi-customer relate enumeration (3-way conf whisper join)
// ─────────────────────────────────────────────────────────────────────────────

func TestTransition_EavesdropToWhisper_MultiCust(t *testing.T) {
	// Two non-agent members (customer + third-party transfer in progress).
	cmds, err := buildTransitionSequence(ModeEavesdrop, ModeWhisper, 10, []int{20, 30})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Expect: relate(10,20), relate(10,30), unmute(10)
	relateCnt := 0
	unmuteCnt := 0
	for _, c := range cmds {
		switch c.command {
		case "relate":
			relateCnt++
		case "unmute":
			unmuteCnt++
		}
	}
	if relateCnt != 2 {
		t.Errorf("expected 2 relate commands for 2 customers, got %d", relateCnt)
	}
	if unmuteCnt != 1 {
		t.Errorf("expected 1 unmute command, got %d", unmuteCnt)
	}
	// unmute must be last.
	if cmds[len(cmds)-1].command != "unmute" {
		t.Errorf("unmute must be the last command, got %q", cmds[len(cmds)-1].command)
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// U9 — Multi-supervisor mode independence
// ─────────────────────────────────────────────────────────────────────────────

func TestTransition_MultiSup_Independence(t *testing.T) {
	// Sup A (mid=10) in whisper mode: relate commands reference mid 10.
	// Sup B (mid=11) in barge mode: a subsequent transition for Sup B
	// should not affect Sup A's relate state (relate commands reference mid 11
	// exclusively).
	custMIDs := []int{20}

	cmdsA, err := buildTransitionSequence(ModeEavesdrop, ModeWhisper, 10, custMIDs)
	if err != nil {
		t.Fatalf("sup A: %v", err)
	}
	for _, c := range cmdsA {
		if c.command == "relate" {
			// Must mention sup A's mid (10), not sup B's (11).
			if len(c.args) > 0 && c.args[0] != '1' {
				t.Errorf("sup A relate arg should start with sup A's mid; got %q", c.args)
			}
		}
	}

	cmdsB, err := buildTransitionSequence(ModeBarge, ModeWhisper, 11, custMIDs)
	if err != nil {
		t.Fatalf("sup B: %v", err)
	}
	for _, c := range cmdsB {
		if c.command == "relate" {
			// Must reference sup B (11), not sup A (10).
			if c.args[:2] != "11" {
				t.Errorf("sup B relate arg must start with '11', got %q", c.args)
			}
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// ParseMode
// ─────────────────────────────────────────────────────────────────────────────

func TestParseMode(t *testing.T) {
	cases := []struct {
		in      string
		want    Mode
		wantErr bool
	}{
		{"listen", ModeEavesdrop, false},
		{"whisper", ModeWhisper, false},
		{"barge", ModeBarge, false},
		{"", "", true},
		{"invalid", "", true},
		{"Listen", "", true}, // case-sensitive
	}
	for _, tc := range cases {
		got, err := ParseMode(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("ParseMode(%q): expected error, got mode=%q", tc.in, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("ParseMode(%q): unexpected error: %v", tc.in, err)
		}
		if got != tc.want {
			t.Errorf("ParseMode(%q): got %q, want %q", tc.in, got, tc.want)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Transition — no error for Barge → Whisper without customers
// ─────────────────────────────────────────────────────────────────────────────

func TestTransition_BargeToWhisper_NoCust(t *testing.T) {
	// Edge: no customer in conference yet. Should not panic or error.
	cmds, err := buildTransitionSequence(ModeBarge, ModeWhisper, 5, nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// No customers → no relate calls needed (nothing to block).
	_ = cmds
}

// ─────────────────────────────────────────────────────────────────────────────
// Barge → Eavesdrop: single mute, no relate
// ─────────────────────────────────────────────────────────────────────────────

func TestTransition_BargeToEavesdrop(t *testing.T) {
	cmds, err := buildTransitionSequence(ModeBarge, ModeEavesdrop, 5, []int{20})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(cmds) != 1 || cmds[0].command != "mute" {
		t.Errorf("expected single 'mute' command, got %v", cmds)
	}
}
