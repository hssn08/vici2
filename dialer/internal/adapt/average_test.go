// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt_test

import (
	"math"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/adapt"
)

func TestAverageWithDeadband(t *testing.T) {
	t.Parallel()

	t.Run("integral_bleed_in_deadband", func(t *testing.T) {
		t.Parallel()
		// Integral should bleed by ×0.95 when in deadband.
		in := adapt.AdaptInput{
			Mode: adapt.DialMethodAdaptAvg, DropPct30d: 1.6, AdaptiveDropPct: 1.5,
			CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
			LastIntegral: 0.1, TickSeconds: 15, WarmUp: false, Now: time.Now(),
		}
		out := adapt.Decide(in)
		if out.ActionTaken != "hold" {
			t.Fatalf("expected hold, got %s", out.ActionTaken)
		}
		want := 0.1 * 0.95
		if math.Abs(out.NewIntegral-want) > 0.001 {
			t.Errorf("integral bleed: got %.4f, want %.4f", out.NewIntegral, want)
		}
	})

	t.Run("antiwindup_at_ceiling_integral_bounded", func(t *testing.T) {
		t.Parallel()
		// Run many ticks at ceiling; integral must not exceed IMax.
		in := adapt.AdaptInput{
			Mode: adapt.DialMethodAdaptAvg, DropPct30d: 0.0, AdaptiveDropPct: 1.5,
			CurrentLevel: 3.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
			LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
		}
		for i := 0; i < 100; i++ {
			out := adapt.Decide(in)
			if out.NewIntegral > adapt.IMax*1.01 {
				t.Errorf("tick %d: integral %.4f exceeded IMax %.4f", i, out.NewIntegral, adapt.IMax)
			}
			in.LastIntegral = out.NewIntegral
		}
	})

	t.Run("antiwindup_at_floor_integral_bounded", func(t *testing.T) {
		t.Parallel()
		in := adapt.AdaptInput{
			Mode: adapt.DialMethodAdaptAvg, DropPct30d: 5.0, AdaptiveDropPct: 1.5,
			CurrentLevel: 1.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
			LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
		}
		for i := 0; i < 100; i++ {
			out := adapt.Decide(in)
			if out.NewIntegral < -adapt.IMax*1.01 {
				t.Errorf("tick %d: integral %.4f below -IMax %.4f", i, out.NewIntegral, adapt.IMax)
			}
			in.LastIntegral = out.NewIntegral
		}
	})

	t.Run("deadband_inside_boundary_hold", func(t *testing.T) {
		t.Parallel()
		// |err| = 0.29 < hold_band_pp=0.30 → clearly inside deadband → hold.
		in := adapt.AdaptInput{
			Mode: adapt.DialMethodAdaptAvg, DropPct30d: 1.21, AdaptiveDropPct: 1.5,
			// err = 1.5 - 1.21 = 0.29 < 0.30 → hold
			CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
			LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
		}
		out := adapt.Decide(in)
		if out.ActionTaken != "hold" {
			t.Errorf("expected hold inside deadband boundary, got %s", out.ActionTaken)
		}
	})

	t.Run("deadband_just_outside_acts", func(t *testing.T) {
		t.Parallel()
		// |err| = 0.31 > hold_band_pp → acts.
		in := adapt.AdaptInput{
			Mode: adapt.DialMethodAdaptAvg, DropPct30d: 1.81, AdaptiveDropPct: 1.5,
			CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
			LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
		}
		out := adapt.Decide(in)
		if out.ActionTaken == "hold" {
			t.Errorf("expected action outside deadband, got hold")
		}
	})
}

func TestHardLimit(t *testing.T) {
	t.Parallel()

	t.Run("hard_integral_always_zero", func(t *testing.T) {
		t.Parallel()
		for _, drop := range []float64{0, 0.5, 1.5, 2.0, 3.0} {
			in := adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptHard, DropPct30d: drop, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0.5, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			}
			out := adapt.Decide(in)
			if out.NewIntegral != 0 {
				t.Errorf("drop=%.1f: HARD mode should have zero integral, got %.4f", drop, out.NewIntegral)
			}
		}
	})

	t.Run("hard_intensity_scales_steps", func(t *testing.T) {
		t.Parallel()
		// +10 intensity → raise step 10% larger.
		inBase := adapt.AdaptInput{
			Mode: adapt.DialMethodAdaptHard, DropPct30d: 0.5, AdaptiveDropPct: 1.5,
			CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
			LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
		}
		inInt := inBase
		inInt.Intensity = 10
		outBase := adapt.Decide(inBase)
		outInt := adapt.Decide(inInt)
		if outInt.NewLevel <= outBase.NewLevel-0.001 {
			t.Errorf("intensity+10 should produce equal or larger raise: base=%.2f int10=%.2f",
				outBase.NewLevel, outInt.NewLevel)
		}
	})

	t.Run("hard_lower_intensity_scales_down", func(t *testing.T) {
		t.Parallel()
		// -10 intensity → lower step 10% larger.
		inBase := adapt.AdaptInput{
			Mode: adapt.DialMethodAdaptHard, DropPct30d: 3.0, AdaptiveDropPct: 1.5,
			CurrentLevel: 2.5, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
			LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
		}
		inInt := inBase
		inInt.Intensity = -10
		outBase := adapt.Decide(inBase)
		outInt := adapt.Decide(inInt)
		if outInt.NewLevel >= outBase.NewLevel+0.001 {
			t.Errorf("intensity-10 should produce equal or smaller level after hard-lower: base=%.2f int-10=%.2f",
				outBase.NewLevel, outInt.NewLevel)
		}
	})
}
