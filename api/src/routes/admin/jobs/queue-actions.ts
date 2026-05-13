/**
 * W02 — Queue and job mutation handlers.
 *
 * POST  /api/admin/jobs/queues/:queue/jobs/:id/retry
 * DELETE /api/admin/jobs/queues/:queue/jobs/:id
 * POST  /api/admin/jobs/queues/:queue/pause
 * POST  /api/admin/jobs/queues/:queue/resume
 * POST  /api/admin/jobs/queues/:queue/drain
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getQueue, resolveQueueName } from './lib/queue-registry.js';
import { findQueueMeta } from './lib/queue-meta.js';
import {
  auditJobRetry,
  auditJobRemove,
  auditQueuePause,
  auditQueueResume,
  auditQueueDrain,
} from './lib/audit-jobs.js';

type AuthReq = FastifyRequest & {
  auth?: { uid: number; tenantId: number; role: string };
};

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

function buildCtx(req: FastifyRequest) {
  const auth = getAuth(req);
  return {
    userId: BigInt(auth.uid),
    tenantId: BigInt(auth.tenantId),
    ipAddress: req.ip ?? null,
    requestId: (req.headers['x-request-id'] as string) ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// POST /queues/:queue/jobs/:id/retry
// ---------------------------------------------------------------------------

export async function handleJobRetry(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string; id: string };
  const fullName = resolveQueueName(params.queue);
  const meta = findQueueMeta(fullName);
  if (!meta || meta.kind !== 'bullmq') {
    return reply.code(400).send({ error: 'QUEUE_KIND_MISMATCH', message: 'Retry only available for BullMQ queues' });
  }

  const queue = getQueue(fullName);
  const job = await queue.getJob(params.id);
  if (!job) {
    return reply.code(404).send({ error: 'JOB_NOT_FOUND', message: `Job ${params.id} not found` });
  }

  const state = await job.getState();
  if (state !== 'failed') {
    return reply.code(409).send({ error: 'NOT_FAILED', message: `Job is in state '${state}', not 'failed'` });
  }

  await job.retry('failed');
  await auditJobRetry(buildCtx(req), fullName, params.id);

  const newState = await job.getState();
  return reply.send({ jobId: params.id, state: newState, queue: fullName });
}

// ---------------------------------------------------------------------------
// DELETE /queues/:queue/jobs/:id
// ---------------------------------------------------------------------------

export async function handleJobRemove(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string; id: string };
  const fullName = resolveQueueName(params.queue);
  const meta = findQueueMeta(fullName);
  if (!meta || meta.kind !== 'bullmq') {
    return reply.code(400).send({ error: 'QUEUE_KIND_MISMATCH', message: 'Remove only available for BullMQ queues' });
  }

  const queue = getQueue(fullName);
  const job = await queue.getJob(params.id);
  if (!job) {
    return reply.code(404).send({ error: 'JOB_NOT_FOUND', message: `Job ${params.id} not found` });
  }

  try {
    await job.remove();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('active')) {
      return reply.code(409).send({
        error: 'JOB_ACTIVE',
        message: 'Cannot remove an active job. Wait for it to complete or fail first.',
      });
    }
    throw err;
  }

  await auditJobRemove(buildCtx(req), fullName, params.id);
  return reply.code(204).send();
}

// ---------------------------------------------------------------------------
// POST /queues/:queue/pause
// ---------------------------------------------------------------------------

export async function handleQueuePause(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string };
  const fullName = resolveQueueName(params.queue);
  const meta = findQueueMeta(fullName);
  if (!meta || meta.kind !== 'bullmq') {
    return reply.code(400).send({ error: 'QUEUE_KIND_MISMATCH', message: 'Pause only available for BullMQ queues' });
  }

  const queue = getQueue(fullName);
  const alreadyPaused = await queue.isPaused();
  if (alreadyPaused) {
    return reply.send({ paused: true, queue: fullName });
  }

  await queue.pause();
  await auditQueuePause(buildCtx(req), fullName);
  return reply.send({ paused: true, queue: fullName });
}

// ---------------------------------------------------------------------------
// POST /queues/:queue/resume
// ---------------------------------------------------------------------------

export async function handleQueueResume(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string };
  const fullName = resolveQueueName(params.queue);
  const meta = findQueueMeta(fullName);
  if (!meta || meta.kind !== 'bullmq') {
    return reply.code(400).send({ error: 'QUEUE_KIND_MISMATCH', message: 'Resume only available for BullMQ queues' });
  }

  const queue = getQueue(fullName);
  const isPaused = await queue.isPaused();
  if (!isPaused) {
    return reply.send({ paused: false, queue: fullName });
  }

  await queue.resume();
  await auditQueueResume(buildCtx(req), fullName);
  return reply.send({ paused: false, queue: fullName });
}

// ---------------------------------------------------------------------------
// POST /queues/:queue/drain
// ---------------------------------------------------------------------------

const DrainBodySchema = z.object({
  confirm: z.string(),
});

export async function handleQueueDrain(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string };
  const query = req.query as { delayed?: string };
  const fullName = resolveQueueName(params.queue);
  const meta = findQueueMeta(fullName);
  if (!meta || meta.kind !== 'bullmq') {
    return reply.code(400).send({ error: 'QUEUE_KIND_MISMATCH', message: 'Drain only available for BullMQ queues' });
  }

  // Short display name for confirmation (use full name as fallback)
  const shortName = meta.displayName || fullName;
  const expected = `drain ${shortName}`;
  const parsed = DrainBodySchema.safeParse(req.body);
  if (!parsed.success || parsed.data.confirm !== expected) {
    return reply.code(400).send({
      error: 'CONFIRMATION_REQUIRED',
      message: `Body must include { "confirm": "${expected}" }`,
    });
  }

  const delayed = query.delayed === 'true';
  const queue = getQueue(fullName);
  await queue.drain(delayed);
  await auditQueueDrain(buildCtx(req), fullName, delayed);

  return reply.send({ drained: true, queue: fullName, delayed });
}
