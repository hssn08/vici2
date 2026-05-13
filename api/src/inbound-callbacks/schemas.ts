// I04 — Inbound Callback Queue: Zod schemas for API + internal endpoints.

import { z } from "zod";

// ── Phone normalisation ───────────────────────────────────────────────────────

// NANP: 10-digit after stripping leading +1 / 1
const NANP_RE = /^\+?1?(\d{10})$/;
// E.164 international: + followed by 7-15 digits
const E164_RE = /^\+[1-9]\d{6,14}$/;
// Reserved NANP ranges to reject
const RESERVED_555_RE = /^1?5551212$|^1?555(0100|01[0-9]{2}|0[2-9][0-9]{2}|1[01][0-9]{2}|11[0-9]{2}|1[2-9][0-9]{2})$/;

/**
 * Normalise a raw phone string to a storable form.
 * NANP → 10-digit string (no prefix)
 * International → E.164 with +
 * Returns null if invalid or reserved.
 */
export function normalizePhone(raw: string): string | null {
  if (!raw || raw.trim() === "") return null;
  const s = raw.trim().replace(/[\s\-().]/g, "");

  // Reject too-short or too-long
  if (s.length < 7 || s.length > 16) return null;

  // NANP path
  const nanpMatch = s.match(NANP_RE);
  if (nanpMatch) {
    const digits = nanpMatch[1];
    if (!digits) return null;
    // Reject reserved 555 ranges
    if (RESERVED_555_RE.test(digits)) return null;
    return digits; // 10-digit
  }

  // E.164 international path
  if (E164_RE.test(s)) return s;

  return null;
}

// ── Queue snapshot endpoint response ─────────────────────────────────────────

export const InboundCallbackRowSchema = z.object({
  id: z.string(),
  callback_number_masked: z.string(),          // last 3 digits replaced with ***
  original_wait_seconds: z.number().nullable(),
  queue_position_at_offer: z.number().nullable(),
  callback_at: z.string(),
  created_at: z.string(),
  position_priority_active: z.boolean(),
  tcpa_window_open: z.boolean(),
  lead: z.object({
    id: z.string(),
    first_name: z.string().nullable(),
    last_name: z.string().nullable(),
    status: z.string(),
  }),
});

export type InboundCallbackRowType = z.infer<typeof InboundCallbackRowSchema>;

export const InboundCallbackQueueResponseSchema = z.object({
  ingroup_id: z.string(),
  pending_count: z.number(),
  stale_count: z.number(),
  next_tcpa_window_open: z.string().nullable(),
  callbacks: z.array(InboundCallbackRowSchema),
});

export type InboundCallbackQueueResponseType = z.infer<typeof InboundCallbackQueueResponseSchema>;

// ── Ingroup queue query params ────────────────────────────────────────────────

export const InboundCallbackQueueQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type InboundCallbackQueueQueryType = z.infer<typeof InboundCallbackQueueQuery>;

// ── Internal exit_callback extension ─────────────────────────────────────────

export const ExitCallbackInboundQuery = z.object({
  call_uuid: z.string().min(1),
  number: z.string().min(1).max(20),
  tenant: z.coerce.number().int().default(1),
  ingroup_id: z.string().min(1).max(32).optional(),
  source: z.enum(["inbound"]).optional(),
  queue_position: z.coerce.number().int().min(0).optional(),
});

export type ExitCallbackInboundQueryType = z.infer<typeof ExitCallbackInboundQuery>;
