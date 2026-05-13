package picker

import (
	"context"
	"fmt"

	"github.com/vici2/dialer/internal/valkey"
)

// TokenBucket manages per-campaign dispatch_tokens DECR/INCR against Valkey.
// E02 writes: SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2 each tick.
// E04 reads: DECR atomically per dispatch; refuses when result ≤ 0.
//
// See PLAN §3.1 for the full contract and §3.2 for accepted trade-offs.
type TokenBucket struct {
	vc      *valkey.Client
	metrics *Metrics
}

// NewTokenBucket constructs a TokenBucket bound to the given Valkey client.
func NewTokenBucket(vc *valkey.Client, m *Metrics) *TokenBucket {
	return &TokenBucket{vc: vc, metrics: m}
}

// Acquire atomically DECRs the dispatch_tokens counter for the given campaign.
// Returns (true, nil) when a token was successfully consumed.
// Returns (false, nil) when no tokens are available (over-decremented → INCR
// restored).
// Returns (false, ErrNoTokens) when the key is missing (E02 down / TTL expired).
//
// PLAN §3.1 code pattern.
func (t *TokenBucket) Acquire(ctx context.Context, tid, cid int64) (ok bool, err error) {
	key := dispatchTokensKey(tid, cid)
	val, err := t.vc.State.Decr(ctx, key).Result()
	if err != nil {
		// Valkey connection error or key-type mismatch → ErrNoTokens.
		// Note: DECR on a missing key is NOT an error in Redis/Valkey; it
		// creates the key at 0 and returns -1, which is caught below as
		// over-decrement. ErrNoTokens is for genuine transport failures.
		return false, ErrNoTokens
	}
	if val < 0 {
		// Over-decremented (race with another pod or TTL flip).
		// Restore best-effort; ignore error (leakage is bounded and monitored).
		_, _ = t.vc.State.Incr(ctx, key).Result()
		t.metrics.TokensOverDecremented.WithLabelValues(
			fmt.Sprintf("%d", tid), fmt.Sprintf("%d", cid),
		).Inc()
		return false, nil
	}
	t.metrics.TokensConsumed.WithLabelValues(
		fmt.Sprintf("%d", tid), fmt.Sprintf("%d", cid),
	).Inc()
	return true, nil
}

// Release INCRs the token back (best-effort) when dispatch fails before
// T04.Originate is called. Once T04 is invoked, the token is "spent".
// On dispatch-deadline timeout the token is not restored (Q8 decision).
func (t *TokenBucket) Release(ctx context.Context, tid, cid int64) {
	key := dispatchTokensKey(tid, cid)
	_, _ = t.vc.State.Incr(ctx, key).Result()
}
