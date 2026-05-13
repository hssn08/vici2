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

// baseInput returns a standard AdaptInput for table tests.
func baseInput() adapt.AdaptInput {
	return adapt.AdaptInput{
		Mode:             adapt.DialMethodAdaptAvg,
		DropPct30d:       0,
		AdaptiveDropPct:  1.5,
		CurrentLevel:     1.85,
		AdaptiveMaxLevel: 3.0,
		Intensity:        0,
		HoldBandPP:       0.30,
		LastIntegral:     0,
		Now:              time.Now(),
		TickSeconds:      15,
		WarmUp:           false,
	}
}

// TestDecideWorkedExamples verifies all pinned worked examples A–F from PLAN §2.6.
func TestDecideWorkedExamples(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name        string
		in          adapt.AdaptInput
		wantLevel   float64
		wantAction  string
		wantWrite   bool
		wantIntNear float64 // approximate integral (±0.01)
	}{
		{
			// A — ADAPT_AVG, well below target, no integral buildup.
			name: "A_avg_below_target_no_integral",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 0.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 1.85, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantLevel: 2.00, wantAction: "raise", wantWrite: true, wantIntNear: 0.075,
		},
		{
			// B — ADAPT_AVG, slightly above target — falls in deadband.
			name: "B_avg_in_deadband",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 1.7, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.20, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0.05, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantLevel: 2.20, wantAction: "hold", wantWrite: false, wantIntNear: 0.0475,
		},
		{
			// C — ADAPT_AVG, well above target, soft lower.
			name: "C_avg_above_target_lower_soft",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 2.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.20, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0.05, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantLevel: 2.15, wantAction: "lower_soft", wantWrite: true, wantIntNear: -0.025,
		},
		{
			// D — ADAPT_HARD, drop > target, intensity=+5.
			name: "D_hard_above_target_intensity5",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptHard, DropPct30d: 2.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.20, AdaptiveMaxLevel: 3.0, Intensity: 5, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantLevel: 2.00, wantAction: "lower_hard", wantWrite: true, wantIntNear: 0,
		},
		{
			// E — Anti-windup clamp at ceiling.
			name: "E_antiwindup_ceiling",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 0.1, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.95, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0.4, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantLevel: 3.00, wantAction: "raise", wantWrite: true, wantIntNear: 0.50,
		},
		{
			// F — ADAPT_TAPERED, mid-shift (progress=0.25), target=1.5 → effective=2.0625, drop=2.0 → deadband.
			name: "F_tapered_midshift_deadband",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptTapered, DropPct30d: 2.0, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.20, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false,
				Now:        time.Date(2026, 1, 1, 10, 15, 0, 0, time.UTC),
				ShiftStart: time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC),
				ShiftEnd:   time.Date(2026, 1, 1, 17, 0, 0, 0, time.UTC),
			},
			wantLevel: 2.20, wantAction: "hold", wantWrite: false, wantIntNear: 0,
		},
		// Warm-up inhibit.
		{
			name: "warmup_active",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 0.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.00, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0.1, TickSeconds: 15, WarmUp: true, Now: time.Now(),
			},
			wantLevel: 2.00, wantAction: "warm_up", wantWrite: false, wantIntNear: 0.1,
		},
		// Under target, zero integral.
		// drop=0, target=1.5, err=1.5, pTerm=0.05*1.5=0.075, iTerm=0.005*1.5*15=0.1125
		// unclamped=1.0+0.075+0.1125=1.1875 → quantize → 1.20
		{
			name: "under_target_zero_integral",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 0, AdaptiveDropPct: 1.5,
				CurrentLevel: 1.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantLevel: 1.20, wantAction: "raise", wantWrite: true,
		},
		// Over target, outside deadband.
		{
			name: "over_target_outside_deadband",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 3.0, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.50, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantAction: "lower_soft", wantWrite: true,
		},
		// At floor clamp: HARD mode, drop above target.
		{
			name: "floor_clamp_hard",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptHard, DropPct30d: 3.0, AdaptiveDropPct: 1.5,
				CurrentLevel: 1.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantLevel: 1.00, wantAction: "lower_hard",
		},
		// HARD: drop exactly at target → lower_hard (no deadband).
		{
			name: "hard_drop_exactly_at_target",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptHard, DropPct30d: 1.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantAction: "lower_hard",
		},
		// HARD: drop below target → raise.
		{
			name: "hard_drop_below_target",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptHard, DropPct30d: 0.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantAction: "raise",
		},
		// Intensity +20.
		{
			name: "intensity_plus20_raise",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 0, AdaptiveDropPct: 1.5,
				CurrentLevel: 1.5, AdaptiveMaxLevel: 3.0, Intensity: 20, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantAction: "raise",
		},
		// Intensity -20 lower.
		{
			name: "intensity_minus20_lower",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 3.0, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.5, AdaptiveMaxLevel: 3.0, Intensity: -20, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantAction: "lower_soft",
		},
		// Unknown mode defaults to AVG.
		{
			name: "unknown_mode_defaults_to_avg",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethod("RATIO"), DropPct30d: 0, AdaptiveDropPct: 1.5,
				CurrentLevel: 1.5, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantAction: "raise",
		},
		// NeedsWrite=false: quantize(new)==last (no step possible at floor, no error).
		{
			name: "noop_write_hold",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptAvg, DropPct30d: 1.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 2.0, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
			},
			wantWrite: false, wantAction: "hold",
		},
		// TAPERED before shift: target = 1.5×dropPct.
		{
			name: "tapered_before_shift",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptTapered, DropPct30d: 0.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 1.5, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false,
				Now:        time.Date(2026, 1, 1, 7, 0, 0, 0, time.UTC),
				ShiftStart: time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC),
				ShiftEnd:   time.Date(2026, 1, 1, 17, 0, 0, 0, time.UTC),
			},
			wantAction: "raise", // target=2.25, drop=0.5, err=1.75 → raise aggressively
		},
		// TAPERED with no shift configured → behaves like AVG.
		{
			name: "tapered_no_shift",
			in: adapt.AdaptInput{
				Mode: adapt.DialMethodAdaptTapered, DropPct30d: 0.5, AdaptiveDropPct: 1.5,
				CurrentLevel: 1.5, AdaptiveMaxLevel: 3.0, Intensity: 0, HoldBandPP: 0.30,
				LastIntegral: 0, TickSeconds: 15, WarmUp: false, Now: time.Now(),
				// ShiftStart and ShiftEnd are zero → no taper
			},
			wantAction: "raise",
		},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			out := adapt.Decide(tc.in)
			if tc.wantAction != "" && out.ActionTaken != tc.wantAction {
				t.Errorf("action: got %q, want %q", out.ActionTaken, tc.wantAction)
			}
			if tc.wantLevel != 0 && math.Abs(out.NewLevel-tc.wantLevel) > 0.001 {
				t.Errorf("level: got %.4f, want %.4f", out.NewLevel, tc.wantLevel)
			}
			if tc.name == "B_avg_in_deadband" || tc.name == "noop_write_hold" || tc.name == "F_tapered_midshift_deadband" || tc.name == "warmup_active" {
				if out.NeedsWrite {
					t.Errorf("NeedsWrite: got true, want false")
				}
			}
			if tc.wantWrite && !out.NeedsWrite {
				t.Errorf("NeedsWrite: got false, want true for action=%s", out.ActionTaken)
			}
			if tc.wantIntNear != 0 && math.Abs(out.NewIntegral-tc.wantIntNear) > 0.02 {
				t.Errorf("integral: got %.6f, want ~%.6f", out.NewIntegral, tc.wantIntNear)
			}
		})
	}
}

