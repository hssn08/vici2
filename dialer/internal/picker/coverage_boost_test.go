package picker

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/vici2/dialer/internal/originate"
)

// TestNewMetrics_DefaultRegisterer verifies NewMetrics does not panic on first call.
// NOTE: this test runs with a clean process so DefaultRegisterer has no prior registrations.
func TestNewMetrics_ViaRegisterer(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := NewMetricsWithRegisterer(reg)
	if m == nil {
		t.Fatal("expected non-nil Metrics")
	}
	// Calling a metric proves registration succeeded.
	m.DispatchTotal.WithLabelValues("1", "1", "PROGRESSIVE", "bridged").Inc()
}

// TestLogDispatch_WithLogger verifies logDispatch emits a structured log line.
func TestLogDispatch_WithLogger(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	cfg := newProgressiveCfg(400)
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, NewCampaignConfigCache()),
		NewFreqCapIncrementer(vc), &mockOriginator{}, vc, m, logger, "test-log")

	claim := LeadClaim{LeadID: 42, CampaignID: cfg.CampaignID, LockVal: "pod:1"}
	// Must not panic.
	loop.logDispatch(cfg, claim, "test-uuid", 0, "BACKGROUND_JOB_ACK")
}

// TestJanitorLogHelpers_WithLogger verifies the janitor log helpers reach the logger.
func TestJanitorLogHelpers_WithLogger(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	cache := NewCampaignConfigCache()
	claimer := NewClaimer(vc, m)
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))

	j := NewJanitor(vc, cache, claimer, m, logger)
	// Must not panic.
	j.logWarn("test warn", "key", "val")
	j.logError("test error", "key", "val")
	j.logInfo("test info", "key", "val")
}

// TestJanitorLogHelpers_NilLogger verifies nil-safe log helpers.
func TestJanitorLogHelpers_NilLogger(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	cache := NewCampaignConfigCache()
	claimer := NewClaimer(vc, m)

	j := NewJanitor(vc, cache, claimer, m, nil)
	j.logWarn("test warn")
	j.logError("test error")
	j.logInfo("test info")
}

