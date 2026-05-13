// X04 — Number pool reaper job registration.
// Schedule: hourly at minute 0 (0 * * * *).

import { runReaper } from './reaper.js';
import { reaperRun } from './metrics.js';

export const POOL_REAPER_QUEUE_NAME = 'vici2:queue:number-pool-reaper';
export const POOL_REAPER_CRON = '0 * * * *';
export const POOL_REAPER_JOB_ID = 'number-pool-reaper-cron-v1';

export const POOL_REAPER_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600, count: 100 },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runPoolReaperJob(db: any, logger: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }): Promise<void> {
  const now = new Date();
  logger.info({ jobName: 'number-pool-reaper', ts: now.toISOString() }, 'pool reaper: starting');
  try {
    await runReaper(db, now);
    reaperRun.inc();
    logger.info({ jobName: 'number-pool-reaper' }, 'pool reaper: completed');
  } catch (err) {
    logger.error({ err, jobName: 'number-pool-reaper' }, 'pool reaper: failed');
    throw err;
  }
}
