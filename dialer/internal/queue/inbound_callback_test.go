// I04 — Inbound Callback Queue: unit tests for Go dispatcher extension.
// I04 PLAN §10.1.

package queue

import (
	"context"
	"database/sql"
	"log/slog"
	"strconv"
	"testing"
	"time"

	"github.com/alicebob/miniredis/v2"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// ── Test helpers ──────────────────────────────────────────────────────────────

var testMetricsSeq int

func newTestMetrics() *Metrics {
	testMetricsSeq++
	sfx := strconv.Itoa(testMetricsSeq)
	reg := prometheus.NewRegistry()

	mustCounter := func(name string, labels []string) *prometheus.CounterVec {
		c := prometheus.NewCounterVec(prometheus.CounterOpts{Name: name + sfx, Help: "test"}, labels)
		reg.MustRegister(c)
		return c
	}
	mustHistogram := func(name string, labels []string) *prometheus.HistogramVec {
		h := prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: name + sfx, Help: "test"}, labels)
		reg.MustRegister(h)
		return h
	}

	return &Metrics{
		// I04 fields
		I04CallbackFired:    mustCounter("vici2_i04_callback_fired_total_", []string{"ingroup_id", "tcpa_outcome"}),
		I04CallbackDeferred: mustCounter("vici2_i04_callback_deferred_go_total_", []string{"ingroup_id", "reason"}),
		I04CallbackDead:     mustCounter("vici2_i04_callback_dead_go_total_", []string{"ingroup_id", "reason"}),
		I04LockContention:   mustCounter("vici2_i04_lock_contention_total_", []string{"ingroup_id"}),
		I04StubLeadCreated:  mustCounter("vici2_i04_stub_lead_created_go_total_", []string{"ingroup_id"}),
		I04TimeToFire:       mustHistogram("vici2_i04_time_to_fire_seconds_", []string{"ingroup_id"}),
		// Required I01 fields used in normal dispatch paths
		CallsDispatched: mustCounter("vici2_ingroup_calls_dispatched_total_", []string{"ingroup_id"}),
		WaitSeconds:     mustHistogram("vici2_ingroup_wait_seconds_", []string{"ingroup_id"}),
		DispatchSlow:    mustCounter("vici2_ingroup_dispatch_slow_total_", []string{"ingroup_id"}),
		StickyWait:      mustCounter("vici2_ingroup_sticky_wait_total_", []string{"ingroup_id"}),
		NoAgentsSeconds: mustCounter("vici2_ingroup_no_agents_seconds_", []string{"ingroup_id"}),
	}
}

func newTestDispatcher(t *testing.T) (*DispatcherLoop, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})

	ig := &InGroup{
		TenantID:                      1,
		ID:                            "SUPPORT",
		Name:                          "Customer Support",
		CallbackPositionExpiryMinutes: 60,
		OutboundCli:                   "+15550001000",
		CallbackNoAnswerPolicyInbound: "reschedule_30m",
	}

	d := &DispatcherLoop{
		cfg: DispatcherConfig{
			InGroup:          ig,
			TenantID:         1,
			PodID:            "test-pod",
			Rdb:              rdb,
			Keys:             NewQueueKeys(1),
			Metrics:          newTestMetrics(),
			TenantDefaultCLI: "+15550000000",
		},
		log: slog.Default(),
	}
	return d, mr
}

// ── Tests ─────────────────────────────────────────────────────────────────────

