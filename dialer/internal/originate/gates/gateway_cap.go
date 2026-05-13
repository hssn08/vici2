// Package gates contains the five concrete Gate implementations for T04.
// Gate order is FROZEN: gateway_cap → drop_cap → tcpa → dnc → consent.
package gates

import (
	"context"
	"fmt"

	"github.com/vici2/dialer/internal/originate"
)

// GatewayCapGate checks the per-gateway concurrent-call ceiling
// (gateways.max_concurrent) against the live Valkey active-call gauge.
//
// T04 PLAN §3.1: pass condition = active < max_concurrent.
// Phase 1: uses valkey.OriginateOps.Acquire (Lua atomic INCR-then-compare).
type GatewayCapGate struct {
	// Acquire atomically increments the gateway counter and returns whether
	// the cap was exceeded. Signature must match valkey.OriginateOps.Acquire.
	Acquire func(ctx context.Context, gatewayID, campaignID, leadID int64,
		callUUID string, maxConcurrent int, tsMs int64, inFlightTTLSec int) (allowed bool, newCount int64, err error)
}

func (g *GatewayCapGate) Name() string { return "gateway_cap" }

func (g *GatewayCapGate) Check(
	ctx context.Context,
	req *originate.OriginateRequest,
	scratch *originate.GateScratch,
) originate.GateResult {
	// Populate scratch with gateway info (required by later chanvar assembly).
	scratch.ResolvedCarrierID = req.CarrierID
	scratch.ResolvedGatewayID = req.GatewayID
	scratch.ResolvedGatewayName = req.GatewayName

	patch := originate.AuditRowPatch{
		CarrierID:   req.CarrierID,
		GatewayID:   req.GatewayID,
		GatewayName: req.GatewayName,
	}

	if req.MaxConcurrent <= 0 {
		// No cap configured — always ALLOW.
		return originate.GateResult{Outcome: originate.GateAllow, AuditPatch: patch}
	}

	allowed, _, err := g.Acquire(
		ctx,
		req.GatewayID,
		0, // campaignID not used in Lua script cap check
		req.LeadID,
		req.AttemptUUID,
		req.MaxConcurrent,
		0,  // tsMs: 0 = server-side now
		86400, // TTL 24h
	)
	if err != nil || !allowed {
		gwDesc := fmt.Sprintf("gw:%d:full", req.GatewayID)
		patch.ErrorMessage = gwDesc
		return originate.GateResult{
			Outcome:    originate.GateBlock,
			Block:      originate.NewGatewayLimitErr(req.AttemptUUID, gwDesc),
			AuditPatch: patch,
		}
	}

	return originate.GateResult{Outcome: originate.GateAllow, AuditPatch: patch}
}
