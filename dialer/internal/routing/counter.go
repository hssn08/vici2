package routing

import (
	"context"
	"fmt"

	"github.com/redis/go-redis/v9"
)

// Counter manages per-gateway concurrent-call accounting in Valkey.
// T02 PLAN §10.1 — key: t:{tid}:gw:{id}:active
type Counter struct {
	rdb         redis.Cmdable
	gwActiveKey func(tenantID, gatewayID int64) string
}

// NewCounter constructs a Counter. If gwActiveKeyFn is nil, the default key
// format (t:{tid}:gw:{id}:active) is used.
func NewCounter(rdb redis.Cmdable, gwActiveKeyFn func(tenantID, gatewayID int64) string) *Counter {
	if gwActiveKeyFn == nil {
		gwActiveKeyFn = defaultGWActiveKey
	}
	return &Counter{rdb: rdb, gwActiveKey: gwActiveKeyFn}
}

// Inc increments the active-call counter for a gateway by 1.
// Called on CHANNEL_CREATE (T01 EnrichedEvent consumer, T02 PLAN §10.1).
// Returns the new value.
func (c *Counter) Inc(ctx context.Context, tenantID, gatewayID int64) (int64, error) {
	if c.rdb == nil {
		return 0, nil
	}
	key := c.gwActiveKey(tenantID, gatewayID)
	n, err := c.rdb.Incr(ctx, key).Result()
	if err != nil {
		return 0, fmt.Errorf("routing counter Inc: %w", err)
	}
	return n, nil
}

// Dec decrements the active-call counter for a gateway by 1, flooring at 0.
// Called on CHANNEL_HANGUP_COMPLETE (T01 EnrichedEvent consumer, T02 PLAN §10.1).
// Returns the new value (clamped to ≥0).
func (c *Counter) Dec(ctx context.Context, tenantID, gatewayID int64) (int64, error) {
	if c.rdb == nil {
		return 0, nil
	}
	key := c.gwActiveKey(tenantID, gatewayID)
	n, err := c.rdb.Decr(ctx, key).Result()
	if err != nil {
		return 0, fmt.Errorf("routing counter Dec: %w", err)
	}
	// Guard against negative counters caused by missed CHANNEL_CREATE events
	// or counter corruption. Clamp to 0.
	if n < 0 {
		// GETSET 0 if still negative — best effort, tolerate races.
		_ = c.rdb.Set(ctx, key, 0, 0).Err()
		return 0, nil
	}
	return n, nil
}

// Get returns the current active-call count for a gateway.
// Returns 0 if the key does not exist.
func (c *Counter) Get(ctx context.Context, tenantID, gatewayID int64) (int64, error) {
	if c.rdb == nil {
		return 0, nil
	}
	key := c.gwActiveKey(tenantID, gatewayID)
	n, err := c.rdb.Get(ctx, key).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	if err != nil {
		return 0, fmt.Errorf("routing counter Get: %w", err)
	}
	return n, nil
}

// Set forces the counter to a specific value.
// Used by the 60-second reconciler when drift > 2 is detected.
// T02 PLAN §10.3.
func (c *Counter) Set(ctx context.Context, tenantID, gatewayID, value int64) error {
	if c.rdb == nil {
		return nil
	}
	key := c.gwActiveKey(tenantID, gatewayID)
	return c.rdb.Set(ctx, key, value, 0).Err()
}

// IncGatewayActive is a package-level convenience wrapper for T04 callers.
// T02 PLAN §14 frozen surface.
func IncGatewayActive(ctx context.Context, rdb redis.Cmdable, tenantID, gatewayID int64) error {
	_, err := NewCounter(rdb, nil).Inc(ctx, tenantID, gatewayID)
	return err
}

// DecGatewayActive is a package-level convenience wrapper for T01 event consumers.
// T02 PLAN §14 frozen surface.
func DecGatewayActive(ctx context.Context, rdb redis.Cmdable, tenantID, gatewayID int64) error {
	_, err := NewCounter(rdb, nil).Dec(ctx, tenantID, gatewayID)
	return err
}
