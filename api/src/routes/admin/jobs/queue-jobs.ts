/**
 * W02 — GET /api/admin/jobs/queues/:queue/jobs
 *        GET /api/admin/jobs/queues/:queue/jobs/:id
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getQueue, resolveQueueName } from './lib/queue-registry.js';
import { findQueueMeta } from './lib/queue-meta.js';
import { maskAndTruncate } from './lib/mask-job-data.js';
import { auditJobUnmask } from './lib/audit-jobs.js';

const JobStateSchema = z.enum(['waiting', 'active', 'completed', 'failed', 'delayed', 'paused']);

const GetJobsQuerySchema = z.object({
  state: JobStateSchema,
  page: z.string().optional().transform((v) => (v != null ? Number(v) : 0)).pipe(z.number().int().min(0)),
  pageSize: z.string().optional().transform((v) => (v != null ? Number(v) : 20)).pipe(z.number().int().min(1).max(100)),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});

type AuthReq = FastifyRequest & {
  auth?: { uid: number; tenantId: number; role: string };
};

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

export async function handleGetJobs(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string };
  const fullName = resolveQueueName(params.queue);
  const meta = findQueueMeta(fullName);
  if (!meta || meta.kind !== 'bullmq') {
    return reply.code(400).send({ error: 'QUEUE_KIND_MISMATCH', message: 'Job listing only available for BullMQ queues' });
  }

  const parsed = GetJobsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'VALIDATION_ERROR', message: parsed.error.message });
  }
  const { state, page, pageSize, order } = parsed.data;

  const queue = getQueue(fullName);

  const [jobs, total] = await Promise.all([
    queue.getJobs([state], page * pageSize, (page + 1) * pageSize - 1, order === 'asc'),
    queue.getJobCountByTypes(state),
  ]);

  const jobSummaries = jobs.map((job) => ({
    id: job.id ?? '',
    name: job.name,
    queue: fullName,
    state,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 3,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    delay: job.opts.delay ?? 0,
    priority: job.opts.priority ?? 0,
    failedReason: job.failedReason ?? null,
  }));

  return reply.send({
    jobs: jobSummaries,
    total,
    page,
    pageSize,
    state,
    queue: fullName,
  });
}

export async function handleGetJobDetail(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const params = req.params as { queue: string; id: string };
  const auth = getAuth(req);
  const fullName = resolveQueueName(params.queue);
  const meta = findQueueMeta(fullName);
  if (!meta || meta.kind !== 'bullmq') {
    return reply.code(400).send({ error: 'QUEUE_KIND_MISMATCH', message: 'Job detail only available for BullMQ queues' });
  }

  const queue = getQueue(fullName);
  const job = await queue.getJob(params.id);
  if (!job) {
    return reply.code(404).send({ error: 'JOB_NOT_FOUND', message: `Job ${params.id} not found in queue ${fullName}` });
  }

  const unmaskHeader = (req.headers as Record<string, string | string[] | undefined>)['x-jobs-unmask'];
  const requestUnmask = unmaskHeader === '1';

  if (requestUnmask && auth.role !== 'super_admin') {
    return reply.code(403).send({ error: 'FORBIDDEN', message: 'X-Jobs-Unmask requires super_admin role' });
  }

  let dataResult: ReturnType<typeof maskAndTruncate>;
  let rvResult: ReturnType<typeof maskAndTruncate>;

  if (requestUnmask) {
    // Write audit row for unmask
    await auditJobUnmask(
      {
        userId: BigInt(auth.uid),
        tenantId: BigInt(auth.tenantId),
        ipAddress: req.ip ?? null,
        requestId: (req.headers['x-request-id'] as string) ?? undefined,
      },
      fullName,
      params.id,
    );
    dataResult = { data: job.data, truncated: false, masked: false };
    rvResult = { data: job.returnvalue ?? null, truncated: false, masked: false };
  } else {
    dataResult = maskAndTruncate(job.data);
    rvResult = maskAndTruncate(job.returnvalue ?? null);
  }

  const state = await job.getState();
  const logs = await queue.getJobLogs(params.id);

  return reply.send({
    id: job.id ?? '',
    name: job.name,
    queue: fullName,
    state,
    attemptsMade: job.attemptsMade,
    maxAttempts: job.opts.attempts ?? 3,
    timestamp: job.timestamp,
    processedOn: job.processedOn ?? null,
    finishedOn: job.finishedOn ?? null,
    delay: job.opts.delay ?? 0,
    priority: job.opts.priority ?? 0,
    failedReason: job.failedReason ?? null,
    stacktrace: job.stacktrace ?? [],
    opts: job.opts,
    data: dataResult.data,
    returnvalue: rvResult.data,
    logs: logs.logs ?? [],
    _dataTruncated: dataResult.truncated,
    _returnvalueTruncated: rvResult.truncated,
    _masked: dataResult.masked || rvResult.masked,
  });
}
