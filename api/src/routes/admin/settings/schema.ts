// M01 — Admin tenant-settings schemas (Zod validators).
//
// Covers:
//   - Tenant display settings (name, slug)
//   - Auth policy (recording consent default, argon2 cost from auth_config)
//   - DNC retention (internal_dnc_retention_years)
//
// The `settings` JSON column on the Tenant model is an open Json type in
// Prisma; we validate its structure here at the API boundary.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Tenant settings JSON shape
// ---------------------------------------------------------------------------

export const TenantSettingsJsonSchema = z
  .object({
    // Recording consent default; if true new campaigns require explicit consent
    recordingConsentDefault: z.boolean().optional(),
    // Allow admins to override call time windows per campaign
    allowCallTimeOverrides: z.boolean().optional(),
    // Brand label shown in the admin UI header
    brandLabel: z.string().max(64).optional(),
    // Timezone for scheduled reports (IANA tz string)
    reportTimezone: z.string().max(64).optional(),
  })
  .passthrough(); // preserve unknown keys set by other modules

// ---------------------------------------------------------------------------
// Full tenant-settings update
// ---------------------------------------------------------------------------

export const TenantSettingsUpdateSchema = z
  .object({
    name: z.string().min(1).max(128).optional(),
    settings: TenantSettingsJsonSchema.optional(),
    internalDncRetentionYears: z.number().int().min(5).max(99).optional(),
  })
  .strict();

export type TenantSettingsUpdateInput = z.infer<typeof TenantSettingsUpdateSchema>;

// ---------------------------------------------------------------------------
// Response shape
// ---------------------------------------------------------------------------

export interface TenantSettingsResponse {
  id: string;
  name: string;
  slug: string;
  active: boolean;
  settings: Record<string, unknown>;
  internalDncRetentionYears: number;
  updatedAt: string;
}
