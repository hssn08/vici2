// D06 — Zod schemas for callback endpoints.
// Scope discriminator: user_id IS NULL = GLOBAL; NOT NULL = AGENT.

import { z } from "zod";

// ── Shared ─────────────────────────────────────────────────────────────────────

export const CallbackStatusSchema = z.enum(["PENDING", "LIVE", "DONE", "DEAD"]);
export type CallbackStatus = z.infer<typeof CallbackStatusSchema>;

export const CallbackScopeSchema = z.enum(["GLOBAL", "AGENT"]);
export type CallbackScope = z.infer<typeof CallbackScopeSchema>;

// ── Create ─────────────────────────────────────────────────────────────────────

export const CreateCallbackBody = z
  .object({
    lead_id: z.coerce.bigint(),
    campaign_id: z.string().max(32),
    callback_at: z.string().datetime({ offset: false }),  // ISO-8601 + Z required
    agent_only: z.boolean().default(false),
    user_id: z.coerce.bigint().optional(),
    comments: z.string().max(255).optional(),
  })
  .strict();

export type CreateCallbackBodyType = z.infer<typeof CreateCallbackBody>;

// ── Snooze ─────────────────────────────────────────────────────────────────────

export const SnoozeBody = z
  .object({
    callback_at: z.string().datetime({ offset: false }),
    comments: z.string().max(255).optional(),
  })
  .strict();

export type SnoozeBodyType = z.infer<typeof SnoozeBody>;

// ── Admin reassign ─────────────────────────────────────────────────────────────

export const ReassignBody = z
  .object({
    user_id: z.union([z.coerce.bigint(), z.null()]),
  })
  .strict();

export type ReassignBodyType = z.infer<typeof ReassignBody>;

// ── Bulk reassign ──────────────────────────────────────────────────────────────

export const BulkReassignBody = z
  .object({
    from_user_id: z.coerce.bigint(),
    to_user_id: z.union([z.coerce.bigint(), z.null()]),
    scope: z.enum(["pending", "all_non_terminal"]),
  })
  .strict();

export type BulkReassignBodyType = z.infer<typeof BulkReassignBody>;

// ── Bulk cancel ────────────────────────────────────────────────────────────────

export const BulkCancelBody = z
  .object({
    ids: z.array(z.coerce.bigint()).min(1).max(500),
  })
  .strict();

export type BulkCancelBodyType = z.infer<typeof BulkCancelBody>;

// ── List query filters (admin) ─────────────────────────────────────────────────

export const AdminListQuery = z.object({
  status: z.union([z.string(), z.array(z.string())]).optional(),
  scope: z.enum(["GLOBAL", "AGENT"]).optional(),
  user_id: z.coerce.bigint().optional(),
  campaign_id: z.string().max(32).optional(),
  due_from: z.string().datetime({ offset: false }).optional(),
  due_to: z.string().datetime({ offset: false }).optional(),
  stale_only: z.coerce.boolean().optional(),
  cursor: z.coerce.bigint().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type AdminListQueryType = z.infer<typeof AdminListQuery>;

// ── Aggregate query ────────────────────────────────────────────────────────────

export const AggregateQuery = z.object({
  campaign_id: z.string().max(32).optional(),
  horizon_hours: z.coerce.number().int().min(1).max(168).default(24),
});

export type AggregateQueryType = z.infer<typeof AggregateQuery>;

// ── Validation guards ──────────────────────────────────────────────────────────

const MIN_FUTURE_SECONDS = 5 * 60;       // 5 minutes from now
const MAX_FUTURE_SECONDS = 365 * 24 * 3600; // 1 year

export function validateCallbackAt(callbackAt: string): { ok: true } | { ok: false; code: string } {
  const ts = new Date(callbackAt).getTime();
  const now = Date.now();
  if (ts < now + MIN_FUTURE_SECONDS * 1000) {
    return { ok: false, code: "callback_too_soon" };
  }
  if (ts > now + MAX_FUTURE_SECONDS * 1000) {
    return { ok: false, code: "callback_too_far" };
  }
  return { ok: true };
}