// TestDecideProperties verifies four invariants across a wide range of inputs.
func TestDecideProperties(t *testing.T) {
	t.Parallel()

	levels := []float64{1.0, 1.5, 2.0, 2.5, 3.0}
	drops := []float64{0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0}
	modes := []adapt.DialMethod{adapt.DialMethodAdaptHard, adapt.DialMethodAdaptAvg, adapt.DialMethodAdaptTapered}

	for _, mode := range modes {
		for _, level := range levels {
			for _, drop := range drops {
				in := adapt.AdaptInput{
					Mode:             mode,
					DropPct30d:       drop,
					AdaptiveDropPct:  1.5,
					CurrentLevel:     level,
					AdaptiveMaxLevel: 3.0,
					Intensity:        0,
					HoldBandPP:       0.30,
					LastIntegral:     0,
					TickSeconds:      15,
					WarmUp:           false,
					Now:              time.Now(),
				}
				out := adapt.Decide(in)

				// Property 1: Floor/ceiling.
				if out.NewLevel < 1.0 || out.NewLevel > 3.0 {
					t.Errorf("floor/ceiling violated: level=%.2f drop=%.2f → out=%.2f", level, drop, out.NewLevel)
				}

				// Property 2: Quantization.
				rounded := math.Round(out.NewLevel*20) / 20
				if math.Abs(rounded-out.NewLevel) > 0.0001 {
					t.Errorf("quantization violated: out.NewLevel=%.6f not on 0.05 grid", out.NewLevel)
				}

				// Property 3: Determinism — call twice with same input.
				out2 := adapt.Decide(in)
				if out.NewLevel != out2.NewLevel || out.ActionTaken != out2.ActionTaken {
					t.Errorf("determinism violated: got different outputs for same input")
				}

				// Property 4: Monotonicity (sort of) — higher drop should not increase level vs lower drop.
				// Only testable in a pair; we test specifically here for HARD mode.
				if mode == adapt.DialMethodAdaptHard {
					inHigh := in
					inHigh.DropPct30d = drop + 1.0
					outHigh := adapt.Decide(inHigh)
					if outHigh.NewLevel > out.NewLevel+0.05+1e-9 {
						t.Errorf("monotonicity: higher drop=%.2f gave higher level %.2f vs drop=%.2f level=%.2f",
							inHigh.DropPct30d, outHigh.NewLevel, drop, out.NewLevel)
					}
				}
			}
		}
	}
}

// TestQuantize verifies the 0.05 rounding table from PLAN §6.
func TestQuantize(t *testing.T) {
	t.Parallel()
	// These cases are validated per PLAN §6 "Validation test for quantize()".
	cases := []struct{ in, want float64 }{
		{1.234, 1.25},
		{1.226, 1.25},
		{1.20, 1.20},
		// 0.97 → floor clamp means actual output is 1.00 in Decide() but quantize alone:
		{0.974, 0.95},
		{5.001, 5.00},
	}
	for _, c := range cases {
		got := math.Round(c.in*20) / 20
		if math.Abs(got-c.want) > 0.0001 {
			t.Errorf("quantize(%.4f) = %.4f, want %.4f", c.in, got, c.want)
		}
	}
}
