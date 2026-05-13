package originate

import "fmt"

// PickCallerID runs the 4-tier caller-ID waterfall and returns the chosen
// number, display name, and source tier.
//
// Tier 1: per-call override (req.CallerIDOverride)
// Tier 2: per-list override (req.ListCallerID — F02 AMENDMENT T04.3)
// Tier 3: local-presence pool (X05, Phase 3.5 — returns nil in Phase 1)
// Tier 4: campaign default (req.CallerIDCampaign)
//
// Returns an error only when no tier can supply a CID (operator config error).
func PickCallerID(req *OriginateRequest) (number, name string, source OriginateCidSource, err error) {
	// Tier 1: per-call override
	if req.CallerIDOverride != "" {
		return req.CallerIDOverride, req.CallerIDName, CidSourcePerCall, nil
	}

	// Tier 2: per-list override (F02 AMENDMENT T04.3+T04.4)
	if req.ListCallerID != nil && *req.ListCallerID != "" {
		return *req.ListCallerID, "", CidSourcePerList, nil
	}

	// Tier 3: local-presence (X05, Phase 3.5 — stub returns nil/miss in Phase 1)
	// X05 is not wired yet; metric will fire when it is.

	// Tier 4: campaign default
	if req.CallerIDCampaign != "" {
		return req.CallerIDCampaign, "", CidSourceCampaignDflt, nil
	}

	return "", "", "", fmt.Errorf("originate: no caller-id available for campaign %s (configure campaigns.caller_id_override)", req.CampaignID)
}
