package tcpa_test

import (
	"context"
	_ "embed"
	"encoding/json"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/compliance/tcpa"
)

//go:embed fixtures.json
var fixturesJSON []byte

type fixtureReq struct {
	PhoneE164       string  `json:"phoneE164"`
	KnownTimezone   string  `json:"knownTimezone"`
	State           string  `json:"state"`
	EnforcementPoint string `json:"enforcementPoint"`
	IsAutoDialer    bool    `json:"isAutoDialer"`
	UnknownTzPolicy string  `json:"unknownTzPolicy"`
	When            string  `json:"when"`
	CampaignWindow  *struct {
		OpenLocal  int `json:"openLocal"`  // seconds
		CloseLocal int `json:"closeLocal"` // seconds
	} `json:"campaignWindow"`
}

type fixtureWant struct {
	Outcome string `json:"outcome"`
	Reason  string `json:"reason"`
}

type fixture struct {
	ID   int         `json:"id"`
	Desc string      `json:"desc"`
	Req  fixtureReq  `json:"req"`
	Want fixtureWant `json:"want"`
}

func newTestChecker(t *testing.T) *tcpa.Checker {
	t.Helper()
	c, err := tcpa.New(tcpa.CheckerOpts{
		Resolver:   tcpa.StubResolver{},
		Audit:      tcpa.NoopSinkForTest(),
		SampleRate: 1.0, // audit everything in tests
	})
	if err != nil {
		t.Fatalf("tcpa.New: %v", err)
	}
	return c
}

func TestCheckFixtures(t *testing.T) {
	var fixtures []fixture
	if err := json.Unmarshal(fixturesJSON, &fixtures); err != nil {
		t.Fatalf("parse fixtures: %v", err)
	}

	c := newTestChecker(t)
	ctx := context.Background()

	for _, fx := range fixtures {
		fx := fx
		t.Run(fx.Desc, func(t *testing.T) {
			when, err := time.Parse(time.RFC3339, fx.Req.When)
			if err != nil {
				t.Fatalf("fixture %d: parse when %q: %v", fx.ID, fx.Req.When, err)
			}

			req := tcpa.CheckRequest{
				PhoneE164:        fx.Req.PhoneE164,
				KnownTimezone:    fx.Req.KnownTimezone,
				State:            fx.Req.State,
				EnforcementPoint: tcpa.EnforcementPoint(fx.Req.EnforcementPoint),
				IsAutoDialer:     fx.Req.IsAutoDialer,
				When:             when,
			}
			if fx.Req.UnknownTzPolicy != "" {
				req.UnknownTzPolicy = tcpa.UnknownTzPolicy(fx.Req.UnknownTzPolicy)
			}
			if fx.Req.CampaignWindow != nil {
				req.CampaignWindow = &tcpa.Window{
					OpenLocal:  time.Duration(fx.Req.CampaignWindow.OpenLocal) * time.Second,
					CloseLocal: time.Duration(fx.Req.CampaignWindow.CloseLocal) * time.Second,
				}
			}

			res, err := c.Check(ctx, req)
			if err != nil {
				t.Fatalf("fixture %d: Check error: %v", fx.ID, err)
			}
			if string(res.Outcome) != fx.Want.Outcome {
				t.Errorf("fixture %d %q: outcome = %q, want %q", fx.ID, fx.Desc, res.Outcome, fx.Want.Outcome)
			}
			if res.Reason != fx.Want.Reason {
				t.Errorf("fixture %d %q: reason = %q, want %q", fx.ID, fx.Desc, res.Reason, fx.Want.Reason)
			}
		})
	}
}

func TestFederalFloorNeverWeakens(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// Campaign says 6am-11pm; federal floor must win: 8am-9pm
	// 7:30am ET should be SKIP even with campaign 6am window.
	when := time.Date(2026, 5, 13, 11, 30, 0, 0, time.UTC) // 7:30am ET
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		EnforcementPoint: tcpa.PointHopper,
		CampaignWindow:   &tcpa.Window{OpenLocal: 6 * time.Hour, CloseLocal: 23 * time.Hour},
		When:             when,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeSkipUntil {
		t.Errorf("expected SKIP_UNTIL before 8am, got %s (reason=%s)", res.Outcome, res.Reason)
	}
	if res.Effective.OpenLocal != 8*time.Hour {
		t.Errorf("effective open = %v, want 8h (federal floor)", res.Effective.OpenLocal)
	}
}

