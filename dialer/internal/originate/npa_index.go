package originate

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/valkey"
)

// NPAStateResolver is the interface X05's index builder uses to look up the
// US state code for a given NPA. *tz.Resolver satisfies this interface.
type NPAStateResolver interface {
	StateForNPA(npa string) string
}

// PoolMembershipEvent is published on the X04 pool-membership pub/sub channel
// when a DID is added to or removed from a pool.
type PoolMembershipEvent struct {
	Event    string `json:"event"`    // "did_added" | "did_removed"
	PoolID   int64  `json:"pool_id"`
	DIDID    int64  `json:"did_id"`
	DIDE164  string `json:"did_e164"` // E.164 format
	TenantID int64  `json:"tenant_id"`
}

// npaIndexMetrics holds Prometheus metrics for the index builder.
type npaIndexMetrics struct {
	buildTotal    *prometheus.CounterVec
	buildDuration *prometheus.HistogramVec
}

var indexMetrics = &npaIndexMetrics{
	buildTotal: promauto.NewCounterVec(prometheus.CounterOpts{
		Name: "vici2_x05_index_build_total",
		Help: "Total NPA index builds by trigger type.",
	}, []string{"tenant_id", "pool_id", "trigger"}),
	buildDuration: promauto.NewHistogramVec(prometheus.HistogramOpts{
		Name:    "vici2_x05_index_build_duration_seconds",
		Help:    "Duration of NPA index builds.",
		Buckets: prometheus.DefBuckets,
	}, []string{"tenant_id", "pool_id"}),
}

// NPAIndexBuilder maintains NPA and state Valkey SETs for local-presence pools.
// It subscribes to X04's pool-membership pub/sub channel and handles both
// incremental updates and on-demand full rebuilds.
type NPAIndexBuilder struct {
	db          *sql.DB
	rdb         redis.UniversalClient
	keys        valkey.Keys
	tzResolver  NPAStateResolver
}

// NewNPAIndexBuilder creates an NPAIndexBuilder.
func NewNPAIndexBuilder(db *sql.DB, rdb redis.UniversalClient, keys valkey.Keys, tz NPAStateResolver) *NPAIndexBuilder {
	return &NPAIndexBuilder{
		db:         db,
		rdb:        rdb,
		keys:       keys,
		tzResolver: tz,
	}
}

