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

func TestResolveTarget(t *testing.T) {
	t.Parallel()
	dropPct := 1.5
	shiftStart := time.Date(2026, 1, 1, 8, 0, 0, 0, time.UTC)
	shiftEnd := time.Date(2026, 1, 1, 17, 0, 0, 0, time.UTC)

	tests := []struct {
		name  string
		mode  adapt.DialMethod
		now   time.Time
		want  float64
	}{
		{"HARD returns dropPct", adapt.DialMethodAdaptHard, time.Now(), dropPct},
		{"AVG returns dropPct", adapt.DialMethodAdaptAvg, time.Now(), dropPct},
		{"TAPERED no shift returns dropPct", adapt.DialMethodAdaptTapered, time.Now(), dropPct},
		{"TAPERED before shift: 1.5×", adapt.DialMethodAdaptTapered,
			time.Date(2026, 1, 1, 7, 0, 0, 0, time.UTC), dropPct * 1.5},
		{"TAPERED at shift-start: 1.5×", adapt.DialMethodAdaptTapered,
			shiftStart, dropPct * 1.5},
		{"TAPERED mid-shift progress=0.25: 1.375×", adapt.DialMethodAdaptTapered,
			time.Date(2026, 1, 1, 10, 15, 0, 0, time.UTC), dropPct * (1.5 - 0.5*0.25)},
		{"TAPERED mid-shift progress=0.5: 1.25×", adapt.DialMethodAdaptTapered,
			time.Date(2026, 1, 1, 12, 30, 0, 0, time.UTC), dropPct * 1.25},
		{"TAPERED at shift-end: 1.0×", adapt.DialMethodAdaptTapered,
			shiftEnd, dropPct * 1.0},
		{"TAPERED after shift: 1.0×", adapt.DialMethodAdaptTapered,
			time.Date(2026, 1, 1, 18, 0, 0, 0, time.UTC), dropPct},
	}

	for _, tc := range tests {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			var ss, se time.Time
			if tc.mode == adapt.DialMethodAdaptTapered && tc.now != time.Now() {
				// Use shift times unless it's the no-shift test.
				ss = shiftStart
				se = shiftEnd
			}
			// no-shift test: leave zero.
			if tc.name == "TAPERED no shift returns dropPct" {
				ss = time.Time{}
				se = time.Time{}
			}
			got := adapt.ResolveTarget(tc.mode, dropPct, ss, se, tc.now)
			if math.Abs(got-tc.want) > 0.0001 {
				t.Errorf("got %.6f, want %.6f", got, tc.want)
			}
		})
	}
}
