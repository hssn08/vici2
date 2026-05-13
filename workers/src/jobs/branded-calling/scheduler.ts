// N05 — Branded Calling reputation poll scheduler.
// Enqueues poll-reputation jobs for active registrations on tiered cadences:
//   Healthy (score >= 60 or NULL): daily at 03:00 UTC
//   At-risk (score 30-59): every 4 hours
//   Critical (score < 30): every 1 hour

import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { PollReputationJobPayload } from './poll-reputation.js';
import { brandedDidCountGauge } from '../../lib/metrics.js';

const BATCH_SIZE = 100;

export type PollTier = 'healthy' | 'at_risk' | 'critical';

function getTier(score: number | null): PollTier {
  if (score === null || score >= 60) return 'healthy';
  if (score >= 30) return 'at_risk';
  return 'critical';
}

function tierIntervalMs(tier: PollTier): number {
  switch (tier) {
    case 'healthy':  return 24 * 60 * 60 * 1000;
    case 'at_risk':  return  4 * 60 * 60 * 1000;
    case 'critical': return  1 * 60 * 60 * 1000;
  }
}

 
export async function runBrandedCallingScheduler(
  queue: Queue<PollReputationJobPayload>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  logger: Logger,
): Promise<void> {
  const now = new Date();

  const registrations = await prisma.brandedDidRegistration.findMany({
    where: { status: 'active' },
    select: {
      id: true,
      tenantId: true,
      providerId: true,
      provider: true,
      reputationScore: true,
      reputationLastPolledAt: true,
    },
    orderBy: { reputationLastPolledAt: 'asc' },
  });

  // Group by (tenantId, providerId) and collect DIDs due for poll.
  const groups = new Map<string, {
    tenantId: bigint;
    providerId: bigint;
    provider: string;
    ids: bigint[];
  }>();

  for (const reg of registrations) {
    const tier = getTier(reg.reputationScore as number | null);
    const intervalMs = tierIntervalMs(tier);
    const lastPoll = reg.reputationLastPolledAt as Date | null;
    const isDue = !lastPoll || (now.getTime() - lastPoll.getTime()) >= intervalMs;
    if (!isDue) continue;

    const key = `${String(reg.tenantId)}:${String(reg.providerId)}`;
    if (!groups.has(key)) {
      groups.set(key, {
        tenantId: reg.tenantId as bigint,
        providerId: reg.providerId as bigint,
        provider: reg.provider as string,
        ids: [],
      });
    }
    groups.get(key)!.ids.push(reg.id as bigint);
  }

  let totalEnqueued = 0;
  for (const group of groups.values()) {
    for (let i = 0; i < group.ids.length; i += BATCH_SIZE) {
      const batch = group.ids.slice(i, i + BATCH_SIZE);
      await queue.add('branded-calling:poll-reputation', {
        tenantId: String(group.tenantId),
        providerId: String(group.providerId),
        didIds: batch.map(String),
      }, {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: 50,
        removeOnFail: 25,
      });
      totalEnqueued++;
    }
  }

  // Update branded_did_count gauge.
  const counts = await prisma.brandedDidRegistration.groupBy({
    by: ['provider', 'tenantId', 'status'],
    _count: { id: true },
  });
  for (const row of counts) {
    brandedDidCountGauge.labels({
      provider: row.provider as string,
      tenant_id: String(row.tenantId),
      status: row.status as string,
    }).set((row._count as { id: number }).id);
  }

  logger.info(
    { groups: groups.size, batches: totalEnqueued, totalDids: registrations.length },
    'N05: scheduler ran',
  );
}
