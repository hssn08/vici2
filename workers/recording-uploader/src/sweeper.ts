/**
 * workers/recording-uploader/src/sweeper.ts
 *
 * Two-phase local file deletion sweeper.
 * Runs every 5 minutes; queries recordings where deletion_pending=TRUE
 * AND lifecycle_state='available' AND updated_at < now() - 1h.
 * R02 PLAN §9.
 */

import { unlink } from 'node:fs/promises';
import type { Logger } from 'pino';

import type { DbClient } from './jobs/recording-upload.js';
import * as metrics from './metrics.js';
import type { AuditWriter } from './services/recording.service.js';

const BATCH_LIMIT = 1000;
const GRACE_HOURS = 1;

interface SweeperDeps {
  prisma: DbClient;
  audit: AuditWriter;
  logger: Logger;
}

export async function runSweep(deps: SweeperDeps): Promise<void> {
  const { prisma, audit, logger } = deps;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidates: any[] = await prisma.$queryRaw`
    SELECT r.id, r.tenant_id, r.recording_log_id, r.legal_hold
    FROM recordings r
    WHERE r.deletion_pending = TRUE
      AND r.lifecycle_state = 'available'
      AND r.legal_hold = FALSE
      AND r.updated_at < NOW() - INTERVAL ${GRACE_HOURS} HOUR
    LIMIT ${BATCH_LIMIT}
  `;

  if (candidates.length === 0) return;

  logger.debug({ count: candidates.length }, 'sweeper: processing batch');

  for (const rec of candidates) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await prisma.$queryRaw`
      SELECT filename FROM recording_log WHERE id = ${rec.recording_log_id} LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      // No filename — mark done silently
      await markDone(prisma, rec.recording_log_id, rec.id);
      continue;
    }

    try {
      await unlink(row.filename);
    } catch (err: unknown) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        metrics.sweeperErrorsTotal.inc({ error_code: code ?? 'unknown' });
        logger.warn({ err, filename: row.filename }, 'sweeper: unlink failed; will retry next cycle');
        continue; // leave deletion_pending=TRUE for next sweep
      }
      // ENOENT → already gone, treat as success
    }

    await markDone(prisma, rec.recording_log_id, rec.id);

    metrics.localDeletedTotal.inc({ tenant_id: rec.tenant_id.toString() });

    await audit.append({
      tenantId: rec.tenant_id,
      action: 'recording.local_deleted',
      entityType: 'recording_log',
      entityId: rec.recording_log_id.toString(),
      actorKind: 'worker',
      afterJson: { filename: row.filename },
    });

    // Also advance recording_log lifecycle_state to 'available'
    await prisma.$executeRaw`
      UPDATE recording_log
        SET lifecycle_state = 'available', updated_at = NOW(6)
        WHERE id = ${rec.recording_log_id}
          AND lifecycle_state = 'uploaded'
    `;
  }
}

async function markDone(
  prisma: DbClient,
  recordingLogId: bigint,
  recordingId: bigint,
): Promise<void> {
  await prisma.$executeRaw`
    UPDATE recordings
      SET deletion_pending = FALSE, updated_at = NOW(6)
      WHERE id = ${recordingId}
  `;
  void recordingLogId; // used for audit above
}

/**
 * Start the sweeper on an interval.
 * Returns a cleanup function that stops the interval.
 */
export function startSweeper(
  deps: SweeperDeps,
  intervalMs: number,
): () => void {
  const handle = setInterval(() => {
    runSweep(deps).catch((err: unknown) => {
      deps.logger.error({ err }, 'sweeper: unexpected error in sweep cycle');
    });
  }, intervalMs);

  return () => clearInterval(handle);
}
