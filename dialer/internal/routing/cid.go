package routing

// CallerIDForCall returns the effective caller-ID E.164 for an outbound call.
// It implements the 4-tier waterfall. T02 PLAN §8, T04 PLAN §0 bullet 6.
//
// Tier precedence (highest to lowest):
//  1. PerCallOverride — per-originate request
//  2. PerListOverride — lists.caller_id_override (F02 AMENDMENTS T04.3)
//  3. LocalPresencePool — Phase 3.5 (X05 module); returns "" in Phase 1
//  4. CampaignDefault — campaigns.caller_id_override
//
// Returns "" if no tier provides a value (caller should abort or use system default).
func CallerIDForCall(req CIDRequest) string {
	if req.PerCallOverride != "" {
		return req.PerCallOverride
	}
	if req.PerListOverride != "" {
		return req.PerListOverride
	}
	// Tier 3: local presence (Phase 1 stub — always empty).
	if lp := localPresenceLookup(req); lp != "" {
		return lp
	}
	return req.CampaignDefault
}

// localPresenceLookup is the Phase 3.5 stub for X05 local-presence pool.
// Phase 1: always returns "". X05 will replace this with a real lookup.
func localPresenceLookup(_ CIDRequest) string { return "" }
