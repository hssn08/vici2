package originate_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	prometheus "github.com/prometheus/client_golang/prometheus"

	"github.com/vici2/dialer/internal/originate"
)

// noopGate is a pass-through gate used in table-driven tests.
type noopGate struct{ name string }

func (g *noopGate) Name() string { return g.name }
func (g *noopGate) Check(_ context.Context, _ *originate.OriginateRequest, _ *originate.GateScratch) originate.GateResult {
	return originate.GateResult{Outcome: originate.GateAllow}
}

func testReq(attemptUUID string, mode originate.OriginateMode) originate.OriginateRequest {
	return originate.OriginateRequest{
		AttemptUUID:      attemptUUID,
		TenantID:         1,
		LeadID:           1001,
		CampaignID:       "SOLAR_Q2",
		ListID:           5,
		AgentID:          42,
		DestNumber:       "+14155550199",
		Mode:             mode,
		CallerIDCampaign: "+12125550100",
		RecordingMode:    originate.RecordAll,
		LeadState:        "CA",
		DialTimeout:      22,
		MaxConcurrent:    0, // no cap
		GatewayID:        11,
		GatewayName:      "twilio_main",
		CarrierID:        7,
	}
}

func TestMissingAttemptUUID(t *testing.T) {
	svc := originate.New(originate.Opts{
		Gates: []originate.Gate{&noopGate{name: "noop"}},
	})
	_, err := svc.Originate(context.Background(), originate.OriginateRequest{
		TenantID: 1,
	})
	if err == nil {
		t.Fatal("expected error for missing AttemptUUID")
	}
}

func TestGatePipelineOrder(t *testing.T) {
	callOrder := []string{}
	gates := []originate.Gate{
		&recordGate{name: "g1", order: &callOrder, block: false},
		&recordGate{name: "g2", order: &callOrder, block: true},
		&recordGate{name: "g3", order: &callOrder, block: false},
	}

	svc := originate.New(originate.Opts{
		Gates: gates,
	})

	req := testReq("11111111-1111-1111-1111-111111111111", originate.ModeProgressive)
	_, err := svc.Originate(context.Background(), req)
	if err == nil {
		t.Fatal("expected BLOCK error from g2")
	}
	if len(callOrder) != 2 {
		t.Fatalf("expected 2 gates called (g1+g2), got %d: %v", len(callOrder), callOrder)
	}
	if callOrder[0] != "g1" || callOrder[1] != "g2" {
		t.Fatalf("unexpected gate order: %v", callOrder)
	}
}

// recordGate records its name in the shared order slice, optionally blocking.
type recordGate struct {
	name  string
	order *[]string
	block bool
}

func (g *recordGate) Name() string { return g.name }
func (g *recordGate) Check(_ context.Context, req *originate.OriginateRequest, _ *originate.GateScratch) originate.GateResult {
	*g.order = append(*g.order, g.name)
	if g.block {
		return originate.GateResult{
			Outcome: originate.GateBlock,
			Block:   originate.NewGatewayLimitErr(req.AttemptUUID, "test:blocked"),
		}
	}
	return originate.GateResult{Outcome: originate.GateAllow}
}

func TestDialTargetMapping(t *testing.T) {
	tests := []struct {
		mode originate.OriginateMode
	}{
		{originate.ModeProgressive},
		{originate.ModePredictive},
		{originate.ModeManual},
		{originate.ModePreview},
	}
	for _, tt := range tests {
		t.Run(string(tt.mode), func(t *testing.T) {
			svc := originate.New(originate.Opts{
				Gates: []originate.Gate{&noopGate{name: "noop"}},
			})
			req := testReq("22222222-2222-2222-2222-222222222222", tt.mode)
			res, err := svc.Originate(context.Background(), req)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if res.CallUUID != req.AttemptUUID {
				t.Errorf("one-UUID rule: CallUUID=%q, want %q", res.CallUUID, req.AttemptUUID)
			}
		})
	}
}

func TestOneUUIDRuleEcho(t *testing.T) {
	svc := originate.New(originate.Opts{
		Gates: []originate.Gate{&noopGate{name: "noop"}},
	})
	uuid := "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	req := testReq(uuid, originate.ModeProgressive)
	res, err := svc.Originate(context.Background(), req)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if res.AttemptUUID != uuid {
		t.Errorf("AttemptUUID mismatch: got %q, want %q", res.AttemptUUID, uuid)
	}
	if res.CallUUID != uuid {
		t.Errorf("CallUUID (one-UUID rule): got %q, want %q", res.CallUUID, uuid)
	}
}

