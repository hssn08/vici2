// M04 — Audit log viewer: Prometheus counters.
//
// Exposes counters only (no histograms for Phase 1). Lazy-initialised so
// tests that import this module without prom-client don't crash.

let _client: typeof import("prom-client") | null = null;

async function client(): Promise<typeof import("prom-client")> {
  if (!_client) {
    _client = await import("prom-client");
  }
  return _client;
}

type Labels = Record<string, string | number>;

let auditViewerRequests: import("prom-client").Counter<string> | null = null;
let auditVerifyTotal: import("prom-client").Counter<string> | null = null;
let auditExportBytes: import("prom-client").Counter<string> | null = null;

export async function getAuditViewerRequestsCounter(): Promise<import("prom-client").Counter<string>> {
  const prom = await client();
  if (!auditViewerRequests) {
    auditViewerRequests = new prom.Counter({
      name: "audit_viewer_requests_total",
      help: "Total M04 audit viewer API requests",
      labelNames: ["endpoint", "status"],
    });
  }
  return auditViewerRequests;
}

export async function getAuditVerifyTotalCounter(): Promise<import("prom-client").Counter<string>> {
  const prom = await client();
  if (!auditVerifyTotal) {
    auditVerifyTotal = new prom.Counter({
      name: "audit_viewer_verify_total",
      help: "Total M04 chain verification calls",
      labelNames: ["table", "result"],
    });
  }
  return auditVerifyTotal;
}

export async function getAuditExportBytesCounter(): Promise<import("prom-client").Counter<string>> {
  const prom = await client();
  if (!auditExportBytes) {
    auditExportBytes = new prom.Counter({
      name: "audit_viewer_export_bytes_total",
      help: "Total bytes exported from audit log viewer",
      labelNames: ["format"],
    });
  }
  return auditExportBytes;
}

export async function incRequest(labels: Labels): Promise<void> {
  try {
    const c = await getAuditViewerRequestsCounter();
    c.inc(labels);
  } catch {
    // metrics are best-effort; never crash on prom errors
  }
}

export async function incVerify(labels: Labels): Promise<void> {
  try {
    const c = await getAuditVerifyTotalCounter();
    c.inc(labels);
  } catch {
    // best-effort
  }
}

export async function incExportBytes(format: string, bytes: number): Promise<void> {
  try {
    const c = await getAuditExportBytesCounter();
    c.inc({ format }, bytes);
  } catch {
    // best-effort
  }
}
