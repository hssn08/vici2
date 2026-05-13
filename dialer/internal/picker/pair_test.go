package picker

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// TestAgentPairer_PickForCall_NoAgent verifies ErrNoReadyAgent when ZSET is empty.
func TestAgentPairer_PickForCall_NoAgent(t *testing.T) {
	vc, _ := newTestValkey(t)
	m := testMetrics()
	pairer := NewAgentPairer(vc, m)

	agentID, err := pairer.PickForCall(context.Background(), 1, 30, "call-uuid-1")
	if err != ErrNoReadyAgent {
		t.Errorf("expected ErrNoReadyAgent, got err=%v agentID=%d", err, agentID)
	}
	if agentID != 0 {
		t.Errorf("expected agentID=0, got %d", agentID)
	}
}

// TestAgentPairer_PickForCall_WithAgent verifies agent selection from ZSET.
func TestAgentPairer_PickForCall_WithAgent(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	pairer := NewAgentPairer(vc, m)

	const campaignID = int64(50)
	const agentUserID = int64(77)

	// Seed a READY agent.
	readyKey := vc.Keys.AgentsByCampaignStatus(campaignID, "READY")
	mr.ZAdd(readyKey, float64(time.Now().UnixMilli()-5000), fmt.Sprintf("%d", agentUserID))
	mr.HSet(vc.Keys.Agent(agentUserID),
		"status", "READY",
		"campaign_id", fmt.Sprintf("%d", campaignID),
		"user_id", fmt.Sprintf("%d", agentUserID),
	)

	agentID, err := pairer.PickForCall(context.Background(), 1, campaignID, "call-uuid-2")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if agentID != agentUserID {
		t.Errorf("expected agentID=%d, got %d", agentUserID, agentID)
	}
}

// TestAgentPairer_ReleaseReservation verifies RESERVED→READY transition.
func TestAgentPairer_ReleaseReservation(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	pairer := NewAgentPairer(vc, m)

	const campaignID = int64(55)
	const agentUserID = int64(88)

	// Put agent in RESERVED state.
	reservedKey := vc.Keys.AgentsByCampaignStatus(campaignID, "RESERVED")
	mr.ZAdd(reservedKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", agentUserID))
	mr.HSet(vc.Keys.Agent(agentUserID),
		"status", "RESERVED",
		"campaign_id", fmt.Sprintf("%d", campaignID),
		"user_id", fmt.Sprintf("%d", agentUserID),
	)

	err := pairer.ReleaseReservation(context.Background(), campaignID, agentUserID)
	if err != nil {
		t.Fatalf("ReleaseReservation error: %v", err)
	}
}

// TestAgentPairer_TransitionToInCall verifies RESERVED→INCALL transition.
func TestAgentPairer_TransitionToInCall(t *testing.T) {
	vc, mr := newTestValkey(t)
	m := testMetrics()
	pairer := NewAgentPairer(vc, m)

	const campaignID = int64(60)
	const agentUserID = int64(99)

	// Put agent in RESERVED state.
	reservedKey := vc.Keys.AgentsByCampaignStatus(campaignID, "RESERVED")
	mr.ZAdd(reservedKey, float64(time.Now().UnixMilli()), fmt.Sprintf("%d", agentUserID))
	mr.HSet(vc.Keys.Agent(agentUserID),
		"status", "RESERVED",
		"campaign_id", fmt.Sprintf("%d", campaignID),
		"user_id", fmt.Sprintf("%d", agentUserID),
	)

	err := pairer.TransitionToInCall(context.Background(), campaignID, agentUserID, 500, "call-uuid-3")
	if err != nil {
		t.Fatalf("TransitionToInCall error: %v", err)
	}
}
