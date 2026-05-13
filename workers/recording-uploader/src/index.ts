/**
 * workers/recording-uploader/src/index.ts
 *
 * Entry point: starts stream-consumer + BullMQ worker pool + sweeper.
 * R02 PLAN §7.1.
 */

import 'dotenv-flow/config';
import http from 'node:http';
import { Redis } from 'ioredis';
import { Worker, Queue } from 'bullmq';
import pino from 'pino';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client') as { PrismaClient: new () => DbClient };

import { parseEnv, TenantSettingsSchema, getCachedSettings, setCachedSettings } from './config.js';
import { makeBackend } from './backends/factory.js';
import { registry, queueDepth } from './metrics.js';
import { StreamConsumer } from './stream-consumer.js';
import { startSweeper } from './sweeper.js';
import { processUploadJob } from './jobs/recording-upload.js';
import { processDeleteLocalJob } from './jobs/recording-delete-local.js';
import { RecordingService, NoopAuditWriter } from './services/recording.service.js';
import type { TenantSettings } from './config.js';
import type { DbClient } from './jobs/recording-upload.js';

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const env = parseEnv();

const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'recording-uploader' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const prisma = new PrismaClient();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
const backend = makeBackend(env);
const audit = new NoopAuditWriter(); // TODO: wire C03 AuditWriter when C03 ships

logger.info({ backend: backend.name }, 'storage backend initialised');

// ---------------------------------------------------------------------------
// Tenant settings loader with 60 s cache
// ---------------------------------------------------------------------------

async function loadTenantSettings(tenantId: bigint): Promise<TenantSettings> {
  const cached = getCachedSettings(tenantId);
  if (cached) return cached;

  const rows = await prisma.$queryRaw<Array<{ settings: unknown }>>`
    SELECT settings FROM tenants WHERE id = ${tenantId} LIMIT 1
  `;
  const raw = rows[0]?.settings ?? {};
  const parsed = TenantSettingsSchema.parse(raw);
  setCachedSettings(tenantId, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// BullMQ queues
// ---------------------------------------------------------------------------

const connection = { host: new URL(env.REDIS_URL).hostname, port: Number(new URL(env.REDIS_URL).port || 6379) };

const uploadQueue = new Queue('recording-upload', { connection });
const deleteLocalQueue = new Queue('recording-delete-local', { connection });
const uploadDlqQueue = new Queue('recording-upload-dlq', { connection });

// ---------------------------------------------------------------------------
// BullMQ workers
// ---------------------------------------------------------------------------

const uploadWorker = new Worker(
  'recording-upload',
  async (job) => {
    await processUploadJob(job, {
      prisma,
      backend,
      tenantSettingsLoader: loadTenantSettings,
      defaultBucket: env.R02_DEFAULT_BUCKET,
      audit,
      logger,
    });
  },
  { connection, concurrency: env.R02_CONCURRENCY },
);

uploadWorker.on('failed', (job, err) => {
  if (!job) return;
  logger.error({ jobId: job.id, err }, 'recording-upload job failed');

  // Move to DLQ on terminal failure (after all attempts exhausted)
  if (job.attemptsMade >= (job.opts.attempts ?? 8)) {
    uploadDlqQueue.add('dlq', job.data, { removeOnFail: false }).catch((e: unknown) => {
      logger.error({ e }, 'failed to write to upload DLQ');
    });
  }
});

const deleteLocalWorker = new Worker(
  'recording-delete-local',
  async (job) => {
    await processDeleteLocalJob(job, { prisma, audit, logger });
  },
  { connection, concurrency: 5 },
);

deleteLocalWorker.on('failed', (job, err) => {
  logger.error({ jobId: job?.id, err }, 'recording-delete-local job failed');
});

logger.info({ concurrency: env.R02_CONCURRENCY }, 'BullMQ workers started');

// ---------------------------------------------------------------------------
// Stream consumer
// ---------------------------------------------------------------------------

const consumer = new StreamConsumer({
  redis,
  uploadQueue,
  deleteLocalQueue,
  logger,
  gracePeriodMs: 5 * 60 * 1000, // 5-min default; per-tenant override in job processor
});

consumer.start().catch((err: unknown) => {
  logger.error({ err }, 'stream-consumer fatal error');
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Sweeper
// ---------------------------------------------------------------------------

const stopSweeper = startSweeper(
  { prisma, audit, logger },
  env.R02_SWEEPER_INTERVAL_SEC * 1000,
);

// ---------------------------------------------------------------------------
// Metrics HTTP server
// ---------------------------------------------------------------------------

// Queue depth gauge updater (every 15 s)
setInterval(async () => {
  try {
    const [uploadCount, deleteCount, dlqCount] = await Promise.all([
      uploadQueue.getActiveCount(),
      deleteLocalQueue.getActiveCount(),
      uploadDlqQueue.count(),
    ]);
    queueDepth.set({ queue: 'recording-upload' }, uploadCount);
    queueDepth.set({ queue: 'recording-delete-local' }, deleteCount);
    queueDepth.set({ queue: 'recording-upload-dlq' }, dlqCount);
  } catch { /* non-fatal */ }
}, 15_000);

const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('content-type', registry.contentType);
    res.end(await registry.metrics());
    return;
  }
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'recording-uploader' }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

metricsServer.listen(env.R02_METRICS_PORT, () => {
  logger.info({ port: env.R02_METRICS_PORT }, 'recording-uploader metrics listening');
});

// ---------------------------------------------------------------------------
// Export RecordingService for API routes
// ---------------------------------------------------------------------------

export const recordingService = new RecordingService(
  prisma,
  backend,
  env.R02_DEFAULT_BUCKET,
  audit,
);

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  consumer.stop();
  stopSweeper();
  await uploadWorker.close();
  await deleteLocalWorker.close();
  await prisma.$disconnect();
  metricsServer.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
