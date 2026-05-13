/**
 * workers/recording-uploader/src/jobs/recording-upload.ts
 *
 * BullMQ Worker for 'recording-upload' queue.
 *
 * Full pipeline per R02 PLAN §7.3:
 *   1. Load recording_log row + tenant settings.
 *   2. Consent gate (§8).
 *   3. Defensive pre-checks (§11.3).
 *   4. Retry HEAD-on-existing (§10).
 *   5. SHA-256 stream hash (§5.2).
 *   6. Single PUT or multipart (§5.1).
 *   7. HEAD verify (§5.2).
 *   8. DB idempotent CAS UPDATE + INSERT (§9.1).
 *   9. Metrics + audit emit.
 */

import { createHash } from 'node:crypto';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import type { Logger } from 'pino';
import type { Job } from 'bullmq';


/** Minimal Prisma-compatible interface for raw SQL queries. */
export interface DbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw<T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
}

import type { StorageBackend } from '../backends/types.js';
import type { TenantSettings } from '../config.js';
import type { AuditWriter } from '../services/recording.service.js';
import * as metrics from '../metrics.js';

// ---------------------------------------------------------------------------
// Job payload
// ---------------------------------------------------------------------------

export interface UploadJobData {
  recordingLogId: string; // bigint serialised as string
  tenantId: string;
  startTime: string; // ISO datetime — needed for partitioned PK
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SINGLE_PUT_THRESHOLD = 16 * 1024 * 1024; // 16 MB
const RETENTION_YEARS_DEFAULT = 7;
const MAX_SHA256_MISMATCHES = 3;

// ---------------------------------------------------------------------------
// Defensive pre-checks (R02 PLAN §11.3)
// ---------------------------------------------------------------------------

export function validateUploadParams(
  tenantId: bigint,
  callUuid: string,
  key: string,
  retainUntil: Date,
): void {
  if (tenantId <= 0n) throw new Error('invalid tenant: tenantId must be > 0');
  if (!/^[0-9a-f-]{36}$/i.test(callUuid)) throw new Error(`invalid call UUID: ${callUuid}`);
  if (!key.startsWith(`tenants/${tenantId}/`))
    throw new Error(`key/tenant mismatch — path injection defense: ${key}`);
  if (retainUntil.getTime() < Date.now() + 365 * 86400 * 1000)
    throw new Error('retention < 1 year — date arithmetic bug');
  if (retainUntil.getTime() > Date.now() + 10 * 365.25 * 86400 * 1000)
    throw new Error('retention > 10 years — date arithmetic bug');
  if (!/\.wav$/i.test(key)) throw new Error(`expected .wav extension: ${key}`);
}

// ---------------------------------------------------------------------------
// Object key generation (R02 PLAN §3)
// ---------------------------------------------------------------------------

export function buildObjectKey(tenantId: bigint, callUuid: string, startTime: Date): string {
  const y = startTime.getUTCFullYear();
  const m = String(startTime.getUTCMonth() + 1).padStart(2, '0');
  const d = String(startTime.getUTCDate()).padStart(2, '0');
  return `tenants/${tenantId}/calls/${y}/${m}/${d}/${callUuid}.wav`;
}

// ---------------------------------------------------------------------------
// SHA-256 streaming hash
// ---------------------------------------------------------------------------

export function streamSha256(filePath: string): Promise<{ hex: string; base64: string }> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      const hex = hash.digest('hex');
      const base64 = Buffer.from(hex, 'hex').toString('base64');
      resolve({ hex, base64 });
    });
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Jitter helper (±25% uniform)
// ---------------------------------------------------------------------------

