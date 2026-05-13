// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import "time"

// ResolveTarget returns the effective drop-pct setpoint for the current mode and time.
//
// PLAN §3.2 (FROZEN formula — corrects DESIGN.md §6.4 sign typo):
//   - HARD / AVG: return dropPct unchanged.
//   - TAPERED: taper from 1.5×dropPct at shift-start to 1.0×dropPct at shift-end.
//     Matches Vicidial PREDICTIVE.txt: "allows running OVER the dropped % in the first half".
//     DESIGN.md §6.4 has the opposite sign; this formula is the correction.
func ResolveTarget(mode DialMethod, dropPct float64, shiftStart, shiftEnd, now time.Time) float64 {
	if mode != DialMethodAdaptTapered {
		return dropPct // HARD + AVG use configured % as-is
	}
	if shiftStart.IsZero() || shiftEnd.IsZero() {
		return dropPct // no shift configured → no taper → behaves like AVG
	}
	if now.Before(shiftStart) {
		return dropPct * 1.5 // before shift: maximally lenient
	}
	if now.After(shiftEnd) {
		return dropPct // after shift: strict
	}
	progress := float64(now.Sub(shiftStart)) / float64(shiftEnd.Sub(shiftStart))
	// progress=0 → 1.5×dropPct (lenient early)
	// progress=1 → 1.0×dropPct (strict at end)
	return dropPct * (1.5 - 0.5*progress)
}
