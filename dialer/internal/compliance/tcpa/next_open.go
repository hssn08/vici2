package tcpa

import "time"

// nextDayOpen computes the next callable open time after partyLocal, scanning
// forward day by day until a non-blackout, non-holiday dow is found.
// It returns the moment local midnight + eff.OpenLocal on the first valid day.
func nextDayOpen(partyLocal time.Time, rule *StateRule, eff Window, hc *HolidayCalendar) time.Time {
	loc := partyLocal.Location()
	// Start from the next calendar day.
	candidate := midnightLocal(partyLocal).AddDate(0, 0, 1)
	for i := 0; i < 14; i++ { // max 2 weeks scan
		dow := int(candidate.Weekday())
		dateStr := candidate.Format("2006-01-02")

		// Skip holiday blackouts.
		if rule != nil && hc.IsHoliday(rule.Code, dateStr) {
			candidate = candidate.AddDate(0, 0, 1)
			continue
		}
		// Skip dow blackouts.
		if rule != nil {
			w := rule.PerDow[dow]
			if w.IsBlackout() {
				candidate = candidate.AddDate(0, 0, 1)
				continue
			}
		}
		// Found a valid day; return open time.
		open := eff.OpenLocal
		if rule != nil {
			w := rule.PerDow[dow]
			if !w.IsZero() && !w.IsBlackout() {
				// Apply state rule for this dow.
				combined := intersect(fedFloor, w)
				if combined.OpenLocal > open {
					open = combined.OpenLocal
				}
			}
		}
		return time.Date(candidate.Year(), candidate.Month(), candidate.Day(), 0, 0, 0, 0, loc).Add(open)
	}
	// Fallback: 7 days from now at federal open (should never reach here).
	return midnightLocal(partyLocal).AddDate(0, 0, 7).Add(fedFloor.OpenLocal)
}

// nextDowOpen finds the next open time that is not blocked by a dow or holiday
// blackout starting from partyLocal (inclusive if the current day resolves).
func nextDowOpen(partyLocal time.Time, rule *StateRule, hc *HolidayCalendar) time.Time {
	loc := partyLocal.Location()
	candidate := midnightLocal(partyLocal).AddDate(0, 0, 1)
	for i := 0; i < 14; i++ {
		dow := int(candidate.Weekday())
		dateStr := candidate.Format("2006-01-02")
		if rule != nil && hc.IsHoliday(rule.Code, dateStr) {
			candidate = candidate.AddDate(0, 0, 1)
			continue
		}
		if rule != nil {
			w := rule.PerDow[dow]
			if w.IsBlackout() {
				candidate = candidate.AddDate(0, 0, 1)
				continue
			}
		}
		// Return the open time on this day.
		open := fedFloor.OpenLocal
		if rule != nil {
			w := rule.PerDow[dow]
			if !w.IsZero() && !w.IsBlackout() {
				combined := intersect(fedFloor, w)
				open = combined.OpenLocal
			}
		}
		return time.Date(candidate.Year(), candidate.Month(), candidate.Day(), 0, 0, 0, 0, loc).Add(open)
	}
	return midnightLocal(partyLocal).AddDate(0, 0, 7).Add(fedFloor.OpenLocal)
}

// nextBusinessDayOpen finds the next day with a callable window starting from
// the day AFTER partyLocal. Used after a holiday blackout.
func nextBusinessDayOpen(partyLocal time.Time, rule StateRule, hc *HolidayCalendar) time.Time {
	return nextDowOpen(partyLocal, &rule, hc)
}
