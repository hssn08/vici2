package picker

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/google/uuid"
	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/valkey"
)

// ensure *originate.Service satisfies Originator at compile time.
var _ Originator = (*originate.Service)(nil)

// dispatchDeadline is the soft wall-clock cap per dispatch attempt. If T04
// hasn't returned in this duration, we move on (PLAN §8.4). The T04 call
// is NOT cancelled — the token is considered leaked and monitored.
const dispatchDeadline = 200 * time.Millisecond

// tickInterval is the dispatch loop poll rate: 10 Hz (100 ms).
// E02 paces at 1 Hz; 10 Hz spread consumption smoothly across each second.
const tickInterval = 100 * time.Millisecond

// DispatchLoop runs the per-campaign 100 ms tick loop.
// It handles all four modes: PROGRESSIVE, MANUAL, PREVIEW, PREDICTIVE.
// One DispatchLoop goroutine per campaign per pod.
type DispatchLoop struct {
	cfg      CampaignConfig
	tokens   *TokenBucket
	claimer  *Claimer
	pairer   *AgentPairer
	checker  *PreT04Checker
	freqCap  *FreqCapIncrementer
	t04      Originator
	vc       *valkey.Client
	metrics  *Metrics
	logger   *slog.Logger
	podID    string
	tenantID int64

	// dispatched is used inside a tick to mark that T04 was invoked.
	// Prevents token Release in the defer when dispatched=true.
	dispatched bool
}

// NewDispatchLoop constructs a DispatchLoop for one campaign.
func NewDispatchLoop(
	cfg CampaignConfig,
	tokens *TokenBucket,
	claimer *Claimer,
	pairer *AgentPairer,
	checker *PreT04Checker,
	freqCap *FreqCapIncrementer,
	t04 Originator,
	vc *valkey.Client,
	m *Metrics,
	logger *slog.Logger,
	podID string,
) *DispatchLoop {
	return &DispatchLoop{
		cfg:      cfg,
		tokens:   tokens,
		claimer:  claimer,
		pairer:   pairer,
		checker:  checker,
		freqCap:  freqCap,
		t04:      t04,
		vc:       vc,
		metrics:  m,
		logger:   logger,
		podID:    podID,
		tenantID: cfg.TenantID,
	}
}

// UpdateConfig hot-reloads the campaign config (called from pubsub handler).
func (l *DispatchLoop) UpdateConfig(cfg CampaignConfig) {
	l.cfg = cfg
}

// Run blocks until ctx is cancelled, running the 100 ms dispatch tick.
// Per-campaign goroutine pair: this loop + answer_handler.go goroutine.
func (l *DispatchLoop) Run(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := l.tick(ctx); err != nil {
				l.logger.Error("picker: dispatch tick error",
					"campaign_id", l.cfg.CampaignID,
					"err", err,
				)
			}
		}
	}
}

// tick executes one dispatch attempt.
// Returns nil if no dispatch was attempted (no tokens, no leads, no agents).
func (l *DispatchLoop) tick(ctx context.Context) error {
	cfg := l.cfg // snapshot to avoid race on hot-reload

	if !cfg.Active {
		return nil
	}

	switch cfg.Mode {
	case originate.ModePredictive:
		return l.tickPredictive(ctx, cfg)
	default:
		// PROGRESSIVE, MANUAL, PREVIEW all use pre-pair model.
		return l.tickProgressive(ctx, cfg)
	}
}

