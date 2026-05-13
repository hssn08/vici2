/**
 * workers/transcription/src/jobs/transcription-job.ts
 *
 * BullMQ Worker processor for 'transcription' queue.
 *
 * Pipeline per N07 PLAN §4:
 *   1. Load recording_log row + tenant settings.
 *   2. Verify lifecycle_state = 'available' (retry guard).
 *   3. Download WAV from S3 via pre-signed URL.
 *   4. Call Python GPU sidecar POST /transcribe.
 *   5. Upload transcript.json + transcript.raw.json to S3.
 *   6. CAS UPDATE recording_log transcript columns.
 *   7. Emit C03 audit rows.
 *   8. Prometheus metrics.
 *
 * N07 PLAN §4 / AC-1..15.
 */

import { createWriteStream, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import https from 'node:https';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import axios from 'axios';
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { TenantTranscriptionSettings } from '../config.js';
import * as metrics from '../metrics.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TranscriptionJobData {
  recordingLogId: string; // BigInt serialised as string
  callUuid: string;
  tenantId: string;
  storageUrl: string;    // s3://bucket/key or https:// presigned
  consentStatus: string;
  durationSec: number;
}

export interface DbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw<T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface AuditWriter {
  append(action: string, payload: Record<string, unknown>): Promise<void>;
}

export class NoopAuditWriter implements AuditWriter {
  async append(_action: string, _payload: Record<string, unknown>): Promise<void> {}
}

export interface TranscriptionJobDeps {
  db: DbClient;
  s3: S3Client;
  audit: AuditWriter;
  tenantSettingsLoader: (tenantId: bigint) => Promise<TenantTranscriptionSettings>;
  defaultBucket: string;
  pythonSidecarUrl: string;
  pythonSidecarTimeoutMs: number;
  retentionYears: number;
  logger: Logger;
}

// ---------------------------------------------------------------------------
// Python sidecar response schema
// ---------------------------------------------------------------------------

export interface TranscriptSegment {
  channel: 'customer' | 'agent' | 'unknown';
  start: number;
  end: number;
  text: string;
  words?: Array<{ word: string; start: number; end: number; score: number }>;
}

export interface SidecarResponse {
  engine: string;
  model: string;
  stereo_mode: boolean;
  lang_detected: string;
  word_count: number;
  processing_ms: number;
  pii_redacted: boolean;
  pii_entity_count: number;
  pii_entity_types: string[];
  transcript_flags: string[];
  segments: TranscriptSegment[];
  raw_segments?: TranscriptSegment[]; // only present when presidio ran + retain_raw=true
}

// ---------------------------------------------------------------------------
// S3 key helpers
// ---------------------------------------------------------------------------

export function buildTranscriptKey(
  tenantId: bigint,
  callUuid: string,
  startTime: Date,
  raw = false,
): string {
  const y = startTime.getUTCFullYear();
  const m = String(startTime.getUTCMonth() + 1).padStart(2, '0');
  const d = String(startTime.getUTCDate()).padStart(2, '0');
  const suffix = raw ? '.transcript.raw.json' : '.transcript.json';
  return `tenants/${tenantId}/calls/${y}/${m}/${d}/${callUuid}${suffix}`;
}

// ---------------------------------------------------------------------------
// Retry guard: lifecycle_state check
// ---------------------------------------------------------------------------

