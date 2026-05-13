// M06 — DID schema unit tests.

import { describe, it, expect } from "vitest";
import {
  DidCreateSchema,
  DidUpdateSchema,
  DidListQuerySchema,
  DidBulkRowSchema,
} from "../../src/routes/admin/dids/schema.js";

// ---------------------------------------------------------------------------
// DidCreateSchema
// ---------------------------------------------------------------------------

describe("DidCreateSchema", () => {
  const base = {
    e164: "+12065551234",
    carrierId: "1",
    routeKind: "ingroup",
    routeTarget: "SALES",
  };

  it("accepts a valid minimal DID", () => {
    const r = DidCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("accepts all optional fields", () => {
    const r = DidCreateSchema.safeParse({
      ...base,
      callerIdName: "Sales Line",
      active: false,
      defaultLang: "es",
      ivrTimeoutSec: 600,
    });
    expect(r.success).toBe(true);
  });

  it("accepts ivr route kind", () => {
    const r = DidCreateSchema.safeParse({ ...base, routeKind: "ivr", routeTarget: "main_menu" });
    expect(r.success).toBe(true);
  });

  it("rejects invalid E.164 (no plus)", () => {
    const r = DidCreateSchema.safeParse({ ...base, e164: "12065551234" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid E.164 (too short)", () => {
    const r = DidCreateSchema.safeParse({ ...base, e164: "+1206" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid route kind", () => {
    const r = DidCreateSchema.safeParse({ ...base, routeKind: "queue" });
    expect(r.success).toBe(false);
  });

  it("rejects ivrTimeoutSec below 30", () => {
    const r = DidCreateSchema.safeParse({ ...base, ivrTimeoutSec: 20 });
    expect(r.success).toBe(false);
  });

  it("rejects ivrTimeoutSec above 7200", () => {
    const r = DidCreateSchema.safeParse({ ...base, ivrTimeoutSec: 10000 });
    expect(r.success).toBe(false);
  });

  it("defaults active to true", () => {
    const r = DidCreateSchema.safeParse(base);
    if (r.success) expect(r.data.active).toBe(true);
  });

  it("defaults defaultLang to en", () => {
    const r = DidCreateSchema.safeParse(base);
    if (r.success) expect(r.data.defaultLang).toBe("en");
  });

  it("defaults ivrTimeoutSec to 300", () => {
    const r = DidCreateSchema.safeParse(base);
    if (r.success) expect(r.data.ivrTimeoutSec).toBe(300);
  });

  it("rejects invalid defaultLang format", () => {
    const r = DidCreateSchema.safeParse({ ...base, defaultLang: "english" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DidUpdateSchema
// ---------------------------------------------------------------------------

describe("DidUpdateSchema", () => {
  it("accepts empty patch (all optional)", () => {
    const r = DidUpdateSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts partial update", () => {
    const r = DidUpdateSchema.safeParse({ active: false, routeTarget: "SUPPORT" });
    expect(r.success).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    const r = DidUpdateSchema.safeParse({ unknownProp: "x" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DidListQuerySchema
// ---------------------------------------------------------------------------

describe("DidListQuerySchema", () => {
  it("accepts defaults", () => {
    const r = DidListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.pageSize).toBe(50);
      expect(r.data.active).toBe("all");
    }
  });

  it("accepts carrierId filter", () => {
    const r = DidListQuerySchema.safeParse({ carrierId: "5" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.carrierId).toBe(5n);
  });

  it("accepts routeKind filter", () => {
    const r = DidListQuerySchema.safeParse({ routeKind: "ivr" });
    expect(r.success).toBe(true);
  });

  it("rejects invalid routeKind", () => {
    const r = DidListQuerySchema.safeParse({ routeKind: "bogus" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DidBulkRowSchema
// ---------------------------------------------------------------------------

describe("DidBulkRowSchema", () => {
  const base = {
    e164: "+12065551234",
    carrier_id: "1",
    route_kind: "ingroup",
    route_target: "SALES",
  };

  it("accepts a valid bulk row", () => {
    const r = DidBulkRowSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("defaults active to true when omitted", () => {
    const r = DidBulkRowSchema.safeParse(base);
    if (r.success) expect(r.data.active).toBe(true);
  });

  it("parses active=false string correctly", () => {
    const r = DidBulkRowSchema.safeParse({ ...base, active: "false" });
    if (r.success) expect(r.data.active).toBe(false);
  });

  it("parses active=true string correctly", () => {
    const r = DidBulkRowSchema.safeParse({ ...base, active: "true" });
    if (r.success) expect(r.data.active).toBe(true);
  });

  it("rejects invalid E.164", () => {
    const r = DidBulkRowSchema.safeParse({ ...base, e164: "bad" });
    expect(r.success).toBe(false);
  });

  it("coerces carrier_id to bigint", () => {
    const r = DidBulkRowSchema.safeParse(base);
    if (r.success) expect(typeof r.data.carrier_id).toBe("bigint");
  });
});