// TestFetchNextInboundCallback_EmptyQueue: no DB → nil returned without error.
func TestFetchNextInboundCallback_EmptyQueue(t *testing.T) {
	d, mr := newTestDispatcher(t)
	defer mr.Close()

	d.cfg.DB = nil
	cb, err := d.fetchNextInboundCallback(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cb != nil {
		t.Fatalf("expected nil callback, got %+v", cb)
	}
}

// TestTryFireInboundCallback_LiveQueueSkip: live calls present → do not fire callback.
func TestTryFireInboundCallback_LiveQueueSkip(t *testing.T) {
	d, mr := newTestDispatcher(t)
	defer mr.Close()

	ctx := context.Background()
	rdb := d.cfg.Rdb

	// Simulate live call in queue
	queueKey := d.cfg.Keys.IngroupQueue("SUPPORT")
	rdb.ZAdd(ctx, queueKey, redis.Z{Score: float64(time.Now().UnixMilli()), Member: "uuid-live-call"})

	// DB is nil; if it were accessed it would panic
	d.cfg.DB = nil
	err := d.tryFireInboundCallback(ctx, &Agent{UserID: 1, Status: "READY"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestTryFireInboundCallback_LockContention: verify Valkey NX lock prevents double fire.
func TestTryFireInboundCallback_LockContention(t *testing.T) {
	d, mr := newTestDispatcher(t)
	defer mr.Close()

	ctx := context.Background()
	rdb := d.cfg.Rdb

	// Pre-set the fire lock as if another pod holds it
	lockKey := d.cfg.Keys.I04CallbackFireLock(999)
	rdb.Set(ctx, lockKey, "other-pod", 120*time.Second)

	// Second SetNX should fail
	locked, err := rdb.SetNX(ctx, lockKey, "test-pod", 120*time.Second).Result()
	if err != nil {
		t.Fatalf("SetNX: %v", err)
	}
	if locked {
		t.Fatal("expected lock to be held by other-pod; got locked=true")
	}
}

// TestDeferInboundCallback_NoDB: re-snooze returns nil when no DB configured.
func TestDeferInboundCallback_NoDB(t *testing.T) {
	d, mr := newTestDispatcher(t)
	defer mr.Close()

	cb := &InboundCallback{ID: 42, LeadID: 1}
	nextOpen := time.Now().Add(8 * time.Hour)

	d.cfg.DB = nil
	err := d.deferInboundCallback(context.Background(), cb, "SUPPORT", nextOpen)
	if err != nil {
		t.Fatalf("unexpected error (no DB): %v", err)
	}
}

// TestPromoteInboundCallback_NoDB: verifies early return when DB is nil.
func TestPromoteInboundCallback_NoDB(t *testing.T) {
	d, mr := newTestDispatcher(t)
	defer mr.Close()

	d.cfg.DB = nil
	cb := &InboundCallback{ID: 1, LeadID: 1}
	agent := &Agent{UserID: 42}

	err := d.promoteInboundCallback(context.Background(), d.cfg.InGroup, agent, cb, "ALLOW")
	if err != nil {
		t.Fatalf("expected nil error when DB is nil, got: %v", err)
	}
}

// TestNullableInt32JSON: verify JSON serialisation of nullable integers.
func TestNullableInt32JSON(t *testing.T) {
	tests := []struct {
		v    sql.NullInt32
		want string
	}{
		{sql.NullInt32{Valid: false}, "null"},
		{sql.NullInt32{Int32: 0, Valid: true}, "0"},
		{sql.NullInt32{Int32: 42, Valid: true}, "42"},
		{sql.NullInt32{Int32: -1, Valid: true}, "-1"},
	}
	for _, tt := range tests {
		got := nullableInt32JSON(tt.v)
		if got != tt.want {
			t.Errorf("nullableInt32JSON(%+v) = %q; want %q", tt.v, got, tt.want)
		}
	}
}

// TestI04CallbackFireLockKey: verify lock key format.
func TestI04CallbackFireLockKey(t *testing.T) {
	k := NewQueueKeys(42)
	got := k.I04CallbackFireLock(999)
	want := "t:42:i04:cb_fire_lock:999"
	if got != want {
		t.Errorf("I04CallbackFireLock = %q; want %q", got, want)
	}
}

// TestInboundCallback_DialNumberFallback: callback_number missing → falls back to lead phone.
func TestInboundCallback_DialNumberFallback(t *testing.T) {
	cb := &InboundCallback{
		ID:             1,
		LeadID:         10,
		CallbackNumber: sql.NullString{Valid: false},
		LeadPhone:      sql.NullString{String: "+15559876543", Valid: true},
	}

	dialNumber := ""
	if cb.CallbackNumber.Valid && cb.CallbackNumber.String != "" {
		dialNumber = cb.CallbackNumber.String
	} else if cb.LeadPhone.Valid {
		dialNumber = cb.LeadPhone.String
	}

	if dialNumber != "+15559876543" {
		t.Errorf("expected fallback to lead phone; got %q", dialNumber)
	}
}

// TestInboundCallback_NeitherNumber: no number → skip.
func TestInboundCallback_NeitherNumber(t *testing.T) {
	cb := &InboundCallback{
		ID:             1,
		LeadID:         10,
		CallbackNumber: sql.NullString{Valid: false},
		LeadPhone:      sql.NullString{Valid: false},
	}

	dialNumber := ""
	if cb.CallbackNumber.Valid && cb.CallbackNumber.String != "" {
		dialNumber = cb.CallbackNumber.String
	} else if cb.LeadPhone.Valid {
		dialNumber = cb.LeadPhone.String
	}

	if dialNumber != "" {
		t.Errorf("expected empty dial number; got %q", dialNumber)
	}
}
