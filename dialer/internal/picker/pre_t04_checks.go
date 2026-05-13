package picker

import (
	"context"
	"fmt"

	"github.com/vici2/dialer/internal/valkey"
)

// dialEligibleStatuses is the set of lead status codes that allow a dial attempt.
// Derived from D04 RESEARCH §3 lead_statuses taxonomy.
// Leads with any other status are considered ineligible for dispatch.
var dialEligibleStatuses = map[string]bool{
	"NEW":    true,
	"NA":     true,  // No Answer — eligible for retry
	"B-CAR": true,  // Busy/carrier — eligible for retry
	"CALLBK": true, // Callback scheduled
	"":       true,  // No status set yet (fresh lead)
}

// PreT04Checker runs the two cheap pre-T04 checks per PLAN §10:
//  1. Campaign still active (process-cache ~50 ns)
//  2. Lead still dial-eligible (Valkey HGET ~50 µs)
//
// T04 owns all 5 compliance gates (TCPA, DNC, consent, drop-cap,
// gateway-cap). E04 explicitly does NOT re-run those gates.
type PreT04Checker struct {
	vc      *valkey.Client
	cfgCache *CampaignConfigCache
}

// NewPreT04Checker constructs a PreT04Checker.
func NewPreT04Checker(vc *valkey.Client, cache *CampaignConfigCache) *PreT04Checker {
	return &PreT04Checker{vc: vc, cfgCache: cache}
}

// CheckCampaignActive returns ErrCampaignPaused if the campaign is inactive
// in the process-cache. Read latency: ~50 ns (sync.RWMutex + map lookup).
func (c *PreT04Checker) CheckCampaignActive(campaignID int64) error {
	if !c.cfgCache.IsActive(campaignID) {
		return ErrCampaignPaused
	}
	return nil
}

// CheckLeadEligible fetches the lead status from the Valkey HASH and returns
// ErrLeadIneligible if it is not in the dial-eligible set.
// Read latency: ~50 µs (one Valkey HGET).
//
// Catches leads that became DNC or DROPPED in the seconds between
// E01 hopper-fill and E04 pop, avoiding a wasted T04 audit-row INSERT.
func (c *PreT04Checker) CheckLeadEligible(ctx context.Context, tenantID, leadID int64) error {
	key := fmt.Sprintf("t:%d:lead:%d", tenantID, leadID)
	status, err := c.vc.State.HGet(ctx, key, "status").Result()
	if err != nil {
		// Key missing means the lead HASH hasn't been written yet (fresh lead).
		// Treat as eligible; T04 gates will validate compliance.
		return nil
	}
	if !dialEligibleStatuses[status] {
		return ErrLeadIneligible
	}
	return nil
}
