/**
 * W02 — DLQ (dead-letter queue) Valkey stream handlers.
 *
 * GET    /api/admin/jobs/dlq/:queue          — list entries
 * POST   /api/admin/jobs/dlq/:queue/:eid/retry — replay single entry
 * DELETE /api/admin/jobs/dlq/:queue           — drain entire DLQ stream
 *
 * DLQ streams use bare XADD (no consumer groups). "Acknowledging" a replayed
 * entry means XDEL (permanent removal).
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ulid } from 'ulidx';
import { getRedis } from '../../../lib/redis.js';
import { findQueueMeta, QUEUE_META } from './lib/queue-meta.js';
import { getQueue, resolveQueueName } from './lib/queue-registry.js';
import { maskAndTruncate } from './lib/mask-job-data.js';
import { auditDlqRetry, auditDlqDrain } from './lib/audit-jobs.js';

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

/** Resolve DLQ stream name from a queue short name or full name. */
function resolveDlqStream(queueParam: string): { dlqStream: string; meta: ReturnType<typeof findQueueMeta> } {
  // Try by full name or short name
  const meta = findQueueMeta(queueParam)
    ?? QUEUE_META.find((q) => q.dlqStreamName?.endsWith('.' + queueParam));

  if (!meta || !meta.dlqStreamName) {
    const err = Object.assign(
      new Error(`No DLQ stream found for queue: ${queueParam}`),
      { statusCode: 404, code: 'DLQ_NOT_FOUND' },
    );
    throw err;
  }
  return { dlqStream: meta.dlqStreamName, meta };
}

/** Parse stream entry ID to timestamp ms. */
function entryIdToTs(entryId: string): number {
  const ms = parseInt(entryId.split('-')[0], 10);
  return isNaN(ms) ? 0 : ms;
}

