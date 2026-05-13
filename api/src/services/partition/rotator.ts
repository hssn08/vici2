/**
 * api/src/services/partition/rotator.ts
 *
 * C04 — Core partition rotation logic.
 *
 * Per PLAN §3, §4:
 *   - ADD: add the next p_YYYY_MM partition via REORGANIZE PARTITION p_max
 *   - DROP: drop partitions older than retentionMonths, with attestation gate
 *     and disk-free pre-flight.
 *   - Per-table isolation: one table's failure does not block others.
 *   - ADD before DROP to guarantee data continuity.
 *   - Audit trail: every outcome written to audit_log via vici2_app.
 *
 * Connection model (PLAN §5):
 *   - `db`      (PrismaClient, vici2_app user)  — INFORMATION_SCHEMA reads,
 *                audit_log writes, attestation reads.
 *   - `adminDb` (mysql2 pool, vici2_partition_admin user) — DDL only.
 */

import type { PrismaClient } from '@prisma/client';
import type { Pool } from 'mysql2/promise';
import pino from 'pino';
import { TABLE_REGISTRY, type TableConfig } from './registry.js';
import { checkAttestation, lastDayOfWindow } from './attestation-gate.js';
import { checkDiskFree } from './disk-check.js';
import { partitionMetrics } from './metrics.js';

const logger = pino({ name: 'c04:rotator' });

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RotateOptions {
  /** When true, compute the plan but issue no DDL. */
  dryRun: boolean;
  /** Restrict rotation to these tables. Default: all TABLE_REGISTRY entries. */
  tables?: string[];
  /** Override "today" for testing (ISO date string YYYY-MM-DD or Date). */
  nowOverride?: Date | string;
}

export type PartitionAction =
  | 'add'
  | 'add.skipped' // already present
  | 'add.error'
  | 'drop'
  | 'drop.skipped.attestation'
  | 'drop.skipped.disk'
  | 'drop.skipped.table_missing'
  | 'drop.error';

export interface PartitionResult {
  table: string;
  partition: string;
  action: PartitionAction;
  dryRun: boolean;
  boundaryDate?: string;
  reason?: string;
  error?: string;
}

export interface RotationSummary {
  dryRun: boolean;
  startedAt: Date;
  finishedAt: Date;
  results: PartitionResult[];
  errors: number;
}

// ---------------------------------------------------------------------------
// INFORMATION_SCHEMA row types
// ---------------------------------------------------------------------------

interface ISchemaPartition {
  PARTITION_NAME: string;
  PARTITION_DESCRIPTION: string; // e.g. "'2026-06-01'" (with quotes) or 'MAXVALUE'
}

// ---------------------------------------------------------------------------
// Date utilities
// ---------------------------------------------------------------------------

/**
 * Returns a Date set to the first instant (UTC) of the given year/month.
 */
export function firstOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

/**
 * Adds `months` calendar months to a Date (UTC-aware).
 */
