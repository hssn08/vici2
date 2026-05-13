// D05 — DNC shared types (TS side).
// Mirror of dialer/internal/dnc/types.go — keep in sync.

import { z } from "zod";

// ── Source enum ────────────────────────────────────────────────────────────────

export const DncSource = z.enum(["federal", "state", "internal", "litigator"]);
export type DncSource = z.infer<typeof DncSource>;

// Source priority for audit reason (PLAN §2.3): internal > litigator > state > federal
export const SOURCE_PRIORITY: Record<DncSource, number> = {
  internal: 4,
  litigator: 3,
  state: 2,
  federal: 1,
};

export function sortSourcesByPriority(sources: DncSource[]): DncSource[] {
  return [...sources].sort((a, b) => SOURCE_PRIORITY[b] - SOURCE_PRIORITY[a]);
}

// ── Check request / result ─────────────────────────────────────────────────────

export const CheckRequestSchema = z.object({
  phoneE164: z.string().min(2).max(16),
  tenantId: z.number().int().positive(),
  campaignId: z.string().optional(),
  leadState: z.string().length(2).optional(),
  sources: z.array(DncSource).min(1),
});
export type CheckRequest = z.infer<typeof CheckRequestSchema>;

export const CheckResultSchema = z.object({
  isDnc: z.boolean(),
  sources: z.array(DncSource),
  latencyMicros: z.number().int(),
  bloomFalsePositive: z.boolean(),
  reason: z.string().optional(), // "malformed" when phone invalid
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

// ── Bloom key helpers ──────────────────────────────────────────────────────────

export function bloomKey(source: DncSource, tenantId?: number): string {
  switch (source) {
    case "federal":
      return "bf:dnc:federal";
    case "litigator":
      return "bf:dnc:litigator";
    case "internal":
      return `t:${tenantId}:dnc:internal:bloom`;
    case "state":
      return `t:${tenantId}:dnc:state:bloom`;
  }
}

// ── Bloom reserve capacities ───────────────────────────────────────────────────

export const BLOOM_CAPS: Record<DncSource, number> = {
  federal: 300_000_000,
  litigator: 10_000_000,
  internal: 200_000,
  state: 5_000_000,
};
export const BLOOM_FPR = 0.001;
