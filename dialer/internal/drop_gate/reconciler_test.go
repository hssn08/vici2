// reconciler_test.go — unit tests for Reconciler using miniredis.
//
// E05 PLAN §16.2: drift detection + fail-closed gating.
package drop_gate

import (
	"context"
	"fmt"
	"strconv"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newMiniRedis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis.Run: %v", err)
	}
	t.Cleanup(mr.Close)
	rc := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rc.Close() })
	return mr, rc
}

func buildReconcilerGate(t *testing.T, rc *redis.Client) *DropGate {
	t.Helper()
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
	return g
}

// seedStream adds n dropped=1 entries to the drop_window STREAM using the redis client.
func seedStream(t *testing.T, mr *miniredis.Miniredis, rc *redis.Client, campaignID int64, tenantID int64, n int) {
	t.Helper()
	_ = mr // miniredis used for server; writes via rc
	streamKey := fmt.Sprintf("t:%d:campaign:{%d}:drop_window", tenantID, campaignID)
	for i := 0; i < n; i++ {
		if err := rc.XAdd(context.Background(), &redis.XAddArgs{
			Stream: streamKey,
			Values: map[string]any{"answered": "1", "dropped": "1"},
		}).Err(); err != nil {
			t.Fatalf("seedStream XAdd: %v", err)
		}
	}
}

func TestReconciler_NoDrift(t *testing.T) {
	_, rc := newMiniRedis(t)
	g := buildReconcilerGate(t, rc)
	// No STREAM entries, no DB entries → drift = 0.
	alertCalled := false
	alertFn := func(ctx context.Context, severity, msg string, tid, cid int64) { alertCalled = true }
	r := NewReconciler(g, nil, rc, nil, alertFn)
	r.reconcile(context.Background())
	if alertCalled {
		t.Error("no drift: expected no alert")
	}
}

func TestReconciler_SevereDrift_GatesDefensively(t *testing.T) {
	mr, rc := newMiniRedis(t)
	g := buildReconcilerGate(t, rc)

	// 5 STREAM entries, 0 DB entries → severe drift.
	seedStream(t, mr, rc, 42, 1, 5)

	var pageAlerted bool
	alertFn := func(ctx context.Context, severity, msg string, tid, cid int64) {
		if severity == "PAGE" {
			pageAlerted = true
		}
	}
	r := NewReconciler(g, nil, rc, nil, alertFn)
	r.reconcile(context.Background())

	// Gate should be set in Valkey.
	dropGatedKey := "t:1:campaign:{42}:drop_gated"
	exists, err := rc.Exists(context.Background(), dropGatedKey).Result()
	if err != nil {
		t.Fatalf("EXISTS: %v", err)
	}
	if exists == 0 {
		t.Error("severe drift: expected drop_gated to be SET")
	}
	if !pageAlerted {
		t.Error("severe drift: expected PAGE alert")
	}
}

// ---------------------------------------------------------------------------
// Valkey key_tests: drop_count / drop_denominator / drop_pct keys
// ---------------------------------------------------------------------------

func TestTickerPublishesValkeyGauges(t *testing.T) {
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

	ticker := NewTicker(g, nil, rc, nil)
	// tick() with nil db returns (0,0); warmup floor applies.
	ticker.tick(context.Background())

	// Gauges must be published.
	pctKey := "t:1:campaign:{42}:drop_pct_30d"
	v, err := rc.Get(context.Background(), pctKey).Result()
	if err != nil {
		t.Fatalf("GET %s: %v", pctKey, err)
	}
	// Warmup: denominator=0 < 100 → drop_pct=0.
	pct, _ := strconv.ParseFloat(v, 64)
	if pct != 0.0 {
		t.Errorf("warmup: expected drop_pct=0.00, got %s", v)
	}
}
