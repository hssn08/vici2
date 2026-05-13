package gates

import (
	"fmt"
	"strconv"

	"context"

	"github.com/redis/go-redis/v9"
	"github.com/vici2/dialer/internal/originate"
	vkey "github.com/vici2/dialer/internal/valkey"
)

// DropCapGate checks the FCC 3% rolling safe-harbor drop-rate ceiling.
//
// E05 PLAN §13.3: Phase 2 wired — reads drop_pct_30d from Valkey (published
// by E05's 15-s ticker). Fail-open on Valkey error because E02's drop_gated
// EXISTS check is the primary fail-closed mechanism; this gate is defense-in-depth.
//
// Returns OutcomeRateLimited when drop_pct >= drop_target_max.
type DropCapGate struct {
	rc *redis.Client
}

// NewDropCapGate constructs the gate. Pass nil rc to get the Phase-1 ALLOW stub.
func NewDropCapGate(rc *redis.Client) *DropCapGate {
	return &DropCapGate{rc: rc}
}

func (g *DropCapGate) Name() string { return "drop_cap" }

func (g *DropCapGate) Check(
	ctx context.Context,
	req *originate.OriginateRequest,
	scratch *originate.GateScratch,
) originate.GateResult {
	if g.rc == nil {
		// Phase 1 stub (no Valkey wired).
		return originate.GateResult{Outcome: originate.GateAllow}
	}

	// Parse campaign ID as int64 for Valkey key construction.
	cidInt, err := strconv.ParseInt(req.CampaignID, 10, 64)
	if err != nil {
		// Non-numeric campaign IDs skip the drop-cap check.
		return originate.GateResult{Outcome: originate.GateAllow}
	}

	keys := vkey.NewKeys(req.TenantID)
	dropPctKey := keys.CampaignDropPct30d(cidInt)

	v, err := g.rc.Get(ctx, dropPctKey).Result()
	if err != nil {
		// Fail-open on Valkey error (E02 drop_gated is the fail-closed path).
		return originate.GateResult{Outcome: originate.GateAllow}
	}

	dropPct, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return originate.GateResult{Outcome: originate.GateAllow}
	}

	// Use DropCapPct from request (campaigns.drop_target_max via config cache).
	// Fall back to FCC hard ceiling (3.00%) if not configured.
	dropTargetMax := req.DropCapPct
	if dropTargetMax <= 0 || dropTargetMax > 3.00 {
		dropTargetMax = 3.00
	}

	if dropPct >= dropTargetMax {
		reason := fmt.Sprintf("drop_cap: %.4f%% >= %.2f%%", dropPct, dropTargetMax)
		return originate.GateResult{
			Outcome: originate.GateBlock,
			Block: originate.NewDropCapErr(req.AttemptUUID, reason, 0),
			AuditPatch: originate.AuditRowPatch{
				ErrorMessage: reason,
			},
		}
	}

	return originate.GateResult{Outcome: originate.GateAllow}
}
