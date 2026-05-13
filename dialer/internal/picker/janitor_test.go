package picker

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/originate"
)

// TestJanitor_SweepOrphans_NoActiveCampaigns verifies no-op with empty cache.
func TestJanitor_SweepOrphans_NoActiveCampaigns(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	cache := NewCampaignConfigCache()
	claimer := NewClaimer(vc, m)

	j := NewJanitor(vc, cache, claimer, m, nil)
	n, err := j.SweepOrphans(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 orphans, got %d", n)
	}
}

// TestJanitor_SweepOrphans_FreshClaims are not reaped.
func TestJanitor_SweepOrphans_FreshClaims(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	cache := NewCampaignConfigCache()
	claimer := NewClaimer(vc, m)

	cfg := CampaignConfig{TenantID: 1, CampaignID: 10, Active: true, Mode: originate.ModeProgressive}
	cache.Set(cfg)

	// Write a fresh in_flight entry (claimed 1 minute ago, within threshold).
	key := fmt.Sprintf("t:%d:campaign:{%d}:in_flight", 1, 10)
	freshTs := time.Now().Add(-1 * time.Minute).UnixMilli()
	mr.HSet(key, "100", fmt.Sprintf("pod1:%d", freshTs))

	j := NewJanitor(vc, cache, claimer, m, nil)
	n, err := j.SweepOrphans(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("expected 0 orphans for fresh claim, got %d", n)
	}
}

// TestJanitor_SweepOrphans_OldClaims are reaped.
func TestJanitor_SweepOrphans_OldClaims(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	cache := NewCampaignConfigCache()
	claimer := NewClaimer(vc, m)

	cfg := CampaignConfig{TenantID: 1, CampaignID: 20, Active: true, Mode: originate.ModeProgressive}
	cache.Set(cfg)

	// Write an old in_flight entry (claimed 6 minutes ago, exceeds 5 min threshold).
	key := fmt.Sprintf("t:%d:campaign:{%d}:in_flight", 1, 20)
	oldTs := time.Now().Add(-6 * time.Minute).UnixMilli()
	mr.HSet(key, "200", fmt.Sprintf("pod1:%d", oldTs))

	// Also write the lock key so Release has something to operate on.
	lockKey := vc.Keys.LeadLock(20, 200)
	mr.Set(lockKey, fmt.Sprintf("pod1:%d", oldTs))

	j := NewJanitor(vc, cache, claimer, m, nil)
	n, err := j.SweepOrphans(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if n != 1 {
		t.Errorf("expected 1 orphan reaped, got %d", n)
	}
}

// TestParseInFlightEntry_ValidFormat verifies parsing of instanceID:ts_ms.
func TestParseInFlightEntry_ValidFormat(t *testing.T) {
	ts := time.Now().Add(-10 * time.Minute)
	tsMs := ts.UnixMilli()
	val := fmt.Sprintf("pod-abc-123:%d", tsMs)

	claimTs, lockVal := parseInFlightEntry(val)
	if lockVal != val {
		t.Errorf("lockVal mismatch: got %q, want %q", lockVal, val)
	}
	diff := claimTs.Sub(time.UnixMilli(tsMs)).Abs()
	if diff > time.Millisecond {
		t.Errorf("claimTs off by %v", diff)
	}
}

// TestParseInFlightEntry_InvalidFormat returns zero time gracefully.
func TestParseInFlightEntry_InvalidFormat(t *testing.T) {
	ts, _ := parseInFlightEntry("invalid-no-colon")
	if !ts.IsZero() {
		t.Errorf("expected zero time for invalid format, got %v", ts)
	}
}

// TestOrphanAgeThreshold is the documented 5-minute threshold.
func TestOrphanAgeThreshold(t *testing.T) {
	if orphanAgeThreshold != 5*time.Minute {
		t.Errorf("orphanAgeThreshold should be 5 minutes, got %v", orphanAgeThreshold)
	}
}