// tickProgressive handles PROGRESSIVE / MANUAL / PREVIEW dispatch.
// Agent is reserved BEFORE originate (zero abandonment risk). PLAN §4.1.
func (l *DispatchLoop) tickProgressive(ctx context.Context, cfg CampaignConfig) error {
	l.dispatched = false

	// 1. Acquire token (for MANUAL mode dispatched by operator, we still consume
	// a token to track the aggregate dispatch rate).
	ok, err := l.tokens.Acquire(ctx, cfg.TenantID, cfg.CampaignID)
	if err == ErrNoTokens {
		return nil // E02 down or TTL expired; correct safety posture
	}
	if err != nil {
		return fmt.Errorf("tick: token acquire: %w", err)
	}
	if !ok {
		return nil // over-decremented; skip tick
	}
	defer func() {
		if !l.dispatched {
			l.tokens.Release(ctx, cfg.TenantID, cfg.CampaignID)
		}
	}()

	// 2. Reserve agent first (agent-before-lead: cheaper to undo if no lead).
	callUUID := uuid.New().String()
	agentID, err := l.pairer.PickForCall(ctx, cfg.TenantID, cfg.CampaignID, callUUID)
	if err == ErrNoReadyAgent {
		l.metrics.NoReadyAgent.WithLabelValues(
			fmt.Sprintf("%d", cfg.TenantID),
			fmt.Sprintf("%d", cfg.CampaignID),
			"no_ready",
		).Inc()
		return nil
	}
	if err != nil {
		return fmt.Errorf("tick: pick agent: %w", err)
	}

	// 3. Claim lead.
	claim, err := l.claimer.Claim(ctx, cfg.TenantID, cfg.CampaignID, l.podID, cfg.LeadLockTTLSec)
	if err == ErrHopperEmpty {
		l.pairer.ReleaseReservation(ctx, cfg.CampaignID, agentID) //nolint:errcheck
		l.wakeRefill(ctx, cfg)
		return nil
	}
	if err != nil {
		l.pairer.ReleaseReservation(ctx, cfg.CampaignID, agentID) //nolint:errcheck
		return fmt.Errorf("tick: claim lead: %w", err)
	}

	// 4. Pre-T04 checks.
	if err := l.checker.CheckCampaignActive(cfg.CampaignID); err != nil {
		l.releaseAll(ctx, cfg, claim, agentID, OutcomeCampaignPaused)
		return nil
	}
	if err := l.checker.CheckLeadEligible(ctx, cfg.TenantID, claim.LeadID); err != nil {
		l.releaseAll(ctx, cfg, claim, agentID, OutcomeLeadIneligible)
		return nil
	}

	// 5. Build request.
	req := buildOriginateRequest(callUUID, cfg, claim, agentID, cfg.Mode)

	// 6. Originate (sync; ~50 ms on ALLOW path). Mark dispatched before calling
	//    so the defer does not INCR token back (token is "spent").
	l.dispatched = true
	start := time.Now()

	resultCh := make(chan struct {
		res *originate.OriginateResult
		err error
	}, 1)
	go func() {
		res, err := l.t04.Originate(ctx, req)
		resultCh <- struct {
			res *originate.OriginateResult
			err error
		}{res, err}
	}()

	select {
	case r := <-resultCh:
		l.metrics.PickLatency.WithLabelValues(
			fmt.Sprintf("%d", cfg.TenantID),
			fmt.Sprintf("%d", cfg.CampaignID),
			string(cfg.Mode),
			"t04",
		).Observe(time.Since(start).Seconds())
		l.processOutcome(ctx, cfg, claim, agentID, r.res, r.err)
	case <-time.After(dispatchDeadline):
		// Deadline exceeded: token leaked (Q8 decision). T04 not cancelled.
		l.metrics.TokenLeaked.WithLabelValues(
			fmt.Sprintf("%d", cfg.TenantID),
			fmt.Sprintf("%d", cfg.CampaignID),
		).Inc()
		l.logger.Warn("picker: dispatch deadline exceeded",
			"campaign_id", cfg.CampaignID,
			"attempt_uuid", callUUID,
			"budget_ms", dispatchDeadline.Milliseconds(),
		)
	}
	return nil
}

// tickPredictive handles PREDICTIVE dispatch.
// AgentID=0, originate to PARK, then answer handler goroutine pairs on answer.
// PLAN §4.2.
func (l *DispatchLoop) tickPredictive(ctx context.Context, cfg CampaignConfig) error {
	l.dispatched = false

	ok, err := l.tokens.Acquire(ctx, cfg.TenantID, cfg.CampaignID)
	if err == ErrNoTokens {
		return nil
	}
	if err != nil {
		return fmt.Errorf("tick: token acquire: %w", err)
	}
	if !ok {
		return nil
	}
	defer func() {
		if !l.dispatched {
			l.tokens.Release(ctx, cfg.TenantID, cfg.CampaignID)
		}
	}()

	claim, err := l.claimer.Claim(ctx, cfg.TenantID, cfg.CampaignID, l.podID, cfg.LeadLockTTLSec)
	if err == ErrHopperEmpty {
		l.wakeRefill(ctx, cfg)
		return nil
	}
	if err != nil {
		return fmt.Errorf("tick: claim lead: %w", err)
	}

	if err := l.checker.CheckCampaignActive(cfg.CampaignID); err != nil {
		l.claimer.ReleaseWithPolicy(ctx, cfg.CampaignID, claim, OutcomeCampaignPaused) //nolint:errcheck
		return nil
	}
	if err := l.checker.CheckLeadEligible(ctx, cfg.TenantID, claim.LeadID); err != nil {
		l.claimer.ReleaseWithPolicy(ctx, cfg.CampaignID, claim, OutcomeLeadIneligible) //nolint:errcheck
		return nil
	}

	req := buildOriginateRequest(uuid.New().String(), cfg, claim, 0, originate.ModePredictive)

	// T04 returns BACKGROUND_JOB ack immediately for PREDICTIVE (non-blocking).
	l.dispatched = true
	res, err := l.t04.Originate(ctx, req)
	if err != nil {
		l.processOutcome(ctx, cfg, claim, 0, res, err)
	}
	// On BACKGROUND_JOB_ACK: bridged outcome arrives via events:vici2.call.answered
	// → answer handler. No processOutcome here.

	if claim.IsCallback {
		l.metrics.CallbackDispatched.WithLabelValues(
			fmt.Sprintf("%d", cfg.TenantID),
			fmt.Sprintf("%d", cfg.CampaignID),
		).Inc()
	}

	l.logDispatch(cfg, claim, req.AttemptUUID, 0, "BACKGROUND_JOB_ACK")
	return nil
}

