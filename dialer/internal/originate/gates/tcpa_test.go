package gates_test

import (
	"context"
	"testing"
	"time"

	"github.com/vici2/dialer/internal/compliance/tcpa"
	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/originate/gates"
)

// stubResolver is a minimal tcpa.Resolver that returns a fixed result.
type stubResolver struct {
	result tcpa.ResolveResult
	err    error
}

func (s *stubResolver) Resolve(_ context.Context, _ tcpa.ResolveRequest) (tcpa.ResolveResult, error) {
	return s.result, s.err
}

// buildTCPAChecker creates a tcpa.Checker with a fixed resolver and a
// single overriding state rule that either ALLOW or BLOCK the call.
func buildAllowChecker(t *testing.T, iana string) *tcpa.Checker {
	t.Helper()
	resolver := &stubResolver{
		result: tcpa.ResolveResult{
			IANA:       iana,
			Confidence: tcpa.ConfKnown,
			Location:   time.UTC,
		},
	}
	// Use a state rule where the window covers the entire day.
	openRule := tcpa.StateRule{
		Code: "TX",
		PerDow: [7]tcpa.Window{
			// All 7 days: 8am–9pm (480..1260 minutes)
			{OpenLocal: 480 * time.Minute, CloseLocal: 1260 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 1260 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 1260 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 1260 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 1260 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 1260 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 1260 * time.Minute},
		},
	}
	checker, err := tcpa.New(tcpa.CheckerOpts{
		Resolver: resolver,
		Rules:    map[string]tcpa.StateRule{"TX": openRule},
		NowFn: func() time.Time {
			// Return 2pm UTC on a Wednesday (business hours, open window).
			return time.Date(2026, 5, 13, 14, 0, 0, 0, time.UTC)
		},
	})
	if err != nil {
		t.Fatalf("tcpa.New: %v", err)
	}
	return checker
}

func TestTCPAGate_Allow(t *testing.T) {
	checker := buildAllowChecker(t, "America/Chicago")
	g := &gates.TCPAGate{
		Checker: checker,
		NowFn: func() time.Time {
			return time.Date(2026, 5, 13, 14, 0, 0, 0, time.UTC)
		},
	}
	req := &originate.OriginateRequest{
		AttemptUUID:  "tcpa-allow-uuid",
		DestNumber:   "+12145550100",
		LeadState:    "TX",
		IsAutoDialer: true,
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateAllow {
		t.Errorf("expected GateAllow, got %v (block: %v)", result.Outcome, result.Block)
	}
	if result.AuditPatch.TCPADecision != "ALLOW" {
		t.Errorf("TCPADecision = %q, want ALLOW", result.AuditPatch.TCPADecision)
	}
}

func TestTCPAGate_Block_AfterWindow(t *testing.T) {
	resolver := &stubResolver{
		result: tcpa.ResolveResult{
			IANA:       "America/Chicago",
			Confidence: tcpa.ConfKnown,
			Location:   time.UTC,
		},
	}
	// Use a rule where the call window has already closed.
	pastCloseRule := tcpa.StateRule{
		Code: "TX",
		PerDow: [7]tcpa.Window{
			// All days: 8am–9am (only 1 hour window, before our test time of 2pm).
			{OpenLocal: 480 * time.Minute, CloseLocal: 540 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 540 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 540 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 540 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 540 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 540 * time.Minute},
			{OpenLocal: 480 * time.Minute, CloseLocal: 540 * time.Minute},
		},
	}
	checker, err := tcpa.New(tcpa.CheckerOpts{
		Resolver: resolver,
		Rules:    map[string]tcpa.StateRule{"TX": pastCloseRule},
		NowFn: func() time.Time {
			return time.Date(2026, 5, 13, 14, 0, 0, 0, time.UTC)
		},
	})
	if err != nil {
		t.Fatalf("tcpa.New: %v", err)
	}

	g := &gates.TCPAGate{
		Checker: checker,
		NowFn: func() time.Time {
			return time.Date(2026, 5, 13, 14, 0, 0, 0, time.UTC)
		},
	}
	req := &originate.OriginateRequest{
		AttemptUUID:  "tcpa-block-uuid",
		DestNumber:   "+12145550100",
		LeadState:    "TX",
		IsAutoDialer: true,
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateBlock {
		t.Errorf("expected GateBlock for after-window, got %v", result.Outcome)
	}
	if result.Block == nil {
		t.Fatal("result.Block is nil")
	}
	if result.Block.Gate() != "tcpa" {
		t.Errorf("Gate() = %q, want tcpa", result.Block.Gate())
	}
	if result.Block.D04Status() != "TCPA" {
		t.Errorf("D04Status() = %q, want TCPA", result.Block.D04Status())
	}
	if result.AuditPatch.TCPADecision != "BLOCK" {
		t.Errorf("TCPADecision = %q, want BLOCK", result.AuditPatch.TCPADecision)
	}
}

func TestTCPAGate_BlockInvalid_NoTimezone(t *testing.T) {
	resolver := &stubResolver{
		result: tcpa.ResolveResult{
			Confidence: tcpa.ConfNone, // can't determine TZ
		},
	}
	checker, err := tcpa.New(tcpa.CheckerOpts{
		Resolver: resolver,
		Rules:    map[string]tcpa.StateRule{},
	})
	if err != nil {
		t.Fatalf("tcpa.New: %v", err)
	}

	g := &gates.TCPAGate{Checker: checker}
	req := &originate.OriginateRequest{
		AttemptUUID: "tcpa-notz-uuid",
		DestNumber:  "+15005550199",
		// No state, no timezone info
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateBlock {
		t.Errorf("expected GateBlock for unknown TZ (PolicyDeny), got %v", result.Outcome)
	}
	if result.Block.Gate() != "tcpa" {
		t.Errorf("Gate() = %q, want tcpa", result.Block.Gate())
	}
}
