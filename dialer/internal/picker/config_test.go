package picker

import (
	"context"
	"testing"

	"github.com/vici2/dialer/internal/originate"
)

// TestParseConfigSnapshot_Valid verifies JSON decoding.
func TestParseConfigSnapshot_Valid(t *testing.T) {
	raw := `{
		"mode": "PREDICTIVE",
		"call_strategy": "longest_wait",
		"lead_lock_ttl_sec": 45,
		"dial_timeout_sec": 30,
		"active": true,
		"amd_enabled": true,
		"campaign_id_str": "SOLAR_Q2"
	}`
	cfg, err := parseConfigSnapshot(1, 42, raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != originate.ModePredictive {
		t.Errorf("Mode: got %s, want PREDICTIVE", cfg.Mode)
	}
	if cfg.CallStrategy != StrategyLongestWait {
		t.Errorf("CallStrategy: got %s, want longest_wait", cfg.CallStrategy)
	}
	if cfg.LeadLockTTLSec != 45 {
		t.Errorf("LeadLockTTLSec: got %d, want 45", cfg.LeadLockTTLSec)
	}
	if cfg.DialTimeoutSec != 30 {
		t.Errorf("DialTimeoutSec: got %d, want 30", cfg.DialTimeoutSec)
	}
	if !cfg.Active {
		t.Error("expected Active=true")
	}
	if !cfg.AMDEnabled {
		t.Error("expected AMDEnabled=true")
	}
	if cfg.CampaignIDStr != "SOLAR_Q2" {
		t.Errorf("CampaignIDStr: got %s", cfg.CampaignIDStr)
	}
}

// TestParseConfigSnapshot_Defaults verifies zero-value fields use safe defaults.
func TestParseConfigSnapshot_Defaults(t *testing.T) {
	raw := `{"active": true}`
	cfg, err := parseConfigSnapshot(1, 10, raw)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != originate.ModeProgressive {
		t.Errorf("expected default mode PROGRESSIVE, got %s", cfg.Mode)
	}
	if cfg.CallStrategy != StrategyLongestWait {
		t.Errorf("expected default strategy longest_wait, got %s", cfg.CallStrategy)
	}
	if cfg.LeadLockTTLSec != 30 {
		t.Errorf("expected default lock TTL 30, got %d", cfg.LeadLockTTLSec)
	}
	if cfg.DialTimeoutSec != 22 {
		t.Errorf("expected default dial timeout 22, got %d", cfg.DialTimeoutSec)
	}
}

// TestParseConfigSnapshot_InvalidJSON verifies error on malformed JSON.
func TestParseConfigSnapshot_InvalidJSON(t *testing.T) {
	_, err := parseConfigSnapshot(1, 10, `{invalid json}`)
	if err == nil {
		t.Error("expected error for invalid JSON")
	}
}

// TestLoadCampaignConfig_MissingKey verifies default is returned on missing key.
func TestLoadCampaignConfig_MissingKey(t *testing.T) {
	vc, _ := newTestValkey(t)
	ctx := context.Background()

	cfg, err := LoadCampaignConfig(ctx, vc, 1, 9999)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// Missing key → safe default: inactive campaign.
	if cfg.Active {
		t.Error("expected Active=false for missing key")
	}
	if cfg.TenantID != 1 {
		t.Errorf("expected TenantID=1, got %d", cfg.TenantID)
	}
	if cfg.CampaignID != 9999 {
		t.Errorf("expected CampaignID=9999, got %d", cfg.CampaignID)
	}
}

// TestLoadCampaignConfig_Valid verifies loading from Valkey.
func TestLoadCampaignConfig_Valid(t *testing.T) {
	vc, mr := newTestValkey(t)
	ctx := context.Background()

	key := configSnapshotKey(1, 55)
	mr.Set(key, `{"mode":"PREDICTIVE","active":true,"lead_lock_ttl_sec":20}`)

	cfg, err := LoadCampaignConfig(ctx, vc, 1, 55)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if cfg.Mode != originate.ModePredictive {
		t.Errorf("expected PREDICTIVE, got %s", cfg.Mode)
	}
	if cfg.LeadLockTTLSec != 20 {
		t.Errorf("expected 20, got %d", cfg.LeadLockTTLSec)
	}
	if !cfg.Active {
		t.Error("expected Active=true")
	}
}

// TestCampaignConfigCache_IsActive verifies IsActive reads correctly.
func TestCampaignConfigCache_IsActive(t *testing.T) {
	cache := NewCampaignConfigCache()
	cache.Set(CampaignConfig{TenantID: 1, CampaignID: 1, Active: true})
	cache.Set(CampaignConfig{TenantID: 1, CampaignID: 2, Active: false})

	if !cache.IsActive(1) {
		t.Error("expected IsActive=true for campaign 1")
	}
	if cache.IsActive(2) {
		t.Error("expected IsActive=false for campaign 2")
	}
	if cache.IsActive(99) {
		t.Error("expected IsActive=false for unknown campaign")
	}
}

// TestCampaignConfigCache_ActiveCampaignIDs returns only active IDs.
func TestCampaignConfigCache_ActiveCampaignIDs(t *testing.T) {
	cache := NewCampaignConfigCache()
	cache.Set(CampaignConfig{TenantID: 1, CampaignID: 1, Active: true})
	cache.Set(CampaignConfig{TenantID: 1, CampaignID: 2, Active: false})
	cache.Set(CampaignConfig{TenantID: 1, CampaignID: 3, Active: true})

	ids := cache.ActiveCampaignIDs()
	if len(ids) != 2 {
		t.Errorf("expected 2 active campaigns, got %d", len(ids))
	}
}

// TestCampaignConfigCache_Delete removes campaign from cache.
func TestCampaignConfigCache_Delete(t *testing.T) {
	cache := NewCampaignConfigCache()
	cache.Set(CampaignConfig{TenantID: 1, CampaignID: 5, Active: true})
	cache.Delete(5)

	if cache.IsActive(5) {
		t.Error("expected IsActive=false after Delete")
	}
}

// TestDefaultConfig verifies all safe-default values.
func TestDefaultConfig(t *testing.T) {
	cfg := defaultConfig(1, 42)
	if cfg.Active {
		t.Error("defaultConfig should have Active=false")
	}
	if cfg.LeadLockTTLSec != 30 {
		t.Errorf("expected LeadLockTTLSec=30, got %d", cfg.LeadLockTTLSec)
	}
	if cfg.DialTimeoutSec != 22 {
		t.Errorf("expected DialTimeoutSec=22, got %d", cfg.DialTimeoutSec)
	}
}
