// supervisor.go — PacingManager: starts/stops per-campaign Pacer goroutines.
//
// E02 PLAN §12 + §13: Manager is the sole public API to main.go.
// It subscribes to campaign events, scans active campaigns on startup,
// and respawns panicking goroutines with 5 s backoff.
package pacing

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/redis/go-redis/v9"
	vkey "github.com/vici2/dialer/internal/valkey"
)

const (
	panicRespawnDelay = 5 * time.Second
	stopDrainTimeout  = 5 * time.Second
)

// ManagerConfig is the public constructor input. E02 PLAN §13.
type ManagerConfig struct {
	// Valkey state client (F04 helper client's State field).
	Valkey *redis.Client

	// Keys is the typed key builder bound to TenantID.
	Keys vkey.Keys

	// DB is the MySQL connection for campaign config. May be nil (unit tests).
	DB *sql.DB

	// Prometheus registry. May be nil (unit tests).
	Prometheus prometheus.Registerer

	// PodID uniquely identifies this pod (e.g., hostname + pid).
	PodID string

	// TenantID is the bound tenant (Phase 1: always 1).
	TenantID int64

	// InitialCampaigns seeds the manager with known-active campaigns
	// without a MySQL scan. Used by main.go and integration tests.
	InitialCampaigns []CampaignConfig
}

// Manager supervises all per-campaign Pacer goroutines.
type Manager struct {
	cfg   ManagerConfig
	store *ConfigStore
	m     *Metrics

	mu     sync.Mutex
	pacers map[string]*managedPacer // key = campaignID

	stopCh chan struct{}
	wg     sync.WaitGroup
}

type managedPacer struct {
	pacer  *Pacer
	cancel context.CancelFunc
}

// NewManager constructs the PacingManager. Call Start() to begin ticking.
func NewManager(cfg ManagerConfig) *Manager {
	if cfg.TenantID == 0 {
		cfg.TenantID = 1
	}
	m := NewMetrics(cfg.Prometheus)
	store := NewConfigStore(cfg.DB, m)

	// Seed initial configs.
	for _, cc := range cfg.InitialCampaigns {
		store.Put(cc)
	}

	return &Manager{
		cfg:    cfg,
		store:  store,
		m:      m,
		pacers: make(map[string]*managedPacer),
		stopCh: make(chan struct{}),
	}
}

// Start subscribes to campaign events, optionally scans MySQL for active
// campaigns, and begins per-campaign tick goroutines. Blocks until ctx done.
func (mgr *Manager) Start(ctx context.Context) error {
	// Start pacers for pre-seeded campaigns.
	for _, cc := range mgr.cfg.InitialCampaigns {
		mgr.ensure(ctx, cc.CampaignID)
	}

	// Subscribe to campaign broadcast pubsub for hot-reload + start/stop events.
	// Phase 2 stub: pubsub subscription wired inline; real message handling
	// for campaign_config_changed + campaign_stopped.
	broadcastCh := fmt.Sprintf("t:%d:broadcast:campaigns", mgr.cfg.TenantID)
	pubsub := mgr.cfg.Valkey.Subscribe(ctx, broadcastCh)
	defer func() { _ = pubsub.Close() }()

	msgCh := pubsub.Channel()

	for {
		select {
		case <-ctx.Done():
			mgr.drainAll()
			return nil
		case <-mgr.stopCh:
			mgr.drainAll()
			return nil
		case msg, ok := <-msgCh:
			if !ok {
				continue
			}
			mgr.handleBroadcast(ctx, msg.Payload)
		}
	}
}

// Stop drains all per-campaign goroutines gracefully (max 5 s).
func (mgr *Manager) Stop(_ context.Context) error {
	close(mgr.stopCh)
	done := make(chan struct{})
	go func() {
		mgr.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(stopDrainTimeout):
		slog.Warn("pacing: supervisor stop timed out; some pacers may still be running")
	}
	return nil
}

// ActiveCampaignCount returns the number of running Pacer goroutines.
func (mgr *Manager) ActiveCampaignCount() int {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	return len(mgr.pacers)
}

// Signal sends a sub-tick acceleration signal to a specific campaign's pacer.
func (mgr *Manager) Signal(campaignID string) {
	mgr.mu.Lock()
	mp, ok := mgr.pacers[campaignID]
	mgr.mu.Unlock()
	if ok {
		mp.pacer.Signal()
	}
}

// ensure starts a pacer for campaignID if one is not already running.
func (mgr *Manager) ensure(ctx context.Context, campaignID string) {
	mgr.mu.Lock()
	defer mgr.mu.Unlock()
	if _, ok := mgr.pacers[campaignID]; ok {
		return
	}
	mgr.spawnLocked(ctx, campaignID)
}

