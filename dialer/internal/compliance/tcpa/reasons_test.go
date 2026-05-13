package tcpa_test

import (
	"context"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/compliance/tcpa"
)

// TestReasonVocabularyExhaustive runs a battery of scenarios and asserts that
// every returned reason string appears in AllReasons (the controlled vocabulary).
// This test would catch a typo or new code path that forgot to register a reason.
func TestReasonVocabularyExhaustive(t *testing.T) {
	c, _ := tcpa.New(tcpa.CheckerOpts{
		Resolver:   tcpa.StubResolver{},
		Audit:      tcpa.NoopSinkForTest(),
		SampleRate: 0,
	})
	ctx := context.Background()

	probes := []struct {
		desc string
		req  tcpa.CheckRequest
	}{
		{
			"ok",
			tcpa.CheckRequest{KnownTimezone: "America/New_York", EnforcementPoint: tcpa.PointHopper, When: time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC)},
		},
		{
			"before_window",
			tcpa.CheckRequest{KnownTimezone: "America/New_York", EnforcementPoint: tcpa.PointHopper, When: time.Date(2026, 5, 13, 11, 0, 0, 0, time.UTC)},
		},
		{
			"after_window",
			tcpa.CheckRequest{KnownTimezone: "America/New_York", EnforcementPoint: tcpa.PointHopper, When: time.Date(2026, 5, 14, 2, 0, 0, 0, time.UTC)},
		},
		{
			"state_sunday_blackout",
			tcpa.CheckRequest{KnownTimezone: "America/New_York", State: "RI", EnforcementPoint: tcpa.PointHopper, When: time.Date(2026, 5, 17, 15, 0, 0, 0, time.UTC)},
		},
		{
			"no_timezone",
			tcpa.CheckRequest{EnforcementPoint: tcpa.PointHopper, UnknownTzPolicy: tcpa.PolicyDeny, When: time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC)},
		},
		{
			"unknown_tz_warn_pass",
			tcpa.CheckRequest{EnforcementPoint: tcpa.PointHopper, UnknownTzPolicy: tcpa.PolicyWarnPass, When: time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC)},
		},
		{
			"boundary_30s_to_close",
			tcpa.CheckRequest{KnownTimezone: "America/New_York", EnforcementPoint: tcpa.PointOriginate, When: time.Date(2026, 5, 14, 0, 59, 35, 0, time.UTC)},
		},
		{
			"state_autodialer_window — ME Sat autodialer",
			tcpa.CheckRequest{KnownTimezone: "America/New_York", State: "ME", EnforcementPoint: tcpa.PointHopper, IsAutoDialer: true, When: time.Date(2026, 5, 16, 15, 0, 0, 0, time.UTC)},
		},
	}

	for _, p := range probes {
		res, err := c.Check(ctx, p.req)
		if err != nil {
			t.Errorf("%s: unexpected error: %v", p.desc, err)
			continue
		}
		if _, ok := tcpa.AllReasons[res.Reason]; !ok {
			t.Errorf("%s: reason %q not in AllReasons controlled vocabulary", p.desc, res.Reason)
		}
	}
}
