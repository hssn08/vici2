/**
 * api/src/services/audit/events.ts
 *
 * Per-table Zod schemas for AuditWriter.append() input validation.
 * Guards:
 *   - No 0x1F (Unit Separator) in any string field — would break canonicalization
 *   - No NUL (0x00) bytes
 *   - No unbalanced UTF-16 surrogates (would make JSON.stringify and MySQL disagree)
 *   - Payload <= 4 KB (JSON columns before_json / after_json)
 *   - entity_type <= 32 chars
 *
 * Action vocabulary for audit_log rows written by C03 itself (readers, verifier):
 *   audit.access.log_listed, audit.access.row_verified, audit.attestation.published, …
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Base guards
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const UNIT_SEP_RE = /\x1f/;
// eslint-disable-next-line no-control-regex
const NUL_RE = /\x00/;

/** String that may not contain 0x1F or NUL. */
const safeStr = (maxLen = 255) =>
  z
    .string()
    .max(maxLen)
    .refine((s) => !UNIT_SEP_RE.test(s), 'Field may not contain 0x1F (unit separator)')
    .refine((s) => !NUL_RE.test(s), 'Field may not contain NUL byte');

/** JSON value (object/array/primitive) with a 4 KB serialization cap. */
const safeJson = () =>
  z.unknown().refine((v) => {
    if (v == null) return true;
    const s = JSON.stringify(v);
    return s.length <= 4096;
  }, 'JSON payload exceeds 4 KB limit');

// ---------------------------------------------------------------------------
// audit_log input schema
// ---------------------------------------------------------------------------

export const AuditLogInputSchema = z.object({
  tenantId: z.bigint(),
  actorUserId: z.bigint().nullable().optional(),
  actorKind: z.enum(['user', 'system', 'worker', 'external_api']),
  action: safeStr(64),
  entityType: safeStr(32),
  entityId: safeStr(64).nullable().optional(),
  beforeJson: safeJson().optional(),
  afterJson: safeJson().optional(),
  requestId: safeStr(64).nullable().optional(),
  ipAddress: safeStr(45).nullable().optional(),
  userAgent: safeStr(255).nullable().optional(),
  ts: z.date(),
});
export type AuditLogInput = z.infer<typeof AuditLogInputSchema>;

// ---------------------------------------------------------------------------
// call_window_audit input schema
// ---------------------------------------------------------------------------

export const CallWindowAuditInputSchema = z.object({
  tenantId: z.bigint(),
  leadId: z.bigint(),
  phoneE164: safeStr(16),
  campaignId: safeStr(32),
  decision: z.enum(['ALLOW', 'ALLOW_WARN', 'SKIP_UNTIL', 'BLOCK_INVALID']),
  reason: safeStr(64),
  tzIana: safeStr(40).nullable().optional(),
  tzConfidence: z.enum(['KNOWN','ZIP','NXX','NPA','STATE_DEFAULT','CAMPAIGN_DEFAULT','NONE']).nullable().optional(),
  stateCode: z.string().length(2).nullable().optional(),
  zip: safeStr(16).nullable().optional(),
  partyLocal: z.date().nullable().optional(),
  partyDow: z.number().int().min(0).max(6).nullable().optional(),
  effectiveOpenMin: z.number().int().min(0).max(1439).nullable().optional(),
  effectiveCloseMin: z.number().int().min(0).max(1439).nullable().optional(),
  ruleApplied: safeStr(64).nullable().optional(),
  enforcementPoint: z.enum(['hopper_filler','originate_path','pacing','manual_dial']),
  nextOpenAt: z.date().nullable().optional(),
  callUuid: safeStr(64).nullable().optional(),
});
export type CallWindowAuditInput = z.infer<typeof CallWindowAuditInputSchema>;

// ---------------------------------------------------------------------------
// originate_audit input schema
// ---------------------------------------------------------------------------

