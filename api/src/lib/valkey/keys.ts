// F04 PLAN §4 + §7.1 — typed key builders for Valkey. This file is
// the *only* allowed source of key strings in TypeScript code; an
// eslint rule (custom, future-work) forbids template literals matching
// `t:${...}` outside this directory.

export type AgentStatus =
  | "READY"
  | "PAUSED"
  | "INCALL"
  | "RESERVED"
  | "WRAPUP"
  | "LOGOUT";

export const ALL_AGENT_STATUSES: ReadonlyArray<AgentStatus> = [
  "READY",
  "PAUSED",
  "INCALL",
  "RESERVED",
  "WRAPUP",
  "LOGOUT",
];

export class Keys {
  readonly tenantId: number;

  constructor(tenantId: number) {
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      throw new Error(`valkey: tenantId must be a positive integer, got ${tenantId}`);
    }
    this.tenantId = tenantId;
  }

  // --- per-campaign (with {cid} hash tag) ---
  campaignHopper(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:hopper`;
  }
  campaignInFlight(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:in_flight`;
  }
  campaignDropWindow(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:drop_window`;
  }
  campaignDialLevel(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:dial_level`;
  }
  campaignActiveCalls(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:active_calls`;
  }
  leadLockPrefix(cid: number): string {
    return `t:${this.tenantId}:lead_lock:{${cid}}:`;
  }
  leadLock(cid: number, leadId: number | string): string {
    return `t:${this.tenantId}:lead_lock:{${cid}}:${leadId}`;
  }

  // --- agent ---
  agent(userId: number): string {
    return `t:${this.tenantId}:agent:${userId}`;
  }
  agentHashPrefix(): string {
    return `t:${this.tenantId}:agent:`;
  }
  agentsByStatus(status: AgentStatus): string {
    return `t:${this.tenantId}:agents:by_status:${status}`;
  }
  agentsByCampaignStatus(cid: number, status: AgentStatus): string {
    return `t:${this.tenantId}:agents:by_campaign:{${cid}}:by_status:${status}`;
  }

  // --- call ---
  call(uuid: string): string {
    return `t:${this.tenantId}:call:${uuid}`;
  }
  callActive(): string {
    return `t:${this.tenantId}:call:active`;
  }
  inFlightCall(uuid: string): string {
    return `t:${this.tenantId}:in_flight:{${uuid}}`;
  }
  gatewayActive(gatewayId: number): string {
    return `t:${this.tenantId}:gw:${gatewayId}:active`;
  }

  // --- coordination ---
  dialerTick(cid: number): string {
    return `t:${this.tenantId}:dialer:tick:${cid}`;
  }
  janitorLock(): string {
    return `t:${this.tenantId}:janitor:lock`;
  }
  adaptLock(cid: number): string {
    return `t:${this.tenantId}:adapt:lock:${cid}`;
  }

  // --- pub/sub ---
  broadcastAgent(userId: number): string {
    return `t:${this.tenantId}:broadcast:agent:${userId}`;
  }
  broadcastCampaign(cid: number): string {
    return `t:${this.tenantId}:broadcast:campaign:${cid}`;
  }
  broadcastWallboard(): string {
    return `t:${this.tenantId}:broadcast:wallboard`;
  }

  // --- DNC ---
  dncCache(phoneE164: string): string {
    return `cache:dnc:${this.tenantId}:${phoneE164}`;
  }
  dncInternalBloom(): string {
    return `t:${this.tenantId}:dnc:internal:bloom`;
  }
  dncStateBloom(): string {
    return `t:${this.tenantId}:dnc:state:bloom`;
  }
  dncBypassToken(token: string): string {
    return `t:${this.tenantId}:dnc:bypass:${token}`;
  }

  // --- E05 drop-gate (FROZEN: E05 PLAN §5.2, §6.3) ---

  /** 30-day rolling drop rate (decimal text, e.g. "1.2300"). Read by E02, E03, T04, S01. */
  campaignDropPct30d(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:drop_pct_30d`;
  }
  /** Cached numerator (drop_log count, last 30d). */
  campaignDropCount30d(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:drop_count_30d`;
  }
  /** Cached denominator (live-answered calls, last 30d). */
  campaignDropDenominator30d(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:drop_denominator_30d`;
  }
  /**
   * Drop-gate STRING. FROZEN contract:
   *   SET key "1"  (no TTL)  → gate engaged
   *   DEL key               → gate released
   *   EXISTS key            → E02 reads this (not GET)
   */
  campaignDropGated(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:drop_gated`;
  }
  /** RFC3339 timestamp of last hard-gate engagement. */
  campaignDropGateEngagedAt(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:drop_gate_engaged_at`;
  }
  /** STREAM of gate engage/release events (mirrored to drop_gate_transition_log). */
  campaignDropGateTransitions(cid: number): string {
    return `t:${this.tenantId}:campaign:{${cid}}:drop_gate_transitions`;
  }

  // --- F05 refresh-token ---
  authRefresh(familyId: string, tokenHash: string): string {
    return `t:${this.tenantId}:auth:refresh:${familyId}:${tokenHash}`;
  }
  authRefreshFamily(familyId: string): string {
    return `t:${this.tenantId}:auth:refresh:family:${familyId}`;
  }
  authRefreshUser(userId: number): string {
    return `t:${this.tenantId}:auth:refresh:user:${userId}`;
  }
}

// Global Bloom keys (no tenant prefix).
export const DNC_FEDERAL_BLOOM = "bf:dnc:federal";
export const DNC_LITIGATOR_BLOOM = "bf:dnc:litigator";

// Event-stream key builder. Tenant id is in the payload (PLAN §4.10).
export function eventStream(domain: string, event: string): string {
  return `events:vici2.${domain}.${event}`;
}
