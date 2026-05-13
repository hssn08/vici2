// I04 — Inbound Callback Queue: Prometheus metrics.

import client from "prom-client";

// Singleton registry for I04 metrics (merged into main registry at startup)
export const i04Registry = new client.Registry();

export const i04CallbackAcceptedTotal = new client.Counter({
  name: "vici2_i04_callback_accepted_total",
  help: "Inbound callback opt-ins received.",
  labelNames: ["path"] as const,  // queue_offer | ivr_terminal
  registers: [i04Registry],
});

export const i04AniMissingTotal = new client.Counter({
  name: "vici2_i04_ani_missing_total",
  help: "Calls where ANI was absent; fallback attempted.",
  labelNames: ["ingroup_id"] as const,
  registers: [i04Registry],
});

export const i04NonUsNumberTotal = new client.Counter({
  name: "vici2_i04_non_us_number_total",
  help: "Non-NANP callback numbers encountered.",
  labelNames: ["ingroup_id"] as const,
  registers: [i04Registry],
});

export const i04CallbackFiredTotal = new client.Counter({
  name: "vici2_i04_callback_fired_total",
  help: "Successful inbound callback originates.",
  labelNames: ["ingroup_id", "tcpa_outcome"] as const,
  registers: [i04Registry],
});

export const i04CallbackDeferredTotal = new client.Counter({
  name: "vici2_i04_callback_deferred_total",
  help: "Inbound callbacks re-snoozed by TCPA or other reason.",
  labelNames: ["ingroup_id", "reason"] as const,
  registers: [i04Registry],
});

export const i04CallbackDeadTotal = new client.Counter({
  name: "vici2_i04_callback_dead_total",
  help: "Inbound callbacks terminated (national_dnc, expired, etc.).",
  labelNames: ["ingroup_id", "reason"] as const,
  registers: [i04Registry],
});

export const i04StubLeadCreatedTotal = new client.Counter({
  name: "vici2_i04_stub_lead_created_total",
  help: "Stub leads created for anonymous callers.",
  labelNames: ["ingroup_id"] as const,
  registers: [i04Registry],
});

export const i04LockContentionTotal = new client.Counter({
  name: "vici2_i04_lock_contention_total",
  help: "Fire lock contention events (concurrent dispatcher pods).",
  labelNames: ["ingroup_id"] as const,
  registers: [i04Registry],
});

export const i04CallbackStaleTotal = new client.Counter({
  name: "vici2_i04_callback_stale_total",
  help: "Pending INBOUND callbacks older than stale threshold.",
  labelNames: ["ingroup_id", "age_bucket"] as const,
  registers: [i04Registry],
});

export const i04TimeToFireSeconds = new client.Histogram({
  name: "vici2_i04_time_to_fire_seconds",
  help: "Seconds from callback created_at to fired_at.",
  labelNames: ["ingroup_id"] as const,
  buckets: [30, 60, 120, 300, 600, 1800, 3600, 7200, 86400],
  registers: [i04Registry],
});

export const i04InternalDncBypassTotal = new client.Counter({
  name: "vici2_i04_internal_dnc_bypass_total",
  help: "Internal DNC bypassed due to express inbound callback consent.",
  labelNames: ["ingroup_id"] as const,
  registers: [i04Registry],
});

export const i04NoAnswerRescheduleTotal = new client.Counter({
  name: "vici2_i04_no_answer_reschedule_total",
  help: "Inbound callback no-answer reschedule count.",
  labelNames: ["ingroup_id", "policy"] as const,
  registers: [i04Registry],
});

export function getI04AgeBucket(ageSeconds: number): string {
  if (ageSeconds < 30 * 60) return "<30m";
  if (ageSeconds < 2 * 3600) return "30m-2h";
  return "2h+";
}
