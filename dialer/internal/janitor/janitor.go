// Package janitor implements the E06 Channel + Conference Janitor.
//
// A 60-second periodic sweep runs in the dialer process. A Valkey SETNX
// leader lock ensures only one dialer pod sweeps at a time. Three sweep
// types run in sequence each tick:
//
//  1. Stuck channels — call_log rows open > 4h cross-referenced with FS live
//     channels; stale DB rows are closed and the FS channel is hung up via ESL.
//  2. Stale conferences — FS conferences empty for > 5 min that are NOT agent
//     home conferences are destroyed via ESL conference kick all.
//  3. Orphan locks — delegates to picker.Janitor.SweepOrphans() and
//     originate.Service.SweepOrphans().
//
// E06 PLAN §2.
package janitor

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/vici2/dialer/internal/audit"
	"github.com/vici2/dialer/internal/esl"
	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/picker"
	"github.com/vici2/dialer/internal/valkey"
)

const (
	// tickInterval is the time between janitor sweeps.
	tickInterval = 60 * time.Second

	// lockTTL is the Valkey SETNX TTL for the leader lock.
	// Must exceed the maximum sweep duration (est. 2-5s); 90s gives 18x headroom.
	lockTTL = 90 * time.Second
)

// Config holds constructor dependencies for the Janitor.
// E06 PLAN §2.1.
type Config struct {
	TenantID    int64
	PodID       string // hostname + PID, used as lock value
	DB          *sql.DB
	Rdb         *redis.Client
	ESL         *esl.Client
	FSHost      string // primary FS host (Phase 1: single host)
	Keys        valkey.Keys
	AuditWriter *audit.Writer

	// Delegation to pre-existing sweep implementations.
	PickerJanitor *picker.Janitor    // SweepOrphans delegation
	OriginateJan  *originate.Service // SweepOrphans delegation

	Metrics *Metrics
	Log     *slog.Logger

	// Thresholds (configurable; defaults apply if zero).
	StuckChannelAge time.Duration // default: 4h
	StaleConfAge    time.Duration // default: 5min
	MaxKillsPerTick int          // default: 100 (safety cap)
}

// Janitor runs the periodic E06 sweeps.
type Janitor struct {
	cfg        Config
	log        *slog.Logger
	sweepTickID string // set per sweep for audit correlation
}

// New constructs a Janitor, applying zero-value threshold defaults.
func New(cfg Config) *Janitor {
	// Apply defaults.
	if cfg.StuckChannelAge == 0 {
		cfg.StuckChannelAge = 4 * time.Hour
	}
	if cfg.StaleConfAge == 0 {
		cfg.StaleConfAge = 5 * time.Minute
	}
	if cfg.MaxKillsPerTick == 0 {
		cfg.MaxKillsPerTick = 100
	}

	log := cfg.Log
	if log == nil {
		log = slog.Default()
	}
	log = log.With("component", "janitor")

	return &Janitor{cfg: cfg, log: log}
}

// Run blocks until ctx is cancelled. Returns ctx.Err().
// Tick interval: 60s. One sweep runs immediately on startup to catch
// crashes that left state.
// E06 PLAN §2.1.
func (j *Janitor) Run(ctx context.Context) error {
	// Run one sweep immediately on startup.
	j.sweep(ctx)

	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			j.sweep(ctx)
		}
	}
}

// sweep acquires the leader lock and runs all three sweepers.
// TickDuration metric is only recorded on the leader pod. E06 PLAN §2.1.
func (j *Janitor) sweep(ctx context.Context) {
	// Leader election: SETNX with lockTTL.
	lockKey := j.cfg.Keys.JanitorLock()
	acquired, err := j.cfg.Rdb.SetNX(ctx, lockKey, j.cfg.PodID, lockTTL).Result()
	if err != nil {
		j.log.Error("janitor: leader lock SETNX", "err", err)
		return
	}
	if !acquired {
		j.log.Debug("janitor: not leader, skipping sweep")
		return
	}
	// Only the leader pod records sweep duration.
	start := time.Now()
	defer func() {
		j.cfg.Metrics.TickDuration.Observe(time.Since(start).Seconds())
	}()
	defer j.cfg.Rdb.Del(ctx, lockKey)

	// Build a sweep tick ID for audit correlation.
	j.sweepTickID = fmt.Sprintf("janitor-sweep-%d", start.UnixMilli())

	j.log.Info("janitor: sweep start", "pod", j.cfg.PodID, "tick_id", j.sweepTickID)

	n1, err := j.sweepStuckChannels(ctx)
	if err != nil {
		j.log.Error("janitor: stuck channels sweep", "err", err)
	}

	n2, err := j.sweepStaleConferences(ctx)
	if err != nil {
		j.log.Error("janitor: stale conferences sweep", "err", err)
	}

	n3, err := j.sweepOrphanLocks(ctx)
	if err != nil {
		j.log.Error("janitor: orphan locks sweep", "err", err)
	}

	j.log.Info("janitor: sweep complete",
		"stuck_killed", n1,
		"stale_confs_killed", n2,
		"orphan_locks_cleared", n3,
		"duration_ms", time.Since(start).Milliseconds(),
	)
}

// joinErrs combines two errors; returns nil if both are nil.
func joinErrs(e1, e2 error) error {
	if e1 == nil {
		return e2
	}
	if e2 == nil {
		return e1
	}
	return errors.Join(e1, e2)
}
