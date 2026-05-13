/**
 * workers/transcription/src/jobs/transcription-retry.ts
 *
 * Manual re-transcription endpoint handler.
 * Called by POST /api/recordings/:id/transcript/retry.
 * Rate-limited to 1 re-transcription per recording per hour (checked in API route).
 *
 * N07 PLAN §7.3 / AC-14.
 */

import type { Queue } from 'bullmq';
import type { TranscriptionJobData } from './transcription-job.js';

export interface RetryTranscriptionDeps {
  db: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $queryRaw<T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
    $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  };
  transcriptionQueue: Queue<TranscriptionJobData>;
}

export interface RetryResult {
  jobId: string;
  status: 'queued';
}

/**
 * Enqueue a manual re-transcription job for a recording.
 * Resets transcript_status to 'queued'. Bypasses stream consumer.
 * Does NOT use jobId dedup — each retry gets a fresh job.
 */
export async function retryTranscription(
  recordingLogIdStr: string,
  tenantId: bigint,
  deps: RetryTranscriptionDeps,
): Promise<RetryResult> {
  const recordingLogId = BigInt(recordingLogIdStr);

  // Load recording
  const rows = await deps.db.$queryRaw<
    Array<{
      id: bigint;
      uuid: string;
      storage_url: string | null;
      consent_status: string;
      duration_sec: number | null;
      tenant_id: bigint;
      transcript_status: string;
    }>
  >`
    SELECT id, uuid, storage_url, consent_status, duration_sec, tenant_id, transcript_status
    FROM recording_log
    WHERE id = ${recordingLogId} AND tenant_id = ${tenantId}
    LIMIT 1
  `;

  const rec = rows[0];
  if (!rec) throw Object.assign(new Error('recording_not_found'), { code: 'NOT_FOUND' });
  if (!rec.storage_url) {
    throw Object.assign(new Error('recording_not_uploaded'), { code: 'PRECONDITION_FAILED' });
  }
  if (rec.consent_status === 'prompted_declined' || rec.consent_status === 'skipped') {
    throw Object.assign(new Error('consent_blocked'), { code: 'CONSENT_BLOCKED' });
  }

  // Reset status to queued
  await deps.db.$executeRaw`
    UPDATE recording_log
    SET transcript_status = 'queued',
        transcript_uri    = NULL,
        updated_at        = NOW()
    WHERE id = ${recordingLogId} AND tenant_id = ${tenantId}
  `;

  // Enqueue fresh job (no jobId dedup for manual retry — intentional)
  const job = await deps.transcriptionQueue.add(
    'transcription',
    {
      recordingLogId: recordingLogIdStr,
      callUuid: rec.uuid,
      tenantId: rec.tenant_id.toString(),
      storageUrl: rec.storage_url,
      consentStatus: rec.consent_status,
      durationSec: rec.duration_sec ?? 0,
    },
    {
      attempts: 6,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 50,
      removeOnFail: 500,
    },
  );

  return { jobId: job.id ?? recordingLogIdStr, status: 'queued' };
}
