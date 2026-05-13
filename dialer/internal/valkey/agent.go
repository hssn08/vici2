// agent.go — typed wrapper around the agent-state Lua scripts.

package valkey

import (
	"context"
	"fmt"
	"strconv"
)

// AgentOps groups agent-state typed operations.
type AgentOps struct{ c *Client }

// Agents returns agent ops bound to this client.
func (c *Client) Agents() *AgentOps { return &AgentOps{c: c} }

// Transition runs the CAS agent-state-transition Lua. Returns true on
// success, false if expectedStatus didn't match.
//
// `extra` is an optional flat list of HSET pairs (e.g.
// {"lead_id","12345","call_uuid","abc"}). Length must be even.
func (a *AgentOps) Transition(
	ctx context.Context,
	cid, userID int64,
	expectedStatus AgentStatus, // "" to skip check
	newStatus AgentStatus,
	nowMs int64,
	extra ...string,
) (bool, error) {
	if len(extra)%2 != 0 {
		return false, fmt.Errorf("valkey: Transition extra must be even-length, got %d", len(extra))
	}

	// If expectedStatus is empty, the script skips the old-index ZREMs
	// of `expectedStatus`. We always pass *some* ZSET (use the new one
	// twice) to keep the script signature simple; the script's ZREM
	// against the new set is a no-op since the member isn't there yet.
	oldStatus := expectedStatus
	if oldStatus == "" {
		oldStatus = newStatus
	}

	args := make([]any, 0, 4+len(extra))
	args = append(args,
		strconv.FormatInt(userID, 10),
		string(expectedStatus), // may be ""
		string(newStatus),
		strconv.FormatInt(nowMs, 10),
	)
	for _, v := range extra {
		args = append(args, v)
	}

	res, err := a.c.Scripts.Eval(
		ctx,
		a.c.State,
		ScriptAgentStateTransition,
		[]string{
			a.c.Keys.Agent(userID),
			a.c.Keys.AgentsByStatus(oldStatus),
			a.c.Keys.AgentsByCampaignStatus(cid, oldStatus),
			a.c.Keys.AgentsByStatus(newStatus),
			a.c.Keys.AgentsByCampaignStatus(cid, newStatus),
		},
		args...,
	)
	if err != nil {
		return false, err
	}
	n, _ := res.(int64)
	return n == 1, nil
}

// PickForCall atomically picks the longest-waiting READY agent in a
// campaign, transitions them to RESERVED, and stamps call_uuid into
// their HASH. Returns 0 if no READY agent is available.
func (a *AgentOps) PickForCall(
	ctx context.Context,
	cid int64,
	callUUID string,
	nowMs int64,
) (int64, error) {
	res, err := a.c.Scripts.Eval(
		ctx,
		a.c.State,
		ScriptPickAgentForCall,
		[]string{
			a.c.Keys.AgentsByCampaignStatus(cid, AgentReady),
			a.c.Keys.AgentsByStatus(AgentReady),
			a.c.Keys.AgentsByCampaignStatus(cid, AgentReserved),
			a.c.Keys.AgentsByStatus(AgentReserved),
			a.c.Keys.AgentHashPrefix(),
		},
		callUUID, strconv.FormatInt(nowMs, 10),
	)
	if err != nil {
		return 0, err
	}
	if res == nil {
		return 0, nil
	}
	s, _ := res.(string)
	if s == "" {
		return 0, nil
	}
	return strconv.ParseInt(s, 10, 64)
}

// SetState writes the canonical agent HASH atomically, and also pushes
// the user into the appropriate by_status index ZSET. Use this for new
// logins (no expected previous status).
func (a *AgentOps) SetState(
	ctx context.Context,
	cid, userID int64,
	status AgentStatus,
	nowMs int64,
	extra ...string,
) error {
	ok, err := a.Transition(ctx, cid, userID, "", status, nowMs, extra...)
	if err != nil {
		return err
	}
	if !ok {
		return fmt.Errorf("valkey: SetState refused for user %d", userID)
	}
	return nil
}
