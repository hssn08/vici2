// D01 — Zod schemas for leads (PLAN §1.3, §11.1)

import { z } from "zod";

// ---------------------------------------------------------------------------
// Reusable field schemas
// ---------------------------------------------------------------------------

const E164 = z
  .string()
  .min(2)
  .max(16)
  .regex(/^\+?[0-9()\-. ]+$/, "Invalid phone format");

const ISODate = z.string().datetime({ offset: true }).optional();

const SortOrderSchema = z
  .enum(["modify_at_desc", "created_at_desc"])
  .default("modify_at_desc");

// ---------------------------------------------------------------------------
// Lead create body
// ---------------------------------------------------------------------------

export const LeadCreateSchema = z.object({
  list_id: z.coerce.bigint().positive(),
  phone_e164: E164,
  phone_alt: E164.optional(),
  phone_alt2: E164.optional(),
  country_code: z.string().length(2).default("US"),
  title: z.string().max(8).optional(),
  first_name: z.string().max(64).optional(),
  middle_initial: z.string().max(4).optional(),
  last_name: z.string().max(64).optional(),
  address1: z.string().max(128).optional(),
  address2: z.string().max(128).optional(),
  city: z.string().max(64).optional(),
  state: z.string().length(2).optional(),
  postal_code: z.string().max(16).optional(),
  email: z.string().email().max(128).optional(),
  date_of_birth: z.string().date().optional(),
  gender: z.enum(["M", "F", "U"]).default("U"),
  comments: z.string().optional(),
  rank: z.number().int().default(0),
  owner_user_id: z.coerce.bigint().positive().optional(),
  vendor_lead_code: z.string().max(64).optional(),
  source_id: z.string().max(64).optional(),
  custom_data: z.record(z.unknown()).default({}),
  status: z
    .string()
    .max(8)
    .optional()
    .refine(
      (v) => v === undefined || v === "NEW",
      "Use the status endpoint (D04) for non-default statuses",
    ),
});

export type LeadCreate = z.infer<typeof LeadCreateSchema>;

// ---------------------------------------------------------------------------
// Lead patch body (PLAN §3)
// ---------------------------------------------------------------------------

export const LeadPatchSchema = z
  .object({
    version: z.number().int().positive().optional(),
    phone_e164: E164.optional(),
    phone_alt: E164.optional().nullable(),
    phone_alt2: E164.optional().nullable(),
    country_code: z.string().length(2).optional(),
    title: z.string().max(8).optional().nullable(),
    first_name: z.string().max(64).optional().nullable(),
    middle_initial: z.string().max(4).optional().nullable(),
    last_name: z.string().max(64).optional().nullable(),
    address1: z.string().max(128).optional().nullable(),
    address2: z.string().max(128).optional().nullable(),
    city: z.string().max(64).optional().nullable(),
    state: z.string().length(2).optional().nullable(),
    postal_code: z.string().max(16).optional().nullable(),
    email: z.string().email().max(128).optional().nullable(),
    date_of_birth: z.string().date().optional().nullable(),
    gender: z.enum(["M", "F", "U"]).optional(),
    comments: z.string().optional().nullable(),
    rank: z.number().int().optional(),
    owner_user_id: z.coerce.bigint().positive().optional().nullable(),
    vendor_lead_code: z.string().max(64).optional().nullable(),
    source_id: z.string().max(64).optional().nullable(),
    custom_data: z.record(z.unknown()).optional(),
    // status field rejected — use D04 endpoint
    status: z
      .never({
        errorMap: () => ({
          message: "Use POST /api/leads/:id/status (D04) to update status",
        }),
      })
      .optional(),
  })
  .strip();

export type LeadPatch = z.infer<typeof LeadPatchSchema>;

// ---------------------------------------------------------------------------
// List query params
// ---------------------------------------------------------------------------

export const LeadListQuerySchema = z.object({
  list_id: z
    .union([z.string(), z.array(z.string())])
    .transform((v) =>
      (Array.isArray(v) ? v : [v]).map((x) => BigInt(x)),
    )
    .optional(),
  status: z
    .union([z.string(), z.array(z.string())])
    .transform((v) => (Array.isArray(v) ? v : [v]))
    .optional(),
  owner_user_id: z.coerce.bigint().positive().optional(),
  phone_e164: z.string().optional(),
  state: z.string().length(2).optional(),
  min_called: z.coerce.number().int().min(0).optional(),
  max_called: z.coerce.number().int().min(0).optional(),
  created_after: ISODate,
  created_before: ISODate,
  modified_after: ISODate,
  modified_before: ISODate,
  search: z.string().min(3).max(100).optional(),
  include_deleted: z
    .string()
    .transform((v) => v === "true" || v === "1")
    .optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  sort: SortOrderSchema,
  expand: z.string().optional(), // comma-separated: list,owner
  include: z.string().optional(), // comma-separated: custom_data
  withCount: z
    .string()
    .transform((v) => v === "true" || v === "1")
    .optional(),
});

export type LeadListQuery = z.infer<typeof LeadListQuerySchema>;

// ---------------------------------------------------------------------------
// Bulk request body (PLAN §4)
// ---------------------------------------------------------------------------

export const BulkLeadRowSchema = LeadCreateSchema.omit({ status: true });

export const LeadBulkRequestSchema = z.object({
  list_id: z.coerce.bigint().positive(),
  leads: z.array(BulkLeadRowSchema).min(1).max(500),
  options: z
    .object({
      skipDuplicates: z.boolean().default(true),
      dryRun: z.boolean().default(false),
      strict: z.boolean().default(false),
    })
    .default({}),
});

export type LeadBulkRequest = z.infer<typeof LeadBulkRequestSchema>;
export type BulkLeadRow = z.infer<typeof BulkLeadRowSchema>;

// ---------------------------------------------------------------------------
// ID params
// ---------------------------------------------------------------------------

export const IdParamSchema = z.object({
  id: z.string().transform((v) => BigInt(v)),
});

export const FieldKeyParamSchema = z.object({
  k: z.string().regex(/^[a-z_][a-z0-9_]{0,30}$/, "Invalid field key format"),
});
