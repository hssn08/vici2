/**
 * api/src/services/audit/canonicalize.ts
 *
 * Per-row canonical byte-string builder, matching the MySQL BEFORE INSERT
 * trigger exactly (PLAN §3.2).
 *
 * The output is the string that gets SHA-256'd to produce row_hash.
 * Both this module and the Go dialer/internal/audit/canonicalize.go MUST
 * produce the same bytes for every fixture in test/fixtures/canonicalization/.
 *
 * Separator: CHAR(31) = 0x1F (ASCII Unit Separator). Never appears in
 * VARCHAR/JSON columns (Zod enforces in events.ts).
 *
 * NULL serialization: two-char literal '\N' (MySQL LOAD DATA convention).
 * Empty string '' and NULL produce DIFFERENT canonical forms.
 *
 * Timestamps: ISO 8601 with microseconds + literal Z suffix.
 * '%Y-%m-%dT%H:%i:%s.%fZ' in MySQL; toISOStringMicros() here.
 *
 * Numeric columns: LPAD zero to 20 chars so byte-length is stable.
 * JSON columns: RFC 8785 JCS (canonicalize()) — matches MySQL JSON_EXTRACT($).
 */

import { canonicalize as jcs } from '../../../../shared/lib/jcs.js';

export const SEP = '\x1f'; // 0x1F Unit Separator
export const NULL_SENTINEL = '\\N';

export type AuditTable =
  | 'audit_log'
  | 'call_window_audit'
  | 'originate_audit'
  | 'consent_log'
  | 'dnc_sync_log'
  | 'audit_attestation';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Pad a BigInt/number to 20 zero-padded decimal chars. */
export function lpad20(n: bigint | number): string {
  return String(n).padStart(20, '0');
}

/** Serialize a nullable string as '\N' for nulls, raw string otherwise. */
export function nullOrStr(v: string | null | undefined): string {
  return v == null ? NULL_SENTINEL : v;
}

/** Serialize a nullable bigint/number. */
export function nullOrNum(v: bigint | number | null | undefined): string {
  return v == null ? NULL_SENTINEL : String(v);
}

/**
 * Format a Date as ISO 8601 with microseconds + literal Z.
 * MySQL: DATE_FORMAT(col, '%Y-%m-%dT%H:%i:%s.%fZ')
 * Note: JS Date has millisecond precision; we extend to microseconds by
 * appending '000' — matches the DB which stores DATETIME(6).
 */
export function toISOStringMicros(d: Date): string {
  const iso = d.toISOString(); // e.g. 2026-05-12T07:00:00.123Z
  // Replace the trailing 'Z' with '000Z' to get microseconds (6 fractional digits)
  // iso is always ".MMMZ"
  return iso.replace(/\.(\d{3})Z$/, '.$1000Z');
}

/** Nullable date. */
export function nullOrDate(d: Date | null | undefined): string {
  return d == null ? NULL_SENTINEL : toISOStringMicros(d);
}

/** JCS-canonicalize a JSON value; return '\N' for null/undefined. */
export function nullOrJson(v: unknown): string {
  if (v == null) return NULL_SENTINEL;
  return jcs(v);
}

// ---------------------------------------------------------------------------
// Per-table canonical builder types
// ---------------------------------------------------------------------------

