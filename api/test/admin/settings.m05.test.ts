// M05 — Extended settings schema unit tests.
//
// Tests the M05-added fields: AuthSettingsSchema cross-field refinements,
// ConsentModeEnum, UnknownTzPolicyEnum, pacingDefaults, supportEmail,
// and defaultCallerState validation.

import { describe, it, expect } from "vitest";
import {
  AuthSettingsSchema,
  TenantSettingsUpdateSchema,
  TenantSettingsJsonSchema,
  ConsentModeEnum,
  UnknownTzPolicyEnum,
  DialMethodEnum,
} from "../../src/routes/admin/settings/schema.js";

// ---------------------------------------------------------------------------
// AuthSettingsSchema
// ---------------------------------------------------------------------------

describe("AuthSettingsSchema", () => {
  it("accepts empty object (no-op)", () => {
    expect(AuthSettingsSchema.safeParse({}).success).toBe(true);
  });

  it("accepts a full valid auth config", () => {
    const r = AuthSettingsSchema.safeParse({
      passwordMinLength: 14,
      lockoutAfterFailures: 5,
      lockoutWindowSeconds: 600,
      accessTokenTtlSeconds: 900,
      refreshTokenTtlSeconds: 604800,
      totpGracePeriodDays: 7,
    });
    expect(r.success).toBe(true);
  });

  it("rejects passwordMinLength below 8", () => {
    expect(AuthSettingsSchema.safeParse({ passwordMinLength: 7 }).success).toBe(false);
  });

  it("rejects passwordMinLength above 128", () => {
    expect(AuthSettingsSchema.safeParse({ passwordMinLength: 129 }).success).toBe(false);
  });

  it("rejects lockoutAfterFailures below 3", () => {
    expect(AuthSettingsSchema.safeParse({ lockoutAfterFailures: 2 }).success).toBe(false);
  });

  it("rejects lockoutAfterFailures above 20", () => {
    expect(AuthSettingsSchema.safeParse({ lockoutAfterFailures: 21 }).success).toBe(false);
  });

  it("rejects lockoutWindowSeconds below 60", () => {
    expect(AuthSettingsSchema.safeParse({ lockoutWindowSeconds: 59 }).success).toBe(false);
  });

  it("rejects accessTokenTtlSeconds below 60", () => {
    expect(AuthSettingsSchema.safeParse({ accessTokenTtlSeconds: 59 }).success).toBe(false);
  });

  it("rejects accessTokenTtlSeconds above 3600", () => {
    expect(AuthSettingsSchema.safeParse({ accessTokenTtlSeconds: 3601 }).success).toBe(false);
  });

  it("rejects refreshTokenTtlSeconds below 3600", () => {
    expect(
      AuthSettingsSchema.safeParse({ refreshTokenTtlSeconds: 3599 }).success,
    ).toBe(false);
  });

  it("rejects refreshTokenTtlSeconds above 7776000", () => {
    expect(
      AuthSettingsSchema.safeParse({ refreshTokenTtlSeconds: 7776001 }).success,
    ).toBe(false);
  });

  it("rejects totpGracePeriodDays below 0", () => {
    expect(AuthSettingsSchema.safeParse({ totpGracePeriodDays: -1 }).success).toBe(false);
  });

  it("rejects totpGracePeriodDays above 30", () => {
    expect(AuthSettingsSchema.safeParse({ totpGracePeriodDays: 31 }).success).toBe(false);
  });

  // Cross-field: lockoutWindowSeconds < accessTokenTtlSeconds
  it("rejects lockoutWindowSeconds >= accessTokenTtlSeconds", () => {
    const r = AuthSettingsSchema.safeParse({
      lockoutWindowSeconds: 900,
      accessTokenTtlSeconds: 900,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.errors.some((e) => e.path.includes("lockoutWindowSeconds")),
      ).toBe(true);
    }
  });

  it("accepts lockoutWindowSeconds < accessTokenTtlSeconds", () => {
    const r = AuthSettingsSchema.safeParse({
      lockoutWindowSeconds: 600,
      accessTokenTtlSeconds: 900,
    });
    expect(r.success).toBe(true);
  });

  // Cross-field: accessTokenTtlSeconds <= refreshTokenTtlSeconds
  it("rejects accessTokenTtlSeconds > refreshTokenTtlSeconds", () => {
    const r = AuthSettingsSchema.safeParse({
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 3599,
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(
        r.error.errors.some((e) => e.path.includes("accessTokenTtlSeconds")),
      ).toBe(true);
    }
  });

  it("accepts accessTokenTtlSeconds === refreshTokenTtlSeconds (edge case)", () => {
    const r = AuthSettingsSchema.safeParse({
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 3600,
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ConsentModeEnum
// ---------------------------------------------------------------------------

describe("ConsentModeEnum", () => {
  it("accepts PROMPT_MESSAGE", () => {
    expect(ConsentModeEnum.safeParse("PROMPT_MESSAGE").success).toBe(true);
  });
  it("accepts REQUIRE_ACTIVE", () => {
    expect(ConsentModeEnum.safeParse("REQUIRE_ACTIVE").success).toBe(true);
  });
  it("accepts SKIP", () => {
    expect(ConsentModeEnum.safeParse("SKIP").success).toBe(true);
  });
  it("rejects unknown value", () => {
    expect(ConsentModeEnum.safeParse("UNKNOWN").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UnknownTzPolicyEnum
// ---------------------------------------------------------------------------

describe("UnknownTzPolicyEnum", () => {
  it("accepts deny", () => {
    expect(UnknownTzPolicyEnum.safeParse("deny").success).toBe(true);
  });
  it("accepts warn_pass", () => {
    expect(UnknownTzPolicyEnum.safeParse("warn_pass").success).toBe(true);
  });
  it("rejects unknown value", () => {
    expect(UnknownTzPolicyEnum.safeParse("pass").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DialMethodEnum
// ---------------------------------------------------------------------------

describe("DialMethodEnum", () => {
  it("accepts all valid dial methods", () => {
    for (const m of ["MANUAL", "RATIO", "PROGRESSIVE", "ADAPT_HARD", "ADAPT_AVG", "ADAPT_TAPERED"]) {
      expect(DialMethodEnum.safeParse(m).success).toBe(true);
    }
  });
  it("rejects invalid dial method", () => {
    expect(DialMethodEnum.safeParse("HYBRID").success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TenantSettingsJsonSchema — M05 fields
// ---------------------------------------------------------------------------

describe("TenantSettingsJsonSchema — M05 extensions", () => {
  it("accepts supportEmail as a valid email", () => {
    expect(
      TenantSettingsJsonSchema.safeParse({ supportEmail: "help@example.com" }).success,
    ).toBe(true);
  });

  it("rejects supportEmail as an invalid email", () => {
    expect(
      TenantSettingsJsonSchema.safeParse({ supportEmail: "not-an-email" }).success,
    ).toBe(false);
  });

  it("accepts supportEmail as null", () => {
    expect(
      TenantSettingsJsonSchema.safeParse({ supportEmail: null }).success,
    ).toBe(true);
  });

  it("accepts unknownTzPolicyDefault: deny", () => {
    expect(
      TenantSettingsJsonSchema.safeParse({ unknownTzPolicyDefault: "deny" }).success,
    ).toBe(true);
  });

  it("rejects unknownTzPolicyDefault: invalid", () => {
    expect(
      TenantSettingsJsonSchema.safeParse({ unknownTzPolicyDefault: "skip" }).success,
    ).toBe(false);
  });

  it("accepts pacingDefaults with valid dialMethod and dropTargetMax", () => {
    const r = TenantSettingsJsonSchema.safeParse({
      pacingDefaults: { dialMethod: "PROGRESSIVE", dropTargetMax: 1.5 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects pacingDefaults.dropTargetMax above 3.0 (FCC ceiling)", () => {
    const r = TenantSettingsJsonSchema.safeParse({
      pacingDefaults: { dropTargetMax: 3.01 },
    });
    expect(r.success).toBe(false);
  });

  it("accepts pacingDefaults.dropTargetMax at exactly 3.0 (FCC ceiling)", () => {
    const r = TenantSettingsJsonSchema.safeParse({
      pacingDefaults: { dropTargetMax: 3.0 },
    });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TenantSettingsUpdateSchema — M05 additions
// ---------------------------------------------------------------------------

describe("TenantSettingsUpdateSchema — M05 additions", () => {
  it("accepts consentMinimumMode", () => {
    const r = TenantSettingsUpdateSchema.safeParse({
      consentMinimumMode: "REQUIRE_ACTIVE",
    });
    expect(r.success).toBe(true);
  });

  it("rejects invalid consentMinimumMode", () => {
    const r = TenantSettingsUpdateSchema.safeParse({
      consentMinimumMode: "OPTIONAL",
    });
    expect(r.success).toBe(false);
  });

  it("accepts valid 2-letter US state defaultCallerState", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ defaultCallerState: "TX" });
    expect(r.success).toBe(true);
  });

  it("rejects lowercase state code", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ defaultCallerState: "tx" });
    expect(r.success).toBe(false);
  });

  it("rejects 3-letter state code", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ defaultCallerState: "TEX" });
    expect(r.success).toBe(false);
  });

  it("accepts null defaultCallerState (clear)", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ defaultCallerState: null });
    expect(r.success).toBe(true);
  });

  it("accepts auth sub-object with valid fields", () => {
    const r = TenantSettingsUpdateSchema.safeParse({
      auth: { passwordMinLength: 16, lockoutAfterFailures: 5 },
    });
    expect(r.success).toBe(true);
  });

  it("rejects unknown top-level fields (strict)", () => {
    const r = TenantSettingsUpdateSchema.safeParse({ bogus: true });
    expect(r.success).toBe(false);
  });

  it("accepts M01 fields alongside M05 fields (backward compat)", () => {
    const r = TenantSettingsUpdateSchema.safeParse({
      name: "Acme Corp",
      internalDncRetentionYears: 7,
      consentMinimumMode: "PROMPT_MESSAGE",
      settings: { brandLabel: "Acme" },
    });
    expect(r.success).toBe(true);
  });
});
