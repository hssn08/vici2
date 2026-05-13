// M06 — DID number admin schemas (Zod validators).
//
// Covers CRUD + bulk CSV import for the did_numbers table.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Route kind enum (mirrors Prisma DidRouteKind)
// ---------------------------------------------------------------------------

export const DidRouteKindEnum = z.enum([
  "ingroup",
  "ivr",
  "agent",
  "ext",
  "voicemail",
]);

export type DidRouteKind = z.infer<typeof DidRouteKindEnum>;

// ---------------------------------------------------------------------------
// DID create
// ---------------------------------------------------------------------------

export const DidCreateSchema = z.object({
  e164: z
    .string()
    .min(10)
    .max(16)
    .regex(/^\+[1-9]\d{1,14}$/, "Must be E.164 format (+12065551234)"),
  carrierId: z.coerce.bigint().positive(),
  routeKind: DidRouteKindEnum,
  routeTarget: z.string().min(1).max(64),
  callerIdName: z.string().max(64).optional(),
  active: z.boolean().default(true),
  defaultLang: z.string().max(5).regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Must be ISO 639-1 or BCP-47 (e.g. en, es, fr)").default("en"),
  ivrTimeoutSec: z.number().int().min(30).max(7200).default(300),
});

export type DidCreateInput = z.infer<typeof DidCreateSchema>;

// ---------------------------------------------------------------------------
// DID update (all optional)
// ---------------------------------------------------------------------------

export const DidUpdateSchema = DidCreateSchema.partial().strict();

export type DidUpdateInput = z.infer<typeof DidUpdateSchema>;

// ---------------------------------------------------------------------------
// DID list query
// ---------------------------------------------------------------------------

export const DidListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  carrierId: z.coerce.bigint().positive().optional(),
  routeKind: DidRouteKindEnum.optional(),
  active: z.enum(["true", "false", "all"]).default("all"),
  search: z.string().max(20).optional(),
});

export type DidListQuery = z.infer<typeof DidListQuerySchema>;

// ---------------------------------------------------------------------------
// DID bulk row (CSV)
// ---------------------------------------------------------------------------

export const DidBulkRowSchema = z.object({
  e164: z
    .string()
    .min(10)
    .max(16)
    .regex(/^\+[1-9]\d{1,14}$/, "Must be E.164 format"),
  carrier_id: z.coerce.bigint().positive(),
  route_kind: DidRouteKindEnum,
  route_target: z.string().min(1).max(64),
  active: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" || v.toLowerCase() === "true" ? true : false)),
  default_lang: z.string().max(5).optional().default("en"),
});

export type DidBulkRow = z.infer<typeof DidBulkRowSchema>;

// ---------------------------------------------------------------------------
// DID response
// ---------------------------------------------------------------------------

export interface DidResponse {
  id: string;
  tenantId: string;
  e164: string;
  carrierId: string;
  routeKind: string;
  routeTarget: string;
  callerIdName: string | null;
  active: boolean;
  defaultLang: string;
  ivrTimeoutSec: number;
  createdAt: string;
  updatedAt: string;
}

export interface DidListResponse {
  data: DidResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Bulk import result
// ---------------------------------------------------------------------------

export interface BulkImportResult {
  inserted: number;
  updated: number;
  errors: Array<{ row: number; message: string }>;
}
