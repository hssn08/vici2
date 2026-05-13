/**
 * api/src/services/partition/admin-route.ts
 *
 * C04 — POST /api/admin/partition-rotate
 *
 * Manual trigger for partition rotation (superadmin only).
 *
 * Request body (optional):
 *   {
 *     "dryRun": true,          // default: env PARTITION_ROTATOR_DRY_RUN
 *     "tables": ["call_log"]   // default: all registry tables
 *   }
 *
 * Response:
 *   - dryRun=true or tables specified: runs synchronously, returns results
 *   - otherwise: enqueues BullMQ job, returns { jobId, status: "enqueued" }
 */

import { Queue } from 'bullmq';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import type { Pool } from 'mysql2/promise';
import pino from 'pino';
import { getRedis } from '../../lib/redis.js';
import { getPrisma } from '../../lib/prisma.js';
import { runPartitionRotation } from './rotator.js';
import { TABLE_MAP } from './registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

const logger = pino({ name: 'c04:admin-route' });

const QUEUE_NAME = 'vici2:queue:partition-rotate';

const BodySchema = z.object({
  dryRun: z.boolean().optional(),
  tables: z.array(z.string()).optional(),
}).optional();

export function registerPartitionRotateRoute(
  app: AnyApp,
  adminPool: Pool,
  db?: PrismaClient,
): void {
  const prisma = db ?? getPrisma();

  app.post(
    '/api/admin/partition-rotate',
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission('admin:partition-rotate'),
      ],
    },
    async (req: AnyApp, reply: AnyApp) => {
      const body = BodySchema.safeParse(req.body);
      if (!body.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: body.error.issues });
      }

      const envDryRun = process.env.PARTITION_ROTATOR_DRY_RUN !== 'false';
      const dryRun = body.data?.dryRun ?? envDryRun;
      const tables = body.data?.tables;

      // Validate requested tables
      if (tables) {
        const unknown = tables.filter((t) => !TABLE_MAP.has(t));
        if (unknown.length > 0) {
          return reply.status(400).send({
            error: 'Unknown table(s)',
            unknownTables: unknown,
            validTables: [...TABLE_MAP.keys()],
          });
        }
      }

      // Synchronous mode: dry run or targeted table list
      if (dryRun || tables) {
        logger.info({ dryRun, tables }, 'Running partition rotation synchronously');
        try {
          const summary = await runPartitionRotation(prisma, adminPool, { dryRun, tables });
          return reply.status(200).send({
            status: dryRun ? 'dry_run_complete' : 'complete',
            dryRun,
            tables: tables ?? 'all',
            results: summary.results,
            errors: summary.errors,
            durationMs: summary.finishedAt.getTime() - summary.startedAt.getTime(),
          });
        } catch (err) {
          logger.error({ err }, 'Synchronous partition rotation failed');
          return reply.status(500).send({ error: 'Partition rotation failed', message: String(err) });
        }
      }

      // Async mode: enqueue a BullMQ job
      const queue = new Queue(QUEUE_NAME, { connection: getRedis() });
      const job = await queue.add('partition-rotate', { triggeredBy: 'admin-api', tables });
      logger.info({ jobId: job.id }, 'Partition rotation job enqueued');

      return reply.status(202).send({
        status: 'enqueued',
        jobId: job.id,
        tables: tables ?? 'all',
      });
    },
  );
}
