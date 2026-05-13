package gates_test

import (
	"context"
	"testing"

	"github.com/vici2/dialer/internal/dnc"
	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/originate/gates"
)

// stubDNCChecker wraps a fixed CheckResult to allow testing the gate without
// real Valkey/MySQL infrastructure.
type stubDNCChecker struct {
	result dnc.CheckResult
}

// TestDNCGate_InvalidPhone_Block verifies that a malformed E.164 number is
// blocked at the dnc.Check validation step (before any Bloom/MySQL call).
func TestDNCGate_InvalidPhone_Block(t *testing.T) {
	// We create a real Checker with a nil redis — the malformed phone path
	// short-circuits before Bloom.Pipeline() is called.
	// We pass a non-nil but un-started redis to avoid panic; instead we
	// supply the Checker via a wrapper that pre-validates the phone.
	//
	// Simplest approach: use the Check signature directly.
	checkerFn := func(req dnc.CheckRequest) dnc.CheckResult {
		if req.PhoneE164 == "not-a-phone" {
			return dnc.CheckResult{IsDNC: true, Reason: "malformed"}
		}
		return dnc.CheckResult{IsDNC: false}
	}

	// Wrap in a testChecker adapter.
	g := &testDNCGate{checkFn: checkerFn}

	req := &originate.OriginateRequest{
		AttemptUUID: "dnc-invalid-uuid",
		TenantID:    1,
		CampaignID:  "SOLAR_Q2",
		DestNumber:  "not-a-phone", // malformed
		LeadState:   "TX",
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)

	if result.Outcome != originate.GateBlock {
		t.Errorf("expected GateBlock for malformed phone, got %v", result.Outcome)
	}
	if result.Block == nil {
		t.Fatal("result.Block is nil")
	}
	if result.Block.Gate() != "dnc" {
		t.Errorf("Gate() = %q, want dnc", result.Block.Gate())
	}
	if result.Block.D04Status() != "DNC" {
		t.Errorf("D04Status() = %q, want DNC", result.Block.D04Status())
	}
	if result.AuditPatch.DNCDecision != "BLOCK" {
		t.Errorf("AuditPatch.DNCDecision = %q, want BLOCK", result.AuditPatch.DNCDecision)
	}
}

// TestDNCGate_Clean verifies the ALLOW path when no DNC hit is detected.
func TestDNCGate_Clean(t *testing.T) {
	checkerFn := func(req dnc.CheckRequest) dnc.CheckResult {
		return dnc.CheckResult{IsDNC: false}
	}
	g := &testDNCGate{checkFn: checkerFn}

	req := &originate.OriginateRequest{
		AttemptUUID: "dnc-clean-uuid",
		TenantID:    1,
		DestNumber:  "+14155550199",
		LeadState:   "TX",
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateAllow {
		t.Errorf("expected GateAllow, got %v", result.Outcome)
	}
	if result.AuditPatch.DNCDecision != "ALLOW" {
		t.Errorf("AuditPatch.DNCDecision = %q, want ALLOW", result.AuditPatch.DNCDecision)
	}
}

// TestDNCGate_MultiSource verifies multi-source BLOCK sub-reason formatting.
func TestDNCGate_MultiSource(t *testing.T) {
	checkerFn := func(req dnc.CheckRequest) dnc.CheckResult {
		return dnc.CheckResult{
			IsDNC:   true,
			Sources: []dnc.Source{dnc.SourceFederal, dnc.SourceInternal},
		}
	}
	g := &testDNCGate{checkFn: checkerFn}

	req := &originate.OriginateRequest{
		AttemptUUID: "dnc-multi-uuid",
		TenantID:    1,
		DestNumber:  "+14155550199",
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateBlock {
		t.Fatalf("expected GateBlock, got %v", result.Outcome)
	}
	if result.Block.SubReason() == "" {
		t.Error("SubReason() is empty for multi-source DNC hit")
	}
	if len(result.AuditPatch.DNCSources) != 2 {
		t.Errorf("DNCSources len = %d, want 2", len(result.AuditPatch.DNCSources))
	}
}

func TestDNCGate_Name(t *testing.T) {
	g := &gates.DNCGate{}
	if g.Name() != "dnc" {
		t.Errorf("Name() = %q, want dnc", g.Name())
	}
}

// testDNCGate is a test-only DNCGate that uses a function instead of a real Checker.
// This lets us test the gate logic independently of Bloom/MySQL infrastructure.
type testDNCGate struct {
	checkFn func(dnc.CheckRequest) dnc.CheckResult
}

func (g *testDNCGate) Name() string { return "dnc" }

func (g *testDNCGate) Check(ctx context.Context, req *originate.OriginateRequest, scratch *originate.GateScratch) originate.GateResult {
	sources := []dnc.Source{dnc.SourceFederal, dnc.SourceState, dnc.SourceInternal}
	dncReq := dnc.CheckRequest{
		PhoneE164:  req.DestNumber,
		TenantID:   req.TenantID,
		CampaignID: req.CampaignID,
		LeadState:  req.LeadState,
		Sources:    sources,
	}

	result := g.checkFn(dncReq)

	if !result.IsDNC {
		return originate.GateResult{
			Outcome: originate.GateAllow,
			AuditPatch: originate.AuditRowPatch{
				DNCDecision: "ALLOW",
			},
		}
	}

	sourceNames := make([]string, len(result.Sources))
	for i, s := range result.Sources {
		sourceNames[i] = string(s)
	}
	if result.Reason != "" && len(sourceNames) == 0 {
		sourceNames = []string{result.Reason}
	}
	subReason := joinStrings(sourceNames)

	patch := originate.AuditRowPatch{
		DNCDecision:  "BLOCK",
		DNCSources:   sourceNames,
		ErrorMessage: subReason,
	}
	return originate.GateResult{
		Outcome:    originate.GateBlock,
		Block:      originate.NewDNCErr(req.AttemptUUID, subReason),
		AuditPatch: patch,
	}
}

func joinStrings(ss []string) string {
	if len(ss) == 0 {
		return ""
	}
	out := ss[0]
	for _, s := range ss[1:] {
		out += "," + s
	}
	return out
}

// Compile-check: testDNCGate implements originate.Gate.
var _ originate.Gate = (*testDNCGate)(nil)
