// config.go — process-cached campaign config loader with hot-reload.
//
// E02 PLAN §5.6: MySQL read cached 60 s; immediate refresh on
// t:{tid}:broadcast:campaign:{cid} pubsub message "campaign_config_changed".
// Phase 2 ships a static in-memory store (DB stub); Phase 3 wires real MySQL.
package pacing

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"time"
)

const configCacheTTL = 60 * time.Second

// ConfigStore loads and caches CampaignConfig from MySQL.
type ConfigStore struct {
	db  *sql.DB
	m   *Metrics
	mu  sync.RWMutex
	cache map[cacheKey]*cachedConfig
}

type cacheKey struct {
	tenantID   int64
	campaignID string
}

type cachedConfig struct {
	cfg      CampaignConfig
	fetchedAt time.Time
}

// NewConfigStore constructs a ConfigStore. db may be nil (unit-test stub).
func NewConfigStore(db *sql.DB, m *Metrics) *ConfigStore {
	return &ConfigStore{
		db:    db,
		m:     m,
		cache: make(map[cacheKey]*cachedConfig),
	}
}

// Get returns the CampaignConfig for (tenantID, campaignID), using cache if
// fresh, else re-fetching from MySQL. Returns (cfg, false) if not found.
func (s *ConfigStore) Get(ctx context.Context, tenantID int64, campaignID string) (CampaignConfig, bool, error) {
	k := cacheKey{tenantID: tenantID, campaignID: campaignID}

	s.mu.RLock()
	cached, ok := s.cache[k]
	s.mu.RUnlock()

	if ok && time.Since(cached.fetchedAt) < configCacheTTL {
		return cached.cfg, true, nil
	}

	cfg, found, err := s.fetch(ctx, tenantID, campaignID)
	if err != nil {
		return CampaignConfig{}, false, err
	}
	if !found {
		return CampaignConfig{}, false, nil
	}

	// Validate and apply defaults.
	cfg = s.validateAndDefault(cfg)

	s.mu.Lock()
	s.cache[k] = &cachedConfig{cfg: cfg, fetchedAt: time.Now()}
	s.mu.Unlock()

	return cfg, true, nil
}

// Invalidate drops the cached entry for (tenantID, campaignID) so the next
// Get triggers a fresh MySQL fetch. Called by the hot-reload pubsub handler.
func (s *ConfigStore) Invalidate(tenantID int64, campaignID string) {
	k := cacheKey{tenantID: tenantID, campaignID: campaignID}
	s.mu.Lock()
	delete(s.cache, k)
	s.mu.Unlock()
}

// Put inserts or replaces a config entry directly (for tests / stubs).
func (s *ConfigStore) Put(cfg CampaignConfig) {
	cfg = s.validateAndDefault(cfg)
	k := cacheKey{tenantID: cfg.TenantID, campaignID: cfg.CampaignID}
	s.mu.Lock()
	s.cache[k] = &cachedConfig{cfg: cfg, fetchedAt: time.Now()}
	s.mu.Unlock()
}

// fetch reads a single campaign row from MySQL.
// Phase 2 stub: if db is nil, returns not-found (callers use Put for tests).
func (s *ConfigStore) fetch(ctx context.Context, tenantID int64, campaignID string) (CampaignConfig, bool, error) {
	if s.db == nil {
		return CampaignConfig{}, false, nil
	}

	const q = `
		SELECT
			active,
			dial_method,
			auto_dial_level,
			adaptive_max_level,
			available_only_tally,
			COALESCE(calls_per_second, 5),
			COALESCE(ramp_up_factor, 2.00),
			COALESCE(min_call_buffer_seconds, 2.00),
			COALESCE(pacing_tick_ms, 1000)
		FROM campaigns
		WHERE tenant_id = ? AND id = ?
		LIMIT 1`

	row := s.db.QueryRowContext(ctx, q, tenantID, campaignID)

	var (
		active             bool
		dialMethodStr      string
		autoDialLevel      float64
		adaptiveMaxLevel   float64
		availableOnlyTally bool
		callsPerSecond     int
		rampUpFactor       float64
		minCallBufferSecs  float64
		pacingTickMs       int
	)

	if err := row.Scan(
		&active,
		&dialMethodStr,
		&autoDialLevel,
		&adaptiveMaxLevel,
		&availableOnlyTally,
		&callsPerSecond,
		&rampUpFactor,
		&minCallBufferSecs,
		&pacingTickMs,
	); err != nil {
		if err == sql.ErrNoRows {
			return CampaignConfig{}, false, nil
		}
		return CampaignConfig{}, false, fmt.Errorf("config: fetch campaign %s: %w", campaignID, err)
	}

	cfg := CampaignConfig{
		TenantID:           tenantID,
		CampaignID:         campaignID,
		Active:             active,
		DialMethod:         DialMethod(strings.ToUpper(dialMethodStr)),
		AutoDialLevel:      autoDialLevel,
		AdaptiveMaxLevel:   adaptiveMaxLevel,
		AvailableOnlyTally: availableOnlyTally,
		CallsPerSecond:     callsPerSecond,
		RampUpFactor:       rampUpFactor,
		MinCallBufferSecs:  minCallBufferSecs,
		PacingTickMs:       pacingTickMs,
		GatewayMaxCon:      make(map[int64]int),
	}
	return cfg, true, nil
}

// validateAndDefault applies range checks and sets defaults for E02 columns.
// Increments config_invalid_total for violations.
func (s *ConfigStore) validateAndDefault(cfg CampaignConfig) CampaignConfig {
	tid := strconv.FormatInt(cfg.TenantID, 10)

	if cfg.CallsPerSecond < 1 {
		slog.Warn("pacing: calls_per_second < 1, defaulting to 1",
			slog.String("tenant", tid), slog.String("campaign", cfg.CampaignID))
		cfg.CallsPerSecond = 1
		if s.m != nil {
			s.m.ConfigInvalidTotal.WithLabelValues(tid, cfg.CampaignID, "calls_per_second").Inc()
		}
	}

	if cfg.RampUpFactor < 1.0 {
		slog.Warn("pacing: ramp_up_factor < 1.0, defaulting to 2.0",
			slog.String("tenant", tid), slog.String("campaign", cfg.CampaignID))
		cfg.RampUpFactor = 2.0
		if s.m != nil {
			s.m.ConfigInvalidTotal.WithLabelValues(tid, cfg.CampaignID, "ramp_up_factor").Inc()
		}
	}

	if cfg.MinCallBufferSecs < 0.5 {
		cfg.MinCallBufferSecs = 2.0
	}

	if cfg.PacingTickMs < 200 || cfg.PacingTickMs > 5000 {
		slog.Warn("pacing: pacing_tick_ms out of range [200,5000], defaulting to 1000",
			slog.String("tenant", tid), slog.String("campaign", cfg.CampaignID))
		cfg.PacingTickMs = 1000
		if s.m != nil {
			s.m.ConfigInvalidTotal.WithLabelValues(tid, cfg.CampaignID, "pacing_tick_ms").Inc()
		}
	}

	if cfg.AdaptiveMaxLevel <= 0 {
		cfg.AdaptiveMaxLevel = 3.0
	}
	if cfg.GatewayMaxCon == nil {
		cfg.GatewayMaxCon = make(map[int64]int)
	}
	return cfg
}
