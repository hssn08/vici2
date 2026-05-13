// D06 — Prometheus metrics (12 required per PLAN §14).

import client from "prom-client";

export const d06Registry = new client.Registry();

export const callbackScheduledTotal = new client.Counter({
  name: "vici2_d06_callback_scheduled_total",
  help: "Total callbacks scheduled.",
  labelNames: ["scope"],
  registers: [d06Registry],
});

export const callbackFiredTotal = new client.Counter({
  name: "vici2_d06_callback_fired_total",
  help: "Total callbacks promoted to LIVE by the worker.",
  labelNames: ["scope", "tcpa_outcome"],
  registers: [d06Registry],
});

export const callbackDeferredTotal = new client.Counter({
  name: "vici2_d06_callback_deferred_total",
  help: "Total callbacks re-snoozed by TCPA SKIP_UNTIL at fire time.",
  labelNames: ["reason"],
  registers: [d06Registry],
});

export const callbackCancelledTotal = new client.Counter({
  name: "vici2_d06_callback_cancelled_total",
  help: "Total callbacks cancelled.",
  labelNames: ["actor"],
  registers: [d06Registry],
});

export const callbackSnoozedTotal = new client.Counter({
  name: "vici2_d06_callback_snoozed_total",
  help: "Total callbacks snoozed (rescheduled by agent).",
  registers: [d06Registry],
});

export const callbackCompletedTotal = new client.Counter({
  name: "vici2_d06_callback_completed_total",
  help: "Total callbacks completed (LIVE→DONE).",
  labelNames: ["disposition"],
  registers: [d06Registry],
});

export const callbackStaleTotal = new client.Counter({
  name: "vici2_d06_callback_stale_total",
  help: "Total stale callback detections.",
  labelNames: ["scope", "age_bucket"],
  registers: [d06Registry],
});

export const workerTickDuration = new client.Histogram({
  name: "vici2_d06_worker_tick_duration_seconds",
  help: "Duration of each callback-fire worker tick.",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [d06Registry],
});

export const workerTickPromoted = new client.Counter({
  name: "vici2_d06_worker_tick_promoted",
  help: "Per-tick callback outcomes.",
  labelNames: ["outcome"],
  registers: [d06Registry],
});

export const workerTickSkippedTotal = new client.Counter({
  name: "vici2_d06_worker_tick_skipped_total",
  help: "Worker ticks skipped (lock contention or empty queue).",
  labelNames: ["reason"],
  registers: [d06Registry],
});

export const bulkReassignTotal = new client.Counter({
  name: "vici2_d06_bulk_reassign_total",
  help: "Bulk-reassign operations.",
  labelNames: ["outcome"],
  registers: [d06Registry],
});

export const claimRaceTotal = new client.Counter({
  name: "vici2_d06_claim_race_total",
  help: "Self-claim CAS race outcomes.",
  labelNames: ["outcome"],
  registers: [d06Registry],
});
