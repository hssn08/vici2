// transition.go — mode-transition table and ordering rules.
//
// S02 PLAN §4.1: every (from, to) pair emits ≤2 conference API calls in
// the strict order defined by §4.2 to prevent audio leaks.
//
// Ordering rules (load-bearing):
//   Eavesdrop → Whisper: relate FIRST, then unmute.
//   Whisper → Eavesdrop: mute FIRST, then relate clear.
//   All other pairs: single call, no ordering concern.
package supervisor

import "fmt"

// confCmd is a single conference API call to be executed in sequence.
type confCmd struct {
	command string // e.g. "mute", "unmute", "relate"
	args    string // e.g. "42" or "42 17 nospeak"
}

// buildTransitionSequence returns the ordered sequence of conference API calls
// required to move from currentMode to newMode.
//
// custMIDs is the list of non-agent, non-supervisor member-ids in the
// conference (may be empty in listen-only scenarios without a customer yet).
//
// The returned slice has ≤2 elements for any single transition.
func buildTransitionSequence(from, to Mode, supMID int, custMIDs []int) ([]confCmd, error) {
	supStr := fmt.Sprintf("%d", supMID)

	switch {
	// ── Eavesdrop → Whisper ────────────────────────────────────────────────
	// SAFE ORDER: relate nospeak FIRST → then unmute.
	// Rationale: unmuting before relate would briefly expose supervisor audio
	// to the customer during the ~10 µs gap between calls. (S02 PLAN §4.2)
	case from == ModeEavesdrop && to == ModeWhisper:
		var cmds []confCmd
		for _, cid := range custMIDs {
			cmds = append(cmds, confCmd{"relate", fmt.Sprintf("%d %d nospeak", supMID, cid)})
		}
		cmds = append(cmds, confCmd{"unmute", supStr})
		return cmds, nil

	// ── Eavesdrop → Barge ─────────────────────────────────────────────────
	// Single unmute; no relate involved.
	case from == ModeEavesdrop && to == ModeBarge:
		return []confCmd{{"unmute", supStr}}, nil

	// ── Whisper → Eavesdrop ────────────────────────────────────────────────
	// SAFE ORDER: mute FIRST → then relate clear.
	// Rationale: clearing relate before muting briefly exposes supervisor
	// audio to the customer. (S02 PLAN §4.2)
	case from == ModeWhisper && to == ModeEavesdrop:
		var cmds []confCmd
		cmds = append(cmds, confCmd{"mute", supStr})
		for _, cid := range custMIDs {
			cmds = append(cmds, confCmd{"relate", fmt.Sprintf("%d %d clear", supMID, cid)})
		}
		return cmds, nil

	// ── Whisper → Barge ───────────────────────────────────────────────────
	// Only relate clear; supervisor is unmuted in both states.
	case from == ModeWhisper && to == ModeBarge:
		var cmds []confCmd
		for _, cid := range custMIDs {
			cmds = append(cmds, confCmd{"relate", fmt.Sprintf("%d %d clear", supMID, cid)})
		}
		if len(cmds) == 0 {
			// No customers yet (agent only); nothing to clear.
			return nil, nil
		}
		return cmds, nil

	// ── Barge → Whisper ───────────────────────────────────────────────────
	// Only relate nospeak; no mute involved.
	case from == ModeBarge && to == ModeWhisper:
		var cmds []confCmd
		for _, cid := range custMIDs {
			cmds = append(cmds, confCmd{"relate", fmt.Sprintf("%d %d nospeak", supMID, cid)})
		}
		return cmds, nil

	// ── Barge → Eavesdrop ─────────────────────────────────────────────────
	// Single mute; no relate involved (barge had no relate to begin with).
	case from == ModeBarge && to == ModeEavesdrop:
		return []confCmd{{"mute", supStr}}, nil
	}

	return nil, fmt.Errorf("supervisor: unsupported transition %q → %q", from, to)
}