export function addMonths(d: Date, months: number): Date {
  const result = new Date(d);
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

/**
 * Returns the 'p_YYYY_MM' partition name for a given boundary date.
 * The boundary date is the FIRST day of the month the partition covers.
 * e.g. boundary '2026-06-01' → partition p_2026_06.
 */
export function partitionNameFromBoundary(boundary: Date): string {
  const y = boundary.getUTCFullYear();
  const m = String(boundary.getUTCMonth() + 1).padStart(2, '0');
  return `p_${y}_${m}`;
}

/**
 * Formats a Date as 'YYYY-MM-DD' (UTC).
 */
export function toDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Parses the PARTITION_DESCRIPTION value from INFORMATION_SCHEMA.
 * Returns null for MAXVALUE or non-date sentinels.
 */
export function parsePartitionBoundary(desc: string): Date | null {
  // INFORMATION_SCHEMA returns the value quoted for RANGE COLUMNS datetimes,
  // e.g. "'2026-06-01'" or "2026-06-01". Strip optional surrounding quotes.
  const clean = desc.replace(/^'|'$/g, '').trim();
  if (clean.toUpperCase() === 'MAXVALUE' || clean === '') return null;
  const d = new Date(`${clean}T00:00:00Z`);
  if (isNaN(d.getTime())) return null;
  return d;
}

// ---------------------------------------------------------------------------
// Core rotation logic
// ---------------------------------------------------------------------------

/**
 * Runs the full partition rotation cycle across all (or selected) tables.
 */
export async function runPartitionRotation(
  db: PrismaClient,
  adminPool: Pool,
  options: RotateOptions,
): Promise<RotationSummary> {
  const now = options.nowOverride
    ? new Date(options.nowOverride)
    : new Date();

  const startedAt = new Date();
  const results: PartitionResult[] = [];
  let errors = 0;

  const tables = options.tables
    ? TABLE_REGISTRY.filter((t) => options.tables!.includes(t.table))
    : TABLE_REGISTRY;

  logger.info(
    {
      dryRun: options.dryRun,
      tables: tables.map((t) => t.table),
      now: now.toISOString(),
    },
    'Partition rotation starting',
  );

  for (const config of tables) {
    const tableResults = await rotateTable(db, adminPool, config, now, options.dryRun);
    results.push(...tableResults);
    errors += tableResults.filter((r) => r.action.endsWith('.error')).length;
  }

  const finishedAt = new Date();
  const summary: RotationSummary = { dryRun: options.dryRun, startedAt, finishedAt, results, errors };

  partitionMetrics.incRun(options.dryRun ? 'dry_run' : errors > 0 ? 'error' : 'ok');

  logger.info(
    {
      dryRun: options.dryRun,
      totalTables: tables.length,
      added: results.filter((r) => r.action === 'add').length,
      dropped: results.filter((r) => r.action === 'drop').length,
      skipped: results.filter((r) => r.action.includes('skipped')).length,
      errors,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    },
    'Partition rotation complete',
  );

  return summary;
}

/**
 * Rotates a single table: ADD next partition, then DROP expired partitions.
 */
async function rotateTable(
  db: PrismaClient,
  adminPool: Pool,
  config: TableConfig,
  now: Date,
  dryRun: boolean,
): Promise<PartitionResult[]> {
  const stopTimer = partitionMetrics.startTimer(config.table);
  const results: PartitionResult[] = [];

  try {
    // Check if the table exists in INFORMATION_SCHEMA before doing anything
    const partitions = await fetchPartitions(db, config.table);

    if (partitions === null) {
      logger.warn(
        { table: config.table },
        'Table not found in INFORMATION_SCHEMA — skipping (table not yet created)',
      );
      results.push({
        table: config.table,
        partition: '(none)',
        action: 'drop.skipped.table_missing',
        dryRun,
        reason: 'table_not_in_information_schema',
      });
      partitionMetrics.incSkipped(config.table, 'table_missing');
      return results;
    }

    // ADD next partition first (before DROP)
    const addResult = await addNextPartition(db, adminPool, config, partitions, dryRun);
    results.push(addResult);

    // Refresh partitions after ADD (or use original list if dry-run / skipped)
    const currentPartitions = addResult.action === 'add'
      ? await fetchPartitions(db, config.table) ?? partitions
      : partitions;

    // DROP expired partitions
    const dropResults = await dropExpiredPartitions(
      db,
      adminPool,
      config,
      currentPartitions,
      now,
      dryRun,
    );
    results.push(...dropResults);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ err, table: config.table }, 'Unexpected error rotating table');
    results.push({
      table: config.table,
      partition: '(unknown)',
      action: 'add.error',
      dryRun,
      error: errorMsg,
    });
    partitionMetrics.incAlert('drop_error');
  } finally {
    stopTimer();
  }

  return results;
}

// ---------------------------------------------------------------------------
// ADD logic
// ---------------------------------------------------------------------------

