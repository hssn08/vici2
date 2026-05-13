// M08 — Prometheus metrics for the reporting subsystem.

import client from "prom-client";

const registry = new client.Registry();

/** Total report requests by endpoint. */
export const reportRequestsTotal = new client.Counter({
  name: "vici2_m08_report_requests_total",
  help: "Total compliance report requests by endpoint.",
  labelNames: ["endpoint"] as const,
  registers: [registry],
});

/** Total bytes written for CSV exports. */
export const exportBytesTotal = new client.Counter({
  name: "vici2_m08_export_bytes_total",
  help: "Total bytes written for CSV export responses.",
  registers: [registry],
});

/** Evidence pack requests. */
export const evidencePackRequestsTotal = new client.Counter({
  name: "vici2_m08_evidence_pack_requests_total",
  help: "Total TCPA evidence pack assembly requests.",
  labelNames: ["outcome"] as const, // "ok" | "not_found"
  registers: [registry],
});

/** Missing call_uuid lookups (evidence pack call_uuid not found). */
export const missingCallUuidTotal = new client.Counter({
  name: "vici2_m08_missing_call_uuid_total",
  help: "Evidence pack requests for call_uuid not found in originate_audit.",
  registers: [registry],
});

export { registry as m08Registry };
