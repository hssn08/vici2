package queue

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"
)

// Janitor performs startup reconciliation and periodic consistency checks.
// I01 PLAN §18.2 (Janitor goroutine) + §18.4 (startup reconciliation).
type Janitor struct {
	db      *sql.DB
	rdb     *redis.Client
	keys    QueueKeys
	log     *slog.Logger
	metrics *Metrics
}

// NewJanitor creates a Janitor.
func NewJanitor(db *sql.DB, rdb *redis.Client, keys QueueKeys, log *slog.Logger, metrics *Metrics) *Janitor {
	if log == nil {
		log = slog.Default()
	}
	return &Janitor{db: db, rdb: rdb, keys: keys, log: log, metrics: metrics}
}

// ReconcileOnStartup restores Redis ZSET state from MySQL after crash/restart.
// I01 PLAN §18.4.
func (j *Janitor) ReconcileOnStartup(ctx context.Context) error {
	const q = `
		SELECT call_uuid, ingroup_id, base_score
		FROM queue_calls
		WHERE exit_at IS NULL
		  AND enter_at > NOW() - INTERVAL 2 HOUR`

	rows, err := j.db.QueryContext(ctx, q)
	if err != nil {
		return fmt.Errorf("janitor: ReconcileOnStartup query: %w", err)
	}
	defer rows.Close()

	var restored int
	for rows.Next() {
		var (
			callUUID  string
			ingroupID string
			baseScore int64
		)
		if err := rows.Scan(&callUUID, &ingroupID, &baseScore); err != nil {
			j.log.Warn("janitor: scan row", "err", err)
			continue
		}

		// ZADD NX: only add if not already present (idempotent).
		added, err := j.rdb.ZAddNX(ctx, j.keys.IngroupQueue(ingroupID), redis.Z{
			Score:  float64(baseScore),
			Member: callUUID,
		}).Result()
		if err != nil {
			j.log.Error("janitor: ZADD NX", "call_uuid", callUUID, "err", err)
			continue
		}
		if added > 0 {
			restored++
			j.log.Info("janitor: restored call to Redis queue", "call_uuid", callUUID, "ingroup", ingroupID)
		}
	}

	j.log.Info("janitor: startup reconciliation complete", "restored", restored)
	return rows.Err()
}

// Run starts the periodic janitor loop. Runs every 5 minutes.
// I01 PLAN §18.2.
func (j *Janitor) Run(ctx context.Context) error {
	// Initial run on startup.
	if err := j.ReconcileOnStartup(ctx); err != nil {
		j.log.Error("janitor: startup reconcile failed", "err", err)
		// Non-fatal: continue running.
	}

	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := j.ReconcileOnStartup(ctx); err != nil {
				j.log.Error("janitor: periodic reconcile failed", "err", err)
			}
		}
	}
}
