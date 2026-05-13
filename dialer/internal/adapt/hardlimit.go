// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import "fmt"

// HardLimit implements the ADAPT_HARD pure-P controller (PLAN §2.5).
//
// No deadband in HARD — operators chose HARD because they want zero tolerance
// above the setpoint. No integral term: integral stays 0 throughout.
//
//	drop >= target → lower_hard (decrease by step_down_hard × intensity_factor_lower)
//	drop <  target → raise       (increase by step_up × intensity_factor_raise)
func HardLimit(in AdaptInput, target, ceil, current float64) AdaptOutput {
	raiseF, lowerF := intensityFactors(in.Intensity)

	var newLevel float64
	var action, reason string

	if in.DropPct30d >= target {
		// Over (or at) target: hard lower.
		step := StepDownHardBase * lowerF
		newLevel = current - step
		if newLevel < LevelFloor {
			newLevel = LevelFloor
		}
		action = "lower_hard"
		reason = fmt.Sprintf("HARD: drop=%.2f%% >= target=%.2f%%; hard-lower by %.3f (intensity=%d)",
			in.DropPct30d, target, step, in.Intensity)
	} else {
		// Under target: raise.
		step := StepUpBase * raiseF
		newLevel = current + step
		if newLevel > ceil {
			newLevel = ceil
		}
		action = "raise"
		reason = fmt.Sprintf("HARD: drop=%.2f%% < target=%.2f%%; raise by %.3f (intensity=%d)",
			in.DropPct30d, target, step, in.Intensity)
	}

	newLevel = quantize(newLevel)
	newLevel = clamp(newLevel, LevelFloor, ceil)

	return AdaptOutput{
		NewLevel:    newLevel,
		NewIntegral: 0, // HARD mode never accumulates integral (PLAN Q10)
		ActionTaken: action,
		Reason:      reason,
		NeedsWrite:  newLevel != quantize(current),
	}
}
