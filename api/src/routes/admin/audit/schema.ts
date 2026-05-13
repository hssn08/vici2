// M04 — Audit log viewer: Zod schemas for query params and responses.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ISODate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

const CursorString = z.string().min(1).max(64).optional();

const LimitParam = z
  .string()
  .optional()
  .transform((v) => (v !== undefined ? Number(v) : 50))
  .pipe(z.number().int().min(1).max(200));

// ---------------------------------------------------------------------------
// Audit log list query
// ---------------------------------------------------------------------------

export const AUDIT_ACTOR_KINDS = ["user", "system", "worker", "external_api"] as const;
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number];

export const AuditLogListQuerySchema = z.object({
  action: z.string().max(64).optional(),
  actor: z
    .string()
    .regex(/^\d+$/, "actor must be numeric user id")
    .optional(),
  actorKind: z.enum(AUDIT_ACTOR_KINDS).optional(),
  entity_type: z.string().max(32).optional(),
  entity_id: z.string().max(64).optional(),
  from: ISODate.optional(),
  to: ISODate.optional(),
  cursor: CursorString,
  limit: LimitParam,
});

export type AuditLogListQuery = z.infer<typeof AuditLogListQuerySchema>;

// ---------------------------------------------------------------------------
// Audit log row (mirrors DB columns; all numeric IDs as strings for JSON-safe)
// ---------------------------------------------------------------------------

export const AuditLogRowSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  actorUserId: z.string().nullable(),
  actorKind: z.string(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  beforeJson: z.unknown().nullable(),
  afterJson: z.unknown().nullable(),
  requestId: z.string().nullable(),
  ipAddress: z.string().nullable(),
  userAgent: z.string().nullable(),
  ts: z.string(),
  prevHash: z.string(),
  rowHash: z.string(),
  hashAt: z.string(),
});

export type AuditLogRow = z.infer<typeof AuditLogRowSchema>;

// ---------------------------------------------------------------------------
// Audit log detail response
// ---------------------------------------------------------------------------

export const AuditLogDetailResponseSchema = z.object({
  row: AuditLogRowSchema,
  chainContext: z.object({
    prevRows: z.array(AuditLogRowSchema),
    nextRows: z.array(AuditLogRowSchema),
  }),
});

export type AuditLogDetailResponse = z.infer<typeof AuditLogDetailResponseSchema>;

// ---------------------------------------------------------------------------
// Verify row response
// ---------------------------------------------------------------------------

export const VerifyFailureSchema = z.object({
  kind: z.string(),
  table: z.string(),
  tenantId: z.string(),
  id: z.string().optional(),
  date: z.string().optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
});

export const VerifyRowResponseSchema = z.object({
  ok: z.boolean(),
  rowHashRecomputed: z.string(),
  rowHashStored: z.string(),
  prevRowHashMatches: z.boolean(),
  nextRowPrevHashMatches: z.boolean(),
  merkleAttestationDate: z.string().nullable(),
  failures: z.array(VerifyFailureSchema),
  rowsChecked: z.number(),
  daysChecked: z.number(),
  attestationsChecked: z.number(),
});

export type VerifyRowResponse = z.infer<typeof VerifyRowResponseSchema>;

// ---------------------------------------------------------------------------
// Export query
// ---------------------------------------------------------------------------

export const AuditLogExportQuerySchema = z.object({
  action: z.string().max(64).optional(),
  actor: z.string().regex(/^\d+$/).optional(),
  actorKind: z.enum(AUDIT_ACTOR_KINDS).optional(),
  entity_type: z.string().max(32).optional(),
  entity_id: z.string().max(64).optional(),
  from: ISODate.optional(),
  to: ISODate.optional(),
  format: z.enum(["csv", "json"]).default("csv"),
});

export type AuditLogExportQuery = z.infer<typeof AuditLogExportQuerySchema>;

// ---------------------------------------------------------------------------
// Attestation list query
// ---------------------------------------------------------------------------

export const AttestationListQuerySchema = z.object({
  table: z.string().max(64).optional(),
  from: ISODate.optional(),
  to: ISODate.optional(),
  cursor: CursorString,
  limit: LimitParam,
});

export type AttestationListQuery = z.infer<typeof AttestationListQuerySchema>;

// ---------------------------------------------------------------------------
// Attestation row
// ---------------------------------------------------------------------------

export const AttestationRowSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  tableName: z.string(),
  windowDate: z.string(),
  rowCount: z.number(),
  firstId: z.string().nullable(),
  lastId: z.string().nullable(),
  firstRowPrevHash: z.string().nullable(),
  lastRowRowHash: z.string().nullable(),
  merkleRoot: z.string(),
  leafHashAlgo: z.string(),
  nodeHashAlgo: z.string(),
  computedAt: z.string(),
  keyId: z.string(),
  signatureB64: z.string(),
  s3Key: z.string().nullable(),
  s3ETag: z.string().nullable(),
});

export type AttestationRow = z.infer<typeof AttestationRowSchema>;

// ---------------------------------------------------------------------------
// Verify attestation response
// ---------------------------------------------------------------------------

export const VerifyAttestationResponseSchema = z.object({
  ok: z.boolean(),
  merkleRootMatches: z.boolean(),
  signatureValid: z.boolean(),
  rowsChecked: z.number(),
  failures: z.array(VerifyFailureSchema),
});

export type VerifyAttestationResponse = z.infer<typeof VerifyAttestationResponseSchema>;
