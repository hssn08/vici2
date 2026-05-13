// Package valkey is the dialer's typed wrapper around Valkey 8.
//
// F04 PLAN §4 freezes the key namespace; this file is the *only*
// allowed source of key strings. Callers obtain keys via Keys(), never
// concatenate `t:` strings inline. A future golangci-lint rule (PLAN
// §7.4) will enforce this.
package valkey

import (
	"fmt"
)

// AgentStatus is the enum used by per-status ZSET indexes.
// PLAN §4.6.
type AgentStatus string

const (
	AgentReady    AgentStatus = "READY"
	AgentPaused   AgentStatus = "PAUSED"
	AgentInCall   AgentStatus = "INCALL"
	AgentReserved AgentStatus = "RESERVED"
	AgentWrapup   AgentStatus = "WRAPUP"
	AgentLogout   AgentStatus = "LOGOUT"
)

// AllAgentStatuses returns every legal status. Used by tests + index
// invariant checks.
func AllAgentStatuses() []AgentStatus {
	return []AgentStatus{AgentReady, AgentPaused, AgentInCall, AgentReserved, AgentWrapup, AgentLogout}
}

// Keys is a typed key-builder bound to a tenant. F04 PLAN §4 +
// hash-tag convention (§4.7): per-campaign keys wrap `{cid}` so the
// hopper, in-flight, drop_window, and active_calls for one campaign
// colocate on the same Cluster shard.
type Keys struct {
	tid int64
}

// NewKeys returns a Keys builder for the given tenant. Phase 1 uses
// tenant_id=1 everywhere.
func NewKeys(tenantID int64) Keys {
	if tenantID <= 0 {
		// Misuse — the builders panic rather than emit malformed keys.
		panic(fmt.Sprintf("valkey: tenant id must be > 0, got %d", tenantID))
	}
	return Keys{tid: tenantID}
}

// TenantID returns the bound tenant id.
func (k Keys) TenantID() int64 { return k.tid }

// --- per-campaign keys (with {cid} hash tag) --------------------------------

func (k Keys) CampaignHopper(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:hopper", k.tid, cid)
}
func (k Keys) CampaignInFlight(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:in_flight", k.tid, cid)
}
func (k Keys) CampaignDropWindow(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_window", k.tid, cid)
}
func (k Keys) CampaignDialLevel(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:dial_level", k.tid, cid)
}
func (k Keys) CampaignActiveCalls(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:active_calls", k.tid, cid)
}

// LeadLockPrefix is used by Lua scripts that build per-lead lock keys
// via string concat. Return value already ends with `:`.
// PLAN §4.2.
func (k Keys) LeadLockPrefix(cid int64) string {
	return fmt.Sprintf("t:%d:lead_lock:{%d}:", k.tid, cid)
}

// LeadLock is the concrete per-lead lock key.
func (k Keys) LeadLock(cid, leadID int64) string {
	return fmt.Sprintf("t:%d:lead_lock:{%d}:%d", k.tid, cid, leadID)
}

// --- agent keys --------------------------------------------------------------

func (k Keys) Agent(userID int64) string {
	return fmt.Sprintf("t:%d:agent:%d", k.tid, userID)
}

// AgentHashPrefix is for Lua scripts that compose `prefix .. user_id`.
func (k Keys) AgentHashPrefix() string {
	return fmt.Sprintf("t:%d:agent:", k.tid)
}

func (k Keys) AgentsByStatus(status AgentStatus) string {
	return fmt.Sprintf("t:%d:agents:by_status:%s", k.tid, status)
}

func (k Keys) AgentsByCampaignStatus(cid int64, status AgentStatus) string {
	return fmt.Sprintf("t:%d:agents:by_campaign:{%d}:by_status:%s", k.tid, cid, status)
}

// --- call keys ---------------------------------------------------------------

// Call active-state HASH. PLAN §4.8. Note: T04 uses a slightly different
// shape: `t:{tid}:in_flight:{call_uuid}` (5-gate audit, T04 PLAN §11.2);
// that shape is exposed via InFlightCall below to keep both contracts.
func (k Keys) Call(uuid string) string {
	return fmt.Sprintf("t:%d:call:%s", k.tid, uuid)
}
func (k Keys) CallActive() string {
	return fmt.Sprintf("t:%d:call:active", k.tid)
}

