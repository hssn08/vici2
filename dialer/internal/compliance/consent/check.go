package consent

import (
	"context"
	"fmt"
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

// Checker is the C02 recording-consent gate. It is safe for concurrent use.
// Hot-path SLO: p99 < 200µs (T04 RESEARCH §3.5 budget).
type Checker struct {
	rules   map[string]ConsentRule // codegen; keyed by 2-letter state
	audit   Sink                   // async writer to consent_log
	metrics *consentMetrics
	nowFn   func() time.Time // overridable for tests
}

// CheckerOpts configures a Checker. All fields are optional.
type CheckerOpts struct {
	// Audit is the sink for writing audit rows. Defaults to StdoutSink.
	Audit Sink
	// Rules overrides the generated state rule map (for testing).
	Rules map[string]ConsentRule
	// NowFn replaces time.Now in tests. nil → time.Now.
	NowFn func() time.Time
	// Registry for Prometheus metrics. nil = no-op registration.
	Registry prometheus.Registerer
}

// Default is set by New; package-level helper for callers that don't want
// to thread the Checker explicitly.
var Default *Checker

// New creates a new Checker and sets Default.
func New(opts CheckerOpts) (*Checker, error) {
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
	c := &Checker{
		rules:   rules,
		audit:   opts.Audit,
		metrics: newMetrics(opts.Registry),
		nowFn:   opts.NowFn,
	}
	Default = c
	return c, nil
}

// CheckConsent is the canonical recording-consent decision function.
// It is pure modulo nowFn + side-effects (metrics + async audit write).
//
// The 7-step algorithm:
//  0. Normalize When.
//  1. Short-circuit on campaign.recording_policy=NEVER → SKIP.
//  2. Resolve legal floor per state from stateRules map.
//  3. Stricter-state-wins (Kearney v. Salomon Smith Barney).
//  4. PA B2B carveout (§5704(15)).
//  5. Layer tenant minimum.
//  6. Layer campaign override (subject to legal floor — monotonic).
//  7. Build result + reason, emit audit row.
func (c *Checker) CheckConsent(ctx context.Context, req CheckRequest) (CheckResult, error) {
	timer := prometheus.NewTimer(c.metrics.checkDuration.WithLabelValues())
	defer timer.ObserveDuration()

	// ── Step 0: input normalization ─────────────────────────────────────────
	if req.When.IsZero() {
		req.When = c.nowFn()
	}

	// ── Step 1: short-circuit on campaign-disabled ───────────────────────────
	if req.CampaignRecordingPolicy == PolicyNever {
		res := CheckResult{
			Decision:        ModeSkip,
			StateApplied:    req.LeadState,
			Mechanism:       "SKIP/campaign-recording-never",
			Reason:          ReasonCampaignDisabled,
			ConsentRequired: false,
			ConsentRecord:   false,
		}
		return c.emit(ctx, req, res)
	}

	// ── Step 2: resolve legal floor per state ────────────────────────────────
	legalLead, leadHas := c.rules[req.LeadState]
	legalCaller, callerHas := c.rules[req.CallerState]

	leadMode := ModeAllow
	leadCite := ""
	leadStateUnknown := false
	callerStateUnknown := false

	if leadHas {
		leadMode = legalLead.MinimumMode
		leadCite = legalLead.Citation
	} else if req.LeadState == "" {
		// Unknown lead state → conservative default.
		leadMode = ModePromptMessage
		leadStateUnknown = true
		c.metrics.stateMissing.WithLabelValues("lead").Inc()
	}
	// Non-empty lead state not in map → 1-party state → ModeAllow (default).

	callerMode := ModeAllow
	if callerHas {
		callerMode = legalCaller.MinimumMode
	} else if req.CallerState == "" {
		// Unknown caller state → treat as 1-party for the intersection.
		// Lead-state legal floor still wins. Page separately.
		callerStateUnknown = true
		c.metrics.stateMissing.WithLabelValues("caller").Inc()
	}
	// Non-empty caller state not in map → 1-party state → ModeAllow.

	// ── Step 3: stricter-state-wins (Kearney) ───────────────────────────────
	legalFloor := StricterOf(leadMode, callerMode)
	drivingState := req.LeadState
	if callerMode > leadMode {
		drivingState = req.CallerState
	} else if leadMode == callerMode && leadHas {
		drivingState = req.LeadState
	}

	// ── Step 4: B2B carveout (PA Phase 1 only) ──────────────────────────────
	// The PA §5704(15) carveout is a complete legal exemption: it overrides the
	// state floor AND tenant/campaign minimums (the tenant elected not to record;
	// the law says they may). This is consistent with PLAN fixture #6 which shows
	// tenantMinimumMode=PROMPT_MESSAGE and expectedDecision=ALLOW when B2B fires.
	b2bApplied := false
	if req.LeadIsBusiness && leadHas && legalLead.B2BExempt {
		switch req.CampaignRecordingPurpose {
		case PurposeTraining, PurposeQualityControl, PurposeMonitoring:
			b2bApplied = true
			drivingState = req.LeadState
			// B2B carveout: emit early before tenant/campaign layers.
			res := CheckResult{
				Decision:        ModeAllow,
				StateApplied:    drivingState,
				Mechanism:       fmt.Sprintf("ALLOW/b2b-pa-carveout/lead=%s/caller=%s", req.LeadState, req.CallerState),
				Reason:          ReasonB2BPACarveout,
				Citation:        legalLead.Citation,
				ConsentRequired: false,
				ConsentRecord:   true,
			}
			return c.emit(ctx, req, res)
		}
	}

	// ── Step 5: layer tenant minimum ────────────────────────────────────────
	legalOrTenant := StricterOf(legalFloor, req.TenantMinimumMode)
	tenantBumped := req.TenantMinimumMode > legalFloor

	// ── Step 6: layer campaign override (subject to legal floor) ────────────
	final := legalOrTenant
	campaignBumped := false
	if req.CampaignOverrideMode != nil {
		// Campaign can only TIGHTEN, never loosen below legal floor.
		// StricterOf monotonic — this is the correctness invariant.
		proposed := StricterOf(legalOrTenant, *req.CampaignOverrideMode)
		if proposed > legalOrTenant {
			campaignBumped = true
		}
		final = proposed
	}

	// ── Step 7: build result + reason ───────────────────────────────────────
	// Note: b2bApplied=true never reaches here (early return above).
	reason := pickReason(
		false, campaignBumped, tenantBumped,
		leadMode, callerMode, leadHas, callerHas,
		leadStateUnknown, callerStateUnknown,
		final, req.TenantMinimumMode,
		req.CampaignOverrideMode,
	)
	_ = b2bApplied // early-returned above; silence unused-var linter

	promptAudio := ""
	if final == ModePromptMessage || final == ModeRequireActive {
		promptAudio = req.ConsentMsgAudioPath
	}
	optOutAction := ""
	if final == ModeRequireActive {
		optOutAction = req.OptOutAction
	}

	res := CheckResult{
		Decision:        final,
		StateApplied:    drivingState,
		Mechanism:       fmt.Sprintf("%s/lead=%s/caller=%s", final.String(), req.LeadState, req.CallerState),
		Reason:          reason,
		Citation:        leadCite,
		PromptAudio:     promptAudio,
		OptOutAction:    optOutAction,
		ConsentRequired: final != ModeAllow && final != ModeSkip,
		ConsentRecord:   final != ModeSkip,
	}

	return c.emit(ctx, req, res)
}

// emit records metrics and writes an audit row. Returns the CheckResult unchanged
// so callers can `return c.emit(...)`.
func (c *Checker) emit(ctx context.Context, req CheckRequest, res CheckResult) (CheckResult, error) {
	c.metrics.checkTotal.WithLabelValues(
		res.Decision.String(), res.Reason, res.StateApplied,
	).Inc()

	if res.Decision == ModeSkip {
		c.metrics.skippedTotal.WithLabelValues(res.Reason).Inc()
	}
	if res.Decision == ModeAllow && res.Reason == ReasonB2BPACarveout {
		c.metrics.b2bApplied.WithLabelValues(res.StateApplied).Inc()
	}

	row := ConsentLogRow{
		Ts:            req.When,
		TenantID:      req.TenantID,
		CallUUID:      req.CallUUID,
		LeadID:        req.LeadID,
		CampaignID:    req.CampaignID,
		LeadState:     req.LeadState,
		CallerState:   req.CallerState,
		Decision:      res.Decision.String(),
		Mechanism:     res.Mechanism,
		StateApplied:  res.StateApplied,
		ConsentStatus: "pending",
		Reason:        res.Reason,
		Citation:      res.Citation,
		RecordedAt:    req.When,
	}
	if err := c.audit.Write(ctx, row); err != nil {
		c.metrics.auditDropped.WithLabelValues("sink_error").Inc()
	}

	return res, nil
}

// pickReason returns the controlled-vocabulary reason string for the decision.
// The priority order mirrors the algorithm steps in CheckConsent.
func pickReason(
	b2bApplied, campaignBumped, tenantBumped bool,
	leadMode, callerMode Mode,
	leadHas, callerHas bool,
	leadStateUnknown, callerStateUnknown bool,
	final Mode, tenantMin Mode,
	campaignOverride *Mode,
) string {
	// B2B carveout is the most specific classification when it fired.
	if b2bApplied {
		return ReasonB2BPACarveout
	}

	// Campaign-disabled is handled as a short-circuit before this function.
	// Tenant SKIP is a special case.
	if tenantMin == ModeSkip {
		return ReasonTenantPolicySkip
	}

	// Campaign override classifications.
	if campaignBumped {
		if final == ModeRequireActive {
			return ReasonRequireActiveCampaign
		}
		if final == ModePromptBeep {
			return ReasonBeepCampaign
		}
		return ReasonCampaignOverride
	}

	// Tenant minimum bumped the floor.
	if tenantBumped {
		if final == ModeRequireActive {
			return ReasonRequireActiveTenant
		}
		if final == ModePromptBeep {
			return ReasonBeepTenant
		}
		return ReasonTenantMinimumFloor
	}

	// Unknown state classifications (when legal floor was hit by unknown).
	if leadStateUnknown {
		return ReasonLeadStateUnknown
	}
	if callerStateUnknown && !leadHas {
		// Caller unknown AND lead is 1-party → the only reason is caller unknown.
		return ReasonCallerStateUnknown
	}

	// State-law classifications.
	if leadHas && callerHas {
		return ReasonState2PartyBoth
	}
	if leadHas {
		return ReasonState2PartyLead
	}
	if callerHas {
		return ReasonState2PartyCaller
	}

	// Neither state has a rule and no overrides → pure 1-party.
	// Tenant minimum exactly ALLOW (or callerStateUnknown with lead 1-party).
	if callerStateUnknown {
		return ReasonCallerStateUnknown
	}
	return ReasonOK
}
