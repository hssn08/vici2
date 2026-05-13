/**
 * workers/recording-uploader/src/jobs/recording-delete-local.ts
 *
 * BullMQ Worker for 'recording-delete-local' queue.
 *
 * Handles consent-declined recordings: deletes the local WAV file after
 * a grace period (tenants.settings.consent_declined_grace_minutes, default 5).
 * R02 PLAN §8, §9.1.
 */

import { unlink } from 'node:fs/promises';
import type { Logger } from 'pino';
import type { Job } from 'bullmq';

import type { DbClient } from './recording-upload.js';

import * as metrics from '../metrics.js';
import type { AuditWriter } from '../services/recording.service.js';

// ---------------------------------------------------------------------------
// Job payload
// ---------------------------------------------------------------------------

export interface DeleteLocalJobData {
  recordingLogId: string;
  tenantId: string;
  startTime: string;
  filename: string;
  reason: string; // 'consent_declined' | 'consent_skipped'
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

export interface DeleteLocalProcessorDeps {
  prisma: DbClient;
  audit: AuditWriter;
  logger: Logger;
}

export async function processDeleteLocalJob(
  job: Job<DeleteLocalJobData>,
  deps: DeleteLocalProcessorDeps,
): Promise<void> {
  const { prisma, audit, logger } = deps;

  const recordingLogId = BigInt(job.data.recordingLogId);
  const tenantId = BigInt(job.data.tenantId);
  const startTime = new Date(job.data.startTime);
  const filename = job.data.filename;

  const log = logger.child({
    job: job.id,
    recordingLogId: recordingLogId.toString(),
    filename,
  });

  // Delete local file
  try {
    await unlink(filename);
    log.info({ filename }, 'consent-declined local file deleted');
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT') {
      log.warn({ filename }, 'consent-declined local file already gone (ENOENT)');
    } else {
      throw err;
    }
  }

  // Mark lifecycle_state as consent_declined_no_upload (idempotent)
  await prisma.$executeRaw`
    UPDATE recording_log
      SET lifecycle_state = 'consent_declined_no_upload', updated_at = NOW(6)
      WHERE id = ${recordingLogId} AND start_time = ${startTime}
  `;

  metrics.consentSkippedTotal.inc({
    tenant_id: tenantId.toString(),
    reason: job.data.reason,
  });
  metrics.localDeletedTotal.inc({ tenant_id: tenantId.toString() });

  await audit.append({
    tenantId,
    action: 'recording.consent_declined_local_deleted',
    entityType: 'recording_log',
    entityId: recordingLogId.toString(),
    actorKind: 'worker',
    afterJson: { filename, reason: job.data.reason },
  });
}
