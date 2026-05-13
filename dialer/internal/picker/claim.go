package picker

import (
	"context"
	"fmt"
	"time"

	"github.com/vici2/dialer/internal/valkey"
)

// Claimer wraps valkey.HopperOps.Claim/Release with picker-typed results.
// All Lua script interactions go through the F04 valkey package; E04 adds
// no new Lua scripts (PLAN §17).
type Claimer struct {
	vc      *valkey.Client
	metrics *Metrics
}

// NewClaimer constructs a Claimer.
func NewClaimer(vc *valkey.Client, m *Metrics) *Claimer {
	return &Claimer{vc: vc, metrics: m}
}

// Claim atomically pops the next lead from the campaign hopper ZSET and
// writes the per-lead lock + in_flight HASH entry via claim_lead_from_hopper.v1.lua.
//
// Returns (claim, nil) on success.
// Returns a zero LeadClaim with ErrHopperEmpty when the hopper is empty.
// Never returns a partial LeadClaim on error.
//
// Lead phone/list metadata is not populated here — the caller must fetch it
// from MySQL or the lead HASH before building the OriginateRequest.
func (c *Claimer) Claim(
	ctx context.Context,
	tenantID, campaignID int64,
	instanceID string,
	lockTTLSec int,
) (LeadClaim, error) {
	nowMs := time.Now().UnixMilli()

	leadID, lockVal, err := c.vc.Hopper().Claim(ctx, campaignID, instanceID, lockTTLSec, nowMs)
	if err != nil {
		c.metrics.ClaimTotal.WithLabelValues(
			fmt.Sprintf("%d", tenantID),
			fmt.Sprintf("%d", campaignID),
			"error",
		).Inc()
		return LeadClaim{}, fmt.Errorf("picker: claim lead: %w", err)
	}
	if leadID == 0 {
		c.metrics.ClaimTotal.WithLabelValues(
			fmt.Sprintf("%d", tenantID),
			fmt.Sprintf("%d", campaignID),
			"empty_hopper",
		).Inc()
		return LeadClaim{}, ErrHopperEmpty
	}

	c.metrics.ClaimTotal.WithLabelValues(
		fmt.Sprintf("%d", tenantID),
		fmt.Sprintf("%d", campaignID),
		"success",
	).Inc()

	return LeadClaim{
		LeadID:     leadID,
		CampaignID: campaignID,
		LockVal:    lockVal,
		ClaimTs:    time.UnixMilli(nowMs),
	}, nil
}

// Release idempotently releases a hopper lock. If requeue is true, the
// lead is re-added to the hopper with the given score.
//
// The fence token (claim.LockVal) prevents releasing a lock that has
// already been reclaimed by another E04 instance (PLAN §5.2).
func (c *Claimer) Release(
	ctx context.Context,
	campaignID, leadID int64,
	lockVal string,
	requeue bool,
	score float64,
) error {
	_, err := c.vc.Hopper().Release(ctx, campaignID, leadID, lockVal, requeue, score)
	if err != nil {
		return fmt.Errorf("picker: release hopper lock for lead %d: %w", leadID, err)
	}
	return nil
}

// ReleaseWithPolicy releases a lead claim using the retry policy for the given outcome.
// Score is set to 0 for immediate re-queue or a large value (nowMs + delay) for
// delayed re-queue. The exact score computation is E01's concern; E04 passes 0.
func (c *Claimer) ReleaseWithPolicy(
	ctx context.Context,
	campaignID int64,
	claim LeadClaim,
	outcome DialOutcome,
) error {
	policy := PolicyFor(outcome)
	var score float64
	if policy.Requeue && policy.Immediate {
		score = 0
	} else if policy.Requeue {
		// Non-immediate requeue: use time.Now as score; E01 applies recycle delay.
		score = float64(time.Now().UnixMilli())
	}
	return c.Release(ctx, campaignID, claim.LeadID, claim.LockVal, policy.Requeue, score)
}
