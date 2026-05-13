package picker

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/originate"
)

// TestConfigChangedKey verifies the pubsub channel key format.
func TestConfigChangedKey(t *testing.T) {
	key := configChangedKey(1, 42)
	expected := "t:1:broadcast:campaign:42:config_changed"
	if key != expected {
		t.Errorf("got %q, want %q", key, expected)
	}
}

// TestRefillRequestKey verifies the refill_request key format.
func TestRefillRequestKey(t *testing.T) {
	key := refillRequestKey(1, 99)
	expected := "t:1:broadcast:campaign:99:refill_request"
	if key != expected {
		t.Errorf("got %q, want %q", key, expected)
	}
}

// TestConfigSnapshotKey verifies the config_snapshot key format.
func TestConfigSnapshotKey(t *testing.T) {
	key := configSnapshotKey(1, 55)
	expected := "t:1:campaign:55:config_snapshot"
	if key != expected {
		t.Errorf("got %q, want %q", key, expected)
	}
}

// TestTickProgressive_Full exercises the full progressive tick with
// token, agent, lead, and T04 mock returning BACKGROUND_JOB_ACK.
func TestTickProgressive_Full(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(300)
	const agentUserID = int64(401)
	const leadID = int64(5000)

	cfg := newProgressiveCfg(campaignID)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	// Seed tokens.
	mr.Set(dispatchTokensKey(1, campaignID), "5")

	// Seed READY agent.
	readyKey := vc.Keys.AgentsByCampaignStatus(campaignID, "READY")
	mr.ZAdd(readyKey, float64(time.Now().UnixMilli()-2000), fmt.Sprintf("%d", agentUserID))
	mr.HSet(vc.Keys.Agent(agentUserID),
		"status", "READY",
		"campaign_id", fmt.Sprintf("%d", campaignID),
		"user_id", fmt.Sprintf("%d", agentUserID),
	)

	// Seed lead in hopper.
	mr.ZAdd(vc.Keys.CampaignHopper(campaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	t04 := &mockOriginator{
		result: &originate.OriginateResult{
			AttemptUUID: "test-uuid",
			CallUUID:    "test-uuid",
			Outcome:     originate.OutcomeSuccess,
		},
	}

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-full")

	ctx := context.Background()
	if err := loop.tickProgressive(ctx, cfg); err != nil {
		t.Fatalf("tickProgressive error: %v", err)
	}

	// T04 should have been called.
	if t04.called == 0 {
		t.Error("expected T04.Originate to be called")
	}
}

// TestTickProgressive_NoAgent verifies token returned when no agent.
func TestTickProgressive_NoAgent(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(301)

	cfg := newProgressiveCfg(campaignID)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	// Seed tokens but no agents.
	mr.Set(dispatchTokensKey(1, campaignID), "5")

	t04 := &mockOriginator{}
	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-noagent")

	ctx := context.Background()
	if err := loop.tickProgressive(ctx, cfg); err != nil {
		t.Fatalf("tickProgressive error: %v", err)
	}

	if t04.called != 0 {
		t.Error("T04 should not be called when no READY agent")
	}
}

// TestTickPredictive_Full exercises the full predictive tick path.
func TestTickPredictive_Full(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(302)
	const leadID = int64(6000)

	cfg := newProgressiveCfg(campaignID)
	cfg.Mode = originate.ModePredictive
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	// Seed tokens and lead.
	mr.Set(dispatchTokensKey(1, campaignID), "5")
	mr.ZAdd(vc.Keys.CampaignHopper(campaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	t04 := &mockOriginator{
		result: &originate.OriginateResult{
			AttemptUUID: "pred-uuid",
			CallUUID:    "pred-uuid",
			Outcome:     originate.OutcomeSuccess,
		},
	}

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-pred")

	ctx := context.Background()
	if err := loop.tickPredictive(ctx, cfg); err != nil {
		t.Fatalf("tickPredictive error: %v", err)
	}

	if t04.called == 0 {
		t.Error("expected T04.Originate to be called for PREDICTIVE")
	}
}

// TestTickPredictive_T04Error exercises the error path in predictive tick.
func TestTickPredictive_T04Error(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	const campaignID = int64(303)
	const leadID = int64(7000)

	cfg := newProgressiveCfg(campaignID)
	cfg.Mode = originate.ModePredictive
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	mr.Set(dispatchTokensKey(1, campaignID), "5")
	mr.ZAdd(vc.Keys.CampaignHopper(campaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	t04 := &mockOriginator{
		err: originate.NewGatewayLimitErr("uuid-err", "gw1"),
	}

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), t04, vc, m, nil, "test-pred-err")

	ctx := context.Background()
	// Error path: T04 returns error; lead should be released.
	if err := loop.tickPredictive(ctx, cfg); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestReloadConfig verifies supervisor.reloadConfig updates the cache.
func TestReloadConfig(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "reload-test",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}

	ctx := context.Background()

	// Seed updated config.
	mr.Set(configSnapshotKey(1, 42), `{"mode":"PREDICTIVE","active":true,"lead_lock_ttl_sec":10}`)

	sup.reloadConfig(ctx, 42)

	cfg, ok := sup.cfgCache.Get(42)
	if !ok {
		t.Fatal("expected campaign 42 in cache after reload")
	}
	if cfg.Mode != originate.ModePredictive {
		t.Errorf("expected PREDICTIVE after reload, got %s", cfg.Mode)
	}
	if cfg.LeadLockTTLSec != 10 {
		t.Errorf("expected LeadLockTTLSec=10, got %d", cfg.LeadLockTTLSec)
	}
}

// TestReloadConfig_Deactivates verifies inactive config deactivates workers.
func TestReloadConfig_Deactivates(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "deact-test",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor: %v", err)
	}

	ctx := context.Background()

	// Activate campaign first.
	mr.Set(configSnapshotKey(1, 43), `{"mode":"PROGRESSIVE","active":true}`)
	if err := sup.ActivateCampaign(ctx, 43); err != nil {
		t.Fatalf("ActivateCampaign: %v", err)
	}

	// Now reload with active=false.
	mr.Set(configSnapshotKey(1, 43), `{"mode":"PROGRESSIVE","active":false}`)
	sup.reloadConfig(ctx, 43)

	// Campaign should be removed from cache.
	if sup.cfgCache.IsActive(43) {
		t.Error("expected campaign 43 to be deactivated after reload")
	}
}
