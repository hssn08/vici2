// M04 — Audit log viewer: schema unit tests.

import { describe, it, expect } from "vitest";
import {
  AuditLogListQuerySchema,
  AuditLogExportQuerySchema,
  AttestationListQuerySchema,
} from "../../../src/routes/admin/audit/schema.js";

// ---------------------------------------------------------------------------
// AuditLogListQuerySchema
// ---------------------------------------------------------------------------

describe("AuditLogListQuerySchema", () => {
  it("applies defaults for empty input", () => {
    const r = AuditLogListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(50);
      expect(r.data.cursor).toBeUndefined();
      expect(r.data.action).toBeUndefined();
    }
  });

  it("accepts all optional fields", () => {
    const r = AuditLogListQuerySchema.safeParse({
      action: "lead.status.updated",
      actor: "42",
      actorKind: "user",
      entity_type: "lead",
      entity_id: "99",
      from: "2026-01-01",
      to: "2026-01-31",
      cursor: "NDI=",
      limit: "100",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.action).toBe("lead.status.updated");
      expect(r.data.actor).toBe("42");
      expect(r.data.actorKind).toBe("user");
      expect(r.data.entity_type).toBe("lead");
      expect(r.data.entity_id).toBe("99");
      expect(r.data.from).toBe("2026-01-01");
      expect(r.data.to).toBe("2026-01-31");
      expect(r.data.cursor).toBe("NDI=");
      expect(r.data.limit).toBe(100);
    }
  });

  it("rejects limit > 200", () => {
    const r = AuditLogListQuerySchema.safeParse({ limit: "201" });
    expect(r.success).toBe(false);
  });

  it("rejects limit < 1", () => {
    const r = AuditLogListQuerySchema.safeParse({ limit: "0" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid actorKind", () => {
    const r = AuditLogListQuerySchema.safeParse({ actorKind: "robot" });
    expect(r.success).toBe(false);
  });

  it("accepts all valid actorKind values", () => {
    for (const kind of ["user", "system", "worker", "external_api"] as const) {
      const r = AuditLogListQuerySchema.safeParse({ actorKind: kind });
      expect(r.success).toBe(true);
    }
  });

  it("rejects actor with non-numeric value", () => {
    const r = AuditLogListQuerySchema.safeParse({ actor: "john" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid date format for from", () => {
    const r = AuditLogListQuerySchema.safeParse({ from: "01/01/2026" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid date format for to", () => {
    const r = AuditLogListQuerySchema.safeParse({ to: "2026-1-1" });
    expect(r.success).toBe(false);
  });

  it("coerces string limit to number", () => {
    const r = AuditLogListQuerySchema.safeParse({ limit: "25" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(25);
      expect(typeof r.data.limit).toBe("number");
    }
  });

  it("defaults limit to 50 when not provided", () => {
    const r = AuditLogListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.limit).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// AuditLogExportQuerySchema
// ---------------------------------------------------------------------------

describe("AuditLogExportQuerySchema", () => {
  it("defaults format to csv", () => {
    const r = AuditLogExportQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.format).toBe("csv");
  });

  it("accepts format=json", () => {
    const r = AuditLogExportQuerySchema.safeParse({ format: "json" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.format).toBe("json");
  });

  it("rejects invalid format", () => {
    const r = AuditLogExportQuerySchema.safeParse({ format: "xml" });
    expect(r.success).toBe(false);
  });

  it("accepts all filter fields", () => {
    const r = AuditLogExportQuerySchema.safeParse({
      action: "lead.created",
      actor: "1",
      actorKind: "system",
      entity_type: "lead",
      from: "2026-01-01",
      to: "2026-12-31",
      format: "csv",
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AttestationListQuerySchema
// ---------------------------------------------------------------------------

describe("AttestationListQuerySchema", () => {
  it("applies defaults for empty input", () => {
    const r = AttestationListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.limit).toBe(50);
      expect(r.data.cursor).toBeUndefined();
      expect(r.data.table).toBeUndefined();
    }
  });

  it("accepts table, from, to, cursor, limit", () => {
    const r = AttestationListQuerySchema.safeParse({
      table: "audit_log",
      from: "2026-01-01",
      to: "2026-01-31",
      cursor: "MTI=",
      limit: "10",
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.table).toBe("audit_log");
      expect(r.data.limit).toBe(10);
    }
  });

  it("rejects limit > 200", () => {
    const r = AttestationListQuerySchema.safeParse({ limit: "999" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid date format", () => {
    const r = AttestationListQuerySchema.safeParse({ from: "Jan 1 2026" });
    expect(r.success).toBe(false);
  });
});
