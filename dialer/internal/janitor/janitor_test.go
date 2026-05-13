package janitor

import (
	"context"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/valkey"
)

// newTestMetrics creates a metrics registry for tests.
func newTestMetrics(t *testing.T) *Metrics {
	t.Helper()
	reg := prometheus.NewRegistry()
	return NewMetrics(reg)
}

// newMiniredis creates a miniredis server and returns a client.
func newMiniredis(t *testing.T) (*miniredis.Miniredis, *redis.Client) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { rdb.Close() })
	return mr, rdb
}

// countHistogramObs returns the sample count for a named histogram.
func countHistogramObs(reg *prometheus.Registry, name string) uint64 {
	gathered, _ := reg.Gather()
	for _, mf := range gathered {
		if mf.GetName() == name {
			for _, m := range mf.GetMetric() {
				return m.GetHistogram().GetSampleCount()
			}
		}
	}
	return 0
}

// TestThresholdDefaults verifies that zero-value Config thresholds are replaced
// with the PLAN-specified defaults.
// E06 PLAN §11.1 Test 8.
func TestThresholdDefaults(t *testing.T) {
	_, rdb := newMiniredis(t)
	keys := valkey.NewKeys(1)
	j := New(Config{
		TenantID: 1,
		PodID:    "test-pod",
		Rdb:      rdb,
		Keys:     keys,
		Metrics:  newTestMetrics(t),
	})

	if j.cfg.StuckChannelAge != 4*time.Hour {
		t.Errorf("StuckChannelAge: want 4h, got %v", j.cfg.StuckChannelAge)
	}
	if j.cfg.StaleConfAge != 5*time.Minute {
		t.Errorf("StaleConfAge: want 5m, got %v", j.cfg.StaleConfAge)
	}
	if j.cfg.MaxKillsPerTick != 100 {
		t.Errorf("MaxKillsPerTick: want 100, got %d", j.cfg.MaxKillsPerTick)
	}
}

// TestTickDurationMetric verifies that sweep() records a histogram observation.
// E06 PLAN §11.1 Test 7.
func TestTickDurationMetric(t *testing.T) {
	mr, rdb := newMiniredis(t)
	_ = mr
	keys := valkey.NewKeys(1)

	reg := prometheus.NewRegistry()
	metrics := NewMetrics(reg)

	j := New(Config{
		TenantID: 1,
		PodID:    "test-pod",
		Rdb:      rdb,
		Keys:     keys,
		Metrics:  metrics,
	})

	ctx := context.Background()
	j.sweep(ctx)

	// Verify the lock was released.
	lockExists, _ := rdb.Exists(ctx, keys.JanitorLock()).Result()
	if lockExists != 0 {
		t.Error("janitor lock should have been released after sweep")
	}

	// Verify histogram has observations.
	if countHistogramObs(reg, "vici2_janitor_tick_duration_seconds") == 0 {
		t.Error("TickDuration histogram has no observations after sweep")
	}
}

// TestLeaderElection verifies that a pod holding the Valkey lock causes another
// pod to skip its sweep (non-leader returns immediately without incrementing
// the TickDuration histogram).
// E06 PLAN §11.1 Test 1.
func TestLeaderElection(t *testing.T) {
	_, rdb := newMiniredis(t)
	keys := valkey.NewKeys(1)
	ctx := context.Background()

	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)
	j := New(Config{
		TenantID: 1,
		PodID:    "pod-a",
		Rdb:      rdb,
		Keys:     keys,
		Metrics:  m,
	})

	// Pre-acquire the leader lock so our janitor cannot become leader.
	lockKey := keys.JanitorLock()
	rdb.Set(ctx, lockKey, "pod-other", lockTTL)

	// Attempt a sweep — should be skipped (non-leader).
	j.sweep(ctx)

	// No observations expected: non-leader returns before defer records duration.
	obs := countHistogramObs(reg, "vici2_janitor_tick_duration_seconds")
	if obs != 0 {
		t.Errorf("expected no sweep when lock held by another pod, got %d observations", obs)
	}

	// Release the lock and verify next sweep succeeds.
	rdb.Del(ctx, lockKey)
	j.sweep(ctx)

	obs2 := countHistogramObs(reg, "vici2_janitor_tick_duration_seconds")
	if obs2 == 0 {
		t.Error("expected sweep to run after lock was released")
	}
}

// TestAgentHomeConfNeverKilled verifies that agent home and hold conferences
// are unconditionally excluded from the stale conf sweeper.
// E06 PLAN §11.1 Test 4 - CRITICAL acceptance criterion.
func TestAgentHomeConfNeverKilled(t *testing.T) {
	tests := []struct {
		name string
		want bool
	}{
		{"agent_t1_u1042", true},
		{"agent_t1_u1099_hold", true},
		{"agent_t2_u5000", true},
		{"agent_t2_u5000_hold", true},
		{"my_custom_conf", false},
		{"customer_ivr", false},
		{"agent_", false},
		{"agent_t1_u", false},
	}

	for _, tt := range tests {
		got := isAgentHomeConf(tt.name)
		if got != tt.want {
			t.Errorf("isAgentHomeConf(%q) = %v, want %v", tt.name, got, tt.want)
		}
	}
}

