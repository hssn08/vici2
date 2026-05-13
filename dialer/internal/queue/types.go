// Package queue implements the I01 inbound queue service.
//
// I01 PLAN §18: custom Go queue daemon (queuerd). Custom implementation
// instead of mod_callcenter — three independently-sufficient reasons:
//   (a) conference-per-agent is SACRED (T03 invariant)
//   (b) dual state machine coherence
//   (c) multi-attribute skill matching expressivity
//
// I01 PLAN §0 decision summary.
package queue

import (
	"time"
)

// RoutingStrategy is the per-in-group dispatch algorithm.
// I01 PLAN §5.1 (FROZEN).
type RoutingStrategy string

const (
	StrategySkillPriority RoutingStrategy = "skill_priority"
	StrategyLongestIdle   RoutingStrategy = "longest_idle"
	StrategyRoundRobin    RoutingStrategy = "round_robin"
	StrategyTopDown       RoutingStrategy = "top_down"
	StrategyFewestCalls   RoutingStrategy = "fewest_calls"
)

// OverflowAction is the action to take when queue is full / max_wait exceeded.
// I01 PLAN §9.
type OverflowAction string

const (
	ActionHangup           OverflowAction = "hangup"
	ActionOverflowIngroup  OverflowAction = "overflow_ingroup"
	ActionVoicemail        OverflowAction = "voicemail"
	ActionCallbackOffer    OverflowAction = "callback_offer"
	ActionExternalTransfer OverflowAction = "external_transfer"
)

// RecordingMode is the per-in-group recording policy.
// I01 PLAN §13.2.
type RecordingMode string

const (
	RecordingNever    RecordingMode = "NEVER"
	RecordingOnDemand RecordingMode = "ONDEMAND"
	RecordingAll      RecordingMode = "ALL"
	RecordingAllForce RecordingMode = "ALLFORCE"
)

// InGroup holds the live configuration of one in-group.
// Refreshed on admin save + every 60 s.
// I01 PLAN §3.6.
type InGroup struct {
	TenantID   int64
	ID         string
	Name       string
	MaxQueue   int
	MaxWaitSec int

	RoutingStrategy RoutingStrategy
	StickyEnabled   bool
	StickyWindowHrs int
	StickyFirstTrySec int
	StickyWaitWrapup bool
	WrapupSec       *int // nil = inherit

	RecordingMode         RecordingMode
	RecordingDisclosureAudio *string
	MOHStream             string
	WelcomeAudio          *string
	AnnounceIntervalSec   int
	AnnounceMinWaitSec    int

	EntryFullAction OverflowAction
	EntryFullTarget *string
	NoAgentAction   OverflowAction
	NoAgentTarget   *string
	ClosedAction    OverflowAction
	ClosedTarget    *string

	CallbackOfferEnabled      bool
	CallbackOfferAfterSeconds int
	BusinessHoursID           *int64

	// I04 — Inbound Callback Queue configuration
	OutboundCli                   string
	CallbackNoAnswerPolicyInbound string  // leave_callbk | reschedule_30m | reschedule_24h | terminate_NA
	CallbackExpiresHours          int
	CallbackPositionExpiryMinutes int

	// I01 PLAN §3.6 — skill requirements (loaded from ingroup_skills).
	SkillRequirements []SkillRequirement
}

// SkillRequirement defines one skill gate for an in-group.
// I01 PLAN §4.1.
type SkillRequirement struct {
	SkillKey       string
	SkillValue     string
	MinProficiency int
	Required       bool // false = scoring-only, not gating
	Weight         int
}

// QueuedCall is the in-memory state of a call waiting in queue.
// I01 PLAN §3.3 + §3.7.
type QueuedCall struct {
	CallUUID     string
	IngroupID    string
	TenantID     int64
	CallerIDe164 string
	DIDe164      *string
	LeadID       *int64
	EnterAt      time.Time
	BaseScore    int64  // enter_ts_ms − priority_boost_ms; lower = dispatched first
	OverflowHops int
	StickyTarget *int64 // agent user_id for sticky routing
	// MatchedSkillsJSON is the snapshot from enroll.
	MatchedSkillsJSON string
}

