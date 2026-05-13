package gates_test

import (
	"context"
	"errors"
	"testing"

	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/originate/gates"
)

func TestGatewayCapGate_NoCapConfigured(t *testing.T) {
	g := &gates.GatewayCapGate{
		Acquire: func(_ context.Context, _, _, _ int64, _ string, _ int, _ int64, _ int) (bool, int64, error) {
			t.Fatal("Acquire should not be called when MaxConcurrent=0")
			return false, 0, nil
		},
	}
	req := &originate.OriginateRequest{
		AttemptUUID:   "test-uuid",
		GatewayID:     1,
		GatewayName:   "twilio",
		MaxConcurrent: 0, // no cap
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateAllow {
		t.Errorf("expected GateAllow when MaxConcurrent=0, got %v", result.Outcome)
	}
}

func TestGatewayCapGate_UnderCap(t *testing.T) {
	acquireCalled := false
	g := &gates.GatewayCapGate{
		Acquire: func(_ context.Context, gwID, _, _ int64, callUUID string, maxConcurrent int, _ int64, _ int) (bool, int64, error) {
			acquireCalled = true
			if gwID != 11 {
				t.Errorf("Acquire called with wrong gatewayID: %d", gwID)
			}
			if maxConcurrent != 50 {
				t.Errorf("Acquire called with wrong maxConcurrent: %d", maxConcurrent)
			}
			return true, 5, nil // 5 < 50 → ALLOW
		},
	}
	req := &originate.OriginateRequest{
		AttemptUUID:   "test-uuid",
		GatewayID:     11,
		GatewayName:   "twilio_main",
		CarrierID:     7,
		MaxConcurrent: 50,
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if !acquireCalled {
		t.Error("Acquire was not called")
	}
	if result.Outcome != originate.GateAllow {
		t.Errorf("expected GateAllow, got %v", result.Outcome)
	}
	if scratch.ResolvedGatewayID != 11 {
		t.Errorf("scratch.ResolvedGatewayID = %d, want 11", scratch.ResolvedGatewayID)
	}
}

func TestGatewayCapGate_AtCap(t *testing.T) {
	g := &gates.GatewayCapGate{
		Acquire: func(_ context.Context, _, _, _ int64, _ string, _ int, _ int64, _ int) (bool, int64, error) {
			return false, 50, nil // at cap → BLOCK
		},
	}
	req := &originate.OriginateRequest{
		AttemptUUID:   "block-uuid",
		GatewayID:     11,
		GatewayName:   "twilio_main",
		MaxConcurrent: 50,
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateBlock {
		t.Fatalf("expected GateBlock, got %v", result.Outcome)
	}
	if result.Block == nil {
		t.Fatal("result.Block is nil")
	}
	if result.Block.Gate() != "gateway_cap" {
		t.Errorf("Gate() = %q, want gateway_cap", result.Block.Gate())
	}
	if result.Block.D04Status() != "GATEWAY_LIMIT_TRY_LATER" {
		t.Errorf("D04Status() = %q, want GATEWAY_LIMIT_TRY_LATER", result.Block.D04Status())
	}
}

func TestGatewayCapGate_AcquireError(t *testing.T) {
	g := &gates.GatewayCapGate{
		Acquire: func(_ context.Context, _, _, _ int64, _ string, _ int, _ int64, _ int) (bool, int64, error) {
			return false, 0, errors.New("valkey: connection refused")
		},
	}
	req := &originate.OriginateRequest{
		AttemptUUID:   "err-uuid",
		GatewayID:     11,
		MaxConcurrent: 10,
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	// Error should be treated as BLOCK (fail-closed).
	if result.Outcome != originate.GateBlock {
		t.Errorf("expected GateBlock on Acquire error, got %v", result.Outcome)
	}
}
