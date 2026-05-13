// recovery_test.go — cold-start recovery tests.
//
// E05 PLAN §16.2: if drop_gated was present before crash, gate re-engaged within first tick.
package drop_gate

import (
	"context"
	"testing"
	"time"
)

// TestRecovery_GatedBeforeCrash: Valkey has drop_gated=1; recovery → HARD_BREACH.
func TestRecovery_GatedBeforeCrash(t *testing.T) {
	_, rc := newMiniRedis(t)

	cfg := CampaignConfig{
		TenantID:       1,
		CampaignID:     42,
		DialMethod:     "PROGRESSIVE",
		DropTargetSoft: 1.00,
		DropTargetMax:  1.50,
		RecoverSeconds: 300,
	}.ApplyDefaults()
	g, err := New(cfg, rc, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Pre-set drop_gated in Valkey (simulating state before crash).
	dropGatedKey := "t:1:campaign:{42}:drop_gated"
	engagedAtKey := "t:1:campaign:{42}:drop_gate_engaged_at"
	rc.Set(context.Background(), dropGatedKey, "1", 0)
	rc.Set(context.Background(), engagedAtKey,
		time.Now().Add(-5*time.Minute).UTC().Format(time.RFC3339), 0)

	// Run recovery (nil db → queryMysqlRaw returns 0,0 → warmup).
	if err := Recover(context.Background(), g, nil, rc); err != nil {
		t.Fatalf("Recover: %v", err)
	}

	// With drop_gated present and dropPct=0 (warmup), gate should stay HARD_BREACH.
	// (dropPct=0 < effectiveMax=1.50; but gated=true triggers HARD_BREACH path)
	if g.State() != StateHardBreach {
		t.Errorf("expected HARD_BREACH after recovery with drop_gated, got %s", g.State())
	}
}

// TestRecovery_NotGated: no drop_gated key; recovery → NORMAL.
func TestRecovery_NotGated(t *testing.T) {
	_, rc := newMiniRedis(t)

	cfg := CampaignConfig{
		TenantID:       1,
		CampaignID:     42,
		DialMethod:     "PROGRESSIVE",
		DropTargetSoft: 1.00,
		DropTargetMax:  1.50,
		RecoverSeconds: 300,
	}.ApplyDefaults()
	g, err := New(cfg, rc, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// No drop_gated key; dropPct=0 (warmup) → NORMAL.
	if err := Recover(context.Background(), g, nil, rc); err != nil {
		t.Fatalf("Recover: %v", err)
	}

	if g.State() != StateNormal {
		t.Errorf("expected NORMAL, got %s", g.State())
	}
}

// TestRecovery_GateReleasedAfterDwell: gate was set but dwell elapsed; first
// ticker tick should release. We test this by checking the gate transitions.
func TestRecovery_DwellStatePreserved(t *testing.T) {
	_, rc := newMiniRedis(t)

	cfg := CampaignConfig{
		TenantID:       1,
		CampaignID:     42,
		DialMethod:     "PROGRESSIVE",
		DropTargetSoft: 1.00,
		DropTargetMax:  1.50,
		RecoverSeconds: 60,
	}.ApplyDefaults()
	g, err := New(cfg, rc, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	// Set gate + engaged_at (5 minutes ago > 60s dwell).
	rc.Set(context.Background(), "t:1:campaign:{42}:drop_gated", "1", 0)
	engagedTime := time.Now().Add(-5 * time.Minute)
	rc.Set(context.Background(), "t:1:campaign:{42}:drop_gate_engaged_at",
		engagedTime.UTC().Format(time.RFC3339), 0)

	if err := Recover(context.Background(), g, nil, rc); err != nil {
		t.Fatalf("Recover: %v", err)
	}

	// Gate should be HARD_BREACH with engagedAt = 5 min ago.
	if g.State() != StateHardBreach {
		t.Errorf("expected HARD_BREACH, got %s", g.State())
	}

	ea := g.EngagedAt()
	if ea.IsZero() {
		t.Error("engagedAt should not be zero after recovery")
	}

	// Simulate a tick with dropPct=0.10 < releaseThreshold(0.50) and dwell elapsed.
	state, err := g.Tick(context.Background(), 0.10, 1000, tickInterval)
	if err != nil {
		t.Fatalf("Tick: %v", err)
	}
	// Dwell has elapsed (5 min > 60s) + dropPct(0.10) < release(0.50) → NORMAL.
	if state != StateNormal {
		t.Errorf("expected NORMAL after dwell tick, got %s", state)
	}
}
