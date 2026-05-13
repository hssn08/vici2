package picker

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"

	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/valkey"
)

// CallStrategy mirrors campaigns.call_strategy (F02 E04 amendment).
// Phase 2 ships only longest_wait; other strategies in HANDOFF Phase 3.
type CallStrategy string

const (
	StrategyLongestWait CallStrategy = "longest_wait"
	StrategyRandom      CallStrategy = "random"
	StrategyFewestCalls CallStrategy = "fewest_calls"
	StrategyRank        CallStrategy = "rank"
)

// CampaignConfig is a snapshot of campaign configuration read from
// t:{tid}:campaign:{cid}:config_snapshot (JSON STRING set by M02 on save).
// Hot-reloaded on pubsub t:{tid}:broadcast:campaign:{cid}:config_changed.
//
// E04 never reads MySQL directly — config comes from M02's snapshot.
// Worst-case staleness: 100 ms (one dispatch tick).
type CampaignConfig struct {
	TenantID       int64
	CampaignID     int64
	CampaignIDStr  string // VARCHAR(32) for OriginateRequest
	Mode           originate.OriginateMode
	CallStrategy   CallStrategy
	LeadLockTTLSec int // default 30; F02 amendment campaigns.lead_lock_ttl_seconds
	DialTimeoutSec int // ring seconds; default 22
	Active         bool
	AMDEnabled     bool
}

// configSnapshotKey returns the Valkey key for the campaign config snapshot.
// Written by M02; read by E04 on hot-reload.
func configSnapshotKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:campaign:%d:config_snapshot", tid, cid)
}

// dispatchTokensKey returns the per-campaign dispatch_tokens STRING key.
// Written by E02 each tick (SET n EX 2); E04 DECRs per dispatch.
func dispatchTokensKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:dispatch_tokens", tid, cid)
}

// refillRequestKey returns the key E04 publishes to when the hopper is empty.
// E01 filler subscribes to this channel and wakes up to refill.
func refillRequestKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:broadcast:campaign:%d:refill_request", tid, cid)
}

// configChangedKey returns the pubsub channel E04 subscribes to for hot-reload.
func configChangedKey(tid, cid int64) string {
	return fmt.Sprintf("t:%d:broadcast:campaign:%d:config_changed", tid, cid)
}

// configJSONSnapshot is the on-wire JSON shape of the config_snapshot STRING.
// M02 writes this; E04 decodes it.
type configJSONSnapshot struct {
	Mode           string `json:"mode"`
	CallStrategy   string `json:"call_strategy"`
	LeadLockTTLSec int    `json:"lead_lock_ttl_sec"`
	DialTimeoutSec int    `json:"dial_timeout_sec"`
	Active         bool   `json:"active"`
	AMDEnabled     bool   `json:"amd_enabled"`
	CampaignIDStr  string `json:"campaign_id_str"`
}

// LoadCampaignConfig loads a CampaignConfig from Valkey.
// Returns a safe default if the key is missing (campaign not yet saved via M02).
func LoadCampaignConfig(ctx context.Context, vc *valkey.Client, tenantID, campaignID int64) (CampaignConfig, error) {
	key := configSnapshotKey(tenantID, campaignID)
	raw, err := vc.State.Get(ctx, key).Result()
	if err != nil {
		// Key missing → return a safe default (campaign appears inactive).
		return defaultConfig(tenantID, campaignID), nil
	}
	return parseConfigSnapshot(tenantID, campaignID, raw)
}

// parseConfigSnapshot decodes the JSON blob from Valkey into a CampaignConfig.
func parseConfigSnapshot(tenantID, campaignID int64, raw string) (CampaignConfig, error) {
	var snap configJSONSnapshot
	if err := json.Unmarshal([]byte(raw), &snap); err != nil {
		return CampaignConfig{}, fmt.Errorf("picker: parse config snapshot for campaign %d: %w", campaignID, err)
	}

	mode := originate.OriginateMode(snap.Mode)
	if mode == "" {
		mode = originate.ModeProgressive
	}
	strategy := CallStrategy(snap.CallStrategy)
	if strategy == "" {
		strategy = StrategyLongestWait
	}
	lockTTL := snap.LeadLockTTLSec
	if lockTTL <= 0 {
		lockTTL = 30
	}
	dialTO := snap.DialTimeoutSec
	if dialTO <= 0 {
		dialTO = 22
	}
	cidStr := snap.CampaignIDStr
	if cidStr == "" {
		cidStr = fmt.Sprintf("%d", campaignID)
	}

	return CampaignConfig{
		TenantID:       tenantID,
		CampaignID:     campaignID,
		CampaignIDStr:  cidStr,
		Mode:           mode,
		CallStrategy:   strategy,
		LeadLockTTLSec: lockTTL,
		DialTimeoutSec: dialTO,
		Active:         snap.Active,
		AMDEnabled:     snap.AMDEnabled,
	}, nil
}

// defaultConfig returns a safe default config when the snapshot is missing.
func defaultConfig(tenantID, campaignID int64) CampaignConfig {
	return CampaignConfig{
		TenantID:       tenantID,
		CampaignID:     campaignID,
		CampaignIDStr:  fmt.Sprintf("%d", campaignID),
		Mode:           originate.ModeProgressive,
		CallStrategy:   StrategyLongestWait,
		LeadLockTTLSec: 30,
		DialTimeoutSec: 22,
		Active:         false,
		AMDEnabled:     false,
	}
}

// CampaignConfigCache is a thread-safe in-process cache of CampaignConfig
// snapshots. Updated via pubsub config_changed events. Read latency ~50 ns.
type CampaignConfigCache struct {
	mu   sync.RWMutex
	data map[int64]CampaignConfig
}

// NewCampaignConfigCache constructs an empty cache.
func NewCampaignConfigCache() *CampaignConfigCache {
	return &CampaignConfigCache{data: make(map[int64]CampaignConfig)}
}

// Get returns the current config for a campaign (zero-value if not cached).
func (c *CampaignConfigCache) Get(cid int64) (CampaignConfig, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	cfg, ok := c.data[cid]
	return cfg, ok
}

// Set stores or replaces a config in the cache.
func (c *CampaignConfigCache) Set(cfg CampaignConfig) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data[cfg.CampaignID] = cfg
}

// IsActive returns true if the campaign is active in the cache.
func (c *CampaignConfigCache) IsActive(cid int64) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	cfg, ok := c.data[cid]
	if !ok {
		return false
	}
	return cfg.Active
}

// Delete removes a campaign from the cache (on deactivation).
func (c *CampaignConfigCache) Delete(cid int64) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.data, cid)
}

// ActiveCampaignIDs returns the IDs of all currently active campaigns.
func (c *CampaignConfigCache) ActiveCampaignIDs() []int64 {
	c.mu.RLock()
	defer c.mu.RUnlock()
	ids := make([]int64, 0, len(c.data))
	for cid, cfg := range c.data {
		if cfg.Active {
			ids = append(ids, cid)
		}
	}
	return ids
}
