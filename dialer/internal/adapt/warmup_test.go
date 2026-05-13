// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt_test

import (
	"testing"
	"time"

	"github.com/vici2/dialer/internal/adapt"
)

func TestWarmUp(t *testing.T) {
	t.Parallel()
	now := time.Now()

	t.Run("fresh_warmup_is_active", func(t *testing.T) {
		t.Parallel()
		wu := adapt.InitWarmUp(50, 300, now)
		if !wu.IsActive(now) {
			t.Error("expected warm-up to be active immediately")
		}
	})

	t.Run("calls_gate_exits_warmup", func(t *testing.T) {
		t.Parallel()
		wu := adapt.InitWarmUp(2, 300, now)
		wu.DecrementCall()
		if !wu.IsActive(now) {
			t.Error("expected still active after 1 call")
		}
		wu.DecrementCall()
		if wu.IsActive(now) {
			t.Error("expected warm-up to exit after 2 calls")
		}
	})

	t.Run("time_gate_exits_warmup", func(t *testing.T) {
		t.Parallel()
		wu := adapt.InitWarmUp(50, 10, now)
		// Not enough time.
		if !wu.IsActive(now.Add(5 * time.Second)) {
			t.Error("expected active at 5s with 10s gate")
		}
		// Enough time.
		if wu.IsActive(now.Add(11 * time.Second)) {
			t.Error("expected exit at 11s with 10s gate")
		}
	})

	t.Run("zero_calls_gate_instant_exit", func(t *testing.T) {
		t.Parallel()
		wu := adapt.InitWarmUp(0, 300, now)
		// CallsRemaining starts at 0 → calls gate exits immediately.
		if wu.IsActive(now) {
			t.Error("expected immediate exit with minAnswered=0")
		}
	})

	t.Run("decide_returns_warmup_when_active", func(t *testing.T) {
		t.Parallel()
		in := adapt.AdaptInput{
			Mode: adapt.DialMethodAdaptAvg, DropPct30d: 0, AdaptiveDropPct: 1.5,
			CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
			LastIntegral: 0.2, TickSeconds: 15, WarmUp: true, Now: time.Now(),
		}
		out := adapt.Decide(in)
		if out.ActionTaken != "warm_up" {
			t.Errorf("expected warm_up action, got %s", out.ActionTaken)
		}
		if out.NeedsWrite {
			t.Error("expected NeedsWrite=false during warm-up")
		}
		if out.NewLevel != 2.0 {
			t.Errorf("expected level unchanged at 2.0, got %.2f", out.NewLevel)
		}
	})
}