// InFlightCall is T04's per-call in-flight HASH. The {uuid} is wrapped
// in cluster hash-tag braces because T04 PLAN §11 colocates the gateway
// counter and in_flight HASH for hot-path Lua atomics.
func (k Keys) InFlightCall(uuid string) string {
	return fmt.Sprintf("t:%d:in_flight:{%s}", k.tid, uuid)
}

// GatewayActive is T04's per-gateway concurrent-call counter.
func (k Keys) GatewayActive(gatewayID int64) string {
	return fmt.Sprintf("t:%d:gw:%d:active", k.tid, gatewayID)
}

// --- coordination primitives -------------------------------------------------

func (k Keys) DialerTick(cid int64) string {
	return fmt.Sprintf("t:%d:dialer:tick:%d", k.tid, cid)
}
func (k Keys) JanitorLock() string {
	return fmt.Sprintf("t:%d:janitor:lock", k.tid)
}

// JanitorEmptyConfs is the HASH tracking when each non-agent conference
// first became empty (for stale conference detection).
// Field = conference_name, Value = empty_since_unix_ms (decimal string).
// No TTL — fields are deleted when the conference is killed or recovers.
// E06 PLAN §4.3.
func (k Keys) JanitorEmptyConfs() string {
	return fmt.Sprintf("t:%d:janitor:empty_confs", k.tid)
}
func (k Keys) AdaptLock(cid int64) string {
	return fmt.Sprintf("t:%d:adapt:lock:{%d}", k.tid, cid)
}

// AdaptFastcutLock is the fast-cut coalescing lock key (E03 PLAN §10.2).
// TTL=5s; prevents multi-pod fast-cut storms.
func (k Keys) AdaptFastcutLock(cid int64) string {
	return fmt.Sprintf("t:%d:adapt:fastcut:{%d}", k.tid, cid)
}

// CampaignPaceState is the E03 controller HASH key (E03 PLAN §10.1).
// Contains integral_term, last_level, warm_up_calls_remaining, and 6 other fields.
// No TTL — persistent. Hash tag {cid} colocates with dial_level and active_calls.
func (k Keys) CampaignPaceState(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:pace_state", k.tid, cid)
}

// CampaignAdaptDecisions is the E03 audit STREAM (MAXLEN 5760 = 24h at 15s).
func (k Keys) CampaignAdaptDecisions(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:adapt_decisions", k.tid, cid)
}

// --- pub/sub channels --------------------------------------------------------

func (k Keys) BroadcastAgent(userID int64) string {
	return fmt.Sprintf("t:%d:broadcast:agent:%d", k.tid, userID)
}
func (k Keys) BroadcastCampaign(cid int64) string {
	return fmt.Sprintf("t:%d:broadcast:campaign:%d", k.tid, cid)
}
func (k Keys) BroadcastWallboard() string {
	return fmt.Sprintf("t:%d:broadcast:wallboard", k.tid)
}

// --- streams (cross-tenant) --------------------------------------------------

// EventStream returns one of the canonical `events:vici2.<domain>.<event>`
// streams. Tenant id is in the payload, not the key (PLAN §4.10).
func EventStream(domain, event string) string {
	return fmt.Sprintf("events:vici2.%s.%s", domain, event)
}

// --- DNC --------------------------------------------------------------------

// DNCCache is the per-number negative-cache STRING in DB 1.
func (k Keys) DNCCache(phoneE164 string) string {
	return fmt.Sprintf("cache:dnc:%d:%s", k.tid, phoneE164)
}

// DNCInternalBloom is the per-tenant internal-DNC Bloom filter (D05 PLAN §1.2).
func (k Keys) DNCInternalBloom() string {
	return fmt.Sprintf("t:%d:dnc:internal:bloom", k.tid)
}
func (k Keys) DNCStateBloom() string {
	return fmt.Sprintf("t:%d:dnc:state:bloom", k.tid)
}

// DNCFederalBloom is the global federal-DNC Bloom (no tenant prefix).
func DNCFederalBloom() string    { return "bf:dnc:federal" }
func DNCLitigatorBloom() string  { return "bf:dnc:litigator" }

// DNCBypassToken stores a single-use DNC-bypass token (60s TTL).
func (k Keys) DNCBypassToken(token string) string {
	return fmt.Sprintf("t:%d:dnc:bypass:%s", k.tid, token)
}

