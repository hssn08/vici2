package tcpa

import (
	"context"
	"math/rand/v2"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// CheckerOpts configures a Checker. All fields are optional except Resolver.
type CheckerOpts struct {
	// Resolver is the D03 timezone resolver. Required.
	Resolver Resolver
	// Audit is the sink for writing audit rows. Defaults to StdoutSink.
	Audit Sink
	// Rules overrides the generated state rule map (for testing).
	Rules map[string]StateRule
	// SampleRate controls the fraction of ALLOW decisions that are audited.
	// Default 0.01 (1%).
	SampleRate float64
	// NowFn replaces time.Now in tests.
	NowFn func() time.Time
	// Registry for Prometheus metrics. nil = no-op registration.
	Registry prometheus.Registerer
}

// Checker is the main TCPA gate. It is safe for concurrent use.
type Checker struct {
	resolver   Resolver
	audit      Sink
	rules      map[string]StateRule
	holidays   *HolidayCalendar
	nowFn      func() time.Time
	sampleRate float64
	metrics    *tcpaMetrics
}

// Default is set by New and used by package-level Check.
var Default *Checker

// New creates a new Checker and sets Default.
func New(opts CheckerOpts) (*Checker, error) {
	if opts.Resolver == nil {
		return nil, errorf("tcpa.New: Resolver is required")
	}
	if opts.SampleRate == 0 {
		opts.SampleRate = 0.01
	}
	if opts.NowFn == nil {
		opts.NowFn = time.Now
	}
	if opts.Audit == nil {
		opts.Audit = StdoutSink{}
	}
	rules := stateRules
	if opts.Rules != nil {
		rules = opts.Rules
	}
	hc := newHolidayCalendar(rules)
	c := &Checker{
		resolver:   opts.Resolver,
		audit:      opts.Audit,
		rules:      rules,
		holidays:   hc,
		nowFn:      opts.NowFn,
		sampleRate: opts.SampleRate,
		metrics:    newMetrics(opts.Registry, hc),
	}
	Default = c
	return c, nil
}

// errorf builds an error without importing fmt (keeps import list clean).
func errorf(msg string) error {
	return &tcpaError{msg: msg}
}

type tcpaError struct{ msg string }

func (e *tcpaError) Error() string { return e.msg }

// Check evaluates the TCPA time-window gate for the given request.
// It is safe for concurrent use and completes in < 1ms (p99) on the hot path.
//
// Outcomes:
//   - OutcomeAllow: call may proceed.
//   - OutcomeSkipUntil: call should be deferred until CheckResult.NextOpen.
//   - OutcomeBlockInvalid: call must not be placed (bad data).
func (c *Checker) Check(ctx context.Context, req CheckRequest) (CheckResult, error) {
	if req.When.IsZero() {
		req.When = c.nowFn()
	}
	if req.UnknownTzPolicy == "" {
		req.UnknownTzPolicy = PolicyDeny
	}

	timer := prometheus.NewTimer(c.metrics.checkDuration.WithLabelValues(string(req.EnforcementPoint)))
	defer timer.ObserveDuration()

	// ── Step 1: resolve TZ via D03 ──────────────────────────────────────────
	resolved, err := c.resolver.Resolve(ctx, ResolveRequest{
		LeadID:        req.LeadID,
		PhoneE164:     req.PhoneE164,
		KnownTimezone: req.KnownTimezone,
		Zip:           req.Zip,
		State:         req.State,
	})
	if err != nil {
		return CheckResult{}, err
	}

	// ── Step 2: handle unknown TZ ───────────────────────────────────────────
	if resolved.Confidence == ConfNone {
		if req.UnknownTzPolicy == PolicyWarnPass {
			return c.emit(ctx, req, CheckResult{
				Outcome:      OutcomeAllow,
				Confidence:   ConfNone,
				Reason:       ReasonUnknownTzWarnPass,
				RuleApplied:  "campaign_warn_pass",
			})
		}
		return c.emit(ctx, req, CheckResult{
			Outcome:     OutcomeBlockInvalid,
			Confidence:  ConfNone,
			Reason:      ReasonNoTimezone,
			RuleApplied: "policy_deny",
		})
	}

	// ── Step 3: compute called-party local time ─────────────────────────────
	loc := resolved.Location
	partyLocal := req.When.In(loc)
	dow := int(partyLocal.Weekday()) // 0=Sun…6=Sat
	// partyElapsed is time since local midnight, with second precision for the
	// 30s boundary gate at originate point.
	partyElapsed := time.Duration(partyLocal.Hour())*time.Hour +
		time.Duration(partyLocal.Minute())*time.Minute +
		time.Duration(partyLocal.Second())*time.Second
	// partyMins is minute-precision for general window comparisons.
	partyMins := time.Duration(partyLocal.Hour()*60+partyLocal.Minute()) * time.Minute

	// ── Step 4: pick state for rule lookup ─────────────────────────────────
	state := req.State
	if state == "" {
		state = stateFromTz(resolved.IANA)
	}
	rule, hasState := c.rules[state]

	// ── Step 5: holiday + dow blackout ──────────────────────────────────────
	if hasState {
		dateStr := partyLocal.Format("2006-01-02")
		if c.holidays.IsHoliday(state, dateStr) {
			nextOpen := nextBusinessDayOpen(partyLocal, rule, c.holidays)
			return c.emit(ctx, req, CheckResult{
				Outcome:     OutcomeSkipUntil,
				TzIANA:      resolved.IANA,
				Confidence:  resolved.Confidence,
				NextOpen:    &nextOpen,
				PartyLocal:  partyLocal,
				Reason:      ReasonStateHolidayBlackout,
				RuleApplied: state + "_holiday",
			})
		}
		if rule.PerDow[dow].IsBlackout() {
			nextOpen := nextDowOpen(partyLocal, &rule, c.holidays)
			reason := ReasonStateSundayBlackout
			if dow != 0 {
				reason = ReasonStateDowBlackout
			}
			return c.emit(ctx, req, CheckResult{
				Outcome:     OutcomeSkipUntil,
				TzIANA:      resolved.IANA,
				Confidence:  resolved.Confidence,
				NextOpen:    &nextOpen,
				PartyLocal:  partyLocal,
				Reason:      reason,
				RuleApplied: state + "_" + dowName(dow) + "_blackout",
			})
		}
	}

	// ── Step 6: build effective window = intersect(fed, state, [auto,] campaign) ─
	eff := fedFloor
	if hasState {
		w := rule.PerDow[dow]
		if !w.IsZero() && !w.IsBlackout() {
			eff = intersect(eff, w)
		}
		if req.IsAutoDialer {
			// Check per-dow autodialer blackout first (e.g. ME Sat/Sun).
			if rule.AutoDialerBlackoutDows != 0 && (rule.AutoDialerBlackoutDows>>uint(dow))&1 == 1 {
				nextOpen := nextDayOpen(partyLocal, &rule, eff, c.holidays)
				return c.emit(ctx, req, CheckResult{
					Outcome:     OutcomeSkipUntil,
					TzIANA:      resolved.IANA,
					Confidence:  resolved.Confidence,
					NextOpen:    &nextOpen,
					PartyLocal:  partyLocal,
					Effective:   eff,
					Reason:      ReasonStateAutoDialerWindow,
					RuleApplied: state + "_" + dowName(dow) + "_autodialer_blackout",
				})
			}
			if rule.AutoDialerOnly != nil {
				autoW := *rule.AutoDialerOnly
				if autoW.IsBlackout() {
					nextOpen := nextDayOpen(partyLocal, &rule, eff, c.holidays)
					return c.emit(ctx, req, CheckResult{
						Outcome:     OutcomeSkipUntil,
						TzIANA:      resolved.IANA,
						Confidence:  resolved.Confidence,
						NextOpen:    &nextOpen,
						PartyLocal:  partyLocal,
						Effective:   eff,
						Reason:      ReasonStateAutoDialerWindow,
						RuleApplied: state + "_" + dowName(dow) + "_autodialer_blackout",
					})
				}
				eff = intersect(eff, autoW)
			}
		}
	}
	if req.CampaignWindow != nil && !req.CampaignWindow.IsZero() {
		eff = intersect(eff, *req.CampaignWindow)
	}

	if eff.IsBlackout() {
		// State + campaign combined produced empty window for this dow.
		nextOpen := nextDayOpen(partyLocal, &rule, eff, c.holidays)
		reason := ReasonAfterWindow
		if req.IsAutoDialer {
			reason = ReasonStateAutoDialerWindow
		}
		return c.emit(ctx, req, CheckResult{
			Outcome:     OutcomeSkipUntil,
			TzIANA:      resolved.IANA,
			Confidence:  resolved.Confidence,
			NextOpen:    &nextOpen,
			PartyLocal:  partyLocal,
			Effective:   eff,
			Reason:      reason,
			RuleApplied: ruleNameOf(state, dow, eff),
		})
	}

	// ── Step 7: in-window check ─────────────────────────────────────────────
	if partyMins < eff.OpenLocal {
		nextOpen := midnightLocal(partyLocal).Add(eff.OpenLocal)
		return c.emit(ctx, req, CheckResult{
			Outcome:     OutcomeSkipUntil,
			TzIANA:      resolved.IANA,
			Confidence:  resolved.Confidence,
			NextOpen:    &nextOpen,
			PartyLocal:  partyLocal,
			Effective:   eff,
			Reason:      ReasonBeforeWindow,
			RuleApplied: ruleNameOf(state, dow, eff),
		})
	}
	if partyMins >= eff.CloseLocal {
		nextOpen := nextDayOpen(partyLocal, &rule, eff, c.holidays)
		return c.emit(ctx, req, CheckResult{
			Outcome:     OutcomeSkipUntil,
			TzIANA:      resolved.IANA,
			Confidence:  resolved.Confidence,
			NextOpen:    &nextOpen,
			PartyLocal:  partyLocal,
			Effective:   eff,
			Reason:      ReasonAfterWindow,
			RuleApplied: ruleNameOf(state, dow, eff),
		})
	}

	// ── Step 8: ALLOW — with originate-boundary check ───────────────────────
	if req.EnforcementPoint == PointOriginate {
		timeToClose := eff.CloseLocal - partyElapsed
		if timeToClose < 30*time.Second {
			c.metrics.outsideWindow.WithLabelValues(
				string(PointOriginate), ReasonBoundary30sToClose, state,
			).Inc()
			nextOpen := nextDayOpen(partyLocal, &rule, eff, c.holidays)
			return c.emit(ctx, req, CheckResult{
				Outcome:     OutcomeSkipUntil,
				TzIANA:      resolved.IANA,
				Confidence:  resolved.Confidence,
				NextOpen:    &nextOpen,
				PartyLocal:  partyLocal,
				Effective:   eff,
				Reason:      ReasonBoundary30sToClose,
				RuleApplied: ruleNameOf(state, dow, eff),
			})
		}
	}

	return c.emit(ctx, req, CheckResult{
		Outcome:     OutcomeAllow,
		TzIANA:      resolved.IANA,
		Confidence:  resolved.Confidence,
		PartyLocal:  partyLocal,
		Effective:   eff,
		Reason:      ReasonOK,
		RuleApplied: ruleNameOf(state, dow, eff),
	})
}

// WindowClosesWithin returns true if the effective call window for req closes
// within duration d. Used by E02 pacing for boundary deprioritization.
// Does NOT write audit rows or increment outside_window_total.
func (c *Checker) WindowClosesWithin(ctx context.Context, req CheckRequest, d time.Duration) (bool, error) {
	if req.When.IsZero() {
		req.When = c.nowFn()
	}
	resolved, err := c.resolver.Resolve(ctx, ResolveRequest{
		LeadID:        req.LeadID,
		PhoneE164:     req.PhoneE164,
		KnownTimezone: req.KnownTimezone,
		Zip:           req.Zip,
		State:         req.State,
	})
	if err != nil || resolved.Confidence == ConfNone {
		return false, err
	}

	loc := resolved.Location
	partyLocal := req.When.In(loc)
	dow := int(partyLocal.Weekday())
	partyMins := time.Duration(partyLocal.Hour()*60+partyLocal.Minute()) * time.Minute

	state := req.State
	if state == "" {
		state = stateFromTz(resolved.IANA)
	}

	eff := fedFloor
	if rule, hasState := c.rules[state]; hasState {
		w := rule.PerDow[dow]
		if !w.IsZero() && !w.IsBlackout() {
			eff = intersect(eff, w)
		}
		if req.IsAutoDialer {
			if rule.AutoDialerBlackoutDows != 0 && (rule.AutoDialerBlackoutDows>>uint(dow))&1 == 1 {
				// Already past any open window for autodialers on this day.
				return true, nil
			}
			if rule.AutoDialerOnly != nil && !rule.AutoDialerOnly.IsBlackout() {
				eff = intersect(eff, *rule.AutoDialerOnly)
			}
		}
	}
	if req.CampaignWindow != nil && !req.CampaignWindow.IsZero() {
		eff = intersect(eff, *req.CampaignWindow)
	}

	if partyMins >= eff.CloseLocal {
		// Already past close — closes "within 0".
		kind := "5min"
		if d <= 30*time.Second {
			kind = "30s"
		}
		c.metrics.boundaryAdvisory.WithLabelValues(kind, state).Inc()
		return true, nil
	}

	closes := eff.CloseLocal - partyMins < d
	if closes {
		kind := "5min"
		if d <= 30*time.Second {
			kind = "30s"
		}
		c.metrics.boundaryAdvisory.WithLabelValues(kind, state).Inc()
	}
	return closes, nil
}

// emit records metrics and, when appropriate, writes an audit row. It returns
// the CheckResult unchanged so callers can `return c.emit(...)`.
func (c *Checker) emit(ctx context.Context, req CheckRequest, res CheckResult) (CheckResult, error) {
	state := res.TzIANA
	if req.State != "" {
		state = req.State
	}

	c.metrics.checkTotal.WithLabelValues(
		string(res.Outcome), res.Reason, string(req.EnforcementPoint), state,
	).Inc()

	if res.Outcome != OutcomeAllow || rand.Float64() < c.sampleRate {
		row := buildAuditRow(req, res)
		if err := c.audit.Write(ctx, row); err != nil {
			c.metrics.auditDropped.WithLabelValues("sink_error").Inc()
		}
	}
	return res, nil
}

func buildAuditRow(req CheckRequest, res CheckResult) CallWindowAuditRow {
	openMin := int(res.Effective.OpenLocal.Minutes())
	closeMin := int(res.Effective.CloseLocal.Minutes())
	dow := 0
	if !res.PartyLocal.IsZero() {
		dow = int(res.PartyLocal.Weekday())
	}
	decision := string(res.Outcome)
	if res.Reason == ReasonUnknownTzWarnPass {
		decision = "ALLOW_WARN"
	}
	row := CallWindowAuditRow{
		Ts:                time.Now(),
		TenantID:          0, // populated by caller if known; stream consumer sets it
		LeadID:            req.LeadID,
		PhoneE164:         req.PhoneE164,
		CampaignID:        req.CampaignID,
		Decision:          decision,
		Reason:            res.Reason,
		TzIANA:            res.TzIANA,
		TzConfidence:      string(res.Confidence),
		State:             req.State,
		Zip:               req.Zip,
		PartyLocal:        res.PartyLocal,
		PartyDow:          dow,
		EffectiveOpenMin:  openMin,
		EffectiveCloseMin: closeMin,
		RuleApplied:       res.RuleApplied,
		EnforcementPoint:  string(req.EnforcementPoint),
		NextOpenAt:        res.NextOpen,
	}
	return row
}

var dowNames = [7]string{"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"}

func dowName(dow int) string {
	if dow < 0 || dow > 6 {
		return "?"
	}
	return dowNames[dow]
}
