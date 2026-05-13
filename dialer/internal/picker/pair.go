package picker

import (
	"context"
	"fmt"
	"time"

	"github.com/vici2/dialer/internal/valkey"
)

// AgentPairer wraps valkey.AgentOps.PickForCall/Transition with picker semantics.
// No new Lua scripts — reuses F04's pick_agent_for_call.v1 and
// agent_state_transition.v1 scripts.
type AgentPairer struct {
	vc      *valkey.Client
	metrics *Metrics
}

// NewAgentPairer constructs an AgentPairer.
func NewAgentPairer(vc *valkey.Client, m *Metrics) *AgentPairer {
	return &AgentPairer{vc: vc, metrics: m}
}

// PickForCall atomically picks the longest-waiting READY agent in the campaign
// and transitions them to RESERVED via pick_agent_for_call.v1.lua.
//
// Returns (agentID, nil) on success.
// Returns (0, ErrNoReadyAgent) when no READY agent is available.
// The callUUID is stamped into the agent HASH so operators can correlate.
func (p *AgentPairer) PickForCall(
	ctx context.Context,
	tenantID, campaignID int64,
	callUUID string,
) (int64, error) {
	nowMs := time.Now().UnixMilli()

	agentID, err := p.vc.Agents().PickForCall(ctx, campaignID, callUUID, nowMs)
	if err != nil {
		p.metrics.NoReadyAgent.WithLabelValues(
			fmt.Sprintf("%d", tenantID),
			fmt.Sprintf("%d", campaignID),
			"error",
		).Inc()
		return 0, fmt.Errorf("picker: pick_agent_for_call: %w", err)
	}
	if agentID == 0 {
		p.metrics.NoReadyAgent.WithLabelValues(
			fmt.Sprintf("%d", tenantID),
			fmt.Sprintf("%d", campaignID),
			"no_ready",
		).Inc()
		return 0, ErrNoReadyAgent
	}
	return agentID, nil
}

// ReleaseReservation transitions an agent back from RESERVED to READY.
// Called when dispatch fails after agent was pre-paired (PROGRESSIVE mode).
// T04 errors, lead ineligibility, or campaign pause all trigger this path.
func (p *AgentPairer) ReleaseReservation(
	ctx context.Context,
	campaignID, agentID int64,
) error {
	nowMs := time.Now().UnixMilli()
	ok, err := p.vc.Agents().Transition(
		ctx,
		campaignID,
		agentID,
		valkey.AgentReserved,
		valkey.AgentReady,
		nowMs,
	)
	if err != nil {
		return fmt.Errorf("picker: release agent reservation (agent %d): %w", agentID, err)
	}
	if !ok {
		// Agent state changed (logged out mid-pair, etc.) — not an error.
		return nil
	}
	return nil
}

// TransitionToInCall transitions an agent from RESERVED to INCALL.
// Called when T01 CHANNEL_ANSWER confirms the bridge (PROGRESSIVE/MANUAL/PREVIEW).
func (p *AgentPairer) TransitionToInCall(
	ctx context.Context,
	campaignID, agentID, leadID int64,
	callUUID string,
) error {
	nowMs := time.Now().UnixMilli()
	_, err := p.vc.Agents().Transition(
		ctx,
		campaignID,
		agentID,
		valkey.AgentReserved,
		valkey.AgentInCall,
		nowMs,
		"lead_id", fmt.Sprintf("%d", leadID),
		"call_uuid", callUUID,
	)
	if err != nil {
		return fmt.Errorf("picker: RESERVED→INCALL transition (agent %d): %w", agentID, err)
	}
	return nil
}
