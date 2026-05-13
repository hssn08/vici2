/**
 * api/src/services/partition/disk-check.ts
 *
 * C04 — Disk-free pre-flight before DROP PARTITION.
 *
 * Before dropping a partition, estimate its size from INFORMATION_SCHEMA
 * and confirm the MySQL data directory has at least 20% of that size free.
 *
 * This is a best-effort check: InnoDB buffer-pool effects and delayed
 * flush can cause INFORMATION_SCHEMA to underreport. The 20% threshold
 * is intentionally conservative to absorb estimation error.
 *
 * Implementation note: we use Node's `fs.statfs` (Node 19+, available
 * in Node 20) rather than `df` to avoid shell injection and be portable.
 * The datadir path is read from MySQL's @@datadir global.
 */

import { statfs } from 'node:fs/promises';
import type { PrismaClient } from '@prisma/client';
import pino from 'pino';

const logger = pino({ name: 'c04:disk-check' });

export type DiskCheckResult =
  | { ok: true; partitionBytes: bigint; freeBytes: bigint }
  | { ok: false; reason: 'insufficient_disk'; partitionBytes: bigint; freeBytes: bigint }
  | { ok: false; reason: 'db_error'; error: unknown }
  | { ok: false; reason: 'stat_error'; error: unknown };

const MIN_FREE_RATIO = 0.20; // 20%

/**
 * Estimates the size of a specific partition and checks if the filesystem
 * hosting MySQL's datadir has enough free space.
 *
 * @param db             Prisma client (vici2_app user — SELECT on INFORMATION_SCHEMA)
 * @param tableName      MySQL table name
 * @param partitionName  Partition name (e.g. 'p_2022_05')
 * @param schemaName     MySQL schema/database name (defaults to DATABASE())
 */
export async function checkDiskFree(
  db: PrismaClient,
  tableName: string,
  partitionName: string,
  schemaName?: string,
): Promise<DiskCheckResult> {
  let partitionBytes: bigint;
  let datadir: string;

  try {
    // Resolve the schema name if not provided
    const dbName = schemaName ?? await getSchemaName(db);

    const rows = await db.$queryRawUnsafe<
      Array<{ data_length: bigint; index_length: bigint }>
    >(
      `SELECT COALESCE(DATA_LENGTH, 0) AS data_length,
              COALESCE(INDEX_LENGTH, 0) AS index_length
       FROM INFORMATION_SCHEMA.PARTITIONS
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME   = ?
         AND PARTITION_NAME = ?
       LIMIT 1`,
      dbName,
      tableName,
      partitionName,
    );

    if (rows.length === 0) {
      // Partition not found — treat as zero size (safe to proceed)
      partitionBytes = 0n;
    } else {
      partitionBytes = BigInt(rows[0].data_length) + BigInt(rows[0].index_length);
    }

    const datadirRows = await db.$queryRawUnsafe<Array<{ datadir: string }>>(
      `SELECT @@datadir AS datadir`,
    );
    datadir = datadirRows[0]?.datadir ?? '/var/lib/mysql/';
  } catch (err) {
    logger.error({ err, tableName, partitionName }, 'DB error during disk-free check');
    return { ok: false, reason: 'db_error', error: err };
  }

  try {
    const stats = await statfs(datadir);
    // f_bsize * f_bavail = free bytes available to unprivileged users
    const freeBytes = BigInt(stats.bsize) * BigInt(stats.bavail);

    const required = BigInt(Math.ceil(Number(partitionBytes) * MIN_FREE_RATIO));
    if (freeBytes >= required) {
      return { ok: true, partitionBytes, freeBytes };
    }

    logger.warn(
      {
        tableName,
        partitionName,
        partitionBytes: partitionBytes.toString(),
        freeBytes: freeBytes.toString(),
        required: required.toString(),
      },
      'Insufficient disk free for safe DROP PARTITION',
    );
    return { ok: false, reason: 'insufficient_disk', partitionBytes, freeBytes };
  } catch (err) {
    logger.error({ err, datadir }, 'statfs error during disk-free check');
    return { ok: false, reason: 'stat_error', error: err };
  }
}

async function getSchemaName(db: PrismaClient): Promise<string> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT DATABASE() AS name`,
  );
  return rows[0]?.name ?? 'vici2';
}
