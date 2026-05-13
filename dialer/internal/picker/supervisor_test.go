package picker

import (
	"context"
	"testing"
	"time"
)

// TestNewSupervisor_Defaults verifies Supervisor construction with defaults.
func TestNewSupervisor_Defaults(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor error: %v", err)
	}
	if sup == nil {
		t.Fatal("expected non-nil Supervisor")
	}
	// PodID should have been auto-generated.
	if sup.cfg.PodID == "" {
		t.Error("PodID should be auto-generated")
	}
}

// TestSupervisor_ActivateAndDeactivate verifies campaign worker lifecycle.
func TestSupervisor_ActivateAndDeactivate(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	// Seed a config snapshot for the campaign.
	mr.Set(configSnapshotKey(1, 42), `{"mode":"PROGRESSIVE","active":true,"lead_lock_ttl_sec":5}`)

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "test-pod",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor error: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	if err := sup.ActivateCampaign(ctx, 42); err != nil {
		t.Fatalf("ActivateCampaign error: %v", err)
	}

	// Verify campaign is active in cache.
	if !sup.cfgCache.IsActive(42) {
		t.Error("expected campaign 42 to be active")
	}

	// Deactivate and verify workers are cancelled.
	sup.DeactivateCampaign(42)

	// Small sleep to allow goroutines to exit.
	time.Sleep(10 * time.Millisecond)

	if sup.cfgCache.IsActive(42) {
		t.Error("expected campaign 42 to be inactive after deactivation")
	}
}

// TestSupervisor_SweepOrphans verifies the janitor integration.
func TestSupervisor_SweepOrphans(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "test-pod",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor error: %v", err)
	}

	// No active campaigns → 0 orphans.
	n, err := sup.SweepOrphans(context.Background())
	if err != nil {
		t.Fatalf("SweepOrphans error: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 orphans, got %d", n)
	}
}

// TestSupervisor_Stop verifies graceful stop of all workers.
func TestSupervisor_Stop(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()

	mr.Set(configSnapshotKey(1, 77), `{"mode":"PROGRESSIVE","active":true}`)

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "test-stop",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor error: %v", err)
	}

	ctx := context.Background()
	if err := sup.ActivateCampaign(ctx, 77); err != nil {
		t.Fatalf("ActivateCampaign: %v", err)
	}

	// Stop should not panic.
	if err := sup.Stop(ctx); err != nil {
		t.Fatalf("Stop error: %v", err)
	}
}

// TestSupervisor_DispatchManual_CampaignNotActive verifies error on missing campaign.
func TestSupervisor_DispatchManual_CampaignNotActive(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()

	sup, err := NewSupervisor(SupervisorConfig{
		TenantID:     1,
		PodID:        "test-manual",
		ValkeyClient: vc,
		Metrics:      m,
		T04:          &mockOriginator{},
	})
	if err != nil {
		t.Fatalf("NewSupervisor error: %v", err)
	}

	_, err = sup.DispatchManual(context.Background(), ManualDispatchRequest{
		TenantID:   1,
		CampaignID: 9999,
		AgentID:    1,
		LeadID:     100,
	})
	if err == nil {
		t.Error("expected error for campaign not in active cache")
	}
}
