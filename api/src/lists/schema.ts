// D07 — List management Zod schemas.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Settings JSON schema (stored in lists.settings)
// ---------------------------------------------------------------------------

export const ListSettingsSchema = z.object({
  max_attempts: z.number().int().min(1).max(99).default(5),
  recycle_delay_default: z.number().int().min(0).max(86400).default(600),
  override_tz: z.string().max(64).nullable().default(null),
  callable_status_codes: z.array(z.string().max(24)).default(["NEW", "NA", "B", "CALLBK"]),
});

export type ListSettings = z.infer<typeof ListSettingsSchema>;

export const DEFAULT_LIST_SETTINGS: ListSettings = {
  max_attempts: 5,
  recycle_delay_default: 600,
  override_tz: null,
  callable_status_codes: ["NEW", "NA", "B", "CALLBK"],
};

// ---------------------------------------------------------------------------
// List create body
// ---------------------------------------------------------------------------

export const ListCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(4096).optional(),
  active: z.boolean().default(true),
  owner_user_id: z.coerce.bigint().positive().optional(),
  caller_id_override: z.string().max(16).optional(),
  caller_id_name: z.string().max(32).optional(),
  settings: ListSettingsSchema.optional().default(DEFAULT_LIST_SETTINGS),
});

export type ListCreateInput = z.infer<typeof ListCreateSchema>;

// ---------------------------------------------------------------------------
// List update body (all fields optional)
// ---------------------------------------------------------------------------

export const ListUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(4096).nullable().optional(),
  active: z.boolean().optional(),
  owner_user_id: z.coerce.bigint().positive().nullable().optional(),
  caller_id_override: z.string().max(16).nullable().optional(),
  caller_id_name: z.string().max(32).nullable().optional(),
  settings: ListSettingsSchema.partial().optional(),
});

export type ListUpdateInput = z.infer<typeof ListUpdateSchema>;

// ---------------------------------------------------------------------------
// List list query
// ---------------------------------------------------------------------------

export const ListQuerySchema = z.object({
  active: z
    .string()
    .transform((v) => v === "true")
    .optional(),
  owner_user_id: z.coerce.bigint().positive().optional(),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().max(128).optional(),
});

export type ListQuery = z.infer<typeof ListQuerySchema>;

// ---------------------------------------------------------------------------
// Campaign assignment
// ---------------------------------------------------------------------------

export const CampaignLinkSchema = z.object({
  campaign_id: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-zA-Z0-9_-]+$/, "campaign_id must be alphanumeric/underscore/hyphen"),
  priority: z.number().int().min(0).max(32767).default(0),
  active: z.boolean().default(true),
});

export type CampaignLinkInput = z.infer<typeof CampaignLinkSchema>;

export const CampaignLinkUpdateSchema = z.object({
  priority: z.number().int().min(0).max(32767).optional(),
  active: z.boolean().optional(),
});

export type CampaignLinkUpdateInput = z.infer<typeof CampaignLinkUpdateSchema>;

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export const CloneSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(4096).optional(),
  include_deleted: z.boolean().default(false),
});

export type CloneInput = z.infer<typeof CloneSchema>;

// ---------------------------------------------------------------------------
// Reset / Purge (body optional)
// ---------------------------------------------------------------------------

export const ResetPurgeSchema = z.object({
  reason: z.string().max(256).optional(),
});

export type ResetPurgeInput = z.infer<typeof ResetPurgeSchema>;