func TestOriginateErrorInterface(t *testing.T) {
	errs := []originate.OriginateError{
		originate.NewGatewayLimitErr("uuid-1", "gw:11:full"),
		originate.NewDropCapErr("uuid-2", "campaign:X:1.7%>=1.5%", 5*time.Minute),
		originate.NewTCPAErr("uuid-3", "after_window", 24*time.Hour),
		originate.NewDNCErr("uuid-4", "federal,internal"),
		originate.NewConsentBlockErr("uuid-5", "consent_block:XX"),
		originate.NewCarrierFailErr("uuid-6", "circuit_open", 60*time.Second, originate.OutcomeGatewayFail),
	}
	wantGates := []string{"gateway_cap", "drop_cap", "tcpa", "dnc", "consent", "carrier"}
	wantD04 := []string{"GATEWAY_LIMIT_TRY_LATER", "", "TCPA", "DNC", "CONSENT_NOT_OBTAINED", "CARRIER_FAIL"}

	for i, e := range errs {
		if e.Gate() != wantGates[i] {
			t.Errorf("[%d] Gate() = %q, want %q", i, e.Gate(), wantGates[i])
		}
		if e.D04Status() != wantD04[i] {
			t.Errorf("[%d] D04Status() = %q, want %q", i, e.D04Status(), wantD04[i])
		}
		if e.AttemptUUID() == "" {
			t.Errorf("[%d] AttemptUUID() is empty", i)
		}
		if e.Error() == "" {
			t.Errorf("[%d] Error() is empty", i)
		}
	}
}

func strPtr(s string) *string { return &s }

func TestPickCallerID_Waterfall(t *testing.T) {
	tests := []struct {
		name       string
		req        originate.OriginateRequest
		wantNumber string
		wantSrc    originate.OriginateCidSource
		wantErr    bool
	}{
		{
			name: "tier1_per_call",
			req: originate.OriginateRequest{
				CallerIDOverride: "+18005551234",
				CallerIDCampaign: "+12125550100",
			},
			wantNumber: "+18005551234",
			wantSrc:    originate.CidSourcePerCall,
		},
		{
			name: "tier2_per_list",
			req: originate.OriginateRequest{
				ListCallerID:     strPtr("+13335554444"),
				CallerIDCampaign: "+12125550100",
			},
			wantNumber: "+13335554444",
			wantSrc:    originate.CidSourcePerList,
		},
		{
			name: "tier4_campaign_default",
			req: originate.OriginateRequest{
				CallerIDCampaign: "+12125550100",
			},
			wantNumber: "+12125550100",
			wantSrc:    originate.CidSourceCampaignDflt,
		},
		{
			name:    "no_cid_error",
			req:     originate.OriginateRequest{CampaignID: "NOCID"},
			wantErr: true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			num, _, src, err := originate.PickCallerID(&tt.req)
			if tt.wantErr {
				if err == nil {
					t.Fatal("expected error but got nil")
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if num != tt.wantNumber {
				t.Errorf("number = %q, want %q", num, tt.wantNumber)
			}
			if src != tt.wantSrc {
				t.Errorf("source = %q, want %q", src, tt.wantSrc)
			}
		})
	}
}

func TestErrInProgress(t *testing.T) {
	if originate.ErrInProgress.RetryAfter() != 1*time.Second {
		t.Errorf("ErrInProgress.RetryAfter() = %v, want 1s", originate.ErrInProgress.RetryAfter())
	}
}

func TestErrMissingAttemptUUID(t *testing.T) {
	if originate.ErrMissingAttemptUUID == nil {
		t.Fatal("ErrMissingAttemptUUID should be non-nil")
	}
	if originate.ErrMissingAttemptUUID.Error() == "" {
		t.Error("ErrMissingAttemptUUID.Error() is empty")
	}
}

func TestMetricsRegistration(t *testing.T) {
	reg := prometheus.NewRegistry()
	m := originate.NewMetrics(reg)
	if m == nil {
		t.Fatal("NewMetrics returned nil")
	}
}

func TestSweepOrphansNilDB(t *testing.T) {
	svc := originate.New(originate.Opts{})
	n, err := svc.SweepOrphans(context.Background())
	if err != nil {
		t.Fatalf("SweepOrphans(nil db) error: %v", err)
	}
	if n != 0 {
		t.Fatalf("SweepOrphans(nil db) returned %d, want 0", n)
	}
}

func TestAllModesHaveDialTarget(t *testing.T) {
	modes := []originate.OriginateMode{
		originate.ModeProgressive,
		originate.ModePredictive,
		originate.ModeManual,
		originate.ModePreview,
	}
	for i, m := range modes {
		svc := originate.New(originate.Opts{
			Gates: []originate.Gate{&noopGate{name: "noop"}},
		})
		req := testReq(fmt.Sprintf("44444444-4444-4444-4444-44444444444%d", i), m)
		res, err := svc.Originate(context.Background(), req)
		if err != nil {
			t.Errorf("mode %s: unexpected error: %v", m, err)
			continue
		}
		if res.Outcome != originate.OutcomeSuccess {
			t.Errorf("mode %s: unexpected outcome %s", m, res.Outcome)
		}
	}
}

func TestOutcomeValues(t *testing.T) {
	outcomes := []originate.OriginateOutcome{
		originate.OutcomeSuccess,
		originate.OutcomeTCPABlocked,
		originate.OutcomeDNCBlocked,
		originate.OutcomeConsentBlocked,
		originate.OutcomeGatewayLimit,
		originate.OutcomeRateLimited,
		originate.OutcomeGatewayFail,
		originate.OutcomeTimeout,
		originate.OutcomeJobOrphaned,
		originate.OutcomeOther,
	}
	for _, o := range outcomes {
		if string(o) == "" {
			t.Errorf("OriginateOutcome has empty string value")
		}
	}
}
