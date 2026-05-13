// D01 — After-commit event publish (PLAN §9.3)
// Publishes to Valkey Stream events:vici2.lead.{action} after commit.
// At-least-once; best-effort. The audit_events row is the durable record.

import type { Redis } from "ioredis";

export interface LeadEvent {
  tenant_id: string;
  lead_id: string;
  actor_user_id: string | null;
  ts: string;
  action: string;
  details?: Record<string, unknown>;
}

let _valkey: Redis | null = null;

export function setValkeyForEvents(client: Redis | null): void {
  _valkey = client;
}

export async function publishLeadEvent(
  action: string,
  event: LeadEvent,
): Promise<void> {
  if (!_valkey) return; // best-effort: no-op if not configured
  const streamKey = `events:vici2.lead.${action}`;
  try {
    const fields: string[] = [];
    for (const [k, v] of Object.entries(event)) {
      if (v !== null && v !== undefined) {
        fields.push(k, typeof v === "object" ? JSON.stringify(v) : String(v));
      }
    }
    await _valkey.xadd(streamKey, "*", ...fields);
  } catch {
    // Swallow publish errors — the audit row is authoritative
  }
}
