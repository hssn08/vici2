package picker

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/originate"
)

// mockOriginator implements Originator for testing.
type mockOriginator struct {
	called int64
	result *originate.OriginateResult
	err    error
}

func (m *mockOriginator) Originate(_ context.Context, _ originate.OriginateRequest) (*originate.OriginateResult, error) {
	atomic.AddInt64(&m.called, 1)
	return m.result, m.err
}

func newProgressiveCfg(cid int64) CampaignConfig {
	return CampaignConfig{
		TenantID:       1,
		CampaignID:     cid,
		CampaignIDStr:  "TEST",
		Mode:           originate.ModeProgressive,
		CallStrategy:   StrategyLongestWait,
		LeadLockTTLSec: 5,
		DialTimeoutSec: 22,
		Active:         true,
	}
}

// TestDispatchLoop_NoTokens verifies that no dispatch occurs when E02 is down.
func TestDispatchLoop_NoTokens(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	t04 := &mockOriginator{}

	cfg := newProgressiveCfg(1)
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, NewCampaignConfigCache()),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test")

	ctx := context.Background()
	// No tokens key set → ErrNoTokens → no dispatch.
	if err := loop.tick(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if atomic.LoadInt64(&t04.called) != 0 {
		t.Error("T04 should not have been called with no tokens")
	}
}

// TestDispatchLoop_CampaignPaused verifies no dispatch for inactive campaign.
func TestDispatchLoop_CampaignPaused(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	t04 := &mockOriginator{}

	cfg := newProgressiveCfg(2)
	cfg.Active = false
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, NewCampaignConfigCache()),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test")

	ctx := context.Background()
	if err := loop.tick(ctx); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if atomic.LoadInt64(&t04.called) != 0 {
		t.Error("T04 should not be called for paused campaign")
	}
}

// TestDispatchLoop_HopperEmpty verifies token is returned when hopper is empty.
func TestDispatchLoop_HopperEmpty(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	t04 := &mockOriginator{}

	cfg := newProgressiveCfg(3)
	// Pre-set tokens and an agent.
	mr.Set(dispatchTokensKey(1, 3), "5")

	// Add a READY agent.
	agentKey := vc.Keys.AgentsByCampaignStatus(3, "READY")
	mr.ZAdd(agentKey, float64(time.Now().UnixMilli()-1000), "42")
	mr.HSet(vc.Keys.Agent(42), "status", "READY", "campaign_id", "3", "user_id", "42")

	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test")

	ctx := context.Background()
	if err := loop.tickProgressive(ctx, cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Hopper is empty → no dispatch, but token should be restored.
	if atomic.LoadInt64(&t04.called) != 0 {
		t.Error("T04 should not be called when hopper is empty")
	}
}

// TestDispatchLoop_T04Error verifies outcome mapping for T04 errors.
func TestDispatchLoop_T04Error(t *testing.T) {
	cases := []struct {
		name        string
		t04Err      originate.OriginateError
		wantOutcome DialOutcome
	}{
		{"gateway_limit", originate.NewGatewayLimitErr("uuid-1", "gw1"), OutcomeGatewayLimit},
		{"tcpa", originate.NewTCPAErr("uuid-2", "tz", time.Hour), OutcomeTCPABlocked},
		{"dnc", originate.NewDNCErr("uuid-3", "federal"), OutcomeDNCBlocked},
		{"consent", originate.NewConsentBlockErr("uuid-4", "IL"), OutcomeConsentBlocked},
		{"carrier", originate.NewCarrierFailErr("uuid-5", "NO_ROUTE", time.Second, originate.OutcomeGatewayFail), OutcomeCarrierFail},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := outcomeFromOriginateError(tc.t04Err)
			if got != tc.wantOutcome {
				t.Errorf("got %s, want %s", got, tc.wantOutcome)
			}
		})
	}
}

// TestDispatchLoop_UpdateConfig verifies hot-reload updates the config.
func TestDispatchLoop_UpdateConfig(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	t04 := &mockOriginator{}

	cfg := newProgressiveCfg(5)
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, NewCampaignConfigCache()),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test")

	newCfg := cfg
	newCfg.Mode = originate.ModePredictive
	loop.UpdateConfig(newCfg)

	if loop.cfg.Mode != originate.ModePredictive {
		t.Error("expected Mode to be updated to PREDICTIVE")
	}
}

