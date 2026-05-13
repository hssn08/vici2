package routing

import (
	"context"
	"testing"
)

func intPtr(n int) *int { return &n }

// makeGateway builds a minimal Gateway for tests.
func makeGateway(id int64, priority int, weight int16, active bool, maxConcurrent *int) Gateway {
	return Gateway{
		ID:            id,
		Name:          gatewaySafeName(id),
		Priority:      priority,
		Weight:        weight,
		Active:        active,
		MaxConcurrent: maxConcurrent,
		CarrierKind:   KindTwilio,
	}
}

func gatewaySafeName(id int64) string {
	return "gw" + itoa(id)
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	pos := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		pos--
		buf[pos] = byte(n%10) + '0'
		n /= 10
	}
	if neg {
		pos--
		buf[pos] = '-'
	}
	return string(buf[pos:])
}

func TestSelectGateway_Basic(t *testing.T) {
	sel := NewSelector(nil, nil)
	ctx := context.Background()

	gws := []Gateway{
		makeGateway(1, 1, 100, true, nil),
		makeGateway(2, 2, 100, true, nil),
	}
	req := SelectRequest{
		TenantID: 1,
		Gateways: gws,
	}
	res, err := sel.SelectGateway(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Gateway.ID != 1 {
		t.Errorf("expected gateway 1 (lower priority), got %d", res.Gateway.ID)
	}
}

func TestSelectGateway_InactiveSkipped(t *testing.T) {
	sel := NewSelector(nil, nil)
	ctx := context.Background()

	gws := []Gateway{
		makeGateway(1, 1, 100, false, nil), // inactive
		makeGateway(2, 2, 100, true, nil),
	}
	req := SelectRequest{TenantID: 1, Gateways: gws}
	res, err := sel.SelectGateway(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Gateway.ID != 2 {
		t.Errorf("expected gateway 2 (active), got %d", res.Gateway.ID)
	}
}

func TestSelectGateway_UnhealthySkipped(t *testing.T) {
	sel := NewSelector(nil, nil)
	ctx := context.Background()

	gws := []Gateway{
		makeGateway(1, 1, 100, true, nil),
		makeGateway(2, 2, 100, true, nil),
	}
	health := map[int64]GatewayHealth{
		1: {Healthy: false},
		2: {Healthy: true},
	}
	req := SelectRequest{TenantID: 1, Gateways: gws, HealthCache: health}
	res, err := sel.SelectGateway(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Gateway.ID != 2 {
		t.Errorf("expected gateway 2 (healthy), got %d", res.Gateway.ID)
	}
}

func TestSelectGateway_AtCapacitySkipped(t *testing.T) {
	sel := NewSelector(nil, nil)
	ctx := context.Background()

	maxC := 5
	gws := []Gateway{
		makeGateway(1, 1, 100, true, &maxC),
		makeGateway(2, 2, 100, true, nil),
	}
	activeCounts := map[int64]int64{1: 5} // at capacity
	req := SelectRequest{TenantID: 1, Gateways: gws, ActiveCounts: activeCounts}
	res, err := sel.SelectGateway(ctx, req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Gateway.ID != 2 {
		t.Errorf("expected gateway 2 (not at capacity), got %d", res.Gateway.ID)
	}
}

func TestSelectGateway_AllUnavailable(t *testing.T) {
	sel := NewSelector(nil, nil)
	ctx := context.Background()

	gws := []Gateway{
		makeGateway(1, 1, 100, false, nil),
		makeGateway(2, 2, 100, false, nil),
	}
	_, err := sel.SelectGateway(ctx, SelectRequest{TenantID: 1, Gateways: gws})
	if err != ErrNoGateway {
		t.Errorf("expected ErrNoGateway, got %v", err)
	}
}

func TestSelectGateway_EmptyList(t *testing.T) {
	sel := NewSelector(nil, nil)
	ctx := context.Background()
	_, err := sel.SelectGateway(ctx, SelectRequest{TenantID: 1})
	if err != ErrNoGateway {
		t.Errorf("expected ErrNoGateway for empty list, got %v", err)
	}
}

func TestSelectGateway_WeightTiebreakerWithinSamePriority(t *testing.T) {
	sel := NewSelector(nil, nil)
	ctx := context.Background()

	// Same priority, different weights — higher weight wins.
	gws := []Gateway{
		makeGateway(1, 1, 50, true, nil),
		makeGateway(2, 1, 100, true, nil), // higher weight = preferred
	}
	res, err := sel.SelectGateway(ctx, SelectRequest{TenantID: 1, Gateways: gws})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Gateway.ID != 2 {
		t.Errorf("expected gateway 2 (higher weight), got %d", res.Gateway.ID)
	}
}

func TestSelectGateway_UnknownHealthAllowed(t *testing.T) {
	sel := NewSelector(nil, nil)
	ctx := context.Background()

	// No health cache entry = unknown = treated as healthy.
	gws := []Gateway{makeGateway(1, 1, 100, true, nil)}
	req := SelectRequest{TenantID: 1, Gateways: gws, HealthCache: map[int64]GatewayHealth{}}
	res, err := sel.SelectGateway(ctx, req)
	if err != nil {
		t.Fatalf("expected success for unknown health, got: %v", err)
	}
	if res.Gateway.ID != 1 {
		t.Errorf("expected gateway 1, got %d", res.Gateway.ID)
	}
}

func TestSelectGateway_SortStabilityByID(t *testing.T) {
	// Same priority + same weight → lower ID wins for stability.
	sel := NewSelector(nil, nil)
	ctx := context.Background()

	gws := []Gateway{
		makeGateway(3, 1, 100, true, nil),
		makeGateway(1, 1, 100, true, nil),
		makeGateway(2, 1, 100, true, nil),
	}
	res, err := sel.SelectGateway(ctx, SelectRequest{TenantID: 1, Gateways: gws})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.Gateway.ID != 1 {
		t.Errorf("expected gateway 1 (stable sort), got %d", res.Gateway.ID)
	}
}
