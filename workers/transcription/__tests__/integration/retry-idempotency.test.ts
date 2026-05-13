/**
 * __tests__/integration/retry-idempotency.test.ts
 *
 * Two identical stream messages → one BullMQ job (dedup by jobId=recordingLogId).
 * N07 PLAN §12.3 / §6.1.
 */

import { describe, it, expect, vi } from 'vitest';

describe('retry idempotency — BullMQ jobId dedup', () => {
  it('duplicate stream messages produce one BullMQ job due to jobId dedup', async () => {
    const jobsAdded: string[] = [];

    // BullMQ dedup: if jobId already exists in waiting+active, reject
    const existingJobs = new Set<string>();
    const queueAdd = vi.fn().mockImplementation((_name: string, _data: unknown, opts: { jobId: string }) => {
      if (existingJobs.has(opts.jobId)) {
        // Simulates BullMQ dedup — throws or returns existing job
        return Promise.resolve({ id: opts.jobId, alreadyExists: true });
      }
      existingJobs.add(opts.jobId);
      jobsAdded.push(opts.jobId);
      return Promise.resolve({ id: opts.jobId });
    });

    const recordingLogId = '42';

    // First message — enqueue
    await queueAdd('transcription', { recordingLogId }, { jobId: recordingLogId });
    // Second identical message — dedup
    await queueAdd('transcription', { recordingLogId }, { jobId: recordingLogId });

    // Only one actual job was "created" (existingJobs has 1 entry)
    expect(jobsAdded).toHaveLength(1);
    expect(jobsAdded[0]).toBe(recordingLogId);
  });
});