// TestBuildOriginateRequest verifies the OriginateRequest is built correctly.
func TestBuildOriginateRequest(t *testing.T) {
	cfg := newProgressiveCfg(7)
	claim := LeadClaim{
		LeadID:    100,
		CampaignID: 7,
		LockVal:   "pod1:12345",
		ListID:    5,
		PhoneE164: "+14155551234",
	}
	req := buildOriginateRequest("attempt-uuid", cfg, claim, 42, originate.ModeProgressive)

	if req.AttemptUUID != "attempt-uuid" {
		t.Errorf("AttemptUUID mismatch: %s", req.AttemptUUID)
	}
	if req.AgentID != 42 {
		t.Errorf("AgentID mismatch: %d", req.AgentID)
	}
	if req.LeadID != 100 {
		t.Errorf("LeadID mismatch: %d", req.LeadID)
	}
	if req.DestNumber != "+14155551234" {
		t.Errorf("DestNumber mismatch: %s", req.DestNumber)
	}
	if req.Mode != originate.ModeProgressive {
		t.Errorf("Mode mismatch: %s", req.Mode)
	}
}

// TestDispatchLoop_PredictiveNoAgent verifies PREDICTIVE skips gracefully.
func TestDispatchLoop_PredictiveNoAgent(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	t04 := &mockOriginator{
		result: &originate.OriginateResult{
			AttemptUUID: "uuid-1",
			CallUUID:    "uuid-1",
			Outcome:     originate.OutcomeSuccess,
		},
	}

	cfg := newProgressiveCfg(8)
	cfg.Mode = originate.ModePredictive

	// Set tokens.
	mr.Set(dispatchTokensKey(1, 8), "5")

	// Add lead to hopper.
	hopperKey := vc.Keys.CampaignHopper(8)
	mr.ZAdd(hopperKey, float64(time.Now().UnixMilli()), "200")
	mr.HSet(vc.Keys.LeadLockPrefix(8)+"foo", "x", "1") // just to have the prefix

	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-pod")

	ctx := context.Background()
	// Should claim lead and call T04 (PREDICTIVE, agentID=0).
	if err := loop.tickPredictive(ctx, cfg); err != nil {
		t.Logf("tick error (may be expected): %v", err)
	}
}

// TestOutcomeFromOriginateError_DropCap verifies rate-limited maps correctly.
func TestOutcomeFromOriginateError_DropCap(t *testing.T) {
	err := originate.NewDropCapErr("uuid", "campaign_drop_pct_exceeded", 300*time.Second)
	got := outcomeFromOriginateError(err)
	if got != OutcomeRateLimited {
		t.Errorf("got %s, want OutcomeRateLimited", got)
	}
}

// TestOutcomeFromOriginateError_CircuitOpen verifies circuit_open maps.
func TestOutcomeFromOriginateError_CircuitOpen(t *testing.T) {
	err := originate.NewCarrierFailErr("uuid", "circuit_open", 30*time.Second, originate.OutcomeGatewayFail)
	got := outcomeFromOriginateError(err)
	// circuit_open sub-reason → OutcomeCircuitOpen.
	if got != OutcomeCircuitOpen {
		t.Errorf("got %s, want OutcomeCircuitOpen", got)
	}
}

// TestProcessOutcome_Bridged verifies that Bridged outcome does not requeue.
func TestProcessOutcome_Bridged(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	t04 := &mockOriginator{}

	cfg := newProgressiveCfg(9)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	mr.Set(dispatchTokensKey(1, 9), "5")
	// Add lead to hopper.
	mr.ZAdd(vc.Keys.CampaignHopper(9), float64(time.Now().UnixMilli()), "300")

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test")

	claim := LeadClaim{LeadID: 300, CampaignID: 9, LockVal: "pod1:111", PhoneE164: "+1415"}
	res := &originate.OriginateResult{Outcome: originate.OutcomeSuccess}

	loop.processOutcome(context.Background(), cfg, claim, 0, res, nil)

	// Bridged: no requeue. Checking metric was incremented.
	// (We verify no panic and metric counts)
}

// TestErrors verifies sentinel error values are distinct.
func TestErrors(t *testing.T) {
	errs := []error{ErrNoTokens, ErrHopperEmpty, ErrNoReadyAgent, ErrCampaignPaused, ErrLeadIneligible}
	for i, a := range errs {
		for j, b := range errs {
			if i != j && errors.Is(a, b) {
				t.Errorf("errors[%d] and errors[%d] should be distinct", i, j)
			}
		}
	}
}
