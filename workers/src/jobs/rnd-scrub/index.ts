/**
 * workers/src/jobs/rnd-scrub/index.ts
 *
 * N06 — BullMQ queue definition for RND scrub jobs.
 * The Worker is registered in workers/src/index.ts.
 */

export const RND_SCRUB_QUEUE = 'rnd-scrub';

export interface RndScrubJobData {
  tenantId: number;
  campaignId: string;
  scrubJobId: string;
  triggerReason: 'manual' | 'auto_launch' | 'scheduled_rescrub';
  triggeredByUserId: number | null;
  queryMode: 'api' | 'sftp';
}

export const RND_SCRUB_JOB_OPTS = {
  attempts: 10,
  backoff: {
    type: 'exponential' as const,
    delay: 5_000, // 5s, 10s, 20s … up to ~42 min
  },
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
};
