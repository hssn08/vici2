package tcpa

// Reason constants form a stable controlled vocabulary.
// A linter test (reasons_test.go) asserts that no string outside this set
// is ever returned from Check or WindowClosesWithin.
//
// Adding a new reason requires updating this file AND the test.
const (
	// ReasonNoTimezone: D03 returned NONE and policy=deny.
	ReasonNoTimezone = "no_timezone"
	// ReasonUnknownTzWarnPass: D03 returned NONE but policy=warn_pass; ALLOW emitted.
	ReasonUnknownTzWarnPass = "unknown_tz_warn_pass"
	// ReasonStateSundayBlackout: state Sunday-blackout rule.
	ReasonStateSundayBlackout = "state_sunday_blackout"
	// ReasonStateDowBlackout: state day-of-week blackout rule (non-Sunday).
	ReasonStateDowBlackout = "state_dow_blackout"
	// ReasonStateHolidayBlackout: state holiday blackout.
	ReasonStateHolidayBlackout = "state_holiday_blackout"
	// ReasonBeforeWindow: local time < effective open.
	ReasonBeforeWindow = "before_window"
	// ReasonAfterWindow: local time >= effective close.
	ReasonAfterWindow = "after_window"
	// ReasonStateAutoDialerWindow: ME autodialer outside 09:00–17:00 M-F.
	ReasonStateAutoDialerWindow = "state_autodialer_window"
	// ReasonBoundary30sToClose: within 30s of close at originate point.
	ReasonBoundary30sToClose = "boundary_30s_to_close"
	// ReasonOK: call allowed.
	ReasonOK = "ok"
)

// AllReasons is the exhaustive set of reason strings.
// reasons_test.go asserts this set == all strings returned by Check.
var AllReasons = map[string]struct{}{
	ReasonNoTimezone:            {},
	ReasonUnknownTzWarnPass:     {},
	ReasonStateSundayBlackout:   {},
	ReasonStateDowBlackout:      {},
	ReasonStateHolidayBlackout:  {},
	ReasonBeforeWindow:          {},
	ReasonAfterWindow:           {},
	ReasonStateAutoDialerWindow: {},
	ReasonBoundary30sToClose:    {},
	ReasonOK:                    {},
}