export interface AuditLogCanonFields {
  prevHash: string;
  tenantId: bigint;
  id: bigint;
  ts: Date;
  actorUserId: bigint | null;
  actorKind: string;
  action: string;
  entityType: string;
  entityId: string | null;
  beforeJson: unknown;
  afterJson: unknown;
  requestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

export interface CallWindowAuditCanonFields {
  prevHash: string;
  tenantId: bigint;
  id: bigint;
  createdAt: Date;
  leadId: bigint;
  phoneE164: string;
  campaignId: string;
  decision: string;
  reason: string;
  tzIana: string | null;
  tzConfidence: string | null;
  stateCode: string | null;
  zip: string | null;
  partyLocal: Date | null;
  partyDow: number | null;
  effectiveOpenMin: number | null;
  effectiveCloseMin: number | null;
  ruleApplied: string | null;
  enforcementPoint: string;
  nextOpenAt: Date | null;
  callUuid: string | null;
}

export interface OriginateAuditCanonFields {
  prevHash: string;
  tenantId: bigint;
  id: bigint;
  originatedAt: Date;
  leadId: bigint;
  phoneE164: string;
  campaignId: string | null;
  outcome: string;
  tcpaReason: string | null;
  dncDecision: string | null;
  dncSources: unknown;
  tcpaDecision: string | null;
  callUuid: string | null;
}

export interface ConsentLogCanonFields {
  prevHash: string;
  tenantId: bigint;
  id: bigint;
  callUuid: string;
  leadId: bigint;
  phoneE164: string;
  promptId: string;
  dtmfResponse: string | null;
  outcome: string;
  language: string;
  promptPlayedAt: Date;
}

export interface DncSyncLogCanonFields {
  prevHash: string;
  // dnc_sync_log is global; chain uses tenant_id=1 sentinel
  id: bigint;
  source: string;
  kind: string;
  fileHash: string | null;
  added: number;
  removed: number;
  startedAt: Date;
  completedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Canonical string builders
// ---------------------------------------------------------------------------

export function canonicalAuditLog(f: AuditLogCanonFields): string {
  return [
    f.prevHash,
    lpad20(f.tenantId),
    'audit_log',
    lpad20(f.id),
    toISOStringMicros(f.ts),
    f.actorUserId == null ? NULL_SENTINEL : String(f.actorUserId),
    f.actorKind,
    f.action,
    f.entityType,
    nullOrStr(f.entityId),
    nullOrJson(f.beforeJson),
    nullOrJson(f.afterJson),
    nullOrStr(f.requestId),
    nullOrStr(f.ipAddress),
    nullOrStr(f.userAgent),
  ].join(SEP);
}

export function canonicalCallWindowAudit(f: CallWindowAuditCanonFields): string {
  return [
    f.prevHash,
    lpad20(f.tenantId),
    'call_window_audit',
    lpad20(f.id),
    toISOStringMicros(f.createdAt),
    String(f.leadId),
    f.phoneE164,
    f.campaignId,
    f.decision,
    f.reason,
    nullOrStr(f.tzIana),
    nullOrStr(f.tzConfidence),
    nullOrStr(f.stateCode),
    nullOrStr(f.zip),
    nullOrDate(f.partyLocal),
    f.partyDow == null ? NULL_SENTINEL : String(f.partyDow),
    f.effectiveOpenMin == null ? NULL_SENTINEL : String(f.effectiveOpenMin),
    f.effectiveCloseMin == null ? NULL_SENTINEL : String(f.effectiveCloseMin),
    nullOrStr(f.ruleApplied),
    f.enforcementPoint,
    nullOrDate(f.nextOpenAt),
    nullOrStr(f.callUuid),
  ].join(SEP);
}

export function canonicalOriginateAudit(f: OriginateAuditCanonFields): string {
  return [
    f.prevHash,
    lpad20(f.tenantId),
    'originate_audit',
    lpad20(f.id),
    toISOStringMicros(f.originatedAt),
    String(f.leadId),
    f.phoneE164,
    nullOrStr(f.campaignId),
    f.outcome,
    nullOrStr(f.tcpaReason),
    nullOrStr(f.dncDecision),
    nullOrJson(f.dncSources),
    nullOrStr(f.tcpaDecision),
    nullOrStr(f.callUuid),
    nullOrJson(f.dncSources), // payload field — per PLAN §3.5
  ].join(SEP);
}

export function canonicalConsentLog(f: ConsentLogCanonFields): string {
  return [
    f.prevHash,
    lpad20(f.tenantId),
    'consent_log',
    lpad20(f.id),
    f.callUuid,
    String(f.leadId),
    f.phoneE164,
    f.promptId,
    nullOrStr(f.dtmfResponse),
    f.outcome,
    f.language,
    toISOStringMicros(f.promptPlayedAt),
  ].join(SEP);
}

export function canonicalDncSyncLog(f: DncSyncLogCanonFields): string {
  return [
    f.prevHash,
    lpad20(1), // global table; tenant sentinel = 1
    'dnc_sync_log',
    lpad20(f.id),
    f.source,
    f.kind,
    nullOrStr(f.fileHash),
    String(f.added),
    String(f.removed),
    toISOStringMicros(f.startedAt),
    nullOrDate(f.completedAt),
  ].join(SEP);
}

/** Compute SHA-256 over the canonical string. Returns lowercase 64-char hex. */
export async function hashCanonical(canonical: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
