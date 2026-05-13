/**
 * W02 — Typed audit log wrappers for jobs queue admin mutations.
 *
 * Each mutation action maps to one audit_log row via AuditWriter.
 * Read operations do not produce audit rows (per PLAN §4).
 *
 * Action identifiers (FROZEN per W02 PLAN §4):
 *   jobs.retry          POST /queues/:q/jobs/:id/retry
 *   jobs.remove         DELETE /queues/:q/jobs/:id
 *   jobs.queue.pause    POST /queues/:q/pause
 *   jobs.queue.resume   POST /queues/:q/resume
 *   jobs.queue.drain    POST /queues/:q/drain
 *   jobs.unmask         GET /queues/:q/jobs/:id with X-Jobs-Unmask: 1
 *   jobs.dlq.retry      POST /dlq/:q/:eid/retry
 *   jobs.dlq.drain      DELETE /dlq/:q
 */

import { AuditWriter } from '../../../../services/audit/writer.js';
import { getPrisma } from '../../../../lib/prisma.js';

function getWriter(): AuditWriter {
  return new AuditWriter(getPrisma());
}

interface BaseAuditCtx {
  userId: bigint;
  tenantId: bigint;
  ipAddress: string | null;
  requestId?: string;
}

export async function auditJobRetry(
  ctx: BaseAuditCtx,
  queue: string,
  jobId: string,
): Promise<void> {
  await getWriter().appendAuditLog({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'user',
    action: 'jobs.retry',
    entityType: 'job',
    entityId: jobId,
    afterJson: { queue, jobId },
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress,
    ts: new Date(),
  });
}

export async function auditJobRemove(
  ctx: BaseAuditCtx,
  queue: string,
  jobId: string,
): Promise<void> {
  await getWriter().appendAuditLog({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'user',
    action: 'jobs.remove',
    entityType: 'job',
    entityId: jobId,
    afterJson: { queue, jobId },
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress,
    ts: new Date(),
  });
}

export async function auditQueuePause(
  ctx: BaseAuditCtx,
  queue: string,
): Promise<void> {
  await getWriter().appendAuditLog({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'user',
    action: 'jobs.queue.pause',
    entityType: 'queue',
    entityId: queue,
    afterJson: { queue },
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress,
    ts: new Date(),
  });
}

export async function auditQueueResume(
  ctx: BaseAuditCtx,
  queue: string,
): Promise<void> {
  await getWriter().appendAuditLog({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'user',
    action: 'jobs.queue.resume',
    entityType: 'queue',
    entityId: queue,
    afterJson: { queue },
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress,
    ts: new Date(),
  });
}

export async function auditQueueDrain(
  ctx: BaseAuditCtx,
  queue: string,
  delayed: boolean,
): Promise<void> {
  await getWriter().appendAuditLog({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'user',
    action: 'jobs.queue.drain',
    entityType: 'queue',
    entityId: queue,
    afterJson: { queue, delayed },
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress,
    ts: new Date(),
  });
}

export async function auditJobUnmask(
  ctx: BaseAuditCtx,
  queue: string,
  jobId: string,
): Promise<void> {
  await getWriter().appendAuditLog({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'user',
    action: 'jobs.unmask',
    entityType: 'job',
    entityId: jobId,
    afterJson: { queue, jobId },
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress,
    ts: new Date(),
  });
}

export async function auditDlqRetry(
  ctx: BaseAuditCtx,
  queue: string,
  entryId: string,
  newJobId: string,
): Promise<void> {
  await getWriter().appendAuditLog({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'user',
    action: 'jobs.dlq.retry',
    entityType: 'dlq_entry',
    entityId: entryId,
    afterJson: { queue, entryId, newJobId },
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress,
    ts: new Date(),
  });
}

export async function auditDlqDrain(
  ctx: BaseAuditCtx,
  queue: string,
  entriesRemoved: number,
): Promise<void> {
  await getWriter().appendAuditLog({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'user',
    action: 'jobs.dlq.drain',
    entityType: 'dlq',
    entityId: queue,
    afterJson: { queue, entriesRemoved },
    requestId: ctx.requestId ?? null,
    ipAddress: ctx.ipAddress,
    ts: new Date(),
  });
}
