// hopper.go — typed wrapper around the hopper Lua scripts.

package valkey

import (
	"context"
	"errors"
	"fmt"
	"strconv"

	"github.com/redis/go-redis/v9"
)

// HopperOps groups hopper-related typed operations.
type HopperOps struct{ c *Client }

// Hopper returns the typed hopper operations bound to this client.
func (c *Client) Hopper() *HopperOps { return &HopperOps{c: c} }

// Push adds a single lead to the hopper. Score is computed by the
// caller; convention: `(MAX_PRIO - priority) * 1e10 + entry_ts_unix`.
func (h *HopperOps) Push(ctx context.Context, cid, leadID int64, score float64) error {
	return h.c.State.ZAdd(ctx, h.c.Keys.CampaignHopper(cid), redis.Z{
		Score:  score,
		Member: leadID,
	}).Err()
}

// Size returns ZCARD of the hopper.
func (h *HopperOps) Size(ctx context.Context, cid int64) (int64, error) {
	return h.c.State.ZCard(ctx, h.c.Keys.CampaignHopper(cid)).Result()
}

// Claim atomically pops the next lead from the hopper and writes the
// per-lead lock + in_flight HASH entry. lockTTLSec defaults to 30s if 0.
//
// Returns (0, "", nil) when the hopper is empty — caller must distinguish
// this from an error.
func (h *HopperOps) Claim(
	ctx context.Context,
	cid int64,
	instanceID string,
	lockTTLSec int,
	nowMs int64,
) (leadID int64, lockVal string, err error) {
	if lockTTLSec <= 0 {
		lockTTLSec = 30
	}
	if instanceID == "" {
		return 0, "", errors.New("valkey: Claim requires instanceID")
	}

	res, err := h.c.Scripts.Eval(
		ctx,
		h.c.State,
		ScriptClaimLeadFromHopper,
		[]string{
			h.c.Keys.CampaignHopper(cid),
			h.c.Keys.LeadLockPrefix(cid),
			h.c.Keys.CampaignInFlight(cid),
		},
		strconv.Itoa(lockTTLSec), instanceID, strconv.FormatInt(nowMs, 10),
	)
	if err != nil {
		return 0, "", err
	}
	if res == nil {
		return 0, "", nil
	}
	s, ok := res.(string)
	if !ok {
		return 0, "", fmt.Errorf("valkey: Claim returned unexpected %T", res)
	}
	id, perr := strconv.ParseInt(s, 10, 64)
	if perr != nil {
		return 0, "", fmt.Errorf("valkey: Claim lead_id parse: %w", perr)
	}
	return id, instanceID + ":" + strconv.FormatInt(nowMs, 10), nil
}

// Release idempotently releases a hopper lock. If reinsert is true the
// lead is added back to the hopper at the given score.
func (h *HopperOps) Release(
	ctx context.Context,
	cid, leadID int64,
	lockVal string,
	reinsert bool,
	score float64,
) (released bool, err error) {
	reinsertArg := "0"
	if reinsert {
		reinsertArg = "1"
	}
	res, err := h.c.Scripts.Eval(
		ctx,
		h.c.State,
		ScriptReleaseHopperLock,
		[]string{
			h.c.Keys.LeadLock(cid, leadID),
			h.c.Keys.CampaignInFlight(cid),
			h.c.Keys.CampaignHopper(cid),
		},
		strconv.FormatInt(leadID, 10),
		reinsertArg,
		strconv.FormatFloat(score, 'f', -1, 64),
		lockVal,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.(int64)
	return n == 1, nil
}

// InFlightCount returns HLEN of the in_flight HASH for a campaign —
// useful for /metrics and for janitor reconciliation.
func (h *HopperOps) InFlightCount(ctx context.Context, cid int64) (int64, error) {
	return h.c.State.HLen(ctx, h.c.Keys.CampaignInFlight(cid)).Result()
}
