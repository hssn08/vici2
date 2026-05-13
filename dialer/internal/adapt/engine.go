// Package adapt implements the E03 adaptive dial-level controller.
//
// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.
//
// US8681955B1 patent-defense: no speech analytics, no setpoint adjustment,
// no ML imports. See scripts/ci/check-adapt-patent-boundaries.sh.
package adapt

import (
	"time"
)

// DialMethod mirrors the campaigns.dial_method ENUM.
type DialMethod string

const (
	DialMethodAdaptHard    DialMethod = "ADAPT_HARD"
	DialMethodAdaptAvg     DialMethod = "ADAPT_AVG"
	DialMethodAdaptTapered DialMethod = "ADAPT_TAPERED"
)

// Controller constants (FROZEN per E03 PLAN §2.2).
const (
	Kp               = 0.05  // proportional gain: 1 step per 1pp error
	Ki               = 0.005 // integral gain
	IMax             = 0.5   // integral anti-windup clamp
	KBack            = 0.01  // back-calculation anti-windup coefficient (2×Ki per MathWorks)
	IntegralBleed    = 0.95  // per-tick bleed factor while in deadband
	StepUpBase       = 0.05  // base raise step (Vicidial parity)
	StepDownSoftBase = 0.05  // base soft lower step
	StepDownHardBase = 0.20  // base hard lower step (Vicidial parity)
	QuantizeStep     = 0.05  // output grid (1/20)
	LevelFloor       = 1.0   // absolute minimum dial_level
)

// AdaptInput is the pure-function input for Decide(). No I/O, no clock reads.
// All fields are passed in by the caller.
type AdaptInput struct {
	Mode             DialMethod
	DropPct30d       float64    // from E05; 0..100
	AdaptiveDropPct  float64    // campaigns.adaptive_drop_pct
	CurrentLevel     float64    // last published dial_level (from pace_state.last_level)
	AdaptiveMaxLevel float64    // campaigns.adaptive_max_level; validated ≥ 1.0
	Intensity        int        // campaigns.adaptive_intensity; -20..+20
	HoldBandPP       float64    // campaigns.hold_band_pp; default 0.30
	LastIntegral     float64    // from pace_state HASH
	LastTickTs       time.Time
	Now              time.Time
	TickSeconds      float64    // campaigns.adapt_tick_seconds; default 15
	WarmUp           bool       // true = warm-up gate active; controller inhibited
	ShiftStart       time.Time  // campaigns.shift_start_local resolved to today UTC; zero = unset
	ShiftEnd         time.Time  // campaigns.shift_end_local resolved to today UTC; zero = unset
}

// AdaptOutput is the pure-function result from Decide().
type AdaptOutput struct {
	NewLevel    float64 // clamped [1.0, AdaptiveMaxLevel]; quantized to 0.05
	NewIntegral float64 // back-calculated and clamped to [-IMax, +IMax]
	ActionTaken string  // "raise"|"lower_soft"|"lower_hard"|"hold"|"warm_up"|"fast_cut"
	Reason      string  // human-readable for audit stream
	NeedsWrite  bool    // false when NewLevel == CurrentLevel (skip Valkey write)
}

// Decide is a pure function — no I/O, no clock reads. All inputs are passed in.
// This is the only entry point for the controller math.
//
// Mode dispatch (PLAN §3.3):
//   - WarmUp=true → hold at CurrentLevel, no write
//   - ADAPT_HARD → pure-P HardLimit()
//   - ADAPT_AVG / ADAPT_TAPERED → clamped PI AverageWithDeadband()
//   - unknown mode → default to AverageWithDeadband() + WARN
func Decide(in AdaptInput) AdaptOutput {
	// Clamp max level to valid range.
	ceil := in.AdaptiveMaxLevel
	if ceil < LevelFloor {
		ceil = LevelFloor
	}
	// Clamp current level.
	current := clamp(in.CurrentLevel, LevelFloor, ceil)

	if in.WarmUp {
		return AdaptOutput{
			NewLevel:    current,
			NewIntegral: in.LastIntegral,
			ActionTaken: "warm_up",
			Reason:      "warm-up gate active; controller inhibited",
			NeedsWrite:  false,
		}
	}

	target := ResolveTarget(in.Mode, in.AdaptiveDropPct, in.ShiftStart, in.ShiftEnd, in.Now)

	switch in.Mode {
	case DialMethodAdaptHard:
		return HardLimit(in, target, ceil, current)
	case DialMethodAdaptAvg, DialMethodAdaptTapered:
		return AverageWithDeadband(in, target, ceil, current)
	default:
		// Wrong mode in DB → default to ADAPT_AVG with WARN (failure mode #6).
		out := AverageWithDeadband(in, target, ceil, current)
		out.Reason = "unknown mode '" + string(in.Mode) + "'; defaulted to ADAPT_AVG. " + out.Reason
		return out
	}
}

// intensityFactors returns (raiseF, lowerF) for the intensity modifier (PLAN §2.3).
// intensity ∈ [-20, +20]; factor = 1 ± intensity/100.
func intensityFactors(intensity int) (raiseF, lowerF float64) {
	f := float64(intensity) / 100.0
	raiseF = 1.0 + f
	lowerF = 1.0 - f
	if raiseF < 0 {
		raiseF = 0
	}
	if lowerF < 0 {
		lowerF = 0
	}
	return
}

// quantize snaps x to the nearest 0.05 grid.
func quantize(x float64) float64 {
	return roundHalf(x*20) / 20
}

// roundHalf implements standard round-half-up (not banker's rounding).
func roundHalf(x float64) float64 {
	if x < 0 {
		return -roundHalf(-x)
	}
	floor := float64(int(x))
	if x-floor >= 0.5 {
		return floor + 1
	}
	return floor
}

// clamp returns x clamped to [lo, hi].
func clamp(x, lo, hi float64) float64 {
	if x < lo {
		return lo
	}
	if x > hi {
		return hi
	}
	return x
}

// clampIntegral clamps the integral to [-IMax, +IMax].
func clampIntegral(i float64) float64 {
	return clamp(i, -IMax, IMax)
}
