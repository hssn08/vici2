// D06 — Audit event catalog for callbacks.
// Every state transition writes an audit_log row via this module.

import type { PrismaClient } from "@prisma/client";

export type CallbackAction =
  | "callback.scheduled"
  | "callback.snoozed"
  | "callback.fired"
  | "callback.cancelled"
  | "callback.claimed"
  | "callback.reassigned"
  | "callback.bulk_reassigned"
  | "callback.completed"
  | "callback.rescheduled"
  | "callback.stale_detected";

export type ActorKind = "user" | "worker" | "system";

export interface AuditCallbackPayload {
  prisma: PrismaClient;
  tenantId: bigint;
  callbackId: bigint;
  action: CallbackAction;
  actorKind: ActorKind;
  actorUserId?: bigint | null;
  detailsJson?: Record<string, unknown>;
}

export async function writeCallbackAudit({
  prisma,
  tenantId,
  callbackId,
  action,
  actorKind,
  actorUserId,
  detailsJson,
}: AuditCallbackPayload): Promise<void> {
  await prisma.auditLog.create({
    data: {
      tenantId,
      actorKind: actorKind === "worker" ? "worker" : actorKind === "system" ? "system" : "user",
      actorUserId: actorUserId ?? null,
      action,
      entityType: "callback",
      entityId: String(callbackId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      afterJson: (detailsJson ?? {}) as any,
      ts: new Date(),
    },
  });
}