/** Flatten a Record into alternating key-value pairs for XADD. */
function flattenForXadd(obj: Record<string, unknown>): string[] {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    pairs.push(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// GET /api/admin/jobs/dlq/:queue
// ---------------------------------------------------------------------------

const GetDlqQuerySchema = z.object({
  cursor: z.string().optional().default('-'),
  count: z.string().optional().transform((v) => (v != null ? Number(v) : 20)).pipe(z.number().int().min(1).max(100)),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

export async function handleGetDlq(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string };
  const auth = getAuth(req);
  const unmaskHeader = (req.headers as Record<string, string | string[] | undefined>)['x-jobs-unmask'];
  const requestUnmask = unmaskHeader === '1' && auth.role === 'super_admin';

  const { dlqStream } = resolveDlqStream(params.queue);

  const parsed = GetDlqQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'VALIDATION_ERROR', message: parsed.error.message });
  }
  const { cursor, count, order } = parsed.data;

  const redis = getRedis();
  const [entries, total] = await Promise.all([
    order === 'desc'
      ? redis.xrevrange(dlqStream, cursor === '-' ? '+' : cursor, '-', 'COUNT', count) as Promise<[string, string[]][]>
      : redis.xrange(dlqStream, cursor, '+', 'COUNT', count) as Promise<[string, string[]][]>,
    redis.xlen(dlqStream),
  ]);

  const mapped = entries.map(([entryId, fields]) => {
    // Stream entry fields are alternating key/value pairs
    const fieldMap: Record<string, string> = {};
    for (let i = 0; i < fields.length - 1; i += 2) {
      fieldMap[fields[i]] = fields[i + 1];
    }

    let payload: unknown = {};
    try {
      payload = JSON.parse(fieldMap.payload ?? '{}');
    } catch {
      payload = { _raw: fieldMap.payload };
    }

    if (!requestUnmask) {
      payload = maskAndTruncate(payload).data;
    }

    return {
      entryId,
      ts: entryIdToTs(entryId),
      worker: fieldMap.worker ?? '',
      sourceQueue: fieldMap.source_queue ?? '',
      sourceId: fieldMap.source_id ?? '',
      payload,
      error: fieldMap.error ?? '',
      errorStack: fieldMap.error_stack ?? '',
      attempt: parseInt(fieldMap.attempt ?? '0', 10),
      workerId: fieldMap.worker_id ?? '',
      tenantId: fieldMap.tenant_id ?? '',
      _masked: !requestUnmask,
    };
  });

  const lastEntry = entries[entries.length - 1];
  const nextCursor = lastEntry ? lastEntry[0] : null;

  return reply.send({
    entries: mapped,
    total,
    queue: params.queue,
    streamName: dlqStream,
    nextCursor: entries.length < count ? null : nextCursor,
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/jobs/dlq/:queue/:eid/retry
// ---------------------------------------------------------------------------

export async function handleDlqRetry(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string; eid: string };
  const { dlqStream, meta } = resolveDlqStream(params.queue);
  const redis = getRedis();

  // Fetch the single entry
  const entries = await redis.xrange(dlqStream, params.eid, params.eid) as [string, string[]][];
  if (!entries.length) {
    return reply.code(404).send({ error: 'DLQ_ENTRY_NOT_FOUND', message: `DLQ entry ${params.eid} not found` });
  }

  const [entryId, fields] = entries[0];
  const fieldMap: Record<string, string> = {};
  for (let i = 0; i < fields.length - 1; i += 2) {
    fieldMap[fields[i]] = fields[i + 1];
  }

  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(fieldMap.payload ?? '{}') as Record<string, unknown>;
  } catch {
    payload = { _raw: fieldMap.payload };
  }

  const newJobId = ulid();
  const sourceQueue = fieldMap.source_queue ?? '';

  if (meta && meta.kind === 'stream') {
    // Stream-based worker: XADD back to source stream
    const flatFields = flattenForXadd(payload);
    await redis.xadd(sourceQueue, '*', ...flatFields);
  } else {
    // BullMQ worker: Queue.add() to source queue
    try {
      const fullQueueName = resolveQueueName(sourceQueue);
      const targetQueue = getQueue(fullQueueName);
      const workerName = fieldMap.worker ?? 'unknown';
      await targetQueue.add(workerName, payload, { jobId: newJobId });
    } catch (err) {
      // If we can't resolve the queue, fall back to writing to source stream name
      const msg = err instanceof Error ? err.message : String(err);
      if (!(msg.includes('QUEUE_NOT_FOUND') || msg.includes('QUEUE_KIND_MISMATCH'))) {
        throw err;
      }
      // Unknown queue — log and continue with XADD fallback
      const flatFields = flattenForXadd(payload);
      await redis.xadd(sourceQueue, '*', ...flatFields);
    }
  }

  await auditDlqRetry(buildCtx(req), params.queue, entryId, newJobId);

  // XDEL to permanently remove from DLQ (no consumer groups on DLQ streams)
  await redis.xdel(dlqStream, entryId);

  return reply.send({ retried: true, newJobId, entryId });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/jobs/dlq/:queue
// ---------------------------------------------------------------------------

const DrainDlqBodySchema = z.object({
  confirm: z.string(),
});

export async function handleDlqDrain(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string };
  const { dlqStream } = resolveDlqStream(params.queue);

  const expected = `drain dlq ${params.queue}`;
  const parsed = DrainDlqBodySchema.safeParse(req.body);
  if (!parsed.success || parsed.data.confirm !== expected) {
    return reply.code(400).send({
      error: 'CONFIRMATION_REQUIRED',
      message: `Body must include { "confirm": "${expected}" }`,
    });
  }

  const redis = getRedis();
  const count = await redis.xlen(dlqStream);
  // XTRIM to 0 removes all entries but preserves the stream key
  await redis.xtrim(dlqStream, 'MAXLEN', 0);
  await auditDlqDrain(buildCtx(req), params.queue, count);

  return reply.send({ drained: true, entriesRemoved: count, queue: params.queue });
}
