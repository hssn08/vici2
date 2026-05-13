/**
 * workers/src/jobs/federal-dnc-sync/processor.ts
 *
 * Federal DNC sync processor stub — D05 IMPLEMENT wires the real FTC FTP download.
 *
 * @idempotency
 *   BullMQ jobId = "federal-dnc-sync:YYYY-WW" (weekly window key prevents double-run).
 *   DB CAS: dnc_sync_log upsert on (type, week_key).
 */

import type { Job } from 'bullmq';

export default async function processor(job: Job): Promise<void> {
  job.log('federal-dnc-sync: processor stub — awaiting D05 IMPLEMENT');
  await job.updateProgress(100);
}