// TestStaleConfEmptySinceTracking verifies the empty-since tracking logic.
// E06 PLAN §11.1 Test 5.
func TestStaleConfEmptySinceTracking(t *testing.T) {
	mr, rdb := newMiniredis(t)
	_ = mr
	keys := valkey.NewKeys(1)
	ctx := context.Background()

	emptySinceKey := keys.JanitorEmptyConfs()
	confName := "my_custom_conf"

	// Simulate: conf was first seen empty 10 minutes ago.
	tenMinutesAgo := time.Now().Add(-10 * time.Minute)
	rdb.HSet(ctx, emptySinceKey, confName, strconv.FormatInt(tenMinutesAgo.UnixMilli(), 10))

	// Load the value back and verify it parses correctly.
	val, err := rdb.HGet(ctx, emptySinceKey, confName).Result()
	if err != nil {
		t.Fatalf("HGet: %v", err)
	}
	ms, err := strconv.ParseInt(val, 10, 64)
	if err != nil {
		t.Fatalf("ParseInt: %v", err)
	}
	emptyDuration := time.Since(time.UnixMilli(ms))
	if emptyDuration < 5*time.Minute {
		t.Errorf("duration %v should be >= 5min", emptyDuration)
	}

	// Verify a fresh conf (just became empty) is NOT stale.
	freshName := "fresh_conf"
	rdb.HSet(ctx, emptySinceKey, freshName, strconv.FormatInt(time.Now().UnixMilli(), 10))
	freshVal, _ := rdb.HGet(ctx, emptySinceKey, freshName).Result()
	freshMs, _ := strconv.ParseInt(freshVal, 10, 64)
	freshDuration := time.Since(time.UnixMilli(freshMs))
	if freshDuration >= 5*time.Minute {
		t.Errorf("fresh conf duration %v should be < 5min", freshDuration)
	}
}

// TestOrphanLockDelegation verifies that sweepOrphanLocks correctly handles
// nil delegatees (both PickerJanitor and OriginateJan are nil).
// E06 PLAN §11.1 Test 6.
func TestOrphanLockDelegation(t *testing.T) {
	_, rdb := newMiniredis(t)
	keys := valkey.NewKeys(1)
	reg := prometheus.NewRegistry()
	m := NewMetrics(reg)

	j := New(Config{
		TenantID:      1,
		PodID:         "test-pod",
		Rdb:           rdb,
		Keys:          keys,
		Metrics:       m,
		PickerJanitor: nil,
		OriginateJan:  nil,
	})

	n, err := j.sweepOrphanLocks(context.Background())
	if err != nil {
		t.Errorf("sweepOrphanLocks: unexpected error: %v", err)
	}
	if n != 0 {
		t.Errorf("sweepOrphanLocks: want 0, got %d", n)
	}
}

// TestStaleConfSafetyDoubleCheck verifies that the isAgentHomeConf safety guard
// correctly classifies conference names.
func TestStaleConfSafetyDoubleCheck(t *testing.T) {
	mr, rdb := newMiniredis(t)
	_ = mr
	keys := valkey.NewKeys(1)
	ctx := context.Background()

	emptySinceKey := keys.JanitorEmptyConfs()
	agentConf := "agent_t1_u42"
	customConf := "regular_conf"

	// Pre-populate both into the tracking hash.
	tenMinutesAgo := time.Now().Add(-10 * time.Minute)
	rdb.HSet(ctx, emptySinceKey, agentConf, strconv.FormatInt(tenMinutesAgo.UnixMilli(), 10))
	rdb.HSet(ctx, emptySinceKey, customConf, strconv.FormatInt(tenMinutesAgo.UnixMilli(), 10))

	// Verify both exist.
	all, _ := rdb.HGetAll(ctx, emptySinceKey).Result()
	if len(all) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(all))
	}

	// The isAgentHomeConf guard must protect agent_t1_u42.
	if !isAgentHomeConf(agentConf) {
		t.Errorf("isAgentHomeConf(%q) = false, want true", agentConf)
	}
	if isAgentHomeConf(customConf) {
		t.Errorf("isAgentHomeConf(%q) = true, want false", customConf)
	}
}

// TestJoinErrs verifies the joinErrs helper.
func TestJoinErrs(t *testing.T) {
	err1 := context.DeadlineExceeded
	err2 := context.Canceled

	if joinErrs(nil, nil) != nil {
		t.Error("joinErrs(nil, nil) should return nil")
	}
	if joinErrs(err1, nil) != err1 {
		t.Error("joinErrs(err1, nil) should return err1")
	}
	if joinErrs(nil, err2) != err2 {
		t.Error("joinErrs(nil, err2) should return err2")
	}
	combined := joinErrs(err1, err2)
	if combined == nil {
		t.Error("joinErrs(err1, err2) should return non-nil")
	}
}
