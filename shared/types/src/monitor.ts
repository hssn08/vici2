// S02 supervisor monitor shared types.
// S02 PLAN §15.5.

/** The three supervisor monitoring modes. */
export type MonitorMode = "listen" | "whisper" | "barge";

/** Active monitor session as seen by the supervisor's UI. */
export interface MonitorSession {
  /** Session ID (JTI of the grant token). */
  sessionId: string;
  /** Supervisor's conference member ID. */
  memberID: number;
  /** Target agent's user ID. */
  targetUid: number;
  /** Supervisor's user ID. */
  supUid: number;
  /** Current monitoring mode. */
  mode: MonitorMode;
  /** ISO-8601 timestamp of when the session started. */
  startedAt: string;
  /** Conference name (RFC-002 format). */
  confName: string;
}

/** Response from POST /api/sup/monitor/start. */
export interface MonitorStartResponse {
  /** Session ID (JTI); used as the :id in PATCH/DELETE. */
  session_id: string;
  /** Short-lived monitor grant JWT (60 s TTL). */
  token: string;
  /** ISO-8601 expiry of the token. */
  expires_at: string;
  /** SIP extension to dial: e.g. *81_1042_listen */
  dial_extension: string;
  /** Target conference name: e.g. agent_t1_u1042 */
  target_conf_name: string;
}

/** Response from PATCH /api/sup/sessions/:id/mode. */
export interface MonitorModeSwitchResponse {
  session_id: string;
  previous_mode: MonitorMode;
  mode: MonitorMode;
  transitioned_at: string;
}

/** Agent-side banner payload pushed via WebSocket when monitor count changes. */
export interface MonitorBannerPayload {
  /** Map of mode → count. */
  counts: Partial<Record<MonitorMode, number>>;
  /** Total supervisor count (sum of all modes). */
  total: number;
}
