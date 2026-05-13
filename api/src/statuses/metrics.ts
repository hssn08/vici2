// D04 — Prometheus metrics for the statuses subsystem.

import client from "prom-client";

const registry = new client.Registry();

/** Total disposition writes (success or failure). */
export const dispositionWritesTotal = new client.Counter({
  name: "vici2_d04_disposition_writes_total",
  help: "Total disposition submissions (success + error).",
  labelNames: ["status", "outcome"] as const,
  registers: [registry],
});

/** Hangup-cause → status resolutions. */
export const hangupResolutionsTotal = new client.Counter({
  name: "vici2_d04_hangup_resolutions_total",
  help: "Total FreeSWITCH hangup-cause → status resolutions.",
  labelNames: ["cause", "status"] as const,
  registers: [registry],
});

/** Hangup causes not found in the map (operator alert signal). */
export const hangupUnmappedTotal = new client.Counter({
  name: "vici2_d04_hangup_unmapped_total",
  help: "Hangup causes not present in hangup-cause-map.json.",
  labelNames: ["cause"] as const,
  registers: [registry],
});

/** Cache hit / miss for status list. */
export const cacheOpsTotal = new client.Counter({
  name: "vici2_d04_cache_ops_total",
  help: "Status LRU cache operations.",
  labelNames: ["op"] as const,   // "hit" | "miss" | "invalidate"
  registers: [registry],
});

/** DNC side-effect fires. */
export const dncSideEffectTotal = new client.Counter({
  name: "vici2_d04_dnc_side_effect_total",
  help: "DNC addInternal calls triggered by disposition.",
  labelNames: ["outcome"] as const,  // "ok" | "error"
  registers: [registry],
});

/** Sale CRM webhook fires. */
export const crmWebhookTotal = new client.Counter({
  name: "vici2_d04_crm_webhook_total",
  help: "CRM webhook calls triggered by sale disposition.",
  labelNames: ["outcome"] as const,
  registers: [registry],
});

/** Terminal-status recycle writes (admin override). */
export const terminalRecycleWritesTotal = new client.Counter({
  name: "vici2_d04_terminal_recycle_writes_total",
  help: "Force-recycle admin writes on terminal statuses.",
  registers: [registry],
});

/** Illegal state transition attempts. */
export const illegalTransitionTotal = new client.Counter({
  name: "vici2_d04_illegal_transition_total",
  help: "Illegal lead status transition attempts blocked by service layer.",
  labelNames: ["from", "to"] as const,
  registers: [registry],
});

/** Disposition write latency histogram. */
export const dispositionWriteLatencyMs = new client.Histogram({
  name: "vici2_d04_disposition_write_latency_ms",
  help: "Latency of dispositionService.submit() in milliseconds.",
  buckets: [5, 10, 25, 50, 80, 120, 200, 500],
  registers: [registry],
});

export { registry as d04Registry };
