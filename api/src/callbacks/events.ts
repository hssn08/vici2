// D06 — After-commit event publisher for vici2.callback.* stream.
// Non-blocking: failures are logged but do not roll back transactions.

import pino from "pino";

const logger = pino({ level: "info" });

export type CallbackEventType =
  | "callback_scheduled"
  | "callback_fired_agent"
  | "callback_fired_global"
  | "callback_fired_with_warning"
  | "callback_cancelled"
  | "callback_claimed"
  | "callback_reassigned"
  | "callback_snoozed"
  | "callback_stale"
  | "callback_tcpa_deferred"
  | "callback_rescheduled";

export interface CallbackEvent {
  type: CallbackEventType;
  tenantId: bigint | number;
  callbackId: bigint | number;
  leadId: bigint | number;
  userId?: bigint | number | null;
  campaignId?: string;
  details?: Record<string, unknown>;
  ts: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishCallbackEvent(redis: any, event: CallbackEvent): Promise<void> {
  const streamKey = `events:vici2.callback.${event.type}`;
  const payload = JSON.stringify({
    ...event,
    tenantId: String(event.tenantId),
    callbackId: String(event.callbackId),
    leadId: String(event.leadId),
    userId: event.userId != null ? String(event.userId) : null,
  });
  try {
    await redis.xadd(streamKey, "*", "payload", payload);
  } catch (err) {
    logger.error({ err, streamKey }, "d06:events: failed to publish callback event");
  }
}

// WS notification helper — publish to per-agent channel
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function notifyAgent(redis: any, tenantId: bigint | number, userId: bigint | number, payload: Record<string, unknown>): Promise<void> {
  const channel = `t:${tenantId}:ws:user:${userId}`;
  try {
    await redis.publish(channel, JSON.stringify(payload));
  } catch (err) {
    logger.error({ err, channel }, "d06:events: failed to publish WS notification");
  }
}

// Check if an agent is online (any of: READY, PAUSED, INCALL, WRAPUP)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function isAgentOnline(redis: any, tenantId: bigint | number, userId: bigint | number): Promise<boolean> {
  const key = `t:${tenantId}:agent:status:${userId}`;
  try {
    const status = await redis.get(key);
    return ["READY", "PAUSED", "INCALL", "WRAPUP"].includes(status ?? "");
  } catch {
    return false;
  }
}