// processOutcome maps T04 result/error to DialOutcome and calls release.
func (l *DispatchLoop) processOutcome(
	ctx context.Context,
	cfg CampaignConfig,
	claim LeadClaim,
	agentID int64,
	res *originate.OriginateResult,
	origErr error,
) {
	var outcome DialOutcome

	if origErr != nil {
		var oerr originate.OriginateError
		if asErr, ok := origErr.(originate.OriginateError); ok {
			oerr = asErr
			outcome = outcomeFromOriginateError(oerr)
		} else {
			outcome = OutcomeCarrierFail
		}
	} else if res != nil {
		switch res.Outcome {
		case originate.OutcomeSuccess:
			outcome = OutcomeBridged
		case originate.OutcomeTimeout:
			outcome = OutcomeTimeout
		case originate.OutcomeTCPABlocked:
			outcome = OutcomeTCPABlocked
		case originate.OutcomeDNCBlocked:
			outcome = OutcomeDNCBlocked
		case originate.OutcomeConsentBlocked:
			outcome = OutcomeConsentBlocked
		case originate.OutcomeGatewayLimit:
			outcome = OutcomeGatewayLimit
		case originate.OutcomeRateLimited:
			outcome = OutcomeRateLimited
		case originate.OutcomeGatewayFail:
			outcome = OutcomeCarrierFail
		default:
			outcome = OutcomeCarrierFail
		}
	}

	// Release agent reservation if pre-paired and not bridged.
	if agentID != 0 && outcome != OutcomeBridged {
		l.pairer.ReleaseReservation(ctx, cfg.CampaignID, agentID) //nolint:errcheck
	}

	// Release lead claim.
	l.claimer.ReleaseWithPolicy(ctx, cfg.CampaignID, claim, outcome) //nolint:errcheck

	// Increment freq cap on bridged calls.
	if outcome == OutcomeBridged && claim.PhoneE164 != "" {
		l.freqCap.IncrOnBridged(ctx, cfg.TenantID, cfg.CampaignID, claim.PhoneE164) //nolint:errcheck
	}

	// Update metrics.
	policy := PolicyFor(outcome)
	recycled := "false"
	if policy.Requeue {
		recycled = "true"
		l.metrics.RetryTotal.WithLabelValues(
			fmt.Sprintf("%d", cfg.TenantID),
			fmt.Sprintf("%d", cfg.CampaignID),
			outcome.String(),
			recycled,
		).Inc()
	}

	l.metrics.DispatchTotal.WithLabelValues(
		fmt.Sprintf("%d", cfg.TenantID),
		fmt.Sprintf("%d", cfg.CampaignID),
		string(cfg.Mode),
		outcome.String(),
	).Inc()
}

// releaseAll releases both agent reservation and lead claim with the given outcome.
func (l *DispatchLoop) releaseAll(
	ctx context.Context,
	cfg CampaignConfig,
	claim LeadClaim,
	agentID int64,
	outcome DialOutcome,
) {
	if agentID != 0 {
		l.pairer.ReleaseReservation(ctx, cfg.CampaignID, agentID) //nolint:errcheck
	}
	l.claimer.ReleaseWithPolicy(ctx, cfg.CampaignID, claim, outcome) //nolint:errcheck
	l.metrics.DispatchTotal.WithLabelValues(
		fmt.Sprintf("%d", cfg.TenantID),
		fmt.Sprintf("%d", cfg.CampaignID),
		string(cfg.Mode),
		outcome.String(),
	).Inc()
}

// wakeRefill publishes a refill_request pubsub message so E01 filler can
// ZADD new leads into the hopper. The publish is best-effort.
func (l *DispatchLoop) wakeRefill(ctx context.Context, cfg CampaignConfig) {
	key := refillRequestKey(cfg.TenantID, cfg.CampaignID)
	l.vc.State.Publish(ctx, key, "refill") //nolint:errcheck
}

// logDispatch emits the per-dispatch structured log line (PLAN §13.3).
func (l *DispatchLoop) logDispatch(
	cfg CampaignConfig,
	claim LeadClaim,
	attemptUUID string,
	agentID int64,
	outcome string,
) {
	if l.logger == nil {
		return
	}
	l.logger.Info("picker_dispatch",
		"tenant_id", cfg.TenantID,
		"campaign_id", cfg.CampaignID,
		"mode", string(cfg.Mode),
		"attempt_uuid", attemptUUID,
		"lead_id", claim.LeadID,
		"agent_id", agentID,
		"is_callback", claim.IsCallback,
		"outcome", outcome,
		"pod_id", l.podID,
	)
}