async function waitForAvailable(
  db: DbClient,
  recordingLogId: bigint,
  startTime: Date,
  attemptsMade: number,
  logger: Logger,
): Promise<{ storageUrl: string; consentStatus: string }> {
  const rows = await db.$queryRaw<
    Array<{ lifecycle_state: string; storage_url: string | null; consent_status: string }>
  >`
    SELECT lifecycle_state, storage_url, consent_status
    FROM recording_log
    WHERE id = ${recordingLogId} AND start_time = ${startTime}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) throw new Error(`recording_log_not_found:${recordingLogId}`);
  if (row.lifecycle_state !== 'available') {
    if (attemptsMade >= 3) {
      throw new Error(`lifecycle_not_available:${row.lifecycle_state}:dlq`);
    }
    throw new Error(`lifecycle_not_available:${row.lifecycle_state}:retry`);
  }
  if (!row.storage_url) throw new Error('storage_url_missing');
  logger.debug({ lifecycle: row.lifecycle_state }, 'lifecycle_state=available confirmed');
  return { storageUrl: row.storage_url, consentStatus: row.consent_status };
}

// ---------------------------------------------------------------------------
// WAV download
// ---------------------------------------------------------------------------

async function downloadWav(
  s3: S3Client,
  bucket: string,
  key: string,
  destPath: string,
  logger: Logger,
): Promise<void> {
  logger.debug({ bucket, key, destPath }, 'downloading WAV from S3');
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  const resp = await s3.send(cmd);
  if (!resp.Body) throw new Error('s3_empty_body');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await pipeline(resp.Body as any, createWriteStream(destPath));
  logger.debug({ destPath }, 'WAV download complete');
}

// ---------------------------------------------------------------------------
// S3 upload (transcript JSON sidecars)
// ---------------------------------------------------------------------------

async function uploadTranscriptJson(
  s3: S3Client,
  bucket: string,
  key: string,
  body: string,
  tenantKmsArn: string | undefined,
  retainUntilDate: Date,
  recordingLogId: string,
  isPii: boolean,
): Promise<void> {
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: 'application/json',
    ServerSideEncryption: tenantKmsArn ? 'aws:kms' : 'AES256',
    SSEKMSKeyId: tenantKmsArn,
    BucketKeyEnabled: !!tenantKmsArn,
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: retainUntilDate,
    Metadata: {
      'recording-log-id': recordingLogId,
      ...(isPii ? { 'pii-present': 'true', 'access-role': 'compliance' } : {}),
    },
  });
  await s3.send(cmd);
}

// ---------------------------------------------------------------------------
// Idempotency: check if transcript already exists on retry
// ---------------------------------------------------------------------------

async function transcriptAlreadyUploaded(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export async function processTranscriptionJob(
  job: Job<TranscriptionJobData>,
  deps: TranscriptionJobDeps,
): Promise<void> {
  const { db, s3, audit, tenantSettingsLoader, defaultBucket, pythonSidecarUrl,
    pythonSidecarTimeoutMs, retentionYears, logger } = deps;

  const recordingLogId = BigInt(job.data.recordingLogId);
  const tenantId = BigInt(job.data.tenantId);
  const callUuid = job.data.callUuid;
  const attemptsMade = job.attemptsMade;

  const log = logger.child({
    job: job.id,
    recordingLogId: job.data.recordingLogId,
    callUuid,
    tenantId: job.data.tenantId,
    attempt: attemptsMade,
  });

  log.info('transcription job started');

  if (attemptsMade > 0) {
    metrics.retryTotal.inc({ tenant_id: job.data.tenantId, attempt: String(attemptsMade) });
  }

  // Mark processing
  await db.$executeRaw`
    UPDATE recording_log
    SET transcript_status = 'processing', updated_at = NOW()
    WHERE id = ${recordingLogId}
      AND transcript_status IN ('queued', 'processing')
  `;

  // 1. Load recording_log + tenant settings
  const rows = await db.$queryRaw<
    Array<{
      id: bigint;
      uuid: string;
      start_time: Date;
      duration_sec: number | null;
      lifecycle_state: string;
      storage_url: string | null;
      consent_status: string;
      transcript_uri: string | null;
    }>
  >`
    SELECT id, uuid, start_time, duration_sec, lifecycle_state,
           storage_url, consent_status, transcript_uri
    FROM recording_log
    WHERE id = ${recordingLogId}
    LIMIT 1
  `;

  const rec = rows[0];
  if (!rec) throw new Error(`recording_log_not_found:${recordingLogId}`);

  // 2. Verify lifecycle_state = 'available'
  const { storageUrl } = await waitForAvailable(db, recordingLogId, rec.start_time, attemptsMade, log);

  // Load tenant settings
  const settings = await tenantSettingsLoader(tenantId);
  if (!settings.transcription_enabled) {
    log.info('transcription disabled for tenant — skipping');
    await db.$executeRaw`
      UPDATE recording_log
      SET transcript_status = 'skipped', updated_at = NOW()
      WHERE id = ${recordingLogId}
    `;
    return;
  }

  // Parse S3 URL: s3://bucket/key
  const bucket = settings.recording_bucket ?? defaultBucket;
  const s3Url = new URL(storageUrl.startsWith('s3://') ? storageUrl : `s3://${defaultBucket}/${storageUrl}`);
  const s3Key = s3Url.pathname.replace(/^\//, '');
  const s3Bucket = s3Url.hostname || bucket;

  const startTime = rec.start_time;
  const transcriptKey = buildTranscriptKey(tenantId, callUuid, startTime, false);
  const rawTranscriptKey = buildTranscriptKey(tenantId, callUuid, startTime, true);

  // 4. Idempotency: on retry, skip re-upload if transcript already exists
  if (attemptsMade > 0 && (await transcriptAlreadyUploaded(s3, s3Bucket, transcriptKey))) {
    log.warn('transcript already uploaded — idempotent no-op');
    // Update DB in case it was missed
    await db.$executeRaw`
      UPDATE recording_log
      SET transcript_status = 'completed', updated_at = NOW()
      WHERE id = ${recordingLogId} AND transcript_uri IS NULL
    `;
    return;
  }

  // 3. Download WAV to /tmp
  const tmpWav = join(tmpdir(), `n07-${randomUUID()}.wav`);
  const t0 = Date.now();
  try {
    await downloadWav(s3, s3Bucket, s3Key, tmpWav, log);
    metrics.downloadDurationSeconds.observe(
      { tenant_id: job.data.tenantId, size_bucket: metrics.durationBucket(job.data.durationSec) },
      (Date.now() - t0) / 1000,
    );
  } catch (err) {
    if (existsSync(tmpWav)) unlinkSync(tmpWav);
    throw err;
  }

  // 4. Call Python GPU sidecar
  const t1 = Date.now();
  let sidecarResp: SidecarResponse;
  try {
    const resp = await axios.post<SidecarResponse>(
      `${pythonSidecarUrl}/transcribe`,
      {
        wav_path: tmpWav,
        call_uuid: callUuid,
        lang_hint: settings.transcription_lang_hint,
        model: settings.transcription_model,
        run_presidio: settings.transcription_pii_backend === 'presidio',
        retain_raw: settings.transcription_retain_raw,
      },
      { timeout: pythonSidecarTimeoutMs },
    );
    sidecarResp = resp.data;
    metrics.sidecardCallDurationSeconds.observe(
      {
        model: sidecarResp.model,
        stereo: String(sidecarResp.stereo_mode),
      },
      (Date.now() - t1) / 1000,
    );
  } catch (err) {
    if (existsSync(tmpWav)) unlinkSync(tmpWav);
    log.error({ err }, 'python sidecar call failed');
    throw err;
  } finally {
    if (existsSync(tmpWav)) {
      try { unlinkSync(tmpWav); } catch { /* ignore */ }
    }
  }

  // 5. Upload transcript.json to S3
  const retainUntilDate = new Date(
    Date.now() + (settings.recording_retention_years ?? retentionYears) * 365.25 * 86400 * 1000,
  );

  const transcriptJson = {
    schema_version: 1,
    recording_log_id: job.data.recordingLogId,
    call_uuid: callUuid,
    transcript_status: 'completed',
    transcript_lang: sidecarResp.lang_detected,
    word_count: sidecarResp.word_count,
    processing_ms: sidecarResp.processing_ms,
    engine: sidecarResp.engine,
    model: sidecarResp.model,
    stereo_mode: sidecarResp.stereo_mode,
    pii_redacted: sidecarResp.pii_redacted,
    transcript_flags: sidecarResp.transcript_flags,
    segments: sidecarResp.segments,
  };

  const t2 = Date.now();
  await uploadTranscriptJson(
    s3,
    s3Bucket,
    transcriptKey,
    JSON.stringify(transcriptJson),
    settings.kms_key_arn,
    retainUntilDate,
    job.data.recordingLogId,
    false,
  );

  // Upload raw transcript if PII was found and retain_raw is enabled
  if (sidecarResp.pii_redacted && settings.transcription_retain_raw && sidecarResp.raw_segments) {
    const rawTranscriptJson = {
      ...transcriptJson,
      segments: sidecarResp.raw_segments,
      pii_redacted: false,
      transcript_flags: [...sidecarResp.transcript_flags, 'raw_unredacted'],
    };
    await uploadTranscriptJson(
      s3,
      s3Bucket,
      rawTranscriptKey,
      JSON.stringify(rawTranscriptJson),
      settings.kms_key_arn,
      retainUntilDate,
      job.data.recordingLogId,
      true,
    );
  }

  metrics.uploadDurationSeconds.observe({ tenant_id: job.data.tenantId }, (Date.now() - t2) / 1000);

  const transcriptS3Uri = `s3://${s3Bucket}/${transcriptKey}`;

  // 6. CAS UPDATE recording_log (idempotent — WHERE transcript_uri IS NULL)
  await db.$executeRaw`
    UPDATE recording_log
    SET transcript_uri        = ${transcriptS3Uri},
        transcript_status     = 'completed',
        transcript_lang       = ${sidecarResp.lang_detected},
        transcript_word_count = ${sidecarResp.word_count},
        updated_at            = NOW()
    WHERE id = ${recordingLogId}
      AND transcript_uri IS NULL
  `;

  // 7. Audit rows (C03 AuditWriter)
  await audit.append('transcription.completed', {
    recording_log_id: job.data.recordingLogId,
    call_uuid: callUuid,
    tenant_id: job.data.tenantId,
    transcript_uri: transcriptS3Uri,
    lang: sidecarResp.lang_detected,
    word_count: sidecarResp.word_count,
    processing_ms: sidecarResp.processing_ms,
    engine: sidecarResp.engine,
    model: sidecarResp.model,
    stereo_mode: sidecarResp.stereo_mode,
  });

  if (sidecarResp.pii_redacted && sidecarResp.pii_entity_count > 0) {
    await audit.append('transcription.pii_redacted', {
      recording_log_id: job.data.recordingLogId,
      call_uuid: callUuid,
      tenant_id: job.data.tenantId,
      entity_count: sidecarResp.pii_entity_count,
      entity_types: sidecarResp.pii_entity_types,
    });
    for (const entityType of sidecarResp.pii_entity_types) {
      metrics.piiRedactedTotal.inc({ tenant_id: job.data.tenantId, entity_type: entityType });
    }
  }

  // 8. Prometheus metrics
  const totalMs = Date.now() - t0;
  metrics.processingDurationSeconds.observe(
    {
      model: sidecarResp.model,
      lang: sidecarResp.lang_detected,
      stereo: String(sidecarResp.stereo_mode),
      size_bucket: metrics.durationBucket(job.data.durationSec),
    },
    totalMs / 1000,
  );
  metrics.completedTotal.inc({
    tenant_id: job.data.tenantId,
    lang: sidecarResp.lang_detected,
    model: sidecarResp.model,
    stereo: String(sidecarResp.stereo_mode),
  });

  log.info(
    {
      transcript_uri: transcriptS3Uri,
      lang: sidecarResp.lang_detected,
      word_count: sidecarResp.word_count,
      processing_ms: totalMs,
    },
    'transcription job completed',
  );
}

// ---------------------------------------------------------------------------
// Terminal failure handler (called by BullMQ worker after all attempts)
// ---------------------------------------------------------------------------

export async function handleTranscriptionFailure(
  job: Job<TranscriptionJobData>,
  err: Error,
  db: DbClient,
  audit: AuditWriter,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  dlqQueue: { add: (name: string, data: any, opts?: any) => Promise<any> },
  logger: Logger,
): Promise<void> {
  const recordingLogId = BigInt(job.data.recordingLogId);
  logger.error(
    { jobId: job.id, recordingLogId: job.data.recordingLogId, err: err.message },
    'transcription job terminal failure — DLQ',
  );

  await db.$executeRaw`
    UPDATE recording_log
    SET transcript_status = 'failed', updated_at = NOW()
    WHERE id = ${recordingLogId}
  `;

  await audit.append('transcription.failed', {
    recording_log_id: job.data.recordingLogId,
    call_uuid: job.data.callUuid,
    tenant_id: job.data.tenantId,
    error: err.message,
    attempts: job.attemptsMade,
  });

  metrics.dlqTotal.inc({ tenant_id: job.data.tenantId });

  await dlqQueue.add('dlq', job.data, { removeOnFail: false }).catch((e: unknown) => {
    logger.error({ e }, 'failed to write to transcription DLQ');
  });
}