// spawnLocked creates and starts a Pacer goroutine. Caller must hold mu.
func (mgr *Manager) spawnLocked(ctx context.Context, campaignID string) {
	pacerCtx, cancel := context.WithCancel(ctx)
	p := newPacer(
		mgr.cfg.TenantID,
		campaignID,
		mgr.cfg.PodID,
		mgr.cfg.Valkey,
		mgr.cfg.Keys,
		mgr.store,
		mgr.m,
	)
	mp := &managedPacer{pacer: p, cancel: cancel}
	mgr.pacers[campaignID] = mp

	mgr.wg.Add(1)
	go func() {
		defer mgr.wg.Done()
		mgr.runWithRecovery(pacerCtx, p, campaignID)
	}()
}

// runWithRecovery wraps p.Run() with panic recovery and respawn logic.
// E02 PLAN §10 row 14.
func (mgr *Manager) runWithRecovery(ctx context.Context, p *Pacer, campaignID string) {
	tid := fmt.Sprintf("%d", mgr.cfg.TenantID)
	for {
		func() {
			defer func() {
				if r := recover(); r != nil {
					slog.Error("pacing: goroutine panic",
						slog.String("campaign", campaignID),
						slog.Any("panic", r))
					if mgr.m != nil {
						mgr.m.GoroutinePanicTotal.WithLabelValues(tid, campaignID).Inc()
					}
				}
			}()
			p.Run(ctx)
		}()

		// Check if we should stop (ctx cancelled or pacer stopped externally).
		select {
		case <-ctx.Done():
			// Remove from supervisor map and exit.
			mgr.mu.Lock()
			delete(mgr.pacers, campaignID)
			mgr.mu.Unlock()
			return
		default:
		}

		// Goroutine exited without panic (campaign deleted, etc.).
		// Remove from map and exit without respawn.
		mgr.mu.Lock()
		_, stillThere := mgr.pacers[campaignID]
		mgr.mu.Unlock()
		if !stillThere {
			return
		}

		// Panic recovery: wait 5 s then respawn.
		select {
		case <-ctx.Done():
			mgr.mu.Lock()
			delete(mgr.pacers, campaignID)
			mgr.mu.Unlock()
			return
		case <-time.After(panicRespawnDelay):
		}

		slog.Info("pacing: respawning goroutine after panic",
			slog.String("campaign", campaignID))

		// Replace the pacer in the map with a fresh one.
		mgr.mu.Lock()
		if old, ok := mgr.pacers[campaignID]; ok {
			old.cancel()
		}
		newCtx, newCancel := context.WithCancel(ctx)
		p = newPacer(
			mgr.cfg.TenantID, campaignID, mgr.cfg.PodID,
			mgr.cfg.Valkey, mgr.cfg.Keys, mgr.store, mgr.m,
		)
		mgr.pacers[campaignID] = &managedPacer{pacer: p, cancel: newCancel}
		mgr.mu.Unlock()
		_ = newCtx // pacer run uses its own context from the loop top
		ctx = newCtx
	}
}

// stop cancels a single pacer. Used on campaign_stopped events.
func (mgr *Manager) stop(campaignID string) {
	mgr.mu.Lock()
	mp, ok := mgr.pacers[campaignID]
	if ok {
		delete(mgr.pacers, campaignID)
	}
	mgr.mu.Unlock()
	if ok {
		mp.cancel()
		mp.pacer.Stop()
	}
}

// drainAll cancels all pacers.
func (mgr *Manager) drainAll() {
	mgr.mu.Lock()
	ids := make([]string, 0, len(mgr.pacers))
	for id := range mgr.pacers {
		ids = append(ids, id)
	}
	mgr.mu.Unlock()
	for _, id := range ids {
		mgr.stop(id)
	}
}

// handleBroadcast processes a pubsub message on the campaigns broadcast channel.
func (mgr *Manager) handleBroadcast(ctx context.Context, payload string) {
	// Payload format: "<event>:<campaignID>"
	// e.g. "campaign_config_changed:42" or "campaign_started:42" or "campaign_stopped:42"
	var event, cid string
	if n, _ := fmt.Sscanf(payload, "%s", &event); n == 0 {
		return
	}
	// Simple split on ':'
	for i, c := range payload {
		if c == ':' {
			event = payload[:i]
			cid = payload[i+1:]
			break
		}
	}
	if cid == "" {
		return
	}

	switch event {
	case "campaign_config_changed":
		mgr.store.Invalidate(mgr.cfg.TenantID, cid)
		mgr.Signal(cid)
	case "campaign_started":
		mgr.ensure(ctx, cid)
	case "campaign_stopped":
		mgr.stop(cid)
	case "agent_state_changed", "drop_gate_cleared":
		mgr.Signal(cid)
	}
}