// StartupRebuild queries all pools with local_presence_enabled=true and
// rebuilds their NPA indexes if the sentinel key is missing or expired.
// Call once after dialer startup (before first originate).
func (b *NPAIndexBuilder) StartupRebuild(ctx context.Context) error {
	rows, err := b.db.QueryContext(ctx, `
		SELECT id, tenant_id FROM number_pools
		WHERE local_presence_enabled = 1 AND active = 1`)
	if err != nil {
		return fmt.Errorf("npa_index: query local-presence pools: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var poolID, tenantID int64
		if err := rows.Scan(&poolID, &tenantID); err != nil {
			return fmt.Errorf("npa_index: scan pool row: %w", err)
		}
		// Check sentinel
		exists, _ := b.rdb.Exists(ctx, b.keys.PoolNPAIndexBuilt(poolID)).Result()
		if exists > 0 {
			continue // already indexed
		}
		slog.Info("npa_index: startup rebuild", "pool_id", poolID, "tenant_id", tenantID)
		if err := b.rebuildPool(ctx, tenantID, poolID, "startup"); err != nil {
			slog.Warn("npa_index: rebuild failed", "pool_id", poolID, "err", err)
		}
	}
	return rows.Err()
}

// RebuildPool performs a full rebuild of the NPA and state SETs for a pool.
// Safe to call concurrently; Valkey SADD is idempotent.
func (b *NPAIndexBuilder) RebuildPool(ctx context.Context, tenantID, poolID int64) error {
	return b.rebuildPool(ctx, tenantID, poolID, "cold_start")
}

func (b *NPAIndexBuilder) rebuildPool(ctx context.Context, tenantID, poolID int64, trigger string) error {
	start := time.Now()
	tidStr := strconv.FormatInt(tenantID, 10)
	pidStr := strconv.FormatInt(poolID, 10)

	type didRow struct {
		id   int64
		e164 string
	}

	rows, err := b.db.QueryContext(ctx, `
		SELECT dn.id, dn.e164
		FROM number_pool_dids npd
		JOIN did_numbers dn ON dn.id = npd.did_id
		WHERE npd.pool_id = ? AND npd.tenant_id = ?`, poolID, tenantID)
	if err != nil {
		return fmt.Errorf("npa_index: query pool DIDs: %w", err)
	}
	defer rows.Close()

	npaMap := make(map[string][]interface{})   // npa → []didID strings
	stateMap := make(map[string][]interface{}) // state → []didID strings

	for rows.Next() {
		var dr didRow
		if err := rows.Scan(&dr.id, &dr.e164); err != nil {
			return fmt.Errorf("npa_index: scan DID row: %w", err)
		}
		npa := extractNPA(dr.e164)
		if npa == "" || isReservedNPA(npa) {
			continue
		}
		didStr := strconv.FormatInt(dr.id, 10)
		npaMap[npa] = append(npaMap[npa], didStr)
		if state := b.tzResolver.StateForNPA(npa); state != "" {
			stateMap[state] = append(stateMap[state], didStr)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("npa_index: iterate DID rows: %w", err)
	}

	pipe := b.rdb.Pipeline()
	for npa, dids := range npaMap {
		pipe.SAdd(ctx, b.keys.PoolNPAIndex(poolID, npa), dids...)
	}
	for state, dids := range stateMap {
		pipe.SAdd(ctx, b.keys.PoolStateIndex(poolID, state), dids...)
	}
	pipe.Set(ctx, b.keys.PoolNPAIndexBuilt(poolID), "1", 24*time.Hour)
	if _, err := pipe.Exec(ctx); err != nil {
		return fmt.Errorf("npa_index: write to Valkey: %w", err)
	}

	dur := time.Since(start)
	indexMetrics.buildTotal.WithLabelValues(tidStr, pidStr, trigger).Inc()
	indexMetrics.buildDuration.WithLabelValues(tidStr, pidStr).Observe(dur.Seconds())
	slog.Info("npa_index: rebuild complete",
		"pool_id", poolID, "trigger", trigger, "npa_count", len(npaMap),
		"state_count", len(stateMap), "duration", dur)
	return nil
}

// HandlePoolMembershipEvent processes a single DID add/remove event published
// on the X04 pool-membership pub/sub channel. Updates NPA and state SETs.
func (b *NPAIndexBuilder) HandlePoolMembershipEvent(ctx context.Context, msg PoolMembershipEvent) {
	npa := extractNPA(msg.DIDE164)
	if npa == "" || isReservedNPA(npa) {
		return
	}
	state := b.tzResolver.StateForNPA(npa)
	npaK := b.keys.PoolNPAIndex(msg.PoolID, npa)
	didStr := strconv.FormatInt(msg.DIDID, 10)

	pipe := b.rdb.Pipeline()
	switch msg.Event {
	case "did_added":
		pipe.SAdd(ctx, npaK, didStr)
		if state != "" {
			pipe.SAdd(ctx, b.keys.PoolStateIndex(msg.PoolID, state), didStr)
		}
	case "did_removed":
		pipe.SRem(ctx, npaK, didStr)
		if state != "" {
			pipe.SRem(ctx, b.keys.PoolStateIndex(msg.PoolID, state), didStr)
		}
	default:
		slog.Warn("npa_index: unknown pool membership event", "event", msg.Event)
		return
	}
	if _, err := pipe.Exec(ctx); err != nil {
		slog.Error("npa_index: handle event failed", "event", msg.Event, "pool_id", msg.PoolID, "err", err)
	}
}

// SubscribePoolMembership starts a goroutine that subscribes to the X04
// pool-membership pub/sub channel pattern and calls HandlePoolMembershipEvent
// for each received message. Runs until ctx is cancelled.
func (b *NPAIndexBuilder) SubscribePoolMembership(ctx context.Context, tenantID int64) {
	channel := fmt.Sprintf("t:%d:pool-membership:events", tenantID)
	go func() {
		sub := b.rdb.Subscribe(ctx, channel)
		defer func() { _ = sub.Close() }()

		ch := sub.Channel()
		for {
			select {
			case <-ctx.Done():
				return
			case msg, ok := <-ch:
				if !ok {
					return
				}
				var evt PoolMembershipEvent
				if err := json.Unmarshal([]byte(msg.Payload), &evt); err != nil {
					slog.Warn("npa_index: invalid pool membership event", "err", err)
					continue
				}
				b.HandlePoolMembershipEvent(ctx, evt)
			}
		}
	}()
}
