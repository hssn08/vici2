// D04 — Zod validators for status API surface.

import { z } from "zod";

/** Status code regex: uppercase letter then up to 7 uppercase letters/digits/hyphens/underscores */
export const StatusCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_-]{0,7}$/, "invalid_status_code");

/** Hotkey: single digit 0-9, or null */
export const HotkeySchema = z.string().regex(/^[0-9]$/).nullable();

/**
 * Recycle delay:
 *   -1  = terminal (never re-dial)
 *    0  = immediate re-queue
 *   >0  = seconds before re-queue
 *  null = use campaign default
 */
export const RecycleDelaySchema = z
  .union([z.literal(-1), z.literal(0), z.number().int().min(1)])
  .nullable();

export const CategorySchema = z
  .enum([
    "agent-outcome",
    "system-amd",
    "system-carrier",
    "system-compliance",
    "lifecycle",
  ])
  .nullable();

export const StatusCreateSchema = z.object({
  status: StatusCodeSchema,
  description: z.string().min(1).max(128),
  selectable: z.boolean().optional().default(true),
  humanAnswered: z.boolean().optional().default(false),
  sale: z.boolean().optional().default(false),
  dnc: z.boolean().optional().default(false),
  callback: z.boolean().optional().default(false),
  notInterested: z.boolean().optional().default(false),
  hotkey: HotkeySchema.optional().default(null),
  recycleDelaySeconds: RecycleDelaySchema.optional().default(null),
  category: CategorySchema.optional().default(null),
});

export const StatusUpdateSchema = z.object({
  description: z.string().min(1).max(128).optional(),
  selectable: z.boolean().optional(),
  humanAnswered: z.boolean().optional(),
  sale: z.boolean().optional(),
  dnc: z.boolean().optional(),
  callback: z.boolean().optional(),
  notInterested: z.boolean().optional(),
  hotkey: HotkeySchema.optional(),
  recycleDelaySeconds: RecycleDelaySchema.optional(),
  maxCalls: z.number().int().min(1).nullable().optional(),
});

export const BulkResetSchema = z.object({
  campaignId: z.string().min(1).max(32),
  listIds: z.array(z.number().int().positive()).optional(),
  fromStatuses: z.array(StatusCodeSchema).optional(),
  toStatus: StatusCodeSchema.optional().default("NEW"),
  reason: z.string().min(1).max(255).optional(),
});
