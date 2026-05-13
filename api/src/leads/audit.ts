// D01 — Audit log wrapper (PLAN §9)
// Wraps the shared audit() writer with D01's action catalog.

import { audit as writeAudit, type ActorKind } from "../auth/audit.js";
import { Prisma } from "../auth/audit.js";

export type LeadAuditAction =
  | "lead.created"
  | "lead.updated"
  | "lead.deleted"
  | "lead.bulk_inserted"
  | "lead.field_indexed"
  | "lead.exported";

export interface LeadAuditInput {
  tx: Parameters<typeof writeAudit>[0]["tx"];
  action: LeadAuditAction;
  tenantId: bigint | number;
  actorUserId: bigint | number | null;
  actorKind?: ActorKind;
  entityId: string | null;
  before?: unknown;
  after?: unknown;
  details?: unknown;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export async function auditLead(opts: LeadAuditInput): Promise<void> {
  await writeAudit({
    tx: opts.tx,
    action: opts.action as Parameters<typeof writeAudit>[0]["action"],
    tenantId: opts.tenantId,
    actorUserId: opts.actorUserId,
    actorKind: opts.actorKind ?? "user",
    entityType: "lead",
    entityId: opts.entityId,
    beforeJson: opts.before ?? (opts.details ? undefined : Prisma.JsonNull),
    afterJson: opts.after ?? opts.details ?? Prisma.JsonNull,
    ip: opts.ip,
    userAgent: opts.userAgent,
    requestId: opts.requestId,
  });
}

/**
 * Compute a diff of changed keys between before and after objects.
 * Returns { before: { key: oldVal }, after: { key: newVal } } for changed keys only.
 */
export function diffLeadChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  patchKeys: string[],
): { before: Record<string, unknown>; after: Record<string, unknown> } {
  const diffBefore: Record<string, unknown> = {};
  const diffAfter: Record<string, unknown> = {};
  for (const key of patchKeys) {
    const oldVal = before[key];
    const newVal = after[key];
    if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
      diffBefore[key] = oldVal;
      diffAfter[key] = newVal;
    }
  }
  return { before: diffBefore, after: diffAfter };
}
