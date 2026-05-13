// D06 worker — Prometheus metrics (re-exported from service metrics or standalone).

import client from "prom-client";

export const workerRegistry = new client.Registry();

export const callbackFiredTotal = new client.Counter({
  name: "vici2_d06_callback_fired_total",
  help: "Total callbacks promoted to LIVE by the worker.",
  labelNames: ["scope", "tcpa_outcome"],
  registers: [workerRegistry],
});

export const callbackDeferredTotal = new client.Counter({
  name: "vici2_d06_callback_deferred_total",
  help: "Total callbacks re-snoozed by TCPA SKIP_UNTIL at fire time.",
  labelNames: ["reason"],
  registers: [workerRegistry],
});

export const callbackStaleTotal = new client.Counter({
  name: "vici2_d06_callback_stale_total",
  help: "Total stale callback detections.",
  labelNames: ["scope", "age_bucket"],
  registers: [workerRegistry],
});

export const workerTickDuration = new client.Histogram({
  name: "vici2_d06_worker_tick_duration_seconds",
  help: "Duration of each callback-fire worker tick.",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [workerRegistry],
});

export const workerTickPromoted = new client.Counter({
  name: "vici2_d06_worker_tick_promoted",
  help: "Per-tick callback outcomes.",
  labelNames: ["outcome"],
  registers: [workerRegistry],
});

export const workerTickSkippedTotal = new client.Counter({
  name: "vici2_d06_worker_tick_skipped_total",
  help: "Worker ticks skipped (lock contention or empty queue).",
  labelNames: ["reason"],
  registers: [workerRegistry],
});

export function getAgeBucket(ageSeconds: number): string {
  if (ageSeconds < 8 * 3600) return "4-8h";
  if (ageSeconds < 24 * 3600) return "8-24h";
  if (ageSeconds < 3 * 24 * 3600) return "1-3d";
  return "3d+";
}
