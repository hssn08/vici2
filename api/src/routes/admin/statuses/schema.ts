// M07 — Status Zod schemas.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

const CATEGORY_VALUES = ["sale", "not_interested", "dnc", "callback", "machine", "system", "other"] as const;

export const StatusResponseSchema = z.object({
  tenantId: z.string(),
  campaignId: z.string(),
  status: z.string(),
  description: z.string(),
  selectable: z.boolean(),
  humanAnswered: z.boolean(),
  sale: z.boolean(),
  dnc: z.boolean(),
  callback: z.boolean(),
  notInterested: z.boolean(),
  hotkey: z.string().nullable(),
  recycleDelaySeconds: z.number().nullable(),
  category: z.string().nullable(),
  systemOwner: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type StatusResponse = z.infer<typeof StatusResponseSchema>;

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export const StatusListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  campaignId: z.string().optional(),
  search: z.string().optional(),
  category: z.string().optional(),
  selectable: z.enum(["true", "false", "all"]).default("all"),
});

export type StatusListQuery = z.infer<typeof StatusListQuerySchema>;

export const StatusListResponseSchema = z.object({
  data: z.array(StatusResponseSchema),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
  totalPages: z.number(),
});

export type StatusListResponse = z.infer<typeof StatusListResponseSchema>;

// ---------------------------------------------------------------------------
// Create body
// ---------------------------------------------------------------------------

export const StatusCreateSchema = z.object({
  status: z.string().min(1).max(24, { message: "Status code is required (max 24 chars)" }),
  description: z.string().max(128, { message: "Description must be max 128 characters" }).default(""),
  campaignId: z.string().min(1, { message: "Campaign is required" }),
  selectable: z.boolean().default(true),
  humanAnswered: z.boolean().default(false),
  sale: z.boolean().default(false),
  dnc: z.boolean().default(false),
  callback: z.boolean().default(false),
  notInterested: z.boolean().default(false),
  hotkey: z
    .string()
    .length(1, { message: "Hotkey must be a single character" })
    .nullable()
    .default(null),
  recycleDelaySeconds: z
    .number()
    .int()
    .refine((n) => n === -1 || n === 0 || (n >= 1 && n <= 86400), {
      message: "Recycle delay must be -1 (terminal), 0 (immediate), or 1–86400 seconds",
    })
    .nullable()
    .default(null),
  category: z.enum(CATEGORY_VALUES).nullable().default(null),
});

export type StatusCreateInput = z.infer<typeof StatusCreateSchema>;

// ---------------------------------------------------------------------------
// Update body (partial)
// ---------------------------------------------------------------------------

export const StatusUpdateSchema = StatusCreateSchema.partial().omit({ status: true, campaignId: true });

export type StatusUpdateInput = z.infer<typeof StatusUpdateSchema>;
