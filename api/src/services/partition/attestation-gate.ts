/**
 * api/src/services/partition/attestation-gate.ts
 *
 * C04 — Merkle attestation gate.
 *
 * Before dropping a partition from an attestation-gated table (audit_log,
 * call_window_audit, dnc_sync_log, originate_audit, consent_log), the rotator
 * must confirm that the last day of the partition window has a verified
 * audit_attestation row in the DB (written by C03's daily Merkle worker).
 *
 * The attestation row identifies:
 *   - table_name: the managed table
 *   - window_date: the LAST day of the partition window (YYYY-MM-DD)
 *   - merkle_root: non-null (empty attestation rows have row_count=0 but are still present)
 *   - s3_key: non-null (confirms the signed attestation was persisted to S3)
 *
 * If C03 has not shipped yet (audit_attestation table does not exist), the gate
 * returns a special result indicating the table is missing — the rotator will
 * log a warning and skip the drop (safe default).
 */

import type { PrismaClient } from '@prisma/client';
import pino from 'pino';

const logger = pino({ name: 'c04:attestation-gate' });

export type AttestationGateResult =
  | { ok: true }
  | { ok: false; reason: 'attestation_absent'; windowDate: string }
  | { ok: false; reason: 'attestation_table_missing' }
  | { ok: false; reason: 'db_error'; error: unknown };

/**
 * Checks that a verified attestation row exists for the given table and window
 * date (the last day of the partition being considered for drop).
 *
 * @param db         Prisma client (vici2_app user — SELECT on audit_attestation)
 * @param tableName  Managed table name (e.g. 'audit_log')
 * @param windowDate Last day of the partition window (e.g. '2026-04-30')
 */
export async function checkAttestation(
  db: PrismaClient,
  tableName: string,
  windowDate: string,
): Promise<AttestationGateResult> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ cnt: number }>>(
      `SELECT COUNT(*) AS cnt
       FROM audit_attestation
       WHERE table_name = ?
         AND window_date = ?
         AND merkle_root IS NOT NULL
         AND s3_key IS NOT NULL
       LIMIT 1`,
      tableName,
      windowDate,
    );
    const count = Number(rows[0]?.cnt ?? 0);
    if (count > 0) {
      return { ok: true };
    }
    logger.warn(
      { tableName, windowDate },
      'Attestation absent for partition window — DROP skipped',
    );
    return { ok: false, reason: 'attestation_absent', windowDate };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Detect "table doesn't exist" — C03 not yet deployed
    if (msg.includes("doesn't exist") || msg.includes('ER_NO_SUCH_TABLE')) {
      logger.warn(
        { tableName },
        'audit_attestation table does not exist — C03 not deployed; DROP skipped',
      );
      return { ok: false, reason: 'attestation_table_missing' };
    }
    logger.error({ err, tableName, windowDate }, 'DB error checking attestation');
    return { ok: false, reason: 'db_error', error: err };
  }
}

/**
 * Returns the last day of a partition window.
 * partitionUpperBound is 'YYYY-MM-DD' representing the exclusive upper bound
 * (e.g. '2026-05-01'). The last day of the window is one day before.
 */
export function lastDayOfWindow(partitionUpperBound: string): string {
  const d = new Date(`${partitionUpperBound}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
