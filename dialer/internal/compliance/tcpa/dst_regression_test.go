package tcpa_test

import (
	"context"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/compliance/tcpa"
)

// US DST transitions for 2026-2030 (spring-forward = second Sunday in March,
// fall-back = first Sunday in November).
var dstTransitions = []struct {
	desc     string
	tz       string
	when     time.Time // the exact transition moment in UTC
	isFwd    bool      // spring-forward
}{
	// Spring-forward (clocks go 2am→3am; 02:xx hour is non-existent)
	{"ET spring 2026", "America/New_York", time.Date(2026, 3, 8, 7, 0, 0, 0, time.UTC), true},
	{"ET spring 2027", "America/New_York", time.Date(2027, 3, 14, 7, 0, 0, 0, time.UTC), true},
	{"ET spring 2028", "America/New_York", time.Date(2028, 3, 12, 7, 0, 0, 0, time.UTC), true},
	{"CT spring 2026", "America/Chicago", time.Date(2026, 3, 8, 8, 0, 0, 0, time.UTC), true},
	{"PT spring 2026", "America/Los_Angeles", time.Date(2026, 3, 8, 10, 0, 0, 0, time.UTC), true},
	// Fall-back (clocks go 2am→1am; 01:xx hour is ambiguous)
	{"ET fall 2026", "America/New_York", time.Date(2026, 11, 1, 6, 0, 0, 0, time.UTC), false},
	{"ET fall 2027", "America/New_York", time.Date(2027, 11, 7, 6, 0, 0, 0, time.UTC), false},
	{"CT fall 2026", "America/Chicago", time.Date(2026, 11, 1, 7, 0, 0, 0, time.UTC), false},
	{"PT fall 2026", "America/Los_Angeles", time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC), false},
}

// TestDSTRegressions asserts that Check returns a defined (non-error) result
// for 4 probes around each DST transition.
func TestDSTRegressions(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	for _, tr := range dstTransitions {
		tr := tr
		t.Run(tr.desc, func(t *testing.T) {
			offsets := []time.Duration{
				-1 * time.Minute,
				0,
				1 * time.Minute,
				60 * time.Minute,
			}
			for _, off := range offsets {
				when := tr.when.Add(off)
				req := tcpa.CheckRequest{
					KnownTimezone:    tr.tz,
					EnforcementPoint: tcpa.PointHopper,
					When:             when,
				}
				res, err := c.Check(ctx, req)
				if err != nil {
					t.Errorf("DST %s +%v: unexpected error: %v", tr.desc, off, err)
					continue
				}
				// Just assert we got a defined outcome (no zero-value).
				if res.Outcome == "" {
					t.Errorf("DST %s +%v: got empty outcome", tr.desc, off)
				}
				if _, ok := tcpa.AllReasons[res.Reason]; !ok {
					t.Errorf("DST %s +%v: reason %q not in vocabulary", tr.desc, off, res.Reason)
				}
			}
		})
	}
}
