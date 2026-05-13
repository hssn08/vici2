// Audit writer (PLAN §9). The Prisma grant on audit_log is INSERT+SELECT
// only at the DB layer (per F02 PLAN §4.5); UPDATE/DELETE fail.

import { Prisma, type PrismaClient } from "@prisma/client";

export type AuditAction =
  | "auth.login.success"
  | "auth.login.failure"
  | "auth.logout"
  | "auth.logout.all"
  | "auth.refresh.success"
  | "auth.refresh.expired"
  | "auth.refresh.reuse_detected"
  | "auth.lockout.triggered"
  | "auth.lockout.released"
  | "auth.password.changed"
  | "auth.password.reset_requested"
  | "auth.password.reset_completed"
  | "auth.totp.enrolled"
  | "auth.totp.verified"
  | "auth.totp.failed"
  | "auth.role.changed"
  | "auth.user.created"
  | "auth.user.deleted"
  | "auth.user.activated"
  | "auth.user.deactivated"
  | "auth.sip.rotated"
  | "auth.sip.viewed"
  | "auth.kek.rotation_started"
  | "auth.kek.rotation_completed"
  | "auth.jwt.keys.rotated"
  // O03 alert events
  | "alert.received"
  | "alert.delivered"
  | "alert.delivery_failed"
  | "alert.receiver.created"
  | "alert.receiver.updated"
  | "alert.receiver.deleted"
  | "alert.receiver.test_fired"
  // M05 settings
  | "tenant.settings.updated"
  // R03 recording playback UI access
  | "recording.list"
  | "recording.accessed"
  // M06 carrier / gateway / DID admin
  | "carrier.created"
  | "carrier.updated"
  | "carrier.deleted"
  | "carrier.credential.rotated"
  | "carrier.test_connect"
  | "carrier.gateway.created"
  | "carrier.gateway.updated"
  | "carrier.gateway.deleted"
  | "carrier.gateway.reloaded"
  | "did.created"
  | "did.updated"
  | "did.deleted"
  | "did.bulk_imported"
  // N02 email templates
  | "email_template.created"
  | "email_template.updated"
  | "email_template.deleted"
  | "email_template.test_sent"
  | "notification_prefs.email_unsubscribed"
  // I04 — inbound callback queue
  | "callback.inbound_accepted"
  | "callback.inbound_fired"
  | "callback.inbound_deferred"
  | "callback.inbound_dead"
  | "callback.inbound_no_answer"
  // S05 coaching / quality management
  | "coaching.template.created"
  | "coaching.template.updated"
  | "coaching.template.versioned"
  | "coaching.template.deactivated"
  | "coaching.scorecard.draft_saved"
  | "coaching.scorecard.finalized"
  | "coaching.scorecard.unlocked"
  | "coaching.annotation.created"
  | "coaching.annotation.updated"
  | "coaching.annotation.deleted"
  | "coaching.feedback.created"
  | "coaching.feedback.acknowledged"
  // M07 — Pause codes, statuses, scripts
  | "pause_code.created"
  | "pause_code.updated"
  | "pause_code.deleted"
  | "status.created"
  | "status.updated"
  | "status.deleted"
  | "script.created"
  | "script.updated"
  | "script.deleted"
  | "script.restored";

export type ActorKind = "user" | "system" | "worker" | "external_api";

export interface AuditInput {
  tx: PrismaClient | Prisma.TransactionClient;
  actorUserId: bigint | number | null;
  actorKind: ActorKind;
  action: AuditAction;
  tenantId: bigint | number;
  entityType: string;
  entityId: string | null;
  beforeJson?: unknown;
  afterJson?: unknown;
  ip?: string;
  userAgent?: string;
  requestId?: string;
}

export async function audit(opts: AuditInput): Promise<void> {
  await opts.tx.auditLog.create({
    data: {
      tenantId: BigInt(opts.tenantId),
      actorUserId: opts.actorUserId === null ? null : BigInt(opts.actorUserId),
      actorKind: opts.actorKind,
      action: opts.action,
      entityType: opts.entityType,
      entityId: opts.entityId,
      beforeJson: (opts.beforeJson ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      afterJson: (opts.afterJson ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      requestId: opts.requestId ?? null,
      ipAddress: opts.ip ?? null,
      userAgent: opts.userAgent ?? null,
      ts: new Date(),
    },
  });
}

export { Prisma };
