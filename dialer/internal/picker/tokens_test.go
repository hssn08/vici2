package picker

import (
	"context"
	"fmt"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/vici2/dialer/internal/valkey"
)

// testMetrics returns an isolated Metrics instance using a fresh Prometheus
// registry, preventing duplicate-registration panics in parallel tests.
func testMetrics() *Metrics {
	return NewMetricsWithRegisterer(prometheus.NewRegistry())
}

func newTestValkey(t *testing.T) (*valkey.Client, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)

	vc, err := valkey.New(context.Background(), valkey.Config{
		URL:      "redis://" + mr.Addr(),
		TenantID: 1,
	})
	if err != nil {
		t.Fatalf("valkey.New: %v", err)
	}
	t.Cleanup(func() { vc.Close() })
	return vc, mr
}

func TestTokenBucket_AcquireSuccess(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	tb := NewTokenBucket(vc, m)
	ctx := context.Background()

	// Set tokens=3 manually.
	key := dispatchTokensKey(1, 42)
	mr.Set(key, "3")

	ok, err := tb.Acquire(ctx, 1, 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !ok {
		t.Error("expected ok=true, got false")
	}
	// Token should be 2 now.
	val, _ := mr.Get(key)
	if val != "2" {
		t.Errorf("expected token=2, got %s", val)
	}
}

func TestTokenBucket_AcquireNoTokens_KeyMissing(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	tb := NewTokenBucket(vc, m)
	ctx := context.Background()

	// Key does not exist: Redis/Valkey creates key at 0 and DECRs to -1.
	// This is treated as over-decrement (val < 0) → INCR back → ok=false, err=nil.
	// ErrNoTokens is only returned on actual Valkey error (connection failure etc).
	ok, err := tb.Acquire(ctx, 1, 99)
	if err != nil {
		t.Errorf("expected nil err for missing key, got: %v", err)
	}
	if ok {
		t.Error("expected ok=false when key is missing (no tokens available)")
	}
}

func TestTokenBucket_AcquireOverDecrement(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	tb := NewTokenBucket(vc, m)
	ctx := context.Background()

	// Set tokens=0 — DECR will yield -1 → over-decrement.
	key := dispatchTokensKey(1, 42)
	mr.Set(key, "0")

	ok, err := tb.Acquire(ctx, 1, 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if ok {
		t.Error("expected ok=false on over-decrement, got true")
	}
	// Key should have been INCR'd back to 0.
	val, _ := mr.Get(key)
	if val != "0" {
		t.Errorf("expected key restored to 0, got %s", val)
	}
}

func TestTokenBucket_Release(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	tb := NewTokenBucket(vc, m)
	ctx := context.Background()

	key := dispatchTokensKey(1, 42)
	mr.Set(key, "2")

	tb.Release(ctx, 1, 42)

	val, _ := mr.Get(key)
	if val != "3" {
		t.Errorf("expected token=3 after release, got %s", val)
	}
}

func TestDispatchTokensKey(t *testing.T) {
	key := dispatchTokensKey(1, 42)
	expected := fmt.Sprintf("t:%d:campaign:{%d}:dispatch_tokens", 1, 42)
	if key != expected {
		t.Errorf("key mismatch: got %q, want %q", key, expected)
	}
}