// --- E05 drop-gate keys (FROZEN: E05 PLAN §5.2, §6.3) -----------------------

// CampaignDropPct30d is the per-campaign 30-day rolling drop rate (decimal text).
func (k Keys) CampaignDropPct30d(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_pct_30d", k.tid, cid)
}

// CampaignDropCount30d is the cached numerator (drop_log count).
func (k Keys) CampaignDropCount30d(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_count_30d", k.tid, cid)
}

// CampaignDropDenominator30d is the cached denominator (live-answered calls).
func (k Keys) CampaignDropDenominator30d(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_denominator_30d", k.tid, cid)
}

// CampaignDropGated is the drop-gate STRING key. FROZEN contract:
//
//	Set:    SET key "1"   (no TTL; persistent until DEL)
//	Read:   EXISTS key    (E02 uses EXISTS, not GET)
//	Clear:  DEL key
//	Absent: gate NOT engaged
func (k Keys) CampaignDropGated(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_gated", k.tid, cid)
}

// CampaignDropGateEngagedAt records when the hard gate was last engaged (RFC3339 text).
func (k Keys) CampaignDropGateEngagedAt(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_gate_engaged_at", k.tid, cid)
}

// CampaignDropGateTransitions is the Valkey STREAM for gate engage/release events.
func (k Keys) CampaignDropGateTransitions(cid int64) string {
	return fmt.Sprintf("t:%d:campaign:{%d}:drop_gate_transitions", k.tid, cid)
}

// --- S02 monitor session keys ------------------------------------------------

// MonitorSession is the per-supervisor-session HASH (S02 PLAN §12.1).
func (k Keys) MonitorSession(tenantID int64, supCallUUID string) string {
	return fmt.Sprintf("t:%d:monitor:%s", tenantID, supCallUUID)
}

// AgentMonitors is the ZSET of active supervisor call-UUIDs for a given agent.
func (k Keys) AgentMonitors(tenantID, userID int64) string {
	return fmt.Sprintf("t:%d:agent:%d:monitors", tenantID, userID)
}

// MonitorJTI is the one-time-use JTI lock for a monitor grant token.
func MonitorJTI(jti string) string {
	return fmt.Sprintf("vici2:monitor:jti:%s", jti)
}

// --- F05 refresh-token keys --------------------------------------------------

func (k Keys) AuthRefresh(familyID, tokenHash string) string {
	return fmt.Sprintf("t:%d:auth:refresh:%s:%s", k.tid, familyID, tokenHash)
}
func (k Keys) AuthRefreshFamily(familyID string) string {
	return fmt.Sprintf("t:%d:auth:refresh:family:%s", k.tid, familyID)
}
func (k Keys) AuthRefreshUser(userID int64) string {
	return fmt.Sprintf("t:%d:auth:refresh:user:%d", k.tid, userID)
}

// --- X04 number pool keys ---------------------------------------------------

// PoolRRCursor is the round-robin cursor STRING for a pool (INCR; no TTL).
// Hash tag {poolID} colocates all pool keys on the same Valkey cluster shard.
func (k Keys) PoolRRCursor(poolID int64) string {
	return fmt.Sprintf("t:%d:pool:{%d}:rr_cursor", k.tid, poolID)
}

// PoolMembers is the cached active member list JSON STRING for a pool.
func (k Keys) PoolMembers(poolID int64) string {
	return fmt.Sprintf("t:%d:pool:{%d}:members", k.tid, poolID)
}

// PoolInvalidate is the pub/sub channel name for pool cache invalidation.
// Dialer processes subscribe; API publishes on membership change.
func (k Keys) PoolInvalidate(poolID int64) string {
	return fmt.Sprintf("t:%d:pool:{%d}:invalidate", k.tid, poolID)
}

// DIDDailyCalls is the per-DID daily call counter (INCR; TTL = seconds until midnight UTC).
// Hash tag {didID} colocates the DID's daily and concurrent counters.
func (k Keys) DIDDailyCalls(didID int64) string {
	return fmt.Sprintf("t:%d:did:{%d}:daily_calls", k.tid, didID)
}

// DIDConcurrent is the per-DID concurrent active call counter (INCR on originate, DECR on hangup).
func (k Keys) DIDConcurrent(didID int64) string {
	return fmt.Sprintf("t:%d:did:{%d}:concurrent", k.tid, didID)
}
