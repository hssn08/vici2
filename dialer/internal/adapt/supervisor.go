// E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
// in source control since at least 2008 per inktel/Vicidial git history).
// Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
// Prior art documented per SPEC patent-defense protocol.

package adapt

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
)

// Supervisor manages per-campaign E03 goroutines.
// Spawn on ADAPT_* mode; kill on mode exit or campaign inactive.
// Respawn on panic with 5-s backoff (PLAN §11.4).
type Supervisor struct {
	rdb    *redis.Client
	db     *sql.DB
	m      *Metrics
	podID  string
	mu     sync.Mutex
	active map[int64]context.CancelFunc // cid → cancel
}

// NewSupervisor constructs the supervisor. Call once at process start.
func NewSupervisor(vc *redis.Client, db *sql.DB, reg prometheus.Registerer) *Supervisor {
	return &Supervisor{
		rdb:    vc,
		db:     db,
		m:      NewMetrics(reg),
		podID:  uuid.New().String(),
		active: make(map[int64]context.CancelFunc),
	}
}

// CampaignCount returns the number of active campaign goroutines.
func (s *Supervisor) CampaignCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.active)
}

// Start loads active ADAPT_* campaigns from MySQL and starts goroutines.
// Then subscribes to campaign broadcast channels for hot-config reload and fast-cut.
// Blocks until ctx is cancelled.
func (s *Supervisor) Start(ctx context.Context) error {
	// Load initial set of active campaigns.
	campaigns, err := s.loadActiveCampaigns(ctx)
	if err != nil {
		slog.Error("adapt: supervisor: failed to load campaigns", "err", err)
		// Continue; we'll try again when pubsub fires.
	}

	for _, cfg := range campaigns {
		s.startCampaign(ctx, cfg)
	}

	// Subscribe to all campaign broadcast channels for config-changed events.
	// Phase 2 TODO: subscribe to individual channels per campaign.
	// For now, poll MySQL every 60s for new/changed campaigns.
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			s.reconcile(ctx)
		}
	}
}

// reconcile syncs running goroutines with MySQL state.
func (s *Supervisor) reconcile(ctx context.Context) {
	campaigns, err := s.loadActiveCampaigns(ctx)
	if err != nil {
		slog.Error("adapt: supervisor: reconcile load failed", "err", err)
		return
	}

	// Start any new campaigns.
	activeCIDs := make(map[int64]bool)
	for _, cfg := range campaigns {
		activeCIDs[cfg.CampaignID] = true
		s.mu.Lock()
		_, running := s.active[cfg.CampaignID]
		s.mu.Unlock()
		if !running {
			s.startCampaign(ctx, cfg)
		}
	}

	// Stop campaigns no longer in active ADAPT_* mode.
	s.mu.Lock()
	for cid, cancel := range s.active {
		if !activeCIDs[cid] {
			cancel()
			delete(s.active, cid)
		}
	}
	s.mu.Unlock()
}

// startCampaign spawns a campaign goroutine with panic recovery + backoff respawn.
func (s *Supervisor) startCampaign(ctx context.Context, cfg Config) {
	cctx, cancel := context.WithCancel(ctx)
	s.mu.Lock()
	if old, exists := s.active[cfg.CampaignID]; exists {
		old() // cancel existing before replacing
	}
	s.active[cfg.CampaignID] = cancel
	s.mu.Unlock()

	go s.runCampaignLoop(cctx, cfg)
}

// runCampaignLoop is the per-campaign goroutine. Respawns on panic with 5-s backoff.
func (s *Supervisor) runCampaignLoop(ctx context.Context, cfg Config) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("adapt: campaign goroutine panicked; respawning in 5s",
				"tenant", cfg.TenantID, "campaign", cfg.CampaignID, "panic", r)
			select {
			case <-ctx.Done():
				return
			case <-time.After(5 * time.Second):
				// Re-read config from DB before respawn.
				newCfg, err := LoadConfig(ctx, s.db, cfg.TenantID, cfg.CampaignID)
				if err != nil {
					slog.Error("adapt: respawn: cannot reload config", "err", err)
					return
				}
				s.runCampaignLoop(ctx, newCfg)
			}
		}
	}()

	ticker := time.NewTicker(time.Duration(cfg.AdaptTickSeconds) * time.Second)
	defer ticker.Stop()

	// Subscribe to campaign broadcast channel for fast-cut.
	pubsub := s.rdb.Subscribe(ctx, broadcastCampaignKey(cfg.TenantID, cfg.CampaignID))
	defer pubsub.Close()

	fc := NewFastCutter(cfg.TenantID, cfg.CampaignID, s.rdb, s.m, cfg.DropGatedDebounce)

	// Hot-restart metric.
	lv := Labels(cfg.TenantID, cfg.CampaignID)
	s.m.RestartTotal.With(lv).Inc()

	for {
		select {
		case <-ctx.Done():
			return

		case msg := <-pubsub.Channel():
			// Handle fast-cut and config-changed events.
			if msg != nil {
				fc.HandleMessage(ctx, msg.Payload)
				// Also check for campaign_config_changed.
				var ev map[string]any
				if json.Unmarshal([]byte(msg.Payload), &ev) == nil {
					if ev["event"] == "campaign_config_changed" {
						newCfg, err := LoadConfig(ctx, s.db, cfg.TenantID, cfg.CampaignID)
						if err != nil {
							slog.Error("adapt: hot-reload config failed", "err", err)
						} else {
							cfg = newCfg
							fc = NewFastCutter(cfg.TenantID, cfg.CampaignID, s.rdb, s.m, cfg.DropGatedDebounce)
						}
					}
				}
			}

		case <-ticker.C:
			if _, err := RunTick(ctx, s.rdb, s.m, cfg, s.podID); err != nil {
				slog.Error("adapt: tick failed", "err", err,
					"tenant", cfg.TenantID, "campaign", cfg.CampaignID)
			}
		}
	}
}

// loadActiveCampaigns queries MySQL for all active ADAPT_* campaigns for this tenant.
func (s *Supervisor) loadActiveCampaigns(ctx context.Context) ([]Config, error) {
	const q = `
SELECT id, tenant_id FROM campaigns
WHERE active = 1
  AND dial_method IN ('ADAPT_HARD', 'ADAPT_AVG', 'ADAPT_TAPERED')`

	rows, err := s.db.QueryContext(ctx, q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var cfgs []Config
	for rows.Next() {
		var cid, tid int64
		if err := rows.Scan(&cid, &tid); err != nil {
			continue
		}
		cfg, err := LoadConfig(ctx, s.db, tid, cid)
		if err != nil {
			slog.Error("adapt: load config for campaign", "err", err, "cid", cid)
			continue
		}
		cfgs = append(cfgs, cfg)
	}
	return cfgs, rows.Err()
}
