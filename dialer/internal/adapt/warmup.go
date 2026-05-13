// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import "time"

// WarmUpState tracks the warm-up gate for a campaign.
// Persisted in pace_state HASH fields: warm_up_calls_remaining, warm_up_started_at.
type WarmUpState struct {
	CallsRemaining int
	StartedAt      time.Time
	MinAnswered    int // from campaigns.warmup_min_answered (default 50)
	MinSeconds     int // from campaigns.warmup_min_seconds (default 300)
}

// IsActive returns true if the warm-up gate is still active.
// Exit gates (first wins):
//  1. CallsRemaining <= 0 (answered call count gate)
//  2. Elapsed seconds >= MinSeconds (time gate)
func (w WarmUpState) IsActive(now time.Time) bool {
	if w.CallsRemaining <= 0 {
		return false
	}
	if !w.StartedAt.IsZero() && int(now.Sub(w.StartedAt).Seconds()) >= w.MinSeconds {
		return false
	}
	return true
}

// DecrementCall decrements the call counter (called on each answered call event).
func (w *WarmUpState) DecrementCall() {
	if w.CallsRemaining > 0 {
		w.CallsRemaining--
	}
}

// InitWarmUp creates a fresh WarmUpState for a cold-start.
// minAnswered=0 means "no call gate" (immediate calls-gate exit).
// minSeconds=0 means "no time gate" (immediate time-gate exit).
func InitWarmUp(minAnswered, minSeconds int, now time.Time) WarmUpState {
	if minAnswered < 0 {
		minAnswered = 0
	}
	if minSeconds < 0 {
		minSeconds = 0
	}
	return WarmUpState{
		CallsRemaining: minAnswered,
		StartedAt:      now,
		MinAnswered:    minAnswered,
		MinSeconds:     minSeconds,
	}
}
