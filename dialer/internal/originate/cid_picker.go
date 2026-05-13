package originate

import (
	"context"
	"fmt"
	"log/slog"

	"github.com/vici2/dialer/internal/pool"
)

// PoolPicker is the interface expected by PickCallerID for Tier 3.
// *pool.Service implements this interface.
type PoolPicker interface {
	PickFromPool(ctx context.Context, req pool.PickRequest) (*pool.PickResult, error)
}

// PickCallerID runs the 4-tier caller-ID waterfall and returns the chosen
// number, display name, and source tier.
//
// Tier 1: per-call override (req.CallerIDOverride)
// Tier 2: per-list override (req.ListCallerID — F02 AMENDMENT T04.3)
// Tier 3: number pool (X04) / local-presence hint (X05)
// Tier 4: campaign default (req.CallerIDCampaign)
//
// Returns an error only when no tier can supply a CID (operator config error).
func PickCallerID(
	ctx context.Context,
	req *OriginateRequest,
	poolSvc PoolPicker,
) (number, name string, source OriginateCidSource, err error) {
	// Tier 1: per-call override
	if req.CallerIDOverride != "" {
		return req.CallerIDOverride, req.CallerIDName, CidSourcePerCall, nil
	}

	// Tier 2: per-list override (F02 AMENDMENT T04.3+T04.4)
	if req.ListCallerID != nil && *req.ListCallerID != "" {
		return *req.ListCallerID, "", CidSourcePerList, nil
	}

	// Tier 3: number pool (X04) / local-presence (X05)
	if req.NumberPoolID != 0 && poolSvc != nil {
		res, pickErr := poolSvc.PickFromPool(ctx, pool.PickRequest{
			PoolID:       req.NumberPoolID,
			TenantID:     req.TenantID,
			AreaCodeHint: req.LocalPresenceAreaCode, // X05 sets this
		})
		if pickErr == nil {
			return res.E164, "", CidSourceLocalPresence, nil
		}
		// On ErrPoolEmpty: fall through to Tier 4 (log warning).
		slog.WarnContext(ctx, "pool: empty, falling back to campaign CID",
			"pool_id", req.NumberPoolID, "err", pickErr)
	}

	// Tier 4: campaign default
	if req.CallerIDCampaign != "" {
		return req.CallerIDCampaign, "", CidSourceCampaignDflt, nil
	}

	return "", "", "", fmt.Errorf(
		"originate: no caller-id available for campaign %s (configure campaigns.caller_id_override)",
		req.CampaignID,
	)
}
