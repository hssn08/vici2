// M03 — Prometheus metrics for the ops reporting subsystem.

import client from "prom-client";

const registry = new client.Registry();

/** Total ops report requests by endpoint. */
export const opsReportRequestsTotal = new client.Counter({
  name: "vici2_m03_report_requests_total",
  help: "Total ops report requests by endpoint.",
  labelNames: ["endpoint"] as const,
  registers: [registry],
});

/** Cache hits for ops reports. */
export const opsReportCacheHits = new client.Counter({
  name: "vici2_m03_report_cache_hits_total",
  help: "Ops report Valkey cache hits.",
  labelNames: ["report"] as const,
  registers: [registry],
});

/** Cache misses for ops reports. */
export const opsReportCacheMisses = new client.Counter({
  name: "vici2_m03_report_cache_misses_total",
  help: "Ops report Valkey cache misses (DB query triggered).",
  labelNames: ["report"] as const,
  registers: [registry],
});

/** Total bytes written for CSV exports. */
export const opsExportBytesTotal = new client.Counter({
  name: "vici2_m03_export_bytes_total",
  help: "Total bytes written for CSV export responses.",
  registers: [registry],
});

export { registry as m03Registry };
