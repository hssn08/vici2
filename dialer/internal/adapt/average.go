// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import (
	"fmt"
	"math"
)

// AverageWithDeadband implements the ADAPT_AVG and ADAPT_TAPERED clamped PI
// controller with deadband and back-calculation anti-windup (PLAN §2.4).
//
// Algorithm:
//  1. Compute error e = target - drop30d.
//  2. If |e| <= hold_band_pp: hold (bleed integral × 0.95).
//  3. P + I terms with intensity modifier.
//  4. Clamp output to [floor, ceil]; back-calculate anti-windup.
//  5. Quantize to 0.05 grid.
func AverageWithDeadband(in AdaptInput, target, ceil, current float64) AdaptOutput {
	raiseF, lowerF := intensityFactors(in.Intensity)
	tickSec := in.TickSeconds
	if tickSec <= 0 {
		tickSec = 15
	}
	holdBand := in.HoldBandPP
	if holdBand <= 0 {
		holdBand = 0.30
	}

	err := target - in.DropPct30d

	// 1. Deadband: hold and bleed integral.
	if math.Abs(err) <= holdBand {
		newIntegral := clampIntegral(in.LastIntegral * IntegralBleed)
		return AdaptOutput{
			NewLevel:    current,
			NewIntegral: newIntegral,
			ActionTaken: "hold",
			Reason: fmt.Sprintf("AVG/TAPERED: |err|=%.3f <= hold_band=%.2f; holding at %.2f (integral bled to %.4f)",
				math.Abs(err), holdBand, current, newIntegral),
			NeedsWrite: false,
		}
	}

	// 2. P term with intensity modifier.
	pTerm := Kp * err
	if err > 0 {
		pTerm = Kp * err * raiseF
	} else {
		pTerm = Kp * err * lowerF
	}

	// 3. Integral accumulation.
	iTerm := in.LastIntegral + Ki*err*tickSec

	// 4. Unclamped output.
	unclamped := current + pTerm + iTerm

	// 5. Clamp + back-calculate anti-windup.
	newLevel := clamp(unclamped, LevelFloor, ceil)
	clampedDelta := newLevel - unclamped // 0 when not clamped
	newIntegral := clampIntegral(iTerm + KBack*clampedDelta)

	// 6. Quantize to 0.05 grid.
	newLevel = quantize(newLevel)
	newLevel = clamp(newLevel, LevelFloor, ceil)

	// Determine action label.
	var action string
	switch {
	case newLevel > quantize(current):
		action = "raise"
	case newLevel < quantize(current):
		action = "lower_soft"
	default:
		action = "hold" // quantization collapsed the step
	}

	reason := fmt.Sprintf("AVG/TAPERED: target=%.2f drop=%.2f err=%.3f p=%.4f i=%.4f unclamped=%.4f new=%.2f",
		target, in.DropPct30d, err, pTerm, iTerm, unclamped, newLevel)

	return AdaptOutput{
		NewLevel:    newLevel,
		NewIntegral: newIntegral,
		ActionTaken: action,
		Reason:      reason,
		NeedsWrite:  newLevel != quantize(current),
	}
}