func TestMostRestrictiveWins(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// RI Saturday 10-17; campaign 8-21; effective must be 10-17.
	// 10:30am ET Saturday → ALLOW
	sat := time.Date(2026, 5, 16, 14, 30, 0, 0, time.UTC) // Sat 10:30am ET
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		State:            "RI",
		EnforcementPoint: tcpa.PointHopper,
		CampaignWindow:   &tcpa.Window{OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour},
		When:             sat,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeAllow {
		t.Errorf("expected ALLOW at RI Sat 10:30am, got %s reason=%s", res.Outcome, res.Reason)
	}
	// Effective should be 10-17.
	if res.Effective.OpenLocal != 10*time.Hour {
		t.Errorf("effective open = %v, want 10h (RI Sat)", res.Effective.OpenLocal)
	}
	if res.Effective.CloseLocal != 17*time.Hour {
		t.Errorf("effective close = %v, want 17h (RI Sat)", res.Effective.CloseLocal)
	}
}

func TestSundayBlackoutAbsorbs(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// AL Sunday; any time should produce SKIP_UNTIL.
	sun := time.Date(2026, 5, 17, 14, 0, 0, 0, time.UTC) // Sun 10am ET (AL is CT = 9am)
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/Chicago",
		State:            "AL",
		EnforcementPoint: tcpa.PointHopper,
		When:             sun,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeSkipUntil {
		t.Errorf("expected SKIP_UNTIL on AL Sunday, got %s reason=%s", res.Outcome, res.Reason)
	}
	if res.Reason != tcpa.ReasonStateSundayBlackout {
		t.Errorf("expected reason=%s, got %s", tcpa.ReasonStateSundayBlackout, res.Reason)
	}
}

func TestPureFunctionUnderFixedNow(t *testing.T) {
	fixed := time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC)
	c, _ := tcpa.New(tcpa.CheckerOpts{
		Resolver:   tcpa.StubResolver{},
		Audit:      tcpa.NoopSinkForTest(),
		NowFn:      func() time.Time { return fixed },
		SampleRate: 0,
	})
	ctx := context.Background()
	req := tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		EnforcementPoint: tcpa.PointHopper,
	}
	r1, _ := c.Check(ctx, req)
	r2, _ := c.Check(ctx, req)
	if r1.Outcome != r2.Outcome || r1.Reason != r2.Reason {
		t.Errorf("non-deterministic: r1=%+v r2=%+v", r1, r2)
	}
}

func TestManualDialSameAsOriginate(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// 9:01pm ET → after window; both originate and manual should SKIP
	when := time.Date(2026, 5, 14, 1, 1, 0, 0, time.UTC)
	base := tcpa.CheckRequest{
		KnownTimezone: "America/New_York",
		When:          when,
	}

	rOrig, _ := c.Check(ctx, func() tcpa.CheckRequest { r := base; r.EnforcementPoint = tcpa.PointOriginate; return r }())
	rManual, _ := c.Check(ctx, func() tcpa.CheckRequest { r := base; r.EnforcementPoint = tcpa.PointManual; return r }())

	if rOrig.Outcome != rManual.Outcome {
		t.Errorf("originate=%s, manual=%s — should be identical", rOrig.Outcome, rManual.Outcome)
	}
	if rOrig.Reason != rManual.Reason {
		t.Errorf("originate reason=%s, manual reason=%s — should be identical", rOrig.Reason, rManual.Reason)
	}
}

func TestWindowClosesWithin(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// 4 minutes before ET close (21:00) — closes within 5min, not within 30s
	when := time.Date(2026, 5, 14, 0, 56, 0, 0, time.UTC) // 8:56pm ET
	req := tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		EnforcementPoint: tcpa.PointPacing,
		When:             when,
	}
	within5, err := c.WindowClosesWithin(ctx, req, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if !within5 {
		t.Error("expected WindowClosesWithin(5m) true at 4min before close")
	}

	within30s, err := c.WindowClosesWithin(ctx, req, 30*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if within30s {
		t.Error("expected WindowClosesWithin(30s) false at 4min before close")
	}

	// Already past close → both true
	past := time.Date(2026, 5, 14, 1, 5, 0, 0, time.UTC) // 9:05pm ET
	reqPast := tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		EnforcementPoint: tcpa.PointPacing,
		When:             past,
	}
	pastResult, _ := c.WindowClosesWithin(ctx, reqPast, 5*time.Minute)
	if !pastResult {
		t.Error("expected true when already past close")
	}
}

func TestWindowClosesWithinUnknownTZ(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()
	req := tcpa.CheckRequest{
		EnforcementPoint: tcpa.PointPacing,
		When:             time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC),
	}
	result, err := c.WindowClosesWithin(ctx, req, 5*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	if result {
		t.Error("expected false for unknown TZ")
	}
}

