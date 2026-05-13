/**
 * W02 — GET /api/admin/jobs/queues
 *
 * Returns all 11 queues (BullMQ + stream + tick) with current state counts.
 * Partial failures return 200 with null counts + warnings.
 * 5-second server-side cache per tenant (Valkey SET EX 5).
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getRedis } from '../../../lib/redis.js';
import { QUEUE_META, type QueueMeta } from './lib/queue-meta.js';
import { getQueue } from './lib/queue-registry.js';

interface QueueCounts {
  waiting: number | null;
  active: number | null;
  completed: number | null;
  failed: number | null;
  delayed: number | null;
  paused: number | null;
  depth: number | null;
  pending: number | null;
  lockHeld: boolean | null;
  lockHolder: string | null;
  lockTtlMs: number | null;
}

interface QueueSummary {
  name: string;
  displayName: string;
  kind: 'bullmq' | 'stream' | 'tick';
  owner: string;
  workerPackage: string;
  isPaused: boolean | null;
  counts: QueueCounts;
  dlqDepth: number;
  warning?: string;
}

async function fetchBullmqCounts(meta: QueueMeta): Promise<{ counts: QueueCounts; isPaused: boolean | null; warning?: string }> {
  try {
    const q = getQueue(meta.name);
    const [counts, isPaused] = await Promise.all([
      q.getJobCounts(),
      q.isPaused(),
    ]);
    return {
      counts: {
        waiting: counts.waiting ?? 0,
        active: counts.active ?? 0,
        completed: counts.completed ?? 0,
        failed: counts.failed ?? 0,
        delayed: counts.delayed ?? 0,
        paused: counts.paused ?? 0,
        depth: null,
        pending: null,
        lockHeld: null,
        lockHolder: null,
        lockTtlMs: null,
      },
      isPaused,
    };
  } catch (err) {
    return {
      counts: {
        waiting: null,
        active: null,
        completed: null,
        failed: null,
        delayed: null,
        paused: null,
        depth: null,
        pending: null,
        lockHeld: null,
        lockHolder: null,
        lockTtlMs: null,
      },
      isPaused: null,
      warning: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

async function fetchStreamCounts(meta: QueueMeta): Promise<{ counts: QueueCounts; isPaused: boolean | null; warning?: string }> {
  try {
    const redis = getRedis();
    const [depth, pendingResult] = await Promise.all([
      redis.xlen(meta.name),
      redis.xpending(meta.name, 'MAIN', '-', '+', '1').catch(() => null),
    ]);
    // xpending returns array of pending entries; we just want count
    const pendingCount = await redis.xpending(meta.name, 'MAIN').catch(() => 0) as number | [number, ...unknown[]];
    const pending = typeof pendingCount === 'number' ? pendingCount : (Array.isArray(pendingCount) ? (pendingCount[0] as number) : 0);
    void pendingResult; // unused
    return {
      counts: {
        waiting: null,
        active: null,
        completed: null,
        failed: null,
        delayed: null,
        paused: null,
        depth,
        pending,
        lockHeld: null,
        lockHolder: null,
        lockTtlMs: null,
      },
      isPaused: null,
    };
  } catch (err) {
    return {
      counts: {
        waiting: null,
        active: null,
        completed: null,
        failed: null,
        delayed: null,
        paused: null,
        depth: null,
        pending: null,
        lockHeld: null,
        lockHolder: null,
        lockTtlMs: null,
      },
      isPaused: null,
      warning: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

async function fetchTickCounts(meta: QueueMeta): Promise<{ counts: QueueCounts; isPaused: boolean | null; warning?: string }> {
  try {
    const redis = getRedis();
    const [lockVal, lockTtl] = await Promise.all([
      redis.get(meta.name),
      redis.pttl(meta.name),
    ]);
    const lockHeld = lockVal !== null;
    return {
      counts: {
        waiting: null,
        active: null,
        completed: null,
        failed: null,
        delayed: null,
        paused: null,
        depth: null,
        pending: null,
        lockHeld,
        lockHolder: lockHeld ? lockVal : null,
        lockTtlMs: lockTtl > 0 ? lockTtl : null,
      },
      isPaused: null,
    };
  } catch (err) {
    return {
      counts: {
        waiting: null,
        active: null,
        completed: null,
        failed: null,
        delayed: null,
        paused: null,
        depth: null,
        pending: null,
        lockHeld: null,
        lockHolder: null,
        lockTtlMs: null,
      },
      isPaused: null,
      warning: err instanceof Error ? err.message : 'Unknown error',
    };
  }
}

async function fetchDlqDepth(dlqStream: string | null): Promise<number> {
  if (!dlqStream) return 0;
  try {
    return await getRedis().xlen(dlqStream);
  } catch {
    return 0;
  }
}

async function buildQueueSummaries(): Promise<QueueSummary[]> {
  const results = await Promise.all(
    QUEUE_META.map(async (meta) => {
      let info: { counts: QueueCounts; isPaused: boolean | null; warning?: string };
      if (meta.kind === 'bullmq') {
        info = await fetchBullmqCounts(meta);
      } else if (meta.kind === 'stream') {
        info = await fetchStreamCounts(meta);
      } else {
        info = await fetchTickCounts(meta);
      }

      const dlqDepth = await fetchDlqDepth(meta.dlqStreamName);

      const summary: QueueSummary = {
        name: meta.name,
        displayName: meta.displayName,
        kind: meta.kind,
        owner: meta.owner,
        workerPackage: meta.workerPackage,
        isPaused: info.isPaused,
        counts: info.counts,
        dlqDepth,
      };
      if (info.warning) summary.warning = info.warning;
      return summary;
    }),
  );
  return results;
}

type AuthReq = FastifyRequest & {
  auth?: { uid: number; tenantId: number; role: string };
};

export async function handleGetQueues(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = (req as AuthReq).auth;
  const tenantId = auth?.tenantId ?? 0;

  // 5-second server-side cache per tenant
  const cacheKey = `jobs:queueSummary:${tenantId}`;
  const redis = getRedis();
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      return reply.send(JSON.parse(cached));
    }
  } catch {
    // cache miss on error — continue
  }

  const queues = await buildQueueSummaries();
  const response = { queues, fetchedAt: new Date().toISOString() };

  try {
    await redis.set(cacheKey, JSON.stringify(response), 'EX', 5);
  } catch {
    // non-fatal cache write failure
  }

  return reply.send(response);
}
