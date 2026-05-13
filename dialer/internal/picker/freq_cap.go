package picker

import (
	"context"
	"fmt"
	"time"

	"github.com/vici2/dialer/internal/valkey"
)

// freqCapTTL is the TTL for the frequency-cap counter.
// Set to 24 hours so the key expires naturally after one day.
// The counter itself is read by E01 filler to gate re-dispatch frequency.
const freqCapTTL = 24 * time.Hour

// FreqCapIncrementer owns incrementing t:{tid}:freq:{phone}:{cid} on
// OutcomeBridged. E01 PLAN §8.2 confirms E04 owns this INCR.
type FreqCapIncrementer struct {
	vc *valkey.Client
}

// NewFreqCapIncrementer constructs a FreqCapIncrementer.
func NewFreqCapIncrementer(vc *valkey.Client) *FreqCapIncrementer {
	return &FreqCapIncrementer{vc: vc}
}

// IncrOnBridged increments the frequency cap counter for the lead's phone
// number when a call is successfully bridged (OutcomeBridged).
// Called after T04.Originate returns OutcomeSuccess on the bridged path.
func (f *FreqCapIncrementer) IncrOnBridged(
	ctx context.Context,
	tenantID, campaignID int64,
	phoneE164 string,
) error {
	key := fmt.Sprintf("t:%d:freq:%s:%d", tenantID, phoneE164, campaignID)
	pipe := f.vc.Cache.Pipeline()
	pipe.Incr(ctx, key)
	pipe.Expire(ctx, key, freqCapTTL)
	_, err := pipe.Exec(ctx)
	if err != nil {
		// Non-fatal: freq cap is advisory; log but don't fail the dispatch.
		return fmt.Errorf("picker: freq_cap incr: %w", err)
	}
	return nil
}
