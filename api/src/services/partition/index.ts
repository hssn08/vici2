/**
 * api/src/services/partition/index.ts
 *
 * C04 — Public API for the partition rotation service.
 *
 * Exports:
 *   - runPartitionRotation  — core rotation function (testable, injectable)
 *   - registerPartitionRotateJob — BullMQ cron worker registration
 *   - createAdminPool — factory for the vici2_partition_admin MySQL connection
 */

import { Queue, Worker } from 'bullmq';
import { createPool, type Pool } from 'mysql2/promise';
import type { PrismaClient } from '@prisma/client';
import pino from 'pino';
import { getPrisma } from '../../lib/prisma.js';
import { getRedis } from '../../lib/redis.js';
import { runPartitionRotation, type RotateOptions } from './rotator.js';

export { runPartitionRotation };
export type { RotateOptions, PartitionResult, PartitionAction } from './rotator.js';
export { TABLE_REGISTRY, TABLE_MAP } from './registry.js';

const logger = pino({ name: 'c04:index' });

const QUEUE_NAME = 'vici2:queue:partition-rotate';

/**
 * Creates a mysql2 pool for the vici2_partition_admin user.
 * This pool is used exclusively for DDL (ALTER TABLE ADD/DROP PARTITION).
 * The URL is read from DATABASE_URL_PARTITION_ADMIN env var.
 *
 * Falls back to the standard DATABASE_URL for environments (tests, dev)
 * where a dedicated partition-admin user has not been provisioned.
 */
export function createAdminPool(): Pool {
  const url = process.env.DATABASE_URL_PARTITION_ADMIN ?? process.env.DATABASE_URL ?? '';
  if (!url) {
    throw new Error('DATABASE_URL_PARTITION_ADMIN or DATABASE_URL must be set');
  }
  return createPool({
    uri: url,
    connectionLimit: 1, // DDL is serialized; no concurrency needed
    waitForConnections: true,
    queueLimit: 10,
    connectTimeout: 30_000,
    // Long net_write_timeout for REORGANIZE PARTITION on large tables
    // (set as a session variable after connect)
  });
}

/**
 * Registers the BullMQ cron worker for monthly partition rotation.
 *
 * Cron: '0 2 25 * *' — 02:00 UTC on the 25th of every month.
 * Concurrency: 1 — partition DDL must not run concurrently.
 *
 * Call once at server startup from server.ts (or worker.ts in a
 * dedicated worker process).
 */
export function registerPartitionRotateJob(
  adminPool: Pool,
  db?: PrismaClient,
): { queue: Queue; worker: Worker } {
  const redis = getRedis();
  const prisma = db ?? getPrisma();
  const dryRun = process.env.PARTITION_ROTATOR_DRY_RUN !== 'false';

  const queue = new Queue(QUEUE_NAME, {
    connection: redis,
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: { age: 24 * 3600 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

  // Schedule the monthly cron job on the queue (upsert — idempotent)
  queue.upsertJobScheduler(
    'monthly-partition-rotate',
    { pattern: '0 2 25 * *' },
    {
      name: 'partition-rotate',
      data: { scheduled: true },
    },
  ).catch((err: unknown) => {
    logger.error({ err }, 'Failed to register partition-rotate cron scheduler');
  });

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      logger.info({ jobId: job.id, dryRun }, 'partition-rotate job starting');
      const opts: RotateOptions = {
        dryRun,
        tables: job.data?.tables as string[] | undefined,
      };
      const summary = await runPartitionRotation(prisma, adminPool, opts);
      logger.info(
        {
          jobId: job.id,
          dryRun: summary.dryRun,
          added: summary.results.filter((r) => r.action === 'add').length,
          dropped: summary.results.filter((r) => r.action === 'drop').length,
          errors: summary.errors,
        },
        'partition-rotate job complete',
      );
      return summary;
    },
    {
      connection: redis,
      concurrency: 1,
      lockDuration: 10 * 60 * 1000, // 10 min max per job
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'partition-rotate job failed');
  });

  return { queue, worker };
}
