package tcpa

import (
	"fmt"
	"math"
	"strconv"
	"strings"
	"sync"
	"time"
)

// HolidayCalendar expands holiday matchers into concrete (state, date) tuples
// for a rolling 5-year window. It is populated at process start and refreshed
// annually (or on SIGHUP from main.go).
type HolidayCalendar struct {
	mu    sync.RWMutex
	fixed map[string]map[string]struct{} // state → set of "YYYY-MM-DD"
	built time.Time
}

// newHolidayCalendar builds a calendar from the embedded stateRules.
func newHolidayCalendar(rules map[string]StateRule) *HolidayCalendar {
	hc := &HolidayCalendar{}
	hc.build(rules)
	return hc
}

// IsHoliday returns true if dateISO ("YYYY-MM-DD", expressed in the state's
// local time) is a holiday in the given state.
func (hc *HolidayCalendar) IsHoliday(state, dateISO string) bool {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	if hc.fixed == nil {
		return false
	}
	dates, ok := hc.fixed[state]
	if !ok {
		return false
	}
	_, exists := dates[dateISO]
	return exists
}

// Refresh rebuilds the 5-year window. Called on SIGHUP and at process start.
func (hc *HolidayCalendar) Refresh(rules map[string]StateRule) {
	hc.mu.Lock()
	defer hc.mu.Unlock()
	hc.build(rules)
}

// AgeSeconds returns how long ago the calendar was last built.
func (hc *HolidayCalendar) AgeSeconds() float64 {
	hc.mu.RLock()
	defer hc.mu.RUnlock()
	return time.Since(hc.built).Seconds()
}

func (hc *HolidayCalendar) build(rules map[string]StateRule) {
	fixed := make(map[string]map[string]struct{})
	now := time.Now()
	baseYear := now.Year()

	for _, rule := range rules {
		for _, hm := range rule.HolidayBlackout {
			dates := expandMatcher(hm, baseYear, 5)
			if _, ok := fixed[rule.Code]; !ok {
				fixed[rule.Code] = make(map[string]struct{})
			}
			for _, d := range dates {
				fixed[rule.Code][d] = struct{}{}
			}
		}
	}
	hc.fixed = fixed
	hc.built = now
}

// expandMatcher returns a list of "YYYY-MM-DD" strings for the matcher over
// the next `years` years starting from baseYear.
func expandMatcher(hm HolidayMatcher, baseYear, years int) []string {
	var out []string
	for y := baseYear; y < baseYear+years; y++ {
		switch hm.Kind {
		case "fixed":
			// Value is "YYYY-MM-DD"; replace the year portion.
			parts := strings.SplitN(hm.Value, "-", 2)
			if len(parts) == 2 {
				out = append(out, fmt.Sprintf("%04d-%s", y, parts[1]))
			}
		case "easter_offset":
			offset, err := strconv.Atoi(hm.Value)
			if err != nil {
				continue
			}
			easter := computeEaster(y)
			d := easter.AddDate(0, 0, offset)
			out = append(out, d.Format("2006-01-02"))
		case "named":
			switch hm.Value {
			case "MARDI_GRAS":
				// Mardi Gras = Easter - 47 days.
				easter := computeEaster(y)
				d := easter.AddDate(0, 0, -47)
				out = append(out, d.Format("2006-01-02"))
			}
		}
	}
	return out
}

// computeEaster computes the date of Easter Sunday for the given year using
// the Anonymous Gregorian algorithm.
func computeEaster(year int) time.Time {
	a := year % 19
	b := year / 100
	c := year % 100
	d := b / 4
	e := b % 4
	f := (b + 8) / 25
	g := (b - f + 1) / 3
	h := (19*a + b - d - g + 15) % 30
	i := c / 4
	k := c % 4
	l := (32 + 2*e + 2*i - h - k) % 7
	m := (a + 11*h + 22*l) / 451
	month := (h + l - 7*m + 114) / 31
	day := ((h + l - 7*m + 114) % 31) + 1
	_ = math.E // prevent unused-import if math is used elsewhere
	return time.Date(year, time.Month(month), day, 0, 0, 0, 0, time.UTC)
}