async function addNextPartition(
  db: PrismaClient,
  adminPool: Pool,
  config: TableConfig,
  partitions: ISchemaPartition[],
  dryRun: boolean,
): Promise<PartitionResult> {
  // Find the newest named p_YYYY_MM partition (exclude p_pre and p_max)
  const namedPartitions = partitions
    .filter((p) => /^p_\d{4}_\d{2}$/.test(p.PARTITION_NAME))
    .sort((a, b) => b.PARTITION_NAME.localeCompare(a.PARTITION_NAME));

  let nextBoundary: Date;
  let newPartitionName: string;

  if (namedPartitions.length === 0) {
    // No named partitions yet — start from current month
    const curY = new Date().getUTCFullYear();
    const curM = new Date().getUTCMonth() + 1;
    const thisMonth = firstOfMonth(curY, curM);
    nextBoundary = addMonths(thisMonth, 1);
    newPartitionName = partitionNameFromBoundary(thisMonth);
  } else {
    const newest = namedPartitions[0];
    const newestUpperBound = parsePartitionBoundary(newest.PARTITION_DESCRIPTION);
    if (!newestUpperBound) {
      return {
        table: config.table,
        partition: '(unknown)',
        action: 'add.error',
        dryRun,
        error: `Cannot parse PARTITION_DESCRIPTION: ${newest.PARTITION_DESCRIPTION}`,
      };
    }
    // newestUpperBound is the exclusive upper boundary of the newest named partition,
    // i.e. the first day of the NEXT month after the newest partition's month.
    // The new partition we want to add covers the month starting at newestUpperBound.
    newPartitionName = partitionNameFromBoundary(newestUpperBound);
    nextBoundary = addMonths(newestUpperBound, 1);
  }

  // Check if already present (idempotent)
  const alreadyExists = partitions.some((p) => p.PARTITION_NAME === newPartitionName);
  if (alreadyExists) {
    logger.debug(
      { table: config.table, partition: newPartitionName },
      'Partition already exists — skipping ADD',
    );
    return {
      table: config.table,
      partition: newPartitionName,
      action: 'add.skipped',
      dryRun,
      reason: 'already_exists',
      boundaryDate: toDateString(nextBoundary),
    };
  }

  const nextBoundaryStr = toDateString(nextBoundary);
  const sql = `ALTER TABLE \`${config.table}\` REORGANIZE PARTITION \`p_max\` INTO (
    PARTITION \`${newPartitionName}\` VALUES LESS THAN ('${nextBoundaryStr}'),
    PARTITION \`p_max\` VALUES LESS THAN (MAXVALUE)
  )`;

  logger.info(
    { table: config.table, partition: newPartitionName, boundary: nextBoundaryStr, dryRun },
    'Adding partition',
  );

  if (!dryRun) {
    try {
      await adminPool.execute(sql);

      // Audit trail (written by vici2_app)
      await writeAuditRow(db, {
        action: 'partition.add',
        entityType: config.table,
        entityId: newPartitionName,
        afterJson: { dryRun, boundaryDate: nextBoundaryStr },
      });

      partitionMetrics.incAdded(config.table);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error({ err, table: config.table, partition: newPartitionName }, 'ADD PARTITION failed');
      partitionMetrics.incAlert('partition_missing');
      await writeAuditRow(db, {
        action: 'partition.add.error',
        entityType: config.table,
        entityId: newPartitionName,
        afterJson: { dryRun, boundaryDate: nextBoundaryStr, error: errorMsg },
      }).catch(() => undefined);
      return {
        table: config.table,
        partition: newPartitionName,
        action: 'add.error',
        dryRun,
        boundaryDate: nextBoundaryStr,
        error: errorMsg,
      };
    }
  }

  return {
    table: config.table,
    partition: newPartitionName,
    action: 'add',
    dryRun,
    boundaryDate: nextBoundaryStr,
  };
}

// ---------------------------------------------------------------------------
// DROP logic
// ---------------------------------------------------------------------------