// Agent is the dispatcher's view of one agent.
// Loaded from Redis agent HASH + per-ingroup ZSET.
// I01 PLAN §5.3.
type Agent struct {
	UserID             int64
	Status             string
	LastReadyChangeTs  int64  // score in ready_agents ZSET (ms)
	LastDispatchedAt   int64  // for round_robin
	CallsHandledToday  int64  // for fewest_calls
	Rank               int    // for top_down; lower = higher priority
	Skills             AgentSkillSet
}

// AgentSkillSet is the in-memory skill cache for one agent.
// I01 PLAN §4.4.
type AgentSkillSet struct {
	// map[key:value]proficiency
	Skills map[string]int
	LoadedAt time.Time
}

// Proficiency returns the agent's proficiency for the given skill key+value.
// Returns 0 if not held.
func (s *AgentSkillSet) Proficiency(key, value string) int {
	if s == nil || s.Skills == nil {
		return 0
	}
	return s.Skills[key+":"+value]
}

// MatchScore returns the skill match score for the given in-group requirements.
// Returns -1 if agent is disqualified (required skill gate not met).
// I01 PLAN §4.2 (FROZEN).
func (s *AgentSkillSet) MatchScore(reqs []SkillRequirement) int {
	score := 0
	for _, r := range reqs {
		agentProf := s.Proficiency(r.SkillKey, r.SkillValue)
		if r.Required && agentProf < r.MinProficiency {
			return -1 // gated: disqualified
		}
		if agentProf >= r.MinProficiency {
			score += (agentProf - r.MinProficiency + 1) * r.Weight
		}
	}
	return score
}

// EnrollEvent is published by POST /internal/queue/enroll to Valkey Stream.
// I01 PLAN §17.4.
type EnrollEvent struct {
	CallUUID          string  `json:"call_uuid"`
	IngroupID         string  `json:"ingroup_id"`
	TenantID          int64   `json:"tenant_id"`
	CallerIDe164      string  `json:"caller_id_e164"`
	DIDe164           *string `json:"did_e164,omitempty"`
	BaseScore         int64   `json:"base_score"`
	LeadID            *int64  `json:"lead_id,omitempty"`
	MatchedSkillsJSON string  `json:"matched_skills_json"`
}

// DispatchResult is the outcome of one dispatch cycle attempt.
type DispatchResult int

const (
	DispatchOK          DispatchResult = iota
	DispatchNoCall                     // no calls in queue
	DispatchNoAgent                    // no eligible READY agent
	DispatchRace                       // Lua returned CALL_NOT_IN_QUEUE or AGENT_NOT_READY
	DispatchLockMissed                 // another pod holds the dispatch lock
)

// MaxOverflowHops is the hard-stop for overflow_ingroup chain.
// I01 PLAN §9.4.
const MaxOverflowHops = 3

// AHTAlpha is the EWMA smoothing factor for avg handle time.
// I01 PLAN §8.2 (FROZEN).
const AHTAlpha = 0.1

// AHTDefault is the seed value used before any calls complete.
// I01 PLAN §8.1.
const AHTDefault = 180.0 // seconds

// DispatchLockTTLSec is the Redis NX EX value for the dispatch lock.
// I01 PLAN §18.3.
const DispatchLockTTLSec = 5

// DispatchLockRenewSec is how often the lock holder renews.
const DispatchLockRenewSec = 2

// SkillCacheTTL is the max age for in-process skill cache entries.
// I01 PLAN §4.4.
const SkillCacheTTL = 5 * time.Minute

// RejectLimitPerHour is the threshold that triggers auto-PAUSE.
// I01 PLAN §12.4.
const RejectLimitPerHour = 3
