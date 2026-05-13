// X04 — Number Pool + Rotation: Zod validators and TypeScript interfaces.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const PoolStrategyEnum = z.enum([
  "health_weighted_lru",
  "round_robin",
  "random",
  "least_recently_used",
]);
export type PoolStrategy = z.infer<typeof PoolStrategyEnum>;

export const AttestLevelEnum = z.enum(["A", "B", "C", "unknown"]);
export type AttestLevel = z.infer<typeof AttestLevelEnum>;

export const QuarantineReasonEnum = z.enum([
  "low_answer_rate",
  "high_complaint_rate",
  "manual",
  "label_detected",
]);
export type QuarantineReason = z.infer<typeof QuarantineReasonEnum>;

// ---------------------------------------------------------------------------
// Pool CRUD
// ---------------------------------------------------------------------------

export const PoolCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().optional(),
  strategy: PoolStrategyEnum.default("health_weighted_lru"),
  arFloor: z.number().min(0).max(1).default(0.08),
  arMinSample: z.number().int().min(0).default(200),
  crCeil: z.number().min(0).max(1).default(0.05),
  crMinSample: z.number().int().min(0).default(100),
  dailyCap: z.number().int().min(1).max(65535).default(200),
  minActiveSize: z.number().int().min(1).max(255).default(3),
  maxConcurrent: z.number().int().min(1).max(255).default(5),
  // X05: local-presence NPA matching
  localPresenceEnabled: z.boolean().default(false),
});
export type PoolCreateInput = z.infer<typeof PoolCreateSchema>;

export const PoolUpdateSchema = PoolCreateSchema.partial();
export type PoolUpdateInput = z.infer<typeof PoolUpdateSchema>;

export const PoolListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  active: z.enum(["true", "false", "all"]).default("all"),
  search: z.string().optional(),
});
export type PoolListQuery = z.infer<typeof PoolListQuerySchema>;

export interface PoolResponse {
  id: string;
  tenantId: string;
  name: string;
  description: string | null;
  strategy: string;
  arFloor: number;
  arMinSample: number;
  crCeil: number;
  crMinSample: number;
  dailyCap: number;
  minActiveSize: number;
  maxConcurrent: number;
  active: boolean;
  // X05: local-presence NPA matching
  localPresenceEnabled: boolean;
  activeDids: number;
  quarantinedDids: number;
  createdAt: string;
  updatedAt: string;
}

// X05: NPA coverage report response
export interface NpaCoverageEntry {
  npa: string;
  state: string | null;
  didCount: number;
}

export interface NpaCoverageResponse {
  poolId: string;
  localPresenceEnabled: boolean;
  coverage: NpaCoverageEntry[];
}

export interface PoolListResponse {
  data: PoolResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// DID membership
// ---------------------------------------------------------------------------

export const AddDidSchema = z.object({
  didId: z.string().min(1),
  attestLevel: AttestLevelEnum.default("unknown"),
});
export type AddDidInput = z.infer<typeof AddDidSchema>;

export interface DidMemberResponse {
  id: string;
  poolId: string;
  didId: string;
  e164: string;
  areaCode: string;
  quarantined: boolean;
  quarantinedAt: string | null;
  quarantineReason: string | null;
  firstUsedAt: string | null;
  lastUsedAt: string | null;
  callCount7d: number;
  answerCount7d: number;
  answerRate7d: number;
  callCount30d: number;
  shortCallCount30d: number;
  complaintCount30d: number;
  healthScore: number;
  attestLevel: string;
  dailyCallCount: number;
  concurrentCalls: number;
  createdAt: string;
  updatedAt: string;
}

export const DidMemberListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  quarantined: z.enum(["true", "false", "all"]).default("all"),
});
export type DidMemberListQuery = z.infer<typeof DidMemberListQuerySchema>;

export interface DidMemberListResponse {
  data: DidMemberResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}

// ---------------------------------------------------------------------------
// Quarantine
// ---------------------------------------------------------------------------

export const QuarantineDidSchema = z.object({
  reason: QuarantineReasonEnum.optional().default("manual"),
  meta: z.record(z.unknown()).optional(),
});
export type QuarantineDidInput = z.infer<typeof QuarantineDidSchema>;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface PoolStatsResponse {
  poolId: string;
  totalDids: number;
  activeDids: number;
  quarantinedDids: number;
  avgHealthScore: number;
  avgAnswerRate7d: number;
  totalCallsToday: number;
  activeCallsNow: number;
  belowMinActiveSize: boolean;
}
