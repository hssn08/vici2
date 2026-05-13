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
func (k Keys) AdaptLock(cid int64) string {
	return fmt.Sprintf("t:%d:adapt:lock:%d", k.tid, cid)
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

// --- S02 monitor session keys ------------------------------------------------

// MonitorSession is the per-supervisor-session HASH.
// Format: t:{tid}:monitor:{supCallUUID}
// S02 PLAN §12.1.
func (k Keys) MonitorSession(tenantID int64, supCallUUID string) string {
	return fmt.Sprintf("t:%d:monitor:%s", tenantID, supCallUUID)
}

// AgentMonitors is the ZSET of active supervisor call-UUIDs for a given agent.
// Members: supCallUUIDs, Scores: started_at Unix milliseconds.
// Format: t:{tid}:agent:{uid}:monitors
// S02 PLAN §12.1.
func (k Keys) AgentMonitors(tenantID, userID int64) string {
	return fmt.Sprintf("t:%d:agent:%d:monitors", tenantID, userID)
}

// MonitorJTI is the one-time-use JTI lock for a monitor grant token.
// Format: vici2:monitor:jti:{jti}
// S02 PLAN §12.1: SET NX EX 90.
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