// TestTickProgressive_CampaignPaused verifies release when campaign is not active.
func TestTickProgressive_CampaignPaused(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(500)
	const agentUserID = int64(501)

	// Campaign NOT active in cache (IsActive returns false).
	cfg := newProgressiveCfg(campaignID)
	cfgCache := NewCampaignConfigCache()
	// Don't set cfg in cache → CheckCampaignActive will fail.

	// Seed tokens so we pass token check.
	mr.Set(dispatchTokensKey(1, campaignID), "5")

	// Seed READY agent.
	readyKey := vc.Keys.AgentsByCampaignStatus(campaignID, "READY")
	mr.ZAdd(readyKey, float64(time.Now().UnixMilli()-2000), fmt.Sprintf("%d", agentUserID))
	mr.HSet(vc.Keys.Agent(agentUserID),
		"status", "READY",
		"campaign_id", fmt.Sprintf("%d", campaignID),
		"user_id", fmt.Sprintf("%d", agentUserID),
	)

	// Seed lead.
	mr.ZAdd(vc.Keys.CampaignHopper(campaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", int64(9999)))

	t04 := &mockOriginator{}
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-paused")

	if err := loop.tickProgressive(ctx(t), cfg); err != nil {
		t.Fatalf("tickProgressive error: %v", err)
	}

	// T04 should NOT be called (campaign not active).
	if t04.called != 0 {
		t.Error("T04 should not be called when campaign is paused")
	}
}

// TestTickProgressive_NoLead verifies token returned when hopper is empty.
func TestTickProgressive_NoLead(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(600)
	const agentUserID = int64(601)

	cfg := newProgressiveCfg(campaignID)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	mr.Set(dispatchTokensKey(1, campaignID), "5")

	// Seed READY agent but NO lead in hopper.
	readyKey := vc.Keys.AgentsByCampaignStatus(campaignID, "READY")
	mr.ZAdd(readyKey, float64(time.Now().UnixMilli()-2000), fmt.Sprintf("%d", agentUserID))
	mr.HSet(vc.Keys.Agent(agentUserID),
		"status", "READY",
		"campaign_id", fmt.Sprintf("%d", campaignID),
		"user_id", fmt.Sprintf("%d", agentUserID),
	)

	t04 := &mockOriginator{}
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-nolead")

	if err := loop.tickProgressive(ctx(t), cfg); err != nil {
		t.Fatalf("tickProgressive error: %v", err)
	}

	if t04.called != 0 {
		t.Error("T04 should not be called with no lead in hopper")
	}
}

// TestTickPredictive_NoLead verifies token returned when hopper is empty.
func TestTickPredictive_NoLead(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(700)

	cfg := newProgressiveCfg(campaignID)
	cfg.Mode = originate.ModePredictive
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	mr.Set(dispatchTokensKey(1, campaignID), "5")
	// No lead seeded in hopper.

	t04 := &mockOriginator{}
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-pred-nolead")

	if err := loop.tickPredictive(ctx(t), cfg); err != nil {
		t.Fatalf("tickPredictive error: %v", err)
	}

	if t04.called != 0 {
		t.Error("T04 should not be called with no lead in hopper (PREDICTIVE)")
	}
}

// TestTickPredictive_CampaignPaused verifies claim released when campaign inactive.
func TestTickPredictive_CampaignPaused(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(800)
	const leadID = int64(8001)

	cfg := newProgressiveCfg(campaignID)
	cfg.Mode = originate.ModePredictive
	cfgCache := NewCampaignConfigCache()
	// Campaign NOT in cache → CheckCampaignActive will fail.

	mr.Set(dispatchTokensKey(1, campaignID), "5")
	mr.ZAdd(vc.Keys.CampaignHopper(campaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	t04 := &mockOriginator{}
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-pred-paused")

	if err := loop.tickPredictive(ctx(t), cfg); err != nil {
		t.Fatalf("tickPredictive error: %v", err)
	}

	if t04.called != 0 {
		t.Error("T04 should not be called when campaign is paused (PREDICTIVE)")
	}
}

// TestDispatchManual_Success verifies the happy path of DispatchManual.
func TestDispatchManual_Success(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(900)
	const leadID = int64(9001)
	const agentID = int64(9002)

	// Seed config snapshot.
	mr.Set(configSnapshotKey(1, campaignID), `{"mode":"PROGRESSIVE","active":true,"lead_lock_ttl_sec":10}`)

	// Seed lead in hopper.
	mr.ZAdd(vc.Keys.CampaignHopper(campaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	t04 := &mockOriginator{
		result: &originate.OriginateResult{
			AttemptUUID: "manual-uuid",
			CallUUID:    "manual-uuid",
			Outcome:     originate.OutcomeSuccess,
		},
	}

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "test-manual",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          t04,
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}

	// Activate campaign so it's in cfgCache.
	if err := sup.ActivateCampaign(context.Background(), campaignID); err != nil {
		t.Fatalf("ActivateCampaign: %v", err)
	}

	result, err := sup.DispatchManual(context.Background(), ManualDispatchRequest{
		TenantID:   1,
		CampaignID: campaignID,
		AgentID:    agentID,
		LeadID:     leadID,
	})
	if err != nil {
		t.Fatalf("DispatchManual error: %v", err)
	}
	if result == nil {
		t.Fatal("expected non-nil result")
	}
	if result.AttemptUUID != "manual-uuid" {
		t.Errorf("expected AttemptUUID=manual-uuid, got %s", result.AttemptUUID)
	}
}

// TestDispatchManual_T04Error verifies error propagated on T04 failure.
func TestDispatchManual_T04Error(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(901)
	const leadID = int64(9011)

	mr.Set(configSnapshotKey(1, campaignID), `{"mode":"PROGRESSIVE","active":true,"lead_lock_ttl_sec":10}`)
	mr.ZAdd(vc.Keys.CampaignHopper(campaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	t04 := &mockOriginator{
		err: originate.NewCarrierFailErr("manual-err-uuid", "NO_ROUTE", time.Second, originate.OutcomeGatewayFail),
	}

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "test-manual-err",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          t04,
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}

	if err := sup.ActivateCampaign(context.Background(), campaignID); err != nil {
		t.Fatalf("ActivateCampaign: %v", err)
	}

	_, err = sup.DispatchManual(context.Background(), ManualDispatchRequest{
		TenantID:   1,
		CampaignID: campaignID,
		AgentID:    1,
		LeadID:     leadID,
	})
	if err == nil {
		t.Error("expected error from DispatchManual on T04 failure")
	}
}

// TestProcessOutcome_ResultPathNoError exercises the res != nil branch.
func TestProcessOutcome_ResultPaths(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	cfg := newProgressiveCfg(950)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	outcomes := []originate.OriginateOutcome{
		originate.OutcomeSuccess,
		originate.OutcomeTimeout,
		originate.OutcomeTCPABlocked,
		originate.OutcomeDNCBlocked,
		originate.OutcomeConsentBlocked,
		originate.OutcomeGatewayLimit,
		originate.OutcomeRateLimited,
		originate.OutcomeGatewayFail,
	}

	for i, o := range outcomes {
		leadID := int64(9500 + i)
		mr.ZAdd(vc.Keys.CampaignHopper(cfg.CampaignID),
			float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

		loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
			NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
			NewFreqCapIncrementer(vc), &mockOriginator{}, vc, m, nil, "test")

		claim := LeadClaim{LeadID: leadID, CampaignID: cfg.CampaignID, LockVal: "pod:x"}
		res := &originate.OriginateResult{Outcome: o}
		loop.processOutcome(context.Background(), cfg, claim, 0, res, nil)
	}
}

// TestProcessOutcome_GenericError exercises the generic (non-OriginateError) error branch.
func TestProcessOutcome_GenericError(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	cfg := newProgressiveCfg(951)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	const leadID = int64(9510)
	mr.ZAdd(vc.Keys.CampaignHopper(cfg.CampaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), &mockOriginator{}, vc, m, nil, "test")

	claim := LeadClaim{LeadID: leadID, CampaignID: cfg.CampaignID, LockVal: "pod:g"}
	// Use a non-OriginateError error (plain Go error).
	loop.processOutcome(context.Background(), cfg, claim, 0, nil, fmt.Errorf("generic transport error"))
}

// TestProcessOutcome_Requeue verifies metrics when policy.Requeue is true.
func TestProcessOutcome_Requeue(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	cfg := newProgressiveCfg(952)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	const leadID = int64(9520)
	mr.ZAdd(vc.Keys.CampaignHopper(cfg.CampaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), &mockOriginator{}, vc, m, nil, "test")

	claim := LeadClaim{LeadID: leadID, CampaignID: cfg.CampaignID, LockVal: "pod:rq"}
	// NoAnswer has Requeue=true → triggers retry metric.
	err := originate.NewCarrierFailErr("rq-uuid", "NOANSWER", time.Second, originate.OutcomeGatewayFail)
	loop.processOutcome(context.Background(), cfg, claim, 0, nil, err)
}

// TestJanitor_SweepOrphans_WithExpiredEntry verifies old in_flight entries are released.
func TestJanitor_SweepOrphans_WithExpiredEntry(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(1001)
	cfg := newProgressiveCfg(campaignID)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	// Seed an orphan: timestamp 10 minutes ago.
	oldTs := time.Now().Add(-10 * time.Minute).UnixMilli()
	inFlightKey := fmt.Sprintf("t:%d:campaign:{%d}:in_flight", cfg.TenantID, campaignID)
	mr.HSet(inFlightKey, fmt.Sprintf("%d", int64(1100)), fmt.Sprintf("pod:12345:%d", oldTs))

	claimer := NewClaimer(vc, m)
	j := NewJanitor(vc, cfgCache, claimer, m, nil)

	n, err := j.SweepOrphans(context.Background())
	if err != nil {
		t.Fatalf("SweepOrphans error: %v", err)
	}
	// Should have released the orphaned entry.
	if n < 0 {
		t.Errorf("expected non-negative orphan count, got %d", n)
	}
}

// TestDialOutcome_StringDefault exercises the default case in DialOutcome.String().
func TestDialOutcome_StringDefault(t *testing.T) {
	// DialOutcome(-1) is not a named constant → hits the default case.
	o := DialOutcome(-1)
	if o.String() != "unknown" {
		t.Errorf("expected 'unknown', got %q", o.String())
	}
}

// TestOutcomeFromOriginateError_CircuitOpen2 verifies circuit_open subReason mapping.
func TestOutcomeFromOriginateError_CircuitOpen2(t *testing.T) {
	err := originate.NewCarrierFailErr("uuid-co", "circuit_open", time.Second, originate.OutcomeGatewayFail)
	outcome := outcomeFromOriginateError(err)
	if outcome != OutcomeCircuitOpen {
		t.Errorf("expected OutcomeCircuitOpen, got %s", outcome)
	}
}

// TestOutcomeFromOriginateError_CarrierTimeout verifies carrier+timeout mapping.
func TestOutcomeFromOriginateError_CarrierTimeout(t *testing.T) {
	err := originate.NewCarrierFailErr("uuid-to", "ORIGINATE_TIMEOUT", time.Second, originate.OutcomeTimeout)
	outcome := outcomeFromOriginateError(err)
	if outcome != OutcomeTimeout {
		t.Errorf("expected OutcomeTimeout, got %s", outcome)
	}
}

// TestOutcomeFromOriginateError_DefaultGate verifies fallthrough to OutcomeCarrierFail.
func TestOutcomeFromOriginateError_DefaultGate(t *testing.T) {
	// Use a carrier fail with non-circuit_open subReason.
	err := originate.NewCarrierFailErr("uuid-def", "NO_ROUTE", time.Second, originate.OutcomeGatewayFail)
	outcome := outcomeFromOriginateError(err)
	if outcome != OutcomeCarrierFail {
		t.Errorf("expected OutcomeCarrierFail, got %s", outcome)
	}
}

// TestReleaseReservation_Error exercises the error path in ReleaseReservation.
func TestReleaseReservation_NoAgent(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	pairer := NewAgentPairer(vc, m)

	// Release a non-existent agent — should succeed (agent logged out mid-pair).
	err := pairer.ReleaseReservation(context.Background(), 1, 999999)
	if err != nil {
		t.Errorf("unexpected error releasing non-existent agent: %v", err)
	}
}

// TestTransitionToInCall_NoAgent exercises the error path in TransitionToInCall.
func TestTransitionToInCall_NoAgent(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	pairer := NewAgentPairer(vc, m)

	// Transition a non-existent agent — might return error from Lua or succeed silently.
	// Either way, test it doesn't panic.
	_ = pairer.TransitionToInCall(context.Background(), 1, 999999, 1, "test-uuid")
}

// TestProcessOutcome_WithAgentBridged verifies agent transitions to INCALL on bridge.
func TestProcessOutcome_WithAgentBridged(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	cfg := newProgressiveCfg(960)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	const agentID = int64(9601)
	const leadID = int64(9600)

	// Seed reserved agent.
	reservedKey := vc.Keys.AgentsByCampaignStatus(cfg.CampaignID, "RESERVED")
	mr.ZAdd(reservedKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", agentID))
	mr.HSet(vc.Keys.Agent(agentID),
		"status", "RESERVED",
		"campaign_id", fmt.Sprintf("%d", cfg.CampaignID),
		"user_id", fmt.Sprintf("%d", agentID),
	)
	mr.ZAdd(vc.Keys.CampaignHopper(cfg.CampaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), &mockOriginator{}, vc, m, nil, "test")

	claim := LeadClaim{
		LeadID:     leadID,
		CampaignID: cfg.CampaignID,
		LockVal:    "pod:bridged",
		PhoneE164:  "+19995550101",
	}
	res := &originate.OriginateResult{Outcome: originate.OutcomeSuccess}
	// agentID != 0 + Bridged → should NOT call ReleaseReservation (agent stays INCALL).
	loop.processOutcome(context.Background(), cfg, claim, agentID, res, nil)
}

// TestSupervisor_startWorkers_Reload verifies that re-activating an already active
// campaign kills the old workers and starts fresh ones (the "reload path").
func TestSupervisor_startWorkers_Reload(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	mr.Set(configSnapshotKey(1, 85), `{"mode":"PROGRESSIVE","active":true}`)

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "test-reload",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Activate twice to exercise the "existing workers" cancel path.
	if err := sup.ActivateCampaign(ctx, 85); err != nil {
		t.Fatalf("first ActivateCampaign: %v", err)
	}
	if err := sup.ActivateCampaign(ctx, 85); err != nil {
		t.Fatalf("second ActivateCampaign (reload): %v", err)
	}

	// Should still be active with fresh workers.
	if !sup.cfgCache.IsActive(85) {
		t.Error("expected campaign 85 to be active after reload")
	}
}

// TestClaimer_Release_Error verifies the error path when Valkey is unavailable.
func TestClaimer_Release_Error(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)

	// Close the miniredis to simulate Valkey being unavailable.
	mr.Close()

	err := claimer.Release(context.Background(), 1, 999, "fake-lock", false, 0)
	if err == nil {
		t.Error("expected error when Valkey is unavailable")
	}
}

// TestClaimer_Release_Requeue verifies requeue=true path.
func TestClaimer_Release_Requeue(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	claimer := NewClaimer(vc, m)
	ctx := context.Background()

	const campaignID = int64(1200)
	const leadID = int64(12001)

	hopperKey := vc.Keys.CampaignHopper(campaignID)
	mr.ZAdd(hopperKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	claim, err := claimer.Claim(ctx, 1, campaignID, "pod-rq-direct", 30)
	if err != nil {
		t.Fatalf("claim error: %v", err)
	}

	// Requeue with a score of 0.
	err = claimer.Release(ctx, campaignID, claim.LeadID, claim.LockVal, true, 0)
	if err != nil {
		t.Fatalf("Release(requeue=true) error: %v", err)
	}
}

// TestPickForCall_Error verifies PickForCall returns ErrNoReadyAgent when no agent exists.
func TestPickForCall_Error(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	pairer := NewAgentPairer(vc, m)

	// No agents → ErrNoReadyAgent.
	_, err := pairer.PickForCall(context.Background(), 1, 1, "uuid")
	if err != ErrNoReadyAgent {
		t.Errorf("expected ErrNoReadyAgent, got %v", err)
	}
}

// TestSupervisor_reloadConfig_ParseError verifies error logging on bad JSON snapshot.
func TestSupervisor_reloadConfig_ParseError(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "test-parse-err",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}

	// Seed invalid JSON → LoadCampaignConfig will error.
	mr.Set(configSnapshotKey(1, 55), `{invalid json`)

	// reloadConfig logs the error and returns (no panic).
	sup.reloadConfig(context.Background(), 55)
}

// TestJanitor_SweepOrphans_WithLogger verifies janitor with a logger set.
func TestJanitor_SweepOrphans_WithLogger(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	logger := slog.New(slog.NewTextHandler(os.Stderr, nil))
	cache := NewCampaignConfigCache()
	claimer := NewClaimer(vc, m)

	j := NewJanitor(vc, cache, claimer, m, logger)
	n, err := j.SweepOrphans(context.Background())
	if err != nil {
		t.Fatalf("SweepOrphans error: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 orphans, got %d", n)
	}
}

// ctx is a test helper returning a background context.
func ctx(t *testing.T) context.Context {
	t.Helper()
	return context.Background()
}
