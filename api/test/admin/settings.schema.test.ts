// M01 — Admin settings schema unit tests.

import { describe, it, expect } from "vitest";
import {
  TenantSettingsUpdateSchema,
  TenantSettingsJsonSchema,
} from "../../src/routes/admin/settings/schema.js";

// ---------------------------------------------------------------------------
// TenantSettingsJsonSchema
// ---------------------------------------------------------------------------

describe("TenantSettingsJsonSchema", () => {
  it("accepts an empty object", () => {
    expect(TenantSettingsJsonSchema.safeParse({}).success).toBe(true);
  });

  it("accepts known fields", () => {
    const r = TenantSettingsJsonSchema.safeParse({
      recordingConsentDefault: true,
      allowCallTimeOverrides: false,
      brandLabel: "Acme Corp",
      reportTimezone: "America/New_York",
    });
    expect(r.success).toBe(true);
  });

  it("passes through unknown keys (open schema)", () => {
    const r = TenantSettingsJsonSchema.safeParse({ unknownFutureKey: 42 });
    expect(r.success).toBe(true);
    if (r.success) {
      expect((r.data as Record<string, unknown>).unknownFutureKey).toBe(42);
    }
  });

  it("rejects brandLabel over 64 chars", () => {
    const r = TenantSettingsJsonSchema.safeParse({ brandLabel: "a".repeat(65) });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TenantSettingsUpdateSchema
// ---------------------------------------------------------------------------

describe("TenantSettingsUpdateSchema", () => {
  it("accepts empty object (no-op)", () => {
    expect(TenantSettingsUpdateSchema.safeParse({}).success).toBe(true);
  });

  it("accepts partial update with name", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ name: "ACME" });
    expect(r.success).toBe(true);
  });

  it("accepts internalDncRetentionYears within range", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ internalDncRetentionYears: 10 });
    expect(r.success).toBe(true);
  });

  it("rejects internalDncRetentionYears below 5 (FCC minimum)", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ internalDncRetentionYears: 4 });
    expect(r.success).toBe(false);
  });

  it("rejects internalDncRetentionYears above 99", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ internalDncRetentionYears: 100 });
    expect(r.success).toBe(false);
  });

  it("rejects name over 128 chars", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ name: "x".repeat(129) });
    expect(r.success).toBe(false);
  });

  it("rejects name as empty string", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ name: "" });
    expect(r.success).toBe(false);
  });

  it("rejects unknown fields (strict)", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ bogusField: true });
    expect(r.success).toBe(false);
  });
});
