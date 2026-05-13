// reconciler.go — 60-s STREAM-vs-MySQL drift reconciler.
//
// E05 PLAN §10: validates drop_window STREAM count against drop_log MySQL count.
// Drift > 0.05% → WARN + use MySQL.
// Drift > 1.00% → PAGE + set drop_gated defensively (fail-closed).
package drop_gate

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"math"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	vkey "github.com/vici2/dialer/internal/valkey"
)

const (
	reconcileInterval   = 60 * time.Second
	driftWarnThreshold  = 0.0005 // 0.05%
	driftPageThreshold  = 0.01   // 1.00%
)

// Reconciler validates STREAM counts against MySQL every 60 s.
type Reconciler struct {
	gate  *DropGate
	db    *sql.DB
	rc    *redis.Client
	keys  vkey.Keys
	m     *Metrics
	cfg   CampaignConfig
	alert AlertFunc

	stopCh chan struct{}
}

// NewReconciler constructs a Reconciler for one campaign.
func NewReconciler(gate *DropGate, db *sql.DB, rc *redis.Client, m *Metrics, alertFn AlertFunc) *Reconciler {
	return &Reconciler{
		gate:   gate,
		db:     db,
		rc:     rc,
		keys:   vkey.NewKeys(gate.cfg.TenantID),
		m:      m,
		cfg:    gate.cfg,
		alert:  alertFn,
		stopCh: make(chan struct{}),
	}
}

// Run starts the reconciler loop. Blocks until ctx is cancelled or Stop() is called.
func (r *Reconciler) Run(ctx context.Context) {
	ticker := time.NewTicker(reconcileInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-r.stopCh:
			return
		case <-ticker.C:
			r.reconcile(ctx)
		}
	}
}

// Stop signals the reconciler to exit.
func (r *Reconciler) Stop() {
	close(r.stopCh)
}

// reconcile runs one 60-s drift check cycle.
func (r *Reconciler) reconcile(ctx context.Context) {
	start := time.Now()
	tid := strconv.FormatInt(r.cfg.TenantID, 10)
	cid := strconv.FormatInt(r.cfg.CampaignID, 10)

	streamDropped, err := r.countStreamDrops(ctx)
	if err != nil {
		slog.Warn("reconciler: STREAM count failed",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.String("err", err.Error()))
		return
	}

	dbDropped, err := r.countDBDrops(ctx)
	if err != nil {
		slog.Warn("reconciler: MySQL count failed",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.String("err", err.Error()))
		return
	}

	var drift float64
	switch {
	case dbDropped > 0:
		drift = math.Abs(float64(streamDropped-dbDropped)) / float64(dbDropped)
	case streamDropped > 0:
		// DB has 0 but STREAM has entries: 100% drift (severe by definition).
		drift = 1.0
	}

	if r.m != nil {
		r.m.StreamDriftPct.WithLabelValues(tid, cid).Set(drift)
	}

	switch {
	case drift <= driftWarnThreshold:
		// OK — no action.

	case drift <= driftPageThreshold:
		slog.Warn("reconciler: STREAM drift detected; MySQL wins",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.Float64("drift_pct", drift*100),
			slog.Int64("stream_dropped", streamDropped),
			slog.Int64("db_dropped", dbDropped))
		if r.alert != nil {
			r.alert(ctx, "WARN",
				fmt.Sprintf("drop_window stream drift %.2f%% for campaign %d; using MySQL authoritative count",
					drift*100, r.cfg.CampaignID),
				r.cfg.TenantID, r.cfg.CampaignID)
		}

	default:
		// Severe drift: fail-closed.
		slog.Error("reconciler: SEVERE STREAM drift; applying fail-closed gate",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.Float64("drift_pct", drift*100))
		if r.m != nil {
			r.m.StreamSevereDriftTotal.WithLabelValues(tid, cid).Inc()
		}
		if r.alert != nil {
			r.alert(ctx, "PAGE",
				fmt.Sprintf("SEVERE drop_window stream drift %.2f%% for campaign %d; defensively drop-gating",
					drift*100, r.cfg.CampaignID),
				r.cfg.TenantID, r.cfg.CampaignID)
		}
		// Engage gate defensively — force HARD_BREACH.
		if r.rc != nil {
			if err := r.rc.Set(ctx, r.keys.CampaignDropGated(r.cfg.CampaignID), "1", 0).Err(); err != nil {
				slog.Error("reconciler: failed to SET drop_gated (severe drift)", "err", err)
			}
		}
	}

	if r.m != nil {
		r.m.ReconcilerDurationSeconds.WithLabelValues(tid).Observe(time.Since(start).Seconds())
	}
}

// countStreamDrops reads the drop_window STREAM and counts entries with dropped=1.
// Returns the count of drops in the last 30 days.
func (r *Reconciler) countStreamDrops(ctx context.Context) (int64, error) {
	if r.rc == nil {
		return 0, nil
	}

	streamKey := r.keys.CampaignDropWindow(r.cfg.CampaignID)
	// Read all entries; filter dropped=1.
	// For production with large streams, use cursor-based XRANGE scanning.
	msgs, err := r.rc.XRange(ctx, streamKey, "-", "+").Result()
	if err != nil {
		return 0, fmt.Errorf("XRANGE %s: %w", streamKey, err)
	}

	cutoff := time.Now().Add(-30 * 24 * time.Hour)
	var count int64
	for _, msg := range msgs {
		// Parse dropped field.
		dropped, ok := msg.Values["dropped"]
		if !ok {
			continue
		}
		if fmt.Sprintf("%v", dropped) != "1" {
			continue
		}
		// Parse timestamp from STREAM ID (millisecond epoch prefix).
		// Stream ID format: "<ms_epoch>-<seq>".
		var ms int64
		if _, err := fmt.Sscanf(msg.ID, "%d", &ms); err != nil {
			continue
		}
		ts := time.UnixMilli(ms)
		if ts.Before(cutoff) {
			continue
		}
		count++
	}
	return count, nil
}

// countDBDrops returns the drop_log row count for the last 30 days.
func (r *Reconciler) countDBDrops(ctx context.Context) (int64, error) {
	if r.db == nil {
		return 0, nil
	}
	const q = `
		SELECT COUNT(*) FROM drop_log
		WHERE tenant_id   = ?
		  AND campaign_id = ?
		  AND dropped_at  >= NOW() - INTERVAL 30 DAY`
	var count int64
	err := r.db.QueryRowContext(ctx, q,
		r.cfg.TenantID,
		strconv.FormatInt(r.cfg.CampaignID, 10),
	).Scan(&count)
	return count, err
}
