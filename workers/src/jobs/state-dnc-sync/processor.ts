/**
 * workers/src/jobs/state-dnc-sync/processor.ts
 *
 * State DNC sync processor stub — D05 IMPLEMENT wires per-state file download.
 *
 * @idempotency
 *   BullMQ jobId = "state-dnc-sync:{state}:YYYY-MM" (per-state monthly key).
 *   DB CAS: dnc_sync_log upsert on (type, state, month_key).
 */

import type { Job } from 'bullmq';

export default async function processor(job: Job): Promise<void> {
  const { state } = job.data as { state: string };
  job.log(`state-dnc-sync: processor stub for state=${state} — awaiting D05 IMPLEMENT`);
  await job.updateProgress(100);
}
