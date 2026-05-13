package tcpa

import "time"

// Outcome is the discriminated result of a TCPA window check.
type Outcome string

const (
	// OutcomeAllow means the call may proceed.
	OutcomeAllow Outcome = "ALLOW"
	// OutcomeSkipUntil means the call should be deferred until NextOpen.
	OutcomeSkipUntil Outcome = "SKIP_UNTIL"
	// OutcomeBlockInvalid means the call must not be placed (bad data, e.g. no TZ).
	OutcomeBlockInvalid Outcome = "BLOCK_INVALID"
)

// EnforcementPoint identifies which component is calling Check.
type EnforcementPoint string

const (
	PointHopper    EnforcementPoint = "hopper_filler"
	PointOriginate EnforcementPoint = "originate_path"
	PointPacing    EnforcementPoint = "pacing"
	PointManual    EnforcementPoint = "manual_dial"
)

// Confidence mirrors D03's confidence levels for TZ resolution.
type Confidence string

const (
	ConfKnown           Confidence = "KNOWN"
	ConfZIP             Confidence = "ZIP"
	ConfNXX             Confidence = "NXX"
	ConfNPA             Confidence = "NPA"
	ConfStateDefault    Confidence = "STATE_DEFAULT"
	ConfCampaignDefault Confidence = "CAMPAIGN_DEFAULT"
	ConfNone            Confidence = "NONE"
)

// UnknownTzPolicy controls what to do when D03 cannot resolve a timezone.
type UnknownTzPolicy string

const (
	// PolicyDeny blocks the call (default; conservative; recommended).
	PolicyDeny UnknownTzPolicy = "deny"
	// PolicyWarnPass allows the call but emits an ALLOW_WARN audit row.
	PolicyWarnPass UnknownTzPolicy = "warn_pass"
)

// Window defines a callable time range within a single day (local time).
type Window struct {
	// OpenLocal is minutes-since-local-midnight when calling opens (inclusive).
	OpenLocal time.Duration
	// CloseLocal is minutes-since-local-midnight when calling closes (exclusive).
	CloseLocal time.Duration
	// DowMask is a bitmask: bit 0=Sun, bit 1=Mon … bit 6=Sat.
	// 0 means all days.
	DowMask uint8
}

// IsZero returns true if the window is the zero value (unset).
func (w Window) IsZero() bool {
	return w.OpenLocal == 0 && w.CloseLocal == 0 && w.DowMask == 0
}

// IsBlackout returns true if the window has no callable span (open >= close
// and not the zero value). Used for per-dow blackout entries.
func (w Window) IsBlackout() bool {
	return w.OpenLocal >= w.CloseLocal && !w.IsZero()
}

// HolidayMatcher describes a single holiday rule entry.
type HolidayMatcher struct {
	// Kind is one of "fixed", "easter_offset", "named".
	Kind string
	// Value holds: an ISO date "2026-12-25", an integer offset from Easter
	// "-2" (Good Friday), or a named constant "MARDI_GRAS".
	Value string
}

// StateRule holds the per-state restriction matrix.
type StateRule struct {
	// Code is the 2-letter US state code.
	Code string
	// PerDow holds the calling window for each day of the week.
	// Index 0=Sun, 1=Mon … 6=Sat.
	// A zero-value Window means "use federal floor".
	// A blackout Window (Open >= Close, non-zero) means "no calls this day".
	PerDow [7]Window
	// HolidayBlackout lists dates on which calls are barred in this state.
	HolidayBlackout []HolidayMatcher
	// AutoDialerOnly, if non-nil, is a *narrower* window applied when
	// CheckRequest.IsAutoDialer == true (used for Maine §10 M.R.S. 1498).
	// Only applied on days NOT in AutoDialerBlackoutDows.
	AutoDialerOnly *Window
	// AutoDialerBlackoutDows is a bitmask (bit 0=Sun … bit 6=Sat) of days
	// where autodialers are fully barred regardless of AutoDialerOnly.
	// Used for Maine (Sat/Sun autodialer blackout).
	AutoDialerBlackoutDows uint8
	// Comment is a citation snippet for audit / git blame purposes.
	Comment string
}

// CheckRequest is the input to Check.
type CheckRequest struct {
	LeadID           int64
	PhoneE164        string          // canonical +1NXXXXXXXXX
	KnownTimezone    string          // optional; from leads.known_timezone (IANA)
	Zip              string          // optional; from leads.postal_code
	State            string          // optional; 2-char US state code
	CampaignID       int64
	CampaignWindow   *Window         // narrower override; nil = no campaign restriction
	UnknownTzPolicy  UnknownTzPolicy // default "deny" if zero
	EnforcementPoint EnforcementPoint
	When             time.Time       // injectable for tests; callers should set time.Now()
	IsAutoDialer     bool            // from campaigns.dial_method
}

// CheckResult is the output of Check.
type CheckResult struct {
	Outcome     Outcome
	TzIANA      string     // resolved IANA zone; empty on BLOCK_INVALID(no_timezone)
	Confidence  Confidence // D03 resolution confidence
	NextOpen    *time.Time // populated iff Outcome == SKIP_UNTIL
	Reason      string     // controlled vocabulary (see reasons.go)
	RuleApplied string     // e.g. "fed_8_21" | "RI_Sat_10_17" | "LA_Sun_blackout"
	PartyLocal  time.Time  // req.When expressed in called-party local time
	Effective   Window     // the intersected window that was applied
}
