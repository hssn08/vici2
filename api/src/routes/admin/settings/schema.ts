// M05 — Admin tenant-settings schemas (Zod validators).
//
// M01 baseline: name, settings (brandLabel, reportTimezone,
//   recordingConsentDefault, allowCallTimeOverrides), internalDncRetentionYears.
//
// M05 extensions (additive):
//   - auth sub-object (maps to auth_config row, super_admin only)
//   - compliance fields: consentMinimumMode, defaultCallerState, unknownTzPolicyDefault
//   - pacing defaults: dialMethod, dropTargetMax (stored in settings JSON)
//   - general: supportEmail
//
// All PATCH fields remain optional to stay backward-compatible with M01 clients.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums (mirror Prisma enums; kept local to avoid circular deps)
// ---------------------------------------------------------------------------

export const ConsentModeEnum = z.enum([
  "PROMPT_MESSAGE",
  "REQUIRE_ACTIVE",
  "SKIP",
]);

export const DialMethodEnum = z.enum([
  "MANUAL",
  "RATIO",
  "PROGRESSIVE",
  "ADAPT_HARD",
  "ADAPT_AVG",
  "ADAPT_TAPERED",
]);

export const UnknownTzPolicyEnum = z.enum(["deny", "warn_pass"]);

// US 2-letter state code or null
const StateCode = z
  .string()
  .length(2)
  .regex(/^[A-Z]{2}$/, "Must be a 2-letter US state code (e.g. TX)")
  .nullable()
  .optional();

// ---------------------------------------------------------------------------
// Auth sub-object
// ---------------------------------------------------------------------------

export const AuthSettingsSchema = z
  .object({
    passwordMinLength: z.number().int().min(8).max(128).optional(),
    lockoutAfterFailures: z.number().int().min(3).max(20).optional(),
    lockoutWindowSeconds: z.number().int().min(60).max(86400).optional(),
    accessTokenTtlSeconds: z.number().int().min(60).max(3600).optional(),
    refreshTokenTtlSeconds: z.number().int().min(3600).max(7776000).optional(),
    totpGracePeriodDays: z.number().int().min(0).max(30).optional(),
  })
  .refine(
    (d) => {
      if (
        d.lockoutWindowSeconds !== undefined &&
        d.accessTokenTtlSeconds !== undefined
      ) {
        return d.lockoutWindowSeconds < d.accessTokenTtlSeconds;
      }
      return true;
    },
    {
      message: "lockoutWindowSeconds must be less than accessTokenTtlSeconds",
      path: ["lockoutWindowSeconds"],
    },
  )
  .refine(
    (d) => {
      if (
        d.accessTokenTtlSeconds !== undefined &&
        d.refreshTokenTtlSeconds !== undefined
      ) {
        return d.accessTokenTtlSeconds <= d.refreshTokenTtlSeconds;
      }
      return true;
    },
    {
      message: "accessTokenTtlSeconds must not exceed refreshTokenTtlSeconds",
      path: ["accessTokenTtlSeconds"],
    },
  );

export type AuthSettingsInput = z.infer<typeof AuthSettingsSchema>;

// ---------------------------------------------------------------------------
// Tenant settings JSON shape (stored in tenants.settings)
// ---------------------------------------------------------------------------

export const TenantSettingsJsonSchema = z
  .object({
    // M01 fields
    recordingConsentDefault: z.boolean().optional(),
    allowCallTimeOverrides: z.boolean().optional(),
    brandLabel: z.string().max(64).optional(),
    reportTimezone: z.string().max(64).optional(),
    // M05 general
    supportEmail: z.string().email().max(128).optional().nullable(),
    // M05 compliance
    unknownTzPolicyDefault: UnknownTzPolicyEnum.optional(),
    // M05 pacing defaults
    pacingDefaults: z
      .object({
        dialMethod: DialMethodEnum.optional(),
        dropTargetMax: z
          .number()
          .min(0)
          .max(3.0) // FCC TCPA ceiling
          .optional(),
      })
      .optional(),
  })
  .passthrough(); // preserve unknown keys set by other modules

export type TenantSettingsJson = z.infer<typeof TenantSettingsJsonSchema>;

// ---------------------------------------------------------------------------
// Full tenant-settings update (PATCH body)
// ---------------------------------------------------------------------------

export const TenantSettingsUpdateSchema = z
  .object({
    // M01 fields (kept at top-level for backward compat)
    name: z.string().min(1).max(128).optional(),
    settings: TenantSettingsJsonSchema.optional(),
    internalDncRetentionYears: z.number().int().min(5).max(99).optional(),
    // M05 additions
    auth: AuthSettingsSchema.optional(),
    consentMinimumMode: ConsentModeEnum.optional(),
    defaultCallerState: StateCode,
  })
  .strict();

export type TenantSettingsUpdateInput = z.infer<typeof TenantSettingsUpdateSchema>;

// ---------------------------------------------------------------------------
// Auth config response shape
// ---------------------------------------------------------------------------

export interface AuthConfigResponse {
  passwordMinLength: number;
  lockoutAfterFailures: number;
  lockoutWindowSeconds: number;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  totpGracePeriodDays: number;
}

// ---------------------------------------------------------------------------
// Response shape (superset of M01 TenantSettingsResponse)
// ---------------------------------------------------------------------------

export interface TenantSettingsResponse {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  settings: Record<string, unknown>;
  internalDncRetentionYears: number;
  updatedAt: string;
  // M05 additions
  consentMinimumMode: string;
  defaultCallerState: string | null;
  auth: AuthConfigResponse;
}