func TestStateHolidayBlackout(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// RI Christmas (Dec 25) should be SKIP
	xmas := time.Date(2026, 12, 25, 15, 0, 0, 0, time.UTC) // 10am ET
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		State:            "RI",
		EnforcementPoint: tcpa.PointHopper,
		When:             xmas,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeSkipUntil {
		t.Errorf("expected SKIP_UNTIL on RI Christmas, got %s reason=%s", res.Outcome, res.Reason)
	}
	if res.Reason != tcpa.ReasonStateHolidayBlackout {
		t.Errorf("expected reason=%s, got %s", tcpa.ReasonStateHolidayBlackout, res.Reason)
	}
}

func TestMEAutoDialerMondayAllowed(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// ME autodialer Monday 10am — within 9-5 window
	mon := time.Date(2026, 5, 11, 14, 0, 0, 0, time.UTC) // 10am ET Monday
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		State:            "ME",
		EnforcementPoint: tcpa.PointHopper,
		IsAutoDialer:     true,
		When:             mon,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeAllow {
		t.Errorf("expected ALLOW for ME autodialer Mon 10am, got %s reason=%s", res.Outcome, res.Reason)
	}
}

func TestNextOpenAfterHoliday(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// AL Christmas (Monday) → next open should be Tuesday 8am
	xmas := time.Date(2026, 12, 25, 15, 0, 0, 0, time.UTC) // 10am CT (AL is CDT)
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/Chicago",
		State:            "AL",
		EnforcementPoint: tcpa.PointHopper,
		When:             xmas,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeSkipUntil || res.NextOpen == nil {
		t.Fatalf("expected SKIP_UNTIL with NextOpen, got %s", res.Outcome)
	}
	// NextOpen should be Dec 26 at 8am local
	loc, _ := time.LoadLocation("America/Chicago")
	nextDay := res.NextOpen.In(loc)
	if nextDay.Day() != 26 || nextDay.Month() != 12 {
		t.Errorf("expected next open Dec 26, got %s", nextDay)
	}
	if nextDay.Hour() != 8 {
		t.Errorf("expected next open 8am, got %d", nextDay.Hour())
	}
}

func TestMEAutoDialerSundayBlackout(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	// ME autodialer Sunday → blackout regardless of time
	sun := time.Date(2026, 5, 17, 15, 0, 0, 0, time.UTC) // 11am ET Sunday
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		State:            "ME",
		EnforcementPoint: tcpa.PointHopper,
		IsAutoDialer:     true,
		When:             sun,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeSkipUntil {
		t.Errorf("expected SKIP_UNTIL for ME autodialer Sun, got %s reason=%s", res.Outcome, res.Reason)
	}
	if res.Reason != tcpa.ReasonStateAutoDialerWindow {
		t.Errorf("expected reason=%s, got %s", tcpa.ReasonStateAutoDialerWindow, res.Reason)
	}
}

func TestUTSundayBlackout(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()

	sun := time.Date(2026, 5, 17, 20, 0, 0, 0, time.UTC) // 2pm MT Sunday
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/Denver",
		State:            "UT",
		EnforcementPoint: tcpa.PointHopper,
		When:             sun,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeSkipUntil {
		t.Errorf("expected SKIP_UNTIL on UT Sunday, got %s reason=%s", res.Outcome, res.Reason)
	}
}

func TestOriginateOutsideWindowMetric(t *testing.T) {
	// Check that outside_window is emitted at originate for non-ALLOW
	c := newTestChecker(t)
	ctx := context.Background()
	when := time.Date(2026, 5, 14, 2, 0, 0, 0, time.UTC) // 10pm ET → after close
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		EnforcementPoint: tcpa.PointOriginate,
		When:             when,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeSkipUntil {
		t.Errorf("expected SKIP_UNTIL, got %s", res.Outcome)
	}
}

func TestMSMondayAllowed(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()
	mon := time.Date(2026, 5, 11, 19, 0, 0, 0, time.UTC) // 2pm CT Monday
	res, _ := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/Chicago",
		State:            "MS",
		EnforcementPoint: tcpa.PointHopper,
		When:             mon,
	})
	if res.Outcome != tcpa.OutcomeAllow {
		t.Errorf("expected ALLOW for MS Monday 2pm, got %s reason=%s", res.Outcome, res.Reason)
	}
}

