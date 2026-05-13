package gates_test

import (
	"context"
	"testing"

	"github.com/vici2/dialer/internal/compliance/consent"
	"github.com/vici2/dialer/internal/originate"
	"github.com/vici2/dialer/internal/originate/gates"
)

func buildConsentChecker(t *testing.T) *consent.Checker {
	t.Helper()
	checker, err := consent.New(consent.CheckerOpts{})
	if err != nil {
		t.Fatalf("consent.New: %v", err)
	}
	return checker
}

// Two-party states per T04 PLAN §3.5.
var twoPartyStates = []string{"CA", "CT", "DE", "FL", "IL", "MD", "MA", "MI", "MT", "NH", "OR", "PA", "WA"}

func TestConsentGate_OnePartyState_Allow(t *testing.T) {
	g := &gates.ConsentGate{Checker: buildConsentChecker(t)}
	req := &originate.OriginateRequest{
		AttemptUUID:   "consent-allow-uuid",
		LeadState:     "TX", // 1-party
		RecordingMode: originate.RecordAll,
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateAllow {
		t.Fatalf("expected GateAllow for 1-party state, got %v", result.Outcome)
	}
	if result.AuditPatch.ConsentDecision != "ALLOW" {
		t.Errorf("ConsentDecision = %q, want ALLOW", result.AuditPatch.ConsentDecision)
	}
	if scratch.ConsentDecision != "ALLOW" {
		t.Errorf("scratch.ConsentDecision = %q, want ALLOW", scratch.ConsentDecision)
	}
}

func TestConsentGate_TwoPartyStates_Prompt(t *testing.T) {
	g := &gates.ConsentGate{Checker: buildConsentChecker(t)}
	for _, state := range twoPartyStates {
		t.Run(state, func(t *testing.T) {
			req := &originate.OriginateRequest{
				AttemptUUID:   "consent-prompt-" + state,
				LeadState:     state,
				RecordingMode: originate.RecordAll,
			}
			scratch := &originate.GateScratch{}
			result := g.Check(context.Background(), req, scratch)
			if result.Outcome != originate.GateAllow {
				t.Fatalf("2-party state %s should ALLOW (not block call), got %v", state, result.Outcome)
			}
			if result.AuditPatch.ConsentDecision != "PROMPT" {
				t.Errorf("state %s: ConsentDecision = %q, want PROMPT", state, result.AuditPatch.ConsentDecision)
			}
			if scratch.ConsentDecision != "PROMPT" {
				t.Errorf("state %s: scratch.ConsentDecision = %q, want PROMPT", state, scratch.ConsentDecision)
			}
		})
	}
}

func TestConsentGate_RecordNever_SkipRecording(t *testing.T) {
	g := &gates.ConsentGate{Checker: buildConsentChecker(t)}
	req := &originate.OriginateRequest{
		AttemptUUID:   "consent-skip-uuid",
		LeadState:     "CA", // 2-party, but campaign says NEVER record
		RecordingMode: originate.RecordNever,
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateAllow {
		t.Fatalf("expected GateAllow even for NEVER mode, got %v", result.Outcome)
	}
	if result.AuditPatch.ConsentDecision != "SKIP_RECORDING" {
		t.Errorf("ConsentDecision = %q, want SKIP_RECORDING", result.AuditPatch.ConsentDecision)
	}
}

func TestConsentGate_InterstateStricterStateWins(t *testing.T) {
	// Caller in TX (1-party), lead in CA (2-party) → stricter-state-wins → PROMPT.
	g := &gates.ConsentGate{Checker: buildConsentChecker(t)}
	req := &originate.OriginateRequest{
		AttemptUUID:   "consent-interstate-uuid",
		LeadState:     "CA",  // 2-party
		CallerState:   "TX",  // 1-party
		RecordingMode: originate.RecordAll,
	}
	scratch := &originate.GateScratch{}
	result := g.Check(context.Background(), req, scratch)
	if result.Outcome != originate.GateAllow {
		t.Fatalf("expected GateAllow (never block for consent), got %v", result.Outcome)
	}
	if result.AuditPatch.ConsentDecision != "PROMPT" {
		t.Errorf("interstate stricter-state-wins: ConsentDecision = %q, want PROMPT", result.AuditPatch.ConsentDecision)
	}
}
