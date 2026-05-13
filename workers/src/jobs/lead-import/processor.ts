/**
 * workers/src/jobs/lead-import/processor.ts
 *
 * Lead-import sandboxed processor (compiled to processor.cjs via tsconfig.processor.json).
 *
 * Compiled to CommonJS and loaded by BullMQ via child_process.fork.
 * The ESM source is kept here for type-checking; the CJS output runs in production.
 *
 * @idempotency
 *   BullMQ jobId = importId (dedup in active set, prevents double-enqueue).
 *   DB CAS: UPDATE imports SET status='running' WHERE status='queued' AND id=?
 *   Resume from imports.row_count_processed checkpoint on retry (every 500 rows).
 *
 * Actual CSV parsing logic is wired by D02 IMPLEMENT. This is the W01 stub
 * that establishes the sandboxed processor pattern.
 */

import type { Job } from 'bullmq';

export default async function processor(job: Job): Promise<void> {
  // W01 stub: D02 IMPLEMENT replaces this with the real CSV pipeline.
  const { importId, tenantId } = job.data as { importId: string; tenantId: number };
  job.log(`lead-import: processor stub for importId=${importId} tenantId=${tenantId}`);
  await job.updateProgress(100);
}