async function dropExpiredPartitions(
  db: PrismaClient,
  adminPool: Pool,
  config: TableConfig,
  partitions: ISchemaPartition[],
  now: Date,
  dryRun: boolean,
): Promise<PartitionResult[]> {
  // The retention cutoff: the oldest partition boundary that we should KEEP.
  // Any partition whose upper boundary <= cutoff is eligible for drop.
  const cutoff = addMonths(
    firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1),
    -config.retentionMonths,
  );

  const named = partitions
    .filter((p) => /^p_\d{4}_\d{2}$/.test(p.PARTITION_NAME))
    .sort((a, b) => a.PARTITION_NAME.localeCompare(b.PARTITION_NAME)); // oldest first

  const results: PartitionResult[] = [];

  for (const p of named) {
    const upperBound = parsePartitionBoundary(p.PARTITION_DESCRIPTION);
    if (!upperBound) continue; // skip sentinels

    // Drop if the partition's entire window is before the cutoff
    if (upperBound > cutoff) continue;

    const boundaryDate = toDateString(upperBound);

    // Retention-violation alert: partition is >7 days past its drop deadline
    const dropDeadline = addMonths(upperBound, config.retentionMonths);
    const msOverdue = now.getTime() - dropDeadline.getTime();
    if (msOverdue > 7 * 24 * 3600 * 1000) {
      logger.error(
        { table: config.table, partition: p.PARTITION_NAME, dropDeadline: toDateString(dropDeadline) },
        'Retention violation: partition is >7 days past drop deadline',
      );
      partitionMetrics.incAlert('retention_violation');
    }

    // Attestation gate (only for gated tables)
    if (config.requireAttestation) {
      const windowLastDay = lastDayOfWindow(boundaryDate);
      const attestResult = await checkAttestation(db, config.table, windowLastDay);
      if (!attestResult.ok) {
        const reason = attestResult.reason;
        logger.warn(
          { table: config.table, partition: p.PARTITION_NAME, reason },
          'DROP blocked by attestation gate',
        );
        partitionMetrics.incAlert('drop_blocked');
        partitionMetrics.incSkipped(config.table, reason);
        await writeAuditRow(db, {
          action: 'partition.drop.skipped',
          entityType: config.table,
          entityId: p.PARTITION_NAME,
          afterJson: { dryRun, boundaryDate, reason },
        }).catch(() => undefined);
        results.push({
          table: config.table,
          partition: p.PARTITION_NAME,
          action: 'drop.skipped.attestation',
          dryRun,
          boundaryDate,
          reason,
        });
        continue;
      }
    }

    // Disk-free pre-flight
    const diskResult = await checkDiskFree(db, config.table, p.PARTITION_NAME);
    if (!diskResult.ok) {
      const reason = diskResult.reason;
      logger.warn(
        { table: config.table, partition: p.PARTITION_NAME, reason },
        'DROP blocked by disk-free check',
      );
      partitionMetrics.incAlert('disk_low');
      partitionMetrics.incSkipped(config.table, reason);
      await writeAuditRow(db, {
        action: 'partition.drop.skipped',
        entityType: config.table,
        entityId: p.PARTITION_NAME,
        afterJson: { dryRun, boundaryDate, reason },
      }).catch(() => undefined);
      results.push({
        table: config.table,
        partition: p.PARTITION_NAME,
        action: 'drop.skipped.disk',
        dryRun,
        boundaryDate,
        reason,
      });
      continue;
    }

    // Execute DROP
    const sql = `ALTER TABLE \`${config.table}\` DROP PARTITION \`${p.PARTITION_NAME}\``;

    logger.info(
      { table: config.table, partition: p.PARTITION_NAME, boundaryDate, dryRun },
      'Dropping partition',
    );

    if (!dryRun) {
      // Write audit row BEFORE the DDL (PLAN §13)
      await writeAuditRow(db, {
        action: 'partition.drop',
        entityType: config.table,
        entityId: p.PARTITION_NAME,
        afterJson: { dryRun, boundaryDate },
      }).catch(() => undefined);

      try {
        await adminPool.execute(sql);
        partitionMetrics.incDropped(config.table);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        logger.error({ err, table: config.table, partition: p.PARTITION_NAME }, 'DROP PARTITION failed');
        partitionMetrics.incAlert('drop_error');
        await writeAuditRow(db, {
          action: 'partition.drop.error',
          entityType: config.table,
          entityId: p.PARTITION_NAME,
          afterJson: { dryRun, boundaryDate, error: errorMsg },
        }).catch(() => undefined);
        results.push({
          table: config.table,
          partition: p.PARTITION_NAME,
          action: 'drop.error',
          dryRun,
          boundaryDate,
          error: errorMsg,
        });
        continue;
      }
    }

    results.push({
      table: config.table,
      partition: p.PARTITION_NAME,
      action: 'drop',
      dryRun,
      boundaryDate,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// INFORMATION_SCHEMA query
// ---------------------------------------------------------------------------

/**
 * Returns all partitions for a table sorted by PARTITION_ORDINAL_POSITION.
 * Returns null if the table does not exist in INFORMATION_SCHEMA.
 */
async function fetchPartitions(
  db: PrismaClient,
  tableName: string,
): Promise<ISchemaPartition[] | null> {
  try {
    const rows = await db.$queryRawUnsafe<ISchemaPartition[]>(
      `SELECT PARTITION_NAME, PARTITION_DESCRIPTION
       FROM INFORMATION_SCHEMA.PARTITIONS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND PARTITION_NAME IS NOT NULL
       ORDER BY PARTITION_ORDINAL_POSITION ASC`,
      tableName,
    );
    if (rows.length === 0) return null;
    return rows;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Audit row helper
// ---------------------------------------------------------------------------

interface AuditRowInput {
  action: string;
  entityType: string;
  entityId: string;
  afterJson: Record<string, unknown>;
}

async function writeAuditRow(db: PrismaClient, input: AuditRowInput): Promise<void> {
  try {
    await db.$executeRawUnsafe(
      `INSERT INTO audit_log
         (tenant_id, actor_kind, action, entity_type, entity_id, after_json, ts)
       VALUES (0, 'worker', ?, ?, ?, ?, NOW(6))`,
      input.action,
      input.entityType,
      input.entityId,
      JSON.stringify(input.afterJson),
    );
  } catch (err) {
    // Audit-write failure is logged but must not block the rotation itself.
    // For partition management, a missing audit row is less catastrophic
    // than a blocked rotation that fails to add the next month's partition.
    logger.error({ err, action: input.action }, 'Failed to write audit row for partition event');
  }
}
