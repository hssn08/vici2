package routing

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func newMiniRedis(t *testing.T) (redis.Cmdable, *miniredis.Miniredis) {
	t.Helper()
	mr, err := miniredis.Run()
	if err != nil {
		t.Fatalf("miniredis: %v", err)
	}
	t.Cleanup(mr.Close)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	return rdb, mr
}

func TestCounter_IncDec(t *testing.T) {
	rdb, _ := newMiniRedis(t)
	c := NewCounter(rdb, nil)
	ctx := context.Background()

	n, err := c.Inc(ctx, 1, 42)
	if err != nil || n != 1 {
		t.Fatalf("Inc: n=%d err=%v", n, err)
	}
	n, err = c.Inc(ctx, 1, 42)
	if err != nil || n != 2 {
		t.Fatalf("Inc(2): n=%d err=%v", n, err)
	}
	n, err = c.Dec(ctx, 1, 42)
	if err != nil || n != 1 {
		t.Fatalf("Dec: n=%d err=%v", n, err)
	}
	n, err = c.Get(ctx, 1, 42)
	if err != nil || n != 1 {
		t.Fatalf("Get: n=%d err=%v", n, err)
	}
}

func TestCounter_DecClampsAtZero(t *testing.T) {
	rdb, _ := newMiniRedis(t)
	c := NewCounter(rdb, nil)
	ctx := context.Background()

	// Decrement without any prior increment should not go negative.
	n, err := c.Dec(ctx, 1, 99)
	if err != nil {
		t.Fatalf("Dec on missing key: %v", err)
	}
	if n < 0 {
		t.Errorf("counter went negative: %d", n)
	}
	// Verify key is now 0.
	n, _ = c.Get(ctx, 1, 99)
	if n < 0 {
		t.Errorf("Get returned negative: %d", n)
	}
}

func TestCounter_Set(t *testing.T) {
	rdb, _ := newMiniRedis(t)
	c := NewCounter(rdb, nil)
	ctx := context.Background()

	if err := c.Set(ctx, 1, 7, 42); err != nil {
		t.Fatalf("Set: %v", err)
	}
	n, err := c.Get(ctx, 1, 7)
	if err != nil || n != 42 {
		t.Fatalf("Get after Set: n=%d err=%v", n, err)
	}
}

func TestCounter_NilRDBNoError(t *testing.T) {
	c := NewCounter(nil, nil)
	ctx := context.Background()
	if _, err := c.Inc(ctx, 1, 1); err != nil {
		t.Fatalf("Inc with nil rdb: %v", err)
	}
	if _, err := c.Dec(ctx, 1, 1); err != nil {
		t.Fatalf("Dec with nil rdb: %v", err)
	}
	if _, err := c.Get(ctx, 1, 1); err != nil {
		t.Fatalf("Get with nil rdb: %v", err)
	}
}

func TestIncDecGatewayActive(t *testing.T) {
	rdb, _ := newMiniRedis(t)
	ctx := context.Background()

	if err := IncGatewayActive(ctx, rdb, 1, 5); err != nil {
		t.Fatalf("IncGatewayActive: %v", err)
	}
	if err := DecGatewayActive(ctx, rdb, 1, 5); err != nil {
		t.Fatalf("DecGatewayActive: %v", err)
	}
	// Key should exist with value 0 after clamp.
	n, _ := rdb.Get(ctx, "t:1:gw:5:active").Int64()
	if n != 0 {
		t.Errorf("expected 0 after dec, got %d", n)
	}
}

func TestFetchActiveCounts(t *testing.T) {
	rdb, _ := newMiniRedis(t)
	ctx := context.Background()
	sel := NewSelector(rdb, nil)

	// Set up some gateway counters.
	rdb.Set(ctx, "t:1:gw:1:active", 3, 0)
	rdb.Set(ctx, "t:1:gw:2:active", 7, 0)
	// Gateway 3 has no key (should return 0).

	gws := []Gateway{
		makeGateway(1, 1, 100, true, nil),
		makeGateway(2, 1, 100, true, nil),
		makeGateway(3, 1, 100, true, nil),
	}
	counts, err := sel.FetchActiveCounts(ctx, 1, gws)
	if err != nil {
		t.Fatalf("FetchActiveCounts: %v", err)
	}
	if counts[1] != 3 {
		t.Errorf("gw1: want 3, got %d", counts[1])
	}
	if counts[2] != 7 {
		t.Errorf("gw2: want 7, got %d", counts[2])
	}
	if counts[3] != 0 {
		t.Errorf("gw3 (missing): want 0, got %d", counts[3])
	}
}
