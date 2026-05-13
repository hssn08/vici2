/**
 * api/src/scripts/validate-partitions.ts
 *
 * C04 — Partition validation script.
 *
 * Reads INFORMATION_SCHEMA.PARTITIONS for all managed tables and checks:
 *   1. Every table has a p_max partition (overflow sentinel).
 *   2. No partition is older than its retention window + 7-day grace period.
 *   3. Partition names follow the p_YYYY_MM convention (no gaps in sequence).
 *   4. No gap in the partition sequence (consecutive months).
 *
 * Usage:
 *   pnpm tsx src/scripts/validate-partitions.ts [--schema <db>] [--tables a,b,c]
 *
 * Exit codes:
 *   0 — all checks pass
 *   1 — one or more checks failed
 *
 * Intended for CI (post-deploy health check) and manual ops verification.
 */

import 'dotenv-flow/config';
import { createPool } from 'mysql2/promise';
import { TABLE_REGISTRY, type TableConfig } from '../services/partition/registry.js';
import {
  firstOfMonth,
  addMonths,
  toDateString,
  parsePartitionBoundary,
} from '../services/partition/rotator.js';

const GRACE_DAYS = 7;

interface PartitionRow {
  PARTITION_NAME: string;
  PARTITION_DESCRIPTION: string;
  PARTITION_ORDINAL_POSITION: number;
}

interface CheckResult {
  table: string;
  check: string;
  pass: boolean;
  message?: string;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  let schemaArg: string | undefined;
  let tablesArg: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--schema' && args[i + 1]) {
      schemaArg = args[++i];
    } else if (args[i] === '--tables' && args[i + 1]) {
      tablesArg = args[++i].split(',').map((s) => s.trim());
    }
  }

  const url = process.env.DATABASE_URL ?? '';
  if (!url) {
    console.error('ERROR: DATABASE_URL not set');
    process.exit(1);
  }

  const pool = createPool({ uri: url, connectionLimit: 1 });

  try {
    const conn = await pool.getConnection();
    const [[schemaRow]] = await conn.execute<Array<{ name: string }> & [{ name: string }]>(
      'SELECT DATABASE() AS name',
    );
    const schema = schemaArg ?? schemaRow?.name ?? 'vici2';

    const now = new Date();
    const tables = tablesArg
      ? TABLE_REGISTRY.filter((t) => tablesArg!.includes(t.table))
      : TABLE_REGISTRY;

    const results: CheckResult[] = [];

    for (const cfg of tables) {
      const [rows] = await conn.execute<PartitionRow[]>(
        `SELECT PARTITION_NAME, PARTITION_DESCRIPTION, PARTITION_ORDINAL_POSITION
         FROM INFORMATION_SCHEMA.PARTITIONS
         WHERE TABLE_SCHEMA = ?
           AND TABLE_NAME = ?
           AND PARTITION_NAME IS NOT NULL
         ORDER BY PARTITION_ORDINAL_POSITION ASC`,
        [schema, cfg.table],
      );

      if (rows.length === 0) {
        results.push({
          table: cfg.table,
          check: 'table_exists',
          pass: false,
          message: `Table ${cfg.table} not found in INFORMATION_SCHEMA (not yet created — OK if module not deployed)`,
        });
        continue;
      }

      // Check 1: p_max exists
      const hasMax = rows.some((r) => r.PARTITION_NAME === 'p_max');
      results.push({
        table: cfg.table,
        check: 'p_max_exists',
        pass: hasMax,
        message: hasMax ? undefined : 'Missing p_max sentinel partition',
      });

      // Named partitions (p_YYYY_MM only)
      const named = rows
        .filter((r) => /^p_\d{4}_\d{2}$/.test(r.PARTITION_NAME))
        .sort((a, b) => a.PARTITION_NAME.localeCompare(b.PARTITION_NAME));

      // Check 2: no partition older than retention + 7-day grace
      const firstOfCurrentMonth = firstOfMonth(now.getUTCFullYear(), now.getUTCMonth() + 1);
      const hardCutoff = addMonths(firstOfCurrentMonth, -cfg.retentionMonths);
      const graceCutoff = new Date(hardCutoff.getTime() - GRACE_DAYS * 24 * 3600 * 1000);

      for (const p of named) {
        const bound = parsePartitionBoundary(p.PARTITION_DESCRIPTION);
        if (!bound) continue;
        const isExpired = bound <= graceCutoff;
        results.push({
          table: cfg.table,
          check: `retention:${p.PARTITION_NAME}`,
          pass: !isExpired,
          message: isExpired
            ? `Partition ${p.PARTITION_NAME} (boundary ${toDateString(bound)}) is past retention+grace cutoff (${toDateString(graceCutoff)})`
            : undefined,
        });
      }

      // Check 3: no gap in sequence
      if (named.length >= 2) {
        for (let i = 0; i < named.length - 1; i++) {
          const currBound = parsePartitionBoundary(named[i].PARTITION_DESCRIPTION);
          const nextBound = parsePartitionBoundary(named[i + 1].PARTITION_DESCRIPTION);
          if (!currBound || !nextBound) continue;

          const expectedNext = addMonths(currBound, 1);
          const gapExists = expectedNext.getTime() !== nextBound.getTime();
          if (gapExists) {
            results.push({
              table: cfg.table,
              check: `sequence_gap:${named[i].PARTITION_NAME}`,
              pass: false,
              message: `Gap in partition sequence: ${named[i].PARTITION_NAME} → ${named[i + 1].PARTITION_NAME} (expected ${toDateString(expectedNext)}, got ${toDateString(nextBound)})`,
            });
          }
        }
      }

      // Check 4: partition name format
      for (const p of named) {
        const match = /^p_(\d{4})_(\d{2})$/.exec(p.PARTITION_NAME);
        const bound = match ? parsePartitionBoundary(p.PARTITION_DESCRIPTION) : null;
        const formatOk = match !== null && bound !== null;
        if (!formatOk) {
          results.push({
            table: cfg.table,
            check: `name_format:${p.PARTITION_NAME}`,
            pass: false,
            message: `Non-standard partition name: ${p.PARTITION_NAME}`,
          });
        }
      }
    }

    conn.release();

    // Report
    const failures = results.filter((r) => !r.pass);
    const passes = results.filter((r) => r.pass);

    console.log(`\nPartition validation: ${passes.length} pass, ${failures.length} fail\n`);

    for (const r of results) {
      const icon = r.pass ? 'PASS' : 'FAIL';
      const msg = r.message ? ` — ${r.message}` : '';
      console.log(`  [${icon}] ${r.table} / ${r.check}${msg}`);
    }

    console.log('');

    if (failures.length > 0) {
      console.error(`${failures.length} check(s) failed.`);
      process.exit(1);
    } else {
      console.log('All partition checks passed.');
      process.exit(0);
    }
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('validate-partitions: fatal error', err);
  process.exit(1);
});
