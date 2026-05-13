package queue

import "fmt"

// QueueKeys provides typed Redis key builders for the I01 inbound queue.
// I01 PLAN §3.7 (FROZEN key namespace).
type QueueKeys struct {
	tid int64
}

// NewQueueKeys returns a QueueKeys builder for the given tenant.
func NewQueueKeys(tenantID int64) QueueKeys {
	return QueueKeys{tid: tenantID}
}

// IngroupQueue is the ZSET of waiting calls. Score = base_score (enter_ts_ms − boost_ms).
func (k QueueKeys) IngroupQueue(igid string) string {
	return fmt.Sprintf("t:%d:ingroup:%s:queue", k.tid, igid)
}

// IngroupReadyAgents is the ZSET of READY agents for an ingroup. Score = last_ready_change_ts.
func (k QueueKeys) IngroupReadyAgents(igid string) string {
	return fmt.Sprintf("t:%d:ingroup:%s:ready_agents", k.tid, igid)
}

// IngroupQueueMeta is the HASH with avg_handle_sec, ready_agents, etc.
func (k QueueKeys) IngroupQueueMeta(igid string) string {
	return fmt.Sprintf("t:%d:ingroup:%s:queue_meta", k.tid, igid)
}

// QueueCall is the HASH with per-call state.
func (k QueueKeys) QueueCall(callUUID string) string {
	return fmt.Sprintf("t:%d:queue_call:%s", k.tid, callUUID)
}

// DispatchLock is the NX EX dispatch lock per ingroup.
func (k QueueKeys) DispatchLock(igid string) string {
	return fmt.Sprintf("t:%d:queue_dispatch_lock:%s", k.tid, igid)
}

// StickyAgent is the per-caller sticky agent mapping.
func (k QueueKeys) StickyAgent(phoneE164 string) string {
	return fmt.Sprintf("t:%d:sticky:%s", k.tid, phoneE164)
}

// EWTPerPos is the EWT per position unit (avg_handle_sec / max(1, ready_agents)).
func (k QueueKeys) EWTPerPos(igid string) string {
	return fmt.Sprintf("t:%d:ingroup:%s:ewt_sec_per_pos", k.tid, igid)
}

// AgentSkillsCache is the HASH of {skill_key:skill_value → proficiency} for one agent.
func (k QueueKeys) AgentSkillsCache(userID int64) string {
	return fmt.Sprintf("t:%d:agent_skills:%d", k.tid, userID)
}

// AgentSkillsChangedChannel is the pub/sub invalidation channel.
func (k QueueKeys) AgentSkillsChangedChannel(userID int64) string {
	return fmt.Sprintf("agent_skills_changed:%d", userID)
}

// GlobalAgentsByStatus is the global ZSET for the given status (READY, INCALL, etc.).
// This key is shared with E02 pacing (F04 key namespace).
func (k QueueKeys) GlobalAgentsByStatus(status string) string {
	return fmt.Sprintf("t:%d:agents:by_status:%s", k.tid, status)
}

// AgentHash is the per-agent state HASH.
func (k QueueKeys) AgentHash(userID int64) string {
	return fmt.Sprintf("t:%d:agent:%d", k.tid, userID)
}

// AgentRejectCount is the hourly reject counter for auto-PAUSE logic.
func (k QueueKeys) AgentRejectCount(userID int64) string {
	return fmt.Sprintf("t:%d:agent:%d:reject_count_hourly", k.tid, userID)
}

// EnrollStream is the Valkey Stream for ingroup enrollment events.
// I01 PLAN §17.4.
func (k QueueKeys) EnrollStream() string {
	return "events:vici2.ingroup.enrollment"
}

// InGroupStream is the Valkey Stream for ingroup lifecycle events.
// I01 PLAN §16.1.
func (k QueueKeys) InGroupStream() string {
	return "events:vici2.ingroup.*"
}
