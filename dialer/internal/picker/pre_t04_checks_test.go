package picker

import (
	"context"
	"fmt"
	"testing"

	"github.com/vici2/dialer/internal/originate"
)

func TestCheckCampaignActive_Active(t *testing.T) {
	vc, _ := newTestValkey(t)
	cache := NewCampaignConfigCache()
	cache.Set(CampaignConfig{
		TenantID:   1,
		CampaignID: 10,
		Active:     true,
		Mode:       originate.ModeProgressive,
	})
	checker := NewPreT04Checker(vc, cache)

	if err := checker.CheckCampaignActive(10); err != nil {
		t.Errorf("expected nil for active campaign, got: %v", err)
	}
}

func TestCheckCampaignActive_Paused(t *testing.T) {
	vc, _ := newTestValkey(t)
	cache := NewCampaignConfigCache()
	cache.Set(CampaignConfig{
		TenantID:   1,
		CampaignID: 10,
		Active:     false,
		Mode:       originate.ModeProgressive,
	})
	checker := NewPreT04Checker(vc, cache)

	if err := checker.CheckCampaignActive(10); err != ErrCampaignPaused {
		t.Errorf("expected ErrCampaignPaused, got: %v", err)
	}
}

func TestCheckCampaignActive_NotInCache(t *testing.T) {
	vc, _ := newTestValkey(t)
	cache := NewCampaignConfigCache()
	checker := NewPreT04Checker(vc, cache)

	// Campaign not in cache → treat as paused.
	if err := checker.CheckCampaignActive(999); err != ErrCampaignPaused {
		t.Errorf("expected ErrCampaignPaused for missing campaign, got: %v", err)
	}
}

func TestCheckLeadEligible_EligibleStatus(t *testing.T) {
	vc, mr := newTestValkey(t)
	cache := NewCampaignConfigCache()
	checker := NewPreT04Checker(vc, cache)
	ctx := context.Background()

	// Write lead HASH with eligible status.
	key := fmt.Sprintf("t:%d:lead:%d", 1, 100)
	mr.HSet(key, "status", "NA")

	if err := checker.CheckLeadEligible(ctx, 1, 100); err != nil {
		t.Errorf("expected nil for eligible lead, got: %v", err)
	}
}

func TestCheckLeadEligible_IneligibleStatus(t *testing.T) {
	vc, mr := newTestValkey(t)
	cache := NewCampaignConfigCache()
	checker := NewPreT04Checker(vc, cache)
	ctx := context.Background()

	key := fmt.Sprintf("t:%d:lead:%d", 1, 101)
	mr.HSet(key, "status", "DNC")

	if err := checker.CheckLeadEligible(ctx, 1, 101); err != ErrLeadIneligible {
		t.Errorf("expected ErrLeadIneligible, got: %v", err)
	}
}

func TestCheckLeadEligible_KeyMissing(t *testing.T) {
	vc, _ := newTestValkey(t)
	cache := NewCampaignConfigCache()
	checker := NewPreT04Checker(vc, cache)
	ctx := context.Background()

	// Missing key → treat as eligible (fresh lead).
	if err := checker.CheckLeadEligible(ctx, 1, 999); err != nil {
		t.Errorf("expected nil for fresh lead, got: %v", err)
	}
}

func TestDialEligibleStatuses(t *testing.T) {
	eligible := []string{"NEW", "NA", "B-CAR", "CALLBK", ""}
	for _, s := range eligible {
		if !dialEligibleStatuses[s] {
			t.Errorf("status %q should be eligible", s)
		}
	}
	ineligible := []string{"DNC", "DROP", "INVALID", "CONSENT_NOT_OBTAINED"}
	for _, s := range ineligible {
		if dialEligibleStatuses[s] {
			t.Errorf("status %q should not be eligible", s)
		}
	}
}
