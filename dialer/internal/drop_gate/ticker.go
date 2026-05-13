// ticker.go — 15-s MySQL recompute goroutine + Valkey gauge publish.
//
// E05 PLAN §5: authoritative queries + Valkey STRING publish.
// Denominator MUST use JOIN statuses WHERE human_answered=TRUE (CI-enforced).
package drop_gate

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
	vkey "github.com/vici2/dialer/internal/valkey"
)

const tickInterval = 15 * time.Second

// Ticker drives the 15-s rolling-window recompute for one campaign.
type Ticker struct {
	gate *DropGate
	db   *sql.DB
	rc   *redis.Client
	keys vkey.Keys
	m    *Metrics
	cfg  CampaignConfig

	stopCh chan struct{}
}

// NewTicker constructs a Ticker for one campaign.
func NewTicker(gate *DropGate, db *sql.DB, rc *redis.Client, m *Metrics) *Ticker {
	return &Ticker{
		gate:   gate,
		db:     db,
		rc:     rc,
		keys:   vkey.NewKeys(gate.cfg.TenantID),
		m:      m,
		cfg:    gate.cfg,
		stopCh: make(chan struct{}),
	}
}

// Run starts the ticker loop. Blocks until ctx is cancelled or Stop() is called.
func (t *Ticker) Run(ctx context.Context) {
	ticker := time.NewTicker(tickInterval)
	defer ticker.Stop()

	// Run one tick immediately on start to publish gauges without waiting 15 s.
	t.tick(ctx)

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.stopCh:
			return
		case <-ticker.C:
			t.tick(ctx)
		}
	}
}

// Stop signals the ticker to exit.
func (t *Ticker) Stop() {
	close(t.stopCh)
}

// tick executes one 15-s recompute cycle.
func (t *Ticker) tick(ctx context.Context) {
	start := time.Now()
	tid := strconv.FormatInt(t.cfg.TenantID, 10)
	cid := strconv.FormatInt(t.cfg.CampaignID, 10)

	// MANUAL campaigns are exempt.
	if t.cfg.IsManual() {
		return
	}

	numerator, denominator, err := t.queryMysql(ctx)
	if err != nil {
		slog.Warn("drop_gate.ticker: MySQL query failed",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.String("err", err.Error()))
		return
	}

	// Warmup floor.
	var dropPct float64
	if denominator < WarmupDenominatorFloor {
		dropPct = 0.0
		slog.Debug("drop_gate.ticker: warmup floor",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.Int64("denominator", denominator))
	} else {
		dropPct = 100.0 * float64(numerator) / float64(denominator)
	}

	// Publish Valkey gauges.
	if t.rc != nil {
		pipe := t.rc.Pipeline()
		pipe.Set(ctx, t.keys.CampaignDropPct30d(t.cfg.CampaignID),
			fmt.Sprintf("%.4f", dropPct), 0)
		pipe.Set(ctx, t.keys.CampaignDropCount30d(t.cfg.CampaignID),
			strconv.FormatInt(numerator, 10), 0)
		pipe.Set(ctx, t.keys.CampaignDropDenominator30d(t.cfg.CampaignID),
			strconv.FormatInt(denominator, 10), 0)
		if _, err := pipe.Exec(ctx); err != nil {
			slog.Warn("drop_gate.ticker: Valkey SET failed",
				slog.String("tenant", tid), slog.String("campaign", cid),
				slog.String("err", err.Error()))
		}
	}

	// Prometheus gauges.
	if t.m != nil {
		t.m.DropRatePct.WithLabelValues(tid, cid).Set(dropPct)
		t.m.DropCount30d.WithLabelValues(tid, cid).Set(float64(numerator))
		t.m.DropDenominator30d.WithLabelValues(tid, cid).Set(float64(denominator))
	}

	// Run FSM tick.
	if _, err := t.gate.Tick(ctx, dropPct, denominator, tickInterval); err != nil {
		slog.Warn("drop_gate.ticker: gate.Tick error",
			slog.String("tenant", tid), slog.String("campaign", cid),
			slog.String("err", err.Error()))
	}

	if t.m != nil {
		t.m.TickerDurationSeconds.WithLabelValues(tid).Observe(time.Since(start).Seconds())
	}
}

// queryMysql fetches numerator and denominator from MySQL.
//
// Numerator: drop_log rows in last 30 days.
// Denominator: live-answered calls (JOIN statuses WHERE human_answered=TRUE).
//
// INVARIANT: denominator MUST use JOIN statuses WHERE human_answered=TRUE.
// CI grep in M08 forbids any status IN (...) denominator expression.
func (t *Ticker) queryMysql(ctx context.Context) (numerator, denominator int64, err error) {
	if t.db == nil {
		// Unit-test stub: return zeroes (callers use SetStateForRecovery or direct Tick).
		return 0, 0, nil
	}

	const qNumerator = `
		SELECT COUNT(*) AS drops_30d
		FROM drop_log
		WHERE tenant_id   = ?
		  AND campaign_id = ?
		  AND dropped_at  >= NOW() - INTERVAL 30 DAY`

	if err = t.db.QueryRowContext(ctx, qNumerator,
		t.cfg.TenantID,
		strconv.FormatInt(t.cfg.CampaignID, 10),
	).Scan(&numerator); err != nil {
		return 0, 0, fmt.Errorf("ticker: numerator query: %w", err)
	}

	// Denominator: MUST use JOIN statuses WHERE human_answered=TRUE (FROZEN).
	const qDenominator = `
		SELECT COUNT(*) AS answers_30d
		FROM call_log c
		JOIN statuses s
		  ON c.tenant_id = s.tenant_id
		 AND c.status    = s.status
		WHERE c.tenant_id    = ?
		  AND c.campaign_id  = ?
		  AND c.call_started >= NOW() - INTERVAL 30 DAY
		  AND s.human_answered = TRUE`

	if err = t.db.QueryRowContext(ctx, qDenominator,
		t.cfg.TenantID,
		strconv.FormatInt(t.cfg.CampaignID, 10),
	).Scan(&denominator); err != nil {
		return 0, 0, fmt.Errorf("ticker: denominator query: %w", err)
	}

	return numerator, denominator, nil
}
