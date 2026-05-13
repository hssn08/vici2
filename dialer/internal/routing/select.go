package routing

import (
	"context"
	"fmt"
	"sort"

	"github.com/redis/go-redis/v9"
)

// Selector implements gateway selection with weight + max_concurrent + health filtering.
// T02 PLAN §0 bullets 1–3, §9.1, §10.2.
type Selector struct {
	rdb redis.Cmdable
	// keys is a function that returns the Valkey key for the gateway active counter.
	// Injected to avoid a circular import on the valkey package.
	gwActiveKey func(tenantID, gatewayID int64) string
}

// NewSelector constructs a Selector. rdb may be nil for unit tests (active count always 0).
func NewSelector(rdb redis.Cmdable, gwActiveKeyFn func(tenantID, gatewayID int64) string) *Selector {
	if gwActiveKeyFn == nil {
		gwActiveKeyFn = defaultGWActiveKey
	}
	return &Selector{rdb: rdb, gwActiveKey: gwActiveKeyFn}
}

func defaultGWActiveKey(tenantID, gatewayID int64) string {
	return fmt.Sprintf("t:%d:gw:%d:active", tenantID, gatewayID)
}

// SelectGateway selects the best eligible gateway from req.Gateways.
//
// Eligibility rules (T02 PLAN §9.1, §10.2):
//  1. gateway.Active must be true.
//  2. health cache entry must be missing (unknown) or healthy==true.
//  3. active calls < gateway.MaxConcurrent (if set).
//
// Among eligible gateways, selection is deterministic:
// sort by (priority ASC, weight DESC) — ties broken by gatewayID ASC for stability.
//
// Returns ErrNoGateway if no eligible gateway exists.
// req.ActiveCounts may be pre-populated (e.g. by a batch MGET from the caller);
// if a gateway's ID is absent, the selector fetches its counter from Valkey.
func (s *Selector) SelectGateway(ctx context.Context, req SelectRequest) (SelectResult, error) {
	// Sort gateways: priority ASC, weight DESC, id ASC for stability.
	sorted := make([]Gateway, len(req.Gateways))
	copy(sorted, req.Gateways)
	sort.Slice(sorted, func(i, j int) bool {
		pi, pj := sorted[i].Priority, sorted[j].Priority
		if pi != pj {
			return pi < pj
		}
		wi, wj := sorted[i].Weight, sorted[j].Weight
		if wi != wj {
			return wi > wj
		}
		return sorted[i].ID < sorted[j].ID
	})

	for _, gw := range sorted {
		if !gw.Active {
			continue
		}
		// Health filter: skip if explicitly unhealthy (stale/absent entries = pass).
		if h, ok := req.HealthCache[gw.ID]; ok && !h.Healthy {
			continue
		}

		// Concurrent-call cap check.
		active, err := s.getActiveCount(ctx, req.TenantID, gw, req.ActiveCounts)
		if err != nil {
			// Non-fatal: log and skip gate (conservative: treat as at-capacity).
			continue
		}
		if gw.MaxConcurrent != nil && active >= int64(*gw.MaxConcurrent) {
			continue
		}

		return SelectResult{Gateway: gw, ActiveCount: active}, nil
	}

	return SelectResult{}, ErrNoGateway
}

// getActiveCount returns the active call count for a gateway.
// It first checks the caller-supplied cache; falls back to a Valkey GET.
func (s *Selector) getActiveCount(
	ctx context.Context,
	tenantID int64,
	gw Gateway,
	cache map[int64]int64,
) (int64, error) {
	if v, ok := cache[gw.ID]; ok {
		return v, nil
	}
	if s.rdb == nil {
		return 0, nil
	}
	key := s.gwActiveKey(tenantID, gw.ID)
	n, err := s.rdb.Get(ctx, key).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return n, err
}

// FetchActiveCounts performs a batch MGET for all gateway active counters in a single round-trip.
// Returns a map of gatewayID → count. Missing keys return 0.
// T02 PLAN §10.2 (1-second cached count).
func (s *Selector) FetchActiveCounts(ctx context.Context, tenantID int64, gateways []Gateway) (map[int64]int64, error) {
	if s.rdb == nil || len(gateways) == 0 {
		return make(map[int64]int64), nil
	}
	keys := make([]string, len(gateways))
	for i, gw := range gateways {
		keys[i] = s.gwActiveKey(tenantID, gw.ID)
	}
	vals, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, fmt.Errorf("routing: MGET gateway active counts: %w", err)
	}
	counts := make(map[int64]int64, len(gateways))
	for i, v := range vals {
		if v == nil {
			counts[gateways[i].ID] = 0
			continue
		}
		var n int64
		_, err := fmt.Sscan(fmt.Sprint(v), &n)
		if err == nil {
			counts[gateways[i].ID] = n
		}
	}
	return counts, nil
}
