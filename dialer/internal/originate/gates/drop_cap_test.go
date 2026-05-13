package gates_test

import (
	"context"
	"testing"

	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/originate/gates"
)

func TestDropCapGate_Phase1AlwaysAllow(t *testing.T) {
	g := &gates.DropCapGate{}
	req := &originate.OriginateRequest{
		AttemptUUID: "drop-test-uuid",
		CampaignID:  "SOLAR_Q2",
		DropCapPct:  1.5, // 1.5% cap — but Phase 1 stubs ALLOW
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateAllow {
		t.Errorf("Phase 1 drop_cap should always ALLOW, got %v", result.Outcome)
	}
	if result.Block != nil {
		t.Errorf("Phase 1 drop_cap should have nil Block, got %v", result.Block)
	}
}
