/**
 * workers/src/jobs/rnd-scrub/rescrub-scheduler.ts
 *
 * N06 — Nightly cron (02:30 UTC): find campaigns whose leads have stale
 * RND lookups (lookup_date < now - rescrub_interval_days) and enqueue
 * re-scrub jobs. Skips campaigns already with a queued/running job.
 */

import type { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { monotonicFactory } from 'ulidx';
import type { RndScrubJobData } from './index.js';

const ulid = monotonicFactory();

export async function scheduleRescrubs(
  db: PrismaClient,
  rndScrubQueue: Queue<RndScrubJobData>,
): Promise<{ campaignCount: number; totalStalePhones: number }> {
  let campaignCount = 0;
  let totalStalePhones = 0;

  // Find all active tenants with RND configured
  const configs = await db.tenantRndConfig.findMany({
    where: { isActive: true },
    select: {
      tenantId: true,
      rescrubIntervalDays: true,
    },
  });

  for (const config of configs) {
    const staleThreshold = new Date(
      Date.now() - config.rescrubIntervalDays * 24 * 3600 * 1000,
    );

    // Find running campaigns that have rnd_auto_scrub enabled
    const campaigns = await db.campaign.findMany({
      where: {
        tenantId: config.tenantId,
        rndAutoScrub: true,
      },
      select: { id: true, tenantId: true },
    });

    for (const campaign of campaigns) {
      // Skip if already queued or running
      const activeJob = await db.rndScrubJob.findFirst({
        where: {
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          status: { in: ['queued', 'running'] },
        },
      });
      if (activeJob) continue;

      // Count stale phones (result='no', lookup_date < threshold)
      const staleCount = await db.rndLookupLog.count({
        where: {
          tenantId: campaign.tenantId,
          lookupDate: { lt: staleThreshold },
          result: 'no',
        },
      });

      if (staleCount === 0) continue;

      const scrubJobId = ulid();
      const queryMode = staleCount > 50_000 ? 'sftp' : 'api';

      // Create the job record
      await db.rndScrubJob.create({
        data: {
          id: scrubJobId,
          tenantId: campaign.tenantId,
          campaignId: campaign.id,
          triggerReason: 'scheduled_rescrub',
          status: 'queued',
          totalPhones: staleCount,
          queryMode,
        },
      });

      // Enqueue — use date-keyed jobId to prevent double-scheduling
      const today = new Date().toISOString().slice(0, 10);
      await rndScrubQueue.add(
        'rnd-scrub',
        {
          tenantId: Number(campaign.tenantId),
          campaignId: campaign.id,
          scrubJobId,
          triggerReason: 'scheduled_rescrub',
          triggeredByUserId: null,
          queryMode,
        },
        {
          jobId: `rnd-rescrub:${campaign.id}:${today}`,
          removeOnComplete: { count: 100 },
        },
      );

      campaignCount++;
      totalStalePhones += staleCount;
    }
  }

  return { campaignCount, totalStalePhones };
}