export function jitter(baseMs: number): number {
  const factor = 0.75 + Math.random() * 0.5; // 0.75 – 1.25
  return Math.round(baseMs * factor);
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export interface UploadProcessorDeps {
  prisma: DbClient;
  backend: StorageBackend;
  tenantSettingsLoader: (tenantId: bigint) => Promise<TenantSettings>;
  defaultBucket: string;
  audit: AuditWriter;
  logger: Logger;
}

export async function processUploadJob(
  job: Job<UploadJobData>,
  deps: UploadProcessorDeps,
): Promise<void> {
  const { prisma, backend, tenantSettingsLoader, defaultBucket, audit, logger } = deps;

  const recordingLogId = BigInt(job.data.recordingLogId);
  const tenantId = BigInt(job.data.tenantId);
  const startTime = new Date(job.data.startTime);

  const log = logger.child({
    job: job.id,
    recordingLogId: recordingLogId.toString(),
    tenantId: tenantId.toString(),
    attempt: job.attemptsMade,
  });

  // 1. Load recording_log row
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: any[] = await prisma.$queryRaw`
    SELECT id, uuid, filename, storage_url, consent_status, lifecycle_state,
           size_bytes, duration_sec, campaign_id, lead_id
    FROM recording_log
    WHERE id = ${recordingLogId} AND start_time = ${startTime}
    LIMIT 1
  `;

  if (!row[0]) {
    throw new Error(`row-not-found-retry: recording_log ${recordingLogId} not yet written`);
  }

  const rec = row[0];

  // 2. Consent gate (R02 PLAN §8)
  const noUploadStatuses = new Set(['prompted_declined', 'skipped']);
  if (noUploadStatuses.has(rec.consent_status)) {
    log.info({ consent_status: rec.consent_status }, 'consent declined — skipping upload');
    await prisma.$executeRaw`
      UPDATE recording_log
        SET lifecycle_state = 'consent_declined_no_upload', updated_at = NOW(6)
        WHERE id = ${recordingLogId} AND start_time = ${startTime}
    `;
    metrics.consentSkippedTotal.inc({
      tenant_id: tenantId.toString(),
      reason: rec.consent_status,
    });
    await audit.append({
      tenantId,
      action: 'recording.consent_declined_no_upload',
      entityType: 'recording_log',
      entityId: recordingLogId.toString(),
      actorKind: 'worker',
    });
    return; // stream-consumer already enqueued recording-delete-local separately
  }

  // 3. Load tenant settings
  const settings = await tenantSettingsLoader(tenantId);
  const bucket = settings.recording_bucket ?? defaultBucket;

  if (!bucket) {
    throw Object.assign(
      new Error(`tenant ${tenantId} has no recording_bucket configured`),
      { fatal: true, reason: 'no_bucket_config' },
    );
  }

  // 4. Build object key + retention date
  const key = buildObjectKey(tenantId, rec.uuid, startTime);
  const retentionYears = settings.recording_retention_years ?? RETENTION_YEARS_DEFAULT;
  const retainUntil = new Date(Date.now() + retentionYears * 365.25 * 86400 * 1000);

  validateUploadParams(tenantId, rec.uuid, key, retainUntil);

  // 5. Retry idempotency — HEAD if this is a retry attempt (R02 PLAN §10)
  if (job.attemptsMade > 0) {
    const head = await backend.headObject(bucket, key);
    if (head) {
      // Object exists — check SHA-256 matches
      const existingClientSha = head.clientSha256 ?? head.checksumSha256;
      const localSha = await computeLocalSha(rec.filename);
      if (existingClientSha && existingClientSha === localSha) {
        log.info({ key }, 'retry: object exists with matching SHA-256; skipping upload');
        await advanceDbState(prisma, recordingLogId, startTime, tenantId, {
          storageUrl: `s3://${bucket}/${key}`,
          sha256Hex: localSha,
          sizeBytes: rec.size_bytes ?? BigInt(getFileSize(rec.filename)),
        });
        return;
      }
    }
  }

  // 6. SHA-256 hash
  const shaTimer = metrics.sha256DurationSeconds.startTimer({
    tenant_id: tenantId.toString(),
    size_bucket: metrics.sizeBucket(Number(rec.size_bytes ?? 0)),
  });
  const fileSize = getFileSize(rec.filename);
  const { hex: sha256Hex, base64: sha256Base64 } = await streamSha256(rec.filename);
  shaTimer();

  log.debug({ key, fileSize, sha256Hex }, 'SHA-256 computed');

  // 7. Mark uploading
  await prisma.$executeRaw`
    UPDATE recording_log
      SET lifecycle_state = 'uploading', updated_at = NOW(6)
      WHERE id = ${recordingLogId} AND start_time = ${startTime}
        AND lifecycle_state != 'uploaded' AND lifecycle_state != 'available'
  `;

  // 8. Upload
  const uploadTimer = metrics.uploadDurationSeconds.startTimer({
    tenant_id: tenantId.toString(),
    size_bucket: metrics.sizeBucket(fileSize),
  });

  const isMultipart = fileSize > SINGLE_PUT_THRESHOLD;
  const metadata: Record<string, string> = {
    'client-sha256': sha256Hex,
    'tenant-id': tenantId.toString(),
  };
  if (rec.campaign_id) metadata['campaign-id'] = rec.campaign_id;
  if (rec.lead_id) metadata['lead-id'] = rec.lead_id.toString();

  const putOpts = {
    bucket,
    key,
    body: isMultipart
      ? (createReadStream(rec.filename) as unknown as NodeJS.ReadableStream)
      : readFileBuffer(rec.filename),
    contentType: 'audio/wav',
    contentLength: fileSize,
    kmsKeyId: settings.kms_key_arn,
    objectLockRetainUntilDate: retainUntil,
    metadata,
    checksumSha256: isMultipart ? undefined : sha256Base64,
  };

  let sha256Mismatches = 0;
   
  while (true) {
    if (isMultipart) {
      await backend.putObjectMultipart(putOpts);
    } else {
      await backend.putObject(putOpts);
    }

    // 9. HEAD verify
    const head = await backend.headObject(bucket, key);
    if (!head) throw new Error('HeadObject returned null after upload — object not found');

    const remoteClientSha = head.clientSha256 ?? head.checksumSha256;
    const expectedSha = isMultipart ? sha256Hex : sha256Base64;

    if (!remoteClientSha || remoteClientSha !== expectedSha) {
      sha256Mismatches++;
      log.error(
        { localSha: expectedSha, remoteSha: remoteClientSha, mismatch: sha256Mismatches },
        'SHA-256 mismatch post-upload',
      );
      await backend.deleteObject(bucket, key);

      if (sha256Mismatches >= MAX_SHA256_MISMATCHES) {
        await prisma.$executeRaw`
          UPDATE recording_log
            SET lifecycle_state = 'corrupt',
                failure_reason = 'sha256_mismatch',
                updated_at = NOW(6)
            WHERE id = ${recordingLogId} AND start_time = ${startTime}
        `;
        metrics.uploadFailuresTotal.inc({
          tenant_id: tenantId.toString(),
          reason: 'sha256_mismatch',
        });
        throw Object.assign(
          new Error(`SHA-256 mismatch after ${MAX_SHA256_MISMATCHES} retries — DLQ + SEV-1`),
          { fatal: true, reason: 'sha256_mismatch' },
        );
      }
      // Retry upload within this job attempt
      continue;
    }

    // SHA-256 matches
    break;
  }

  const elapsed = uploadTimer();
  metrics.uploadedTotal.inc({
    tenant_id: tenantId.toString(),
    backend: backend.name,
    multipart: isMultipart ? 'true' : 'false',
  });

  const uploadBps = fileSize / (elapsed || 1);
  metrics.uploadBytesPerSecond.observe(
    { tenant_id: tenantId.toString(), backend: backend.name },
    uploadBps,
  );

  log.info({ key, fileSize, elapsed, isMultipart }, 'recording uploaded successfully');

  // 10. DB state advance (R02 PLAN §9.1)
  await advanceDbState(prisma, recordingLogId, startTime, tenantId, {
    storageUrl: `s3://${bucket}/${key}`,
    sha256Hex,
    sizeBytes: BigInt(fileSize),
  });

  // 11. Audit
  await audit.append({
    tenantId,
    action: 'recording.uploaded',
    entityType: 'recording_log',
    entityId: recordingLogId.toString(),
    actorKind: 'worker',
    afterJson: { key, size_bytes: fileSize, sha256: sha256Hex },
  });
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function advanceDbState(
  prisma: DbClient,
  recordingLogId: bigint,
  startTime: Date,
  tenantId: bigint,
  data: { storageUrl: string; sha256Hex: string; sizeBytes: bigint },
): Promise<void> {
  const sha256Buffer = Buffer.from(data.sha256Hex, 'hex');

  // Idempotent CAS: only update if storage_url not yet set
  await prisma.$executeRaw`
    UPDATE recording_log
      SET storage_url = ${data.storageUrl},
          sha256 = ${sha256Buffer},
          size_bytes = ${data.sizeBytes},
          lifecycle_state = 'uploaded',
          encoded_at = NOW(6),
          updated_at = NOW(6)
      WHERE id = ${recordingLogId}
        AND start_time = ${startTime}
        AND storage_url IS NULL
  `;

  // Insert recordings row (deletion_pending=TRUE means: sweeper should unlink local file)
  await prisma.$executeRaw`
    INSERT INTO recordings (tenant_id, recording_log_id, lifecycle_state, s3_storage_class, deletion_pending, created_at, updated_at)
      VALUES (${tenantId}, ${recordingLogId}, 'available', 'STANDARD', TRUE, NOW(6), NOW(6))
      ON DUPLICATE KEY UPDATE
        lifecycle_state = 'available',
        deletion_pending = TRUE,
        updated_at = NOW(6)
  `;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function getFileSize(filename: string): number {
  return statSync(filename).size;
}

function readFileBuffer(filename: string): Buffer {
  // For single-PUT we can read the whole file (≤16 MB)
  return readFileSync(filename);
}

async function computeLocalSha(filename: string): Promise<string> {
  const { hex } = await streamSha256(filename);
  return hex;
}
