// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt_test

import (
	"context"
	"math"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/adapt"
)

func miniRedis(t *testing.T) *redis.Client {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	return redis.NewClient(&redis.Options{Addr: mr.Addr()})
}

func TestPaceStateRoundTrip(t *testing.T) {
	t.Parallel()
	rdb := miniRedis(t)
	ctx := context.Background()

	now := time.Now().UTC().Truncate(time.Millisecond)
	ps := adapt.PaceState{
		IntegralTerm:         0.123,
		LastLevel:            2.15,
		LastTickTs:           now,
		LastDropPct:          1.42,
		LastAction:           "raise",
		WarmUpCallsRemaining: 37,
		WarmUpStartedAt:      now.Add(-3 * time.Minute),
		ClampActiveSince:     time.Time{},
		TickCount:            42,
	}

	if err := adapt.SavePaceState(ctx, rdb, 1, 101, ps); err != nil {
		t.Fatalf("save: %v", err)
	}

	got, ok, err := adapt.LoadPaceState(ctx, rdb, 1, 101)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if !ok {
		t.Fatal("expected found=true")
	}

	if math.Abs(got.IntegralTerm-ps.IntegralTerm) > 0.0001 {
		t.Errorf("IntegralTerm: got %.4f, want %.4f", got.IntegralTerm, ps.IntegralTerm)
	}
	if math.Abs(got.LastLevel-ps.LastLevel) > 0.01 {
		t.Errorf("LastLevel: got %.2f, want %.2f", got.LastLevel, ps.LastLevel)
	}
	if !got.LastTickTs.Equal(ps.LastTickTs) {
		t.Errorf("LastTickTs: got %v, want %v", got.LastTickTs, ps.LastTickTs)
	}
	if got.LastAction != ps.LastAction {
		t.Errorf("LastAction: got %q, want %q", got.LastAction, ps.LastAction)
	}
	if got.WarmUpCallsRemaining != ps.WarmUpCallsRemaining {
		t.Errorf("WarmUpCallsRemaining: got %d, want %d", got.WarmUpCallsRemaining, ps.WarmUpCallsRemaining)
	}
	if got.TickCount != ps.TickCount {
		t.Errorf("TickCount: got %d, want %d", got.TickCount, ps.TickCount)
	}
}

func TestPaceStateColdStart(t *testing.T) {
	t.Parallel()
	rdb := miniRedis(t)
	ctx := context.Background()

	_, ok, err := adapt.LoadPaceState(ctx, rdb, 1, 9999)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Fatal("expected cold-start (not found)")
	}
}

func TestInitPaceState(t *testing.T) {
	t.Parallel()
	cfg := adapt.Config{
		TenantID: 1, CampaignID: 1,
		Mode: adapt.DialMethodAdaptAvg, AdaptiveDropPct: 1.5,
		AdaptiveMaxLevel: 3.0, AutoDialLevel: 1.5, Intensity: 0,
		HoldBandPP: 0.30, AdaptTickSeconds: 15, WarmupMinAnswered: 50,
		WarmupMinSeconds: 300, DropGatedDebounce: 30,
	}
	now := time.Now()
	ps := adapt.InitPaceState(cfg, now)

	if ps.IntegralTerm != 0 {
		t.Errorf("expected zero integral, got %.4f", ps.IntegralTerm)
	}
	if ps.LastLevel != 1.5 {
		t.Errorf("expected level=1.5, got %.2f", ps.LastLevel)
	}
	if ps.WarmUpCallsRemaining != 50 {
		t.Errorf("expected 50 calls remaining, got %d", ps.WarmUpCallsRemaining)
	}
	if !ps.WarmUpStartedAt.Equal(now) {
		t.Errorf("WarmUpStartedAt mismatch")
	}
}
