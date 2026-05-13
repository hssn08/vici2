// M07 — Pause code Zod schemas.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export const PauseCodeResponseSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  campaignId: z.string().nullable(),
  code: z.string(),
  name: z.string(),
  billable: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type PauseCodeResponse = z.infer<typeof PauseCodeResponseSchema>;

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export const PauseCodeListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  campaignId: z.string().optional(), // '__GLOBAL__' means filter nulls
  search: z.string().optional(),
});

export type PauseCodeListQuery = z.infer<typeof PauseCodeListQuerySchema>;

export const PauseCodeListResponseSchema = z.object({
  data: z.array(PauseCodeResponseSchema),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPages: z.number(),
});

export type PauseCodeListResponse = z.infer<typeof PauseCodeListResponseSchema>;

// ---------------------------------------------------------------------------
// Create body
// ---------------------------------------------------------------------------

const codePattern = /^[A-Z0-9_-]{1,16}$/;

export const PauseCodeCreateSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(16)
    .transform((s) => s.toUpperCase())
    .refine((s) => codePattern.test(s), {
      message: "Code must be 1–16 uppercase alphanumeric/underscore/hyphen characters",
    }),
  name: z.string().min(1).max(64, { message: "Name must be 1–64 characters" }),
  billable: z.boolean().default(true),
  campaignId: z.string().max(32).nullable().default(null),
});

export type PauseCodeCreateInput = z.infer<typeof PauseCodeCreateSchema>;

// ---------------------------------------------------------------------------
// Update body (partial)
// ---------------------------------------------------------------------------

export const PauseCodeUpdateSchema = PauseCodeCreateSchema.partial();

export type PauseCodeUpdateInput = z.infer<typeof PauseCodeUpdateSchema>;
