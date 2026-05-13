// RBAC audit helpers (M02 PLAN §9).
// Thin wrappers that format the deny / sensitive-allow payloads.
// Actual write goes through the caller-supplied AuditWriter (C03 contract).

import type { AuthContext, Decision, DenyReason, ScopeContext } from './can.js';
import type { Verb } from '@vici2/types';
import { MATRIX_VERSION } from './cache.js';

// ---------------------------------------------------------------------------
// Minimal AuditWriter contract (matches C03 HANDOFF)
// ---------------------------------------------------------------------------

export interface AuditRow {
  action:    string;
  actorId?:  bigint;
  tenantId?: bigint;
  afterJson: unknown;
}

export interface AuditWriter {
  append(row: AuditRow): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Emit rbac.denied audit row. Escalates to 500 on AuditWriter failure. */
export async function auditDeny(
  writer:   AuditWriter,
  auth:     AuthContext,
  verb:     Verb,
  scope:    ScopeContext,
  reason:   DenyReason,
): Promise<void> {
  await writer.append({
    action:   'rbac.denied',
    actorId:  auth.uid,
    tenantId: auth.tenantId,
    afterJson: {
      verb,
      scope:          scopeForAudit(scope),
      reason,
      actor: {
        role:        auth.role,
        uid:         auth.uid.toString(),
        userGroupId: auth.userGroupId?.toString() ?? null,
      },
      matrix_version: MATRIX_VERSION,
    },
  });
}

/** Emit rbac.allowed_sensitive audit row. Escalates to 500 on failure. */
export async function auditSensitiveAllow(
  writer:   AuditWriter,
  auth:     AuthContext,
  verb:     Verb,
  scope:    ScopeContext,
): Promise<void> {
  await writer.append({
    action:   'rbac.allowed_sensitive',
    actorId:  auth.uid,
    tenantId: auth.tenantId,
    afterJson: {
      verb,
      scope:          scopeForAudit(scope),
      actor: {
        role:        auth.role,
        uid:         auth.uid.toString(),
        userGroupId: auth.userGroupId?.toString() ?? null,
      },
      matrix_version: MATRIX_VERSION,
    },
  });
}

/** Emit rbac.system_error audit row (cache/matrix failure). */
export async function auditSystemError(
  writer:   AuditWriter,
  auth:     AuthContext,
  verb:     Verb,
  detail:   string,
): Promise<void> {
  await writer.append({
    action:   'rbac.system_error',
    actorId:  auth.uid,
    tenantId: auth.tenantId,
    afterJson: { verb, detail, matrix_version: MATRIX_VERSION },
  });
}

// Serialize scope — entity IDs only, no PII.
function scopeForAudit(scope: ScopeContext): Record<string, string | undefined> {
  return {
    tenantId:     scope.tenantId?.toString(),
    campaignId:   scope.campaignId?.toString(),
    ownerUserId:  scope.ownerUserId?.toString(),
    targetUserId: scope.targetUserId?.toString(),
    entityId:     scope.entityId?.toString(),
  };
}

// ---------------------------------------------------------------------------
// Decision helper — checks decision and emits appropriate audit row.
// Returns the original decision unchanged (pass-through).
// Throws if sensitive-allow audit write fails (escalate to 500).
// Throws if deny audit write fails (escalate to 500 instead of 403).
// ---------------------------------------------------------------------------

export async function auditDecision(
  writer:   AuditWriter,
  auth:     AuthContext,
  verb:     Verb,
  scope:    ScopeContext,
  decision: Decision,
): Promise<Decision> {
  if (!decision.allow) {
    await auditDeny(writer, auth, verb, scope, decision.reason);
  } else if (decision.sensitive) {
    await auditSensitiveAllow(writer, auth, verb, scope);
  }
  return decision;
}
