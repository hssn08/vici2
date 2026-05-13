// D02 — Zod schemas for import endpoints (PLAN §5)

import { z } from "zod";

// ── Column mapping schema ─────────────────────────────────────────────────

export const MappingRowSchema = z.object({
  source: z.string().min(1).max(128),
  target: z.string().min(1).max(128),
  transform: z.string().optional(),
});

export const ColumnMappingSchema = z.object({
  version: z.literal(1),
  rows: z.array(MappingRowSchema).min(1).max(200),
  options: z.object({
    default_status: z.string().max(8).optional(),
    default_country: z.string().length(2).optional(),
    lookup_state_from_zip: z.boolean().optional(),
    skip_blank_rows: z.boolean().optional(),
  }).optional(),
});

const MappingInputSchema = z.union([
  ColumnMappingSchema,
  z.literal("inherit"),
  z.literal("vicidial_default"),
]);

// ── Upload meta schema ────────────────────────────────────────────────────

export const ImportMetaSchema = z.object({
  name: z.string().max(255).optional(),
  delimiter: z.enum(["auto", ",", ";", "\t"]).default("auto"),
  encoding: z.enum(["auto", "utf-8", "windows-1252"]).default("auto"),
  header_row: z.boolean().default(true),
  skip_rows: z.number().int().min(0).max(100).default(0),
  mapping: MappingInputSchema.optional(),
  dedup_policy: z.enum(["skip_in_file", "skip_cross_list", "skip_tenant"]).default("skip_in_file"),
  dnc_policy: z.enum(["skip", "mark", "proceed"]).default("skip"),
  tz_policy: z.enum(["skip", "mark", "proceed"]).default("mark"),
  default_country: z.string().length(2).default("US"),
  default_status: z.string().max(8).default("NEW"),
  options: z.object({
    lookup_state_from_zip: z.boolean().default(true),
    legacy_backslash_escape: z.boolean().default(false),
    strict_phone: z.boolean().default(true),
    persist_raw_errors: z.boolean().default(false),
    raw_insert: z.boolean().default(false),
  }).default({}),
});

export type ImportMeta = z.infer<typeof ImportMetaSchema>;

// ── Import status response ────────────────────────────────────────────────

export const ImportStatusSchema = z.object({
  import_id: z.string(),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  name: z.string().nullish(),
  started_at: z.string().datetime().nullish(),
  completed_at: z.string().datetime().nullish(),
  row_count_total: z.number().int().nullish(),
  row_count_processed: z.number().int(),
  row_count_inserted: z.number().int(),
  row_count_skipped: z.number().int(),
  row_count_errored: z.number().int(),
  summary: z.object({
    by_error_code: z.record(z.number()),
  }).nullish(),
  errors_url: z.string().nullish(),
  failed_reason: z.string().nullish(),
  created_at: z.string().datetime(),
});

export type ImportStatus = z.infer<typeof ImportStatusSchema>;

// ── Create import response ────────────────────────────────────────────────

export const CreateImportResponseSchema = z.object({
  import_id: z.string(),
  status: z.literal("queued"),
  estimated_rows: z.null(),
});

// ── List imports query ────────────────────────────────────────────────────

export const ListImportsQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  list_id: z.coerce.bigint().positive().optional(),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]).optional(),
});

// ── Preview request ───────────────────────────────────────────────────────

export const PreviewRequestSchema = z.object({
  source_key: z.string().optional(),
  mapping: MappingInputSchema.optional(),
  delimiter: z.enum(["auto", ",", ";", "\t"]).default("auto"),
  header_row: z.boolean().default(true),
});
