package gates

import (
	"context"

	"github.com/vici2/dialer/internal/originate"
)

// DropCapGate checks the FCC 3% rolling safe-harbor drop-rate ceiling.
//
// T04 PLAN §3.2: Phase 1 stub always returns ALLOW. E03 (Phase 2 adaptive
// engine) will wire the real Valkey gauge; the gate interface is in place now.
//
// Emits vici2_t04_gate_duration_seconds{gate="drop_cap",stubbed="true"} so
// Phase 2 can see when the real logic takes over.
type DropCapGate struct{}

func (g *DropCapGate) Name() string { return "drop_cap" }

func (g *DropCapGate) Check(
	ctx context.Context,
	req *originate.OriginateRequest,
	scratch *originate.GateScratch,
) originate.GateResult {
	// Phase 1: always ALLOW. E03 wires the real gauge in Phase 2.
	return originate.GateResult{Outcome: originate.GateAllow}
}