export const OriginateAuditInputSchema = z.object({
  tenantId: z.bigint(),
  attemptUuid: safeStr(40),
  callUuid: safeStr(40).nullable().optional(),
  leadId: z.bigint(),
  campaignId: safeStr(32).nullable().optional(),
  listId: z.bigint().nullable().optional(),
  agentId: z.bigint().nullable().optional(),
  mode: z.enum(['PROGRESSIVE','PREDICTIVE','MANUAL','PREVIEW']),
  dialTarget: z.enum(['CONFERENCE','PARK']),
  carrierId: z.bigint().nullable().optional(),
  gatewayId: z.bigint().nullable().optional(),
  gatewayName: safeStr(64).nullable().optional(),
  callerIdNumber: safeStr(16).nullable().optional(),
  callerIdSource: z.enum(['per_call','per_list','local_presence','campaign_default']).nullable().optional(),
  phoneE164: safeStr(16),
  originatedAt: z.date(),
  tcpaDecision: z.enum(['ALLOW','BLOCK','SKIP']).nullable().optional(),
  tcpaReason: safeStr(64).nullable().optional(),
  tcpaTzResolved: safeStr(64).nullable().optional(),
  dncDecision: z.enum(['ALLOW','BLOCK']).nullable().optional(),
  dncSources: safeJson().optional(),
  consentDecision: z.enum(['ALLOW','PROMPT','SKIP_RECORDING','BLOCK']).nullable().optional(),
  consentState: z.string().length(2).nullable().optional(),
  bypassToken: safeStr(64).nullable().optional(),
  outcome: z.enum(['SUCCESS','TCPA_BLOCKED','DNC_BLOCKED','CONSENT_BLOCKED','GATEWAY_LIMIT','RATE_LIMITED','GATEWAY_FAIL','TIMEOUT','JOB_ORPHANED','OTHER']).default('OTHER'),
  outcomeAt: z.date().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  errorMessage: z.string().max(4096).nullable().optional(),
  fsHost: safeStr(64).nullable().optional(),
  requestId: safeStr(64).nullable().optional(),
  ipAddress: safeStr(45).nullable().optional(),
});
export type OriginateAuditInput = z.infer<typeof OriginateAuditInputSchema>;

// ---------------------------------------------------------------------------
// consent_log input schema
// ---------------------------------------------------------------------------

export const ConsentLogInputSchema = z.object({
  tenantId: z.bigint(),
  callUuid: safeStr(64),
  leadId: z.bigint(),
  phoneE164: safeStr(16),
  promptId: safeStr(64),
  dtmfResponse: safeStr(8).nullable().optional(),
  outcome: z.enum(['accepted','declined','timeout','error']),
  language: safeStr(8).default('en'),
  promptPlayedAt: z.date(),
});
export type ConsentLogInput = z.infer<typeof ConsentLogInputSchema>;

// ---------------------------------------------------------------------------
// dnc_sync_log input schema
// ---------------------------------------------------------------------------

export const DncSyncLogInputSchema = z.object({
  source: safeStr(32),
  kind: z.enum(['delta','full','bulk']),
  outcome: z.enum(['success','partial','failed']).default('success'),
  added: z.number().int().default(0),
  removed: z.number().int().default(0),
  errorCount: z.number().int().default(0),
  fileHash: safeStr(128).nullable().optional(),
  startedAt: z.date(),
  completedAt: z.date().nullable().optional(),
  durationMs: z.number().int().nullable().optional(),
  notes: z.string().max(65535).nullable().optional(),
});
export type DncSyncLogInput = z.infer<typeof DncSyncLogInputSchema>;

// ---------------------------------------------------------------------------
// Action vocabulary for C03-owned audit_log rows
// ---------------------------------------------------------------------------

export type C03AuditAction =
  | 'audit.access.log_listed'
  | 'audit.access.call_windows_listed'
  | 'audit.access.originates_listed'
  | 'audit.access.consents_listed'
  | 'audit.access.dnc_syncs_listed'
  | 'audit.access.row_verified'
  | 'audit.access.range_verified'
  | 'audit.access.attestation_fetched'
  | 'audit.access.attestations_listed'
  | 'audit.access.export_requested'
  | 'audit.access.cross_tenant'
  | 'audit.attestation.published'
  | 'audit.attestation.empty_day'
  | 'audit.schema.modified'
  | 'audit.schema.modified.completed';