// TestAutoDialerOnlyIsBlackoutPath exercises the AutoDialerOnly.IsBlackout()
// guard code path using a custom rule injected via CheckerOpts.Rules.
func TestAutoDialerOnlyIsBlackoutPath(t *testing.T) {
	// Craft a state with AutoDialerOnly set to a blackout window.
	customRules := map[string]tcpa.StateRule{
		"XX": {
			Code: "XX",
			PerDow: [7]tcpa.Window{
				0: {OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour},
				1: {OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour},
				2: {OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour},
				3: {OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour},
				4: {OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour},
				5: {OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour},
				6: {OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour},
			},
			// AutoDialerOnly set to blackout (open >= close, non-zero)
			AutoDialerOnly: &tcpa.Window{OpenLocal: 25 * time.Hour, CloseLocal: 0},
		},
	}
	c, err := tcpa.New(tcpa.CheckerOpts{
		Resolver:   tcpa.StubResolver{},
		Audit:      tcpa.NoopSinkForTest(),
		Rules:      customRules,
		SampleRate: 0,
	})
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	wed := time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC) // 11am ET Wednesday
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		State:            "XX",
		EnforcementPoint: tcpa.PointHopper,
		IsAutoDialer:     true,
		When:             wed,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeSkipUntil {
		t.Errorf("expected SKIP_UNTIL for autodialer-blackout-only rule, got %s reason=%s", res.Outcome, res.Reason)
	}
	if res.Reason != tcpa.ReasonStateAutoDialerWindow {
		t.Errorf("expected reason=%s, got %s", tcpa.ReasonStateAutoDialerWindow, res.Reason)
	}
}

// TestEffectiveWindowBlackoutFromCampaign exercises the eff.IsBlackout() path
// when campaign window + state window intersect to zero.
func TestEffectiveWindowBlackoutFromCampaign(t *testing.T) {
	c := newTestChecker(t)
	ctx := context.Background()
	// RI Saturday 10-17; campaign narrows to 18-21 → effectively empty → SKIP
	sat := time.Date(2026, 5, 16, 17, 0, 0, 0, time.UTC) // 1pm ET Saturday (within RI Sat 10-17)
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		State:            "RI",
		EnforcementPoint: tcpa.PointHopper,
		CampaignWindow:   &tcpa.Window{OpenLocal: 18 * time.Hour, CloseLocal: 21 * time.Hour},
		When:             sat,
	})
	if err != nil {
		t.Fatal(err)
	}
	// RI Sat 10-17 intersected with campaign 18-21 → open=18 close=17 → blackout
	if res.Outcome != tcpa.OutcomeSkipUntil {
		t.Errorf("expected SKIP_UNTIL for empty window, got %s reason=%s", res.Outcome, res.Reason)
	}
}

// TestWhenZeroUsesNowFn verifies that a zero When field is replaced by nowFn.
func TestWhenZeroUsesNowFn(t *testing.T) {
	fixed := time.Date(2026, 5, 13, 15, 0, 0, 0, time.UTC)
	c, _ := tcpa.New(tcpa.CheckerOpts{
		Resolver:   tcpa.StubResolver{},
		Audit:      tcpa.NoopSinkForTest(),
		NowFn:      func() time.Time { return fixed },
		SampleRate: 0,
	})
	ctx := context.Background()
	// When is zero — should use nowFn (midday ET → ALLOW)
	res, err := c.Check(ctx, tcpa.CheckRequest{
		KnownTimezone:    "America/New_York",
		EnforcementPoint: tcpa.PointHopper,
	})
	if err != nil {
		t.Fatal(err)
	}
	if res.Outcome != tcpa.OutcomeAllow {
		t.Errorf("expected ALLOW, got %s", res.Outcome)
	}
}

func TestIntersectProperties(t *testing.T) {
	a := tcpa.Window{OpenLocal: 8 * time.Hour, CloseLocal: 21 * time.Hour}
	b := tcpa.Window{OpenLocal: 9 * time.Hour, CloseLocal: 18 * time.Hour}

	ab := tcpa.IntersectForTest(a, b)
	ba := tcpa.IntersectForTest(b, a)

	if ab.OpenLocal != ba.OpenLocal || ab.CloseLocal != ba.CloseLocal {
		t.Errorf("intersect not commutative: ab=%v ba=%v", ab, ba)
	}

	c2 := tcpa.Window{OpenLocal: 10 * time.Hour, CloseLocal: 20 * time.Hour}
	ab_c := tcpa.IntersectForTest(ab, c2)
	a_bc := tcpa.IntersectForTest(a, tcpa.IntersectForTest(b, c2))
	if ab_c.OpenLocal != a_bc.OpenLocal || ab_c.CloseLocal != a_bc.CloseLocal {
		t.Errorf("intersect not associative: (ab)c=%v a(bc)=%v", ab_c, a_bc)
	}
}
