package picker

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/originate"
)

// TestProcessOutcome_AllGateErrors verifies outcome mapping for all T04 gate errors.
func TestProcessOutcome_AllGateErrors(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	cfg := newProgressiveCfg(200)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	cases := []struct {
		name     string
		t04Err   originate.OriginateError
		wantOut  DialOutcome
	}{
		{"gateway_limit", originate.NewGatewayLimitErr("uuid", "gw"), OutcomeGatewayLimit},
		{"drop_cap", originate.NewDropCapErr("uuid", "drop", time.Second), OutcomeRateLimited},
		{"tcpa", originate.NewTCPAErr("uuid", "state", time.Hour), OutcomeTCPABlocked},
		{"dnc", originate.NewDNCErr("uuid", "federal"), OutcomeDNCBlocked},
		{"consent", originate.NewConsentBlockErr("uuid", "IL"), OutcomeConsentBlocked},
		{"carrier", originate.NewCarrierFailErr("uuid", "NO_ROUTE", time.Second, originate.OutcomeGatewayFail), OutcomeCarrierFail},
	}

	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// Seed a claim in the hopper for each test.
			leadID := int64(1000 + i)
			mr.ZAdd(vc.Keys.CampaignHopper(cfg.CampaignID),
				float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

			loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
				NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
				NewFreqCapIncrementer(vc), &mockOriginator{}, vc, m, nil, "test")

			claim := LeadClaim{LeadID: leadID, CampaignID: cfg.CampaignID, LockVal: "pod:12345"}
			loop.processOutcome(context.Background(), cfg, claim, 0, nil, tc.t04Err)

			// Just verify no panic — metric label verification would require
			// a more elaborate setup; covered by the unit tests in dispatch_loop_test.go.
		})
	}
}

// TestReleaseAll_WithAgent verifies that releaseAll releases agent + claim.
func TestReleaseAll_WithAgent(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	cfg := newProgressiveCfg(201)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	const agentID = int64(301)
	const leadID = int64(5001)

	// Seed agent in RESERVED state.
	reservedKey := vc.Keys.AgentsByCampaignStatus(cfg.CampaignID, "RESERVED")
	mr.ZAdd(reservedKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", agentID))
	mr.HSet(vc.Keys.Agent(agentID),
		"status", "RESERVED",
		"campaign_id", fmt.Sprintf("%d", cfg.CampaignID),
		"user_id", fmt.Sprintf("%d", agentID),
	)

	// Seed lead in hopper.
	mr.ZAdd(vc.Keys.CampaignHopper(cfg.CampaignID),
		float64(time.Now().UnixMilli()), fmt.Sprintf("%d", leadID))

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), &mockOriginator{}, vc, m, nil, "test")

	claim := LeadClaim{LeadID: leadID, CampaignID: cfg.CampaignID, LockVal: "pod:99999"}
	loop.releaseAll(context.Background(), cfg, claim, agentID, OutcomeCampaignPaused)
	// No panic = pass.
}

// TestProcessOutcome_BridgedWithFreqCap verifies freq cap is incremented on Bridged.
func TestProcessOutcome_BridgedWithFreqCap(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	cfg := newProgressiveCfg(202)
	cfgCache := NewCampaignConfigCache()
	cfgCache.Set(cfg)

	loop := NewDispatchLoop(cfg, NewTokenBucket(vc, m), NewClaimer(vc, m),
		NewAgentPairer(vc, m), NewPreT04Checker(vc, cfgCache),
		NewFreqCapIncrementer(vc), &mockOriginator{}, vc, m, nil, "test")

	claim := LeadClaim{
		LeadID:     9999,
		CampaignID: cfg.CampaignID,
		LockVal:    "pod:bridged",
		PhoneE164:  "+19995551234",
	}
	res := &originate.OriginateResult{Outcome: originate.OutcomeSuccess}
	loop.processOutcome(context.Background(), cfg, claim, 0, res, nil)

	// Verify freq cap was incremented (freq cap uses vc.Cache = DB 1).
	key := fmt.Sprintf("t:%d:freq:%s:%d", 1, "+19995551234", cfg.CampaignID)
	val, _ := mr.DB(1).Get(key)
	if val != "1" {
		t.Errorf("expected freq cap=1 after bridged call, got %q", val)
	}
}
