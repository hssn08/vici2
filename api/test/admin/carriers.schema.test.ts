// M06 — Carrier + Gateway schema unit tests.

import { describe, it, expect } from "vitest";
import {
  CarrierCreateSchema,
  CarrierUpdateSchema,
  CarrierListQuerySchema,
  GatewayCreateSchema,
  GatewayUpdateSchema,
} from "../../src/routes/admin/carriers/schema.js";

// ---------------------------------------------------------------------------
// CarrierCreateSchema
// ---------------------------------------------------------------------------

describe("CarrierCreateSchema", () => {
  const base = {
    name: "Twilio Production",
    kind: "twilio",
    proxy: "acme.pstn.twilio.com",
  };

  it("accepts a valid minimal carrier", () => {
    const r = CarrierCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("accepts all optional fields", () => {
    const r = CarrierCreateSchema.safeParse({
      ...base,
      username: "sip-user",
      password: "s3cr3t",
      register: true,
      callerIdE164: "+12065551234",
      active: false,
      ipAllowlist: ["54.172.60.0/30"],
      sendPai: true,
      isEmergency: true,
      maxConcurrent: 500,
      notes: { note: "test" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts telnyx-creds kind", () => {
    const r = CarrierCreateSchema.safeParse({ ...base, kind: "telnyx-creds" });
    expect(r.success).toBe(true);
  });

  it("accepts telnyx-ip kind", () => {
    const r = CarrierCreateSchema.safeParse({ ...base, kind: "telnyx-ip" });
    expect(r.success).toBe(true);
  });

  it("rejects unknown kind", () => {
    const r = CarrierCreateSchema.safeParse({ ...base, kind: "vonage" });
    expect(r.success).toBe(false);
  });

  it("rejects empty name", () => {
    const r = CarrierCreateSchema.safeParse({ ...base, name: "" });
    expect(r.success).toBe(false);
  });

  it("rejects name longer than 64 chars", () => {
    const r = CarrierCreateSchema.safeParse({ ...base, name: "x".repeat(65) });
    expect(r.success).toBe(false);
  });

  it("rejects invalid E.164 caller ID", () => {
    const r = CarrierCreateSchema.safeParse({ ...base, callerIdE164: "12065551234" });
    expect(r.success).toBe(false);
  });

  it("accepts valid E.164 caller ID", () => {
    const r = CarrierCreateSchema.safeParse({ ...base, callerIdE164: "+12065551234" });
    expect(r.success).toBe(true);
  });

  it("rejects negative maxConcurrent", () => {
    const r = CarrierCreateSchema.safeParse({ ...base, maxConcurrent: -1 });
    expect(r.success).toBe(false);
  });

  it("defaults active to true", () => {
    const r = CarrierCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.active).toBe(true);
  });

  it("defaults register to false", () => {
    const r = CarrierCreateSchema.safeParse(base);
    if (r.success) expect(r.data.register).toBe(false);
  });

  it("defaults ipAllowlist to empty array", () => {
    const r = CarrierCreateSchema.safeParse(base);
    if (r.success) expect(r.data.ipAllowlist).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CarrierUpdateSchema
// ---------------------------------------------------------------------------

describe("CarrierUpdateSchema", () => {
  it("accepts empty patch (all optional)", () => {
    const r = CarrierUpdateSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts partial update", () => {
    const r = CarrierUpdateSchema.safeParse({ active: false, maxConcurrent: 100 });
    expect(r.success).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    const r = CarrierUpdateSchema.safeParse({ unknownField: "oops" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CarrierListQuerySchema
// ---------------------------------------------------------------------------

describe("CarrierListQuerySchema", () => {
  it("accepts defaults", () => {
    const r = CarrierListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.pageSize).toBe(50);
      expect(r.data.active).toBe("all");
    }
  });

  it("accepts valid kind filter", () => {
    const r = CarrierListQuerySchema.safeParse({ kind: "bandwidth" });
    expect(r.success).toBe(true);
  });

  it("rejects invalid page (< 1)", () => {
    const r = CarrierListQuerySchema.safeParse({ page: "0" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid active value", () => {
    const r = CarrierListQuerySchema.safeParse({ active: "maybe" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GatewayCreateSchema
// ---------------------------------------------------------------------------

describe("GatewayCreateSchema", () => {
  const base = {
    name: "gw-twilio-us-east",
    proxy: "acme.pstn.twilio.com",
  };

  it("accepts valid minimal gateway", () => {
    const r = GatewayCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("accepts full gateway definition", () => {
    const r = GatewayCreateSchema.safeParse({
      ...base,
      realm: "sip.example.com",
      fromUser: "acme",
      fromDomain: "example.com",
      extension: "1001",
      register: true,
      expireSeconds: 1800,
      retrySeconds: 60,
      transport: "tls",
      priority: 10,
      weight: 200,
      active: false,
      templateOverrides: { ping: 25 },
      maxConcurrent: 100,
      costPerMinCents: 25,
    });
    expect(r.success).toBe(true);
  });

  it("rejects name with spaces", () => {
    const r = GatewayCreateSchema.safeParse({ ...base, name: "my gateway" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid transport", () => {
    const r = GatewayCreateSchema.safeParse({ ...base, transport: "sctp" });
    expect(r.success).toBe(false);
  });

  it("rejects expireSeconds below 60", () => {
    const r = GatewayCreateSchema.safeParse({ ...base, expireSeconds: 30 });
    expect(r.success).toBe(false);
  });

  it("defaults transport to udp", () => {
    const r = GatewayCreateSchema.safeParse(base);
    if (r.success) expect(r.data.transport).toBe("udp");
  });

  it("defaults priority to 100", () => {
    const r = GatewayCreateSchema.safeParse(base);
    if (r.success) expect(r.data.priority).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// GatewayUpdateSchema
// ---------------------------------------------------------------------------

describe("GatewayUpdateSchema", () => {
  it("accepts empty patch", () => {
    const r = GatewayUpdateSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts partial update", () => {
    const r = GatewayUpdateSchema.safeParse({ active: false, weight: 50 });
    expect(r.success).toBe(true);
  });
});
