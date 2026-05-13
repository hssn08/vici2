/**
 * workers/recording-uploader/src/index.ts
 *
 * Entry point: starts stream-consumer + BullMQ worker pool + sweeper.
 * R02 PLAN §7.1.
 *
 * W01 IMPLEMENT: replaced ad-hoc HTTP server with WorkerHttpServer
 * (provides /health, /ready, /metrics).  ShutdownManager replaces raw
 * process.on handlers — fixes the missing BullMQ drain bug.
 */

import 'dotenv-flow/config';
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

// W01 shared lib — WorkerHttpServer + ShutdownManager
import { WorkerHttpServer } from '../../src/lib/health-server.js';
import { ShutdownManager } from '../../src/lib/shutdown.js';

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
// HTTP server (W01: WorkerHttpServer with /health + /ready + /metrics)
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

const healthServer = new WorkerHttpServer({
  port: env.R02_METRICS_PORT,
  metricsRegistry: registry,
  service: 'recording-uploader',
  readinessChecks: [
    {
      name: 'valkey',
      check: async () => {
        await redis.ping();
        return true;
      },
    },
    {
      name: 'db',
      check: async () => {
        await (prisma as unknown as { $queryRaw: (sql: TemplateStringsArray) => Promise<unknown> })
          .$queryRaw`SELECT 1`;
        return true;
      },
    },
    {
      name: 's3',
      check: async () => {
        // backend.ping() verifies S3/local-fs reachability
        if (typeof (backend as unknown as { ping?: () => Promise<boolean> }).ping === 'function') {
          return (backend as unknown as { ping: () => Promise<boolean> }).ping();
        }
        return true;
      },
    },
  ],
});

healthServer.listen().then(() => {
  logger.info({ port: env.R02_METRICS_PORT }, 'recording-uploader HTTP server listening');
}).catch((err: unknown) => {
  logger.error({ err }, 'recording-uploader: failed to start HTTP server');
  process.exit(1);
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
// Graceful shutdown (W01: ShutdownManager — drains BullMQ before exit)
// ---------------------------------------------------------------------------

const shutdownMgr = new ShutdownManager();

// Closed last (registered first — ShutdownManager reverses order)
shutdownMgr.register({
  name: 'http-server',
  close: () => healthServer.close(),
});

shutdownMgr.register({
  name: 'redis',
  close: async () => { redis.disconnect(); },
});

shutdownMgr.register({
  name: 'prisma',
  close: async () => { await (prisma as unknown as { $disconnect: () => Promise<void> }).$disconnect(); },
});

shutdownMgr.register({
  name: 'sweeper',
  close: async () => { stopSweeper(); },
});

shutdownMgr.register({
  name: 'stream-consumer',
  close: async () => { consumer.stop(); },
});

// BullMQ workers — drain in-flight with timeout
shutdownMgr.register({
  name: 'delete-local-worker',
  close: async () => {
    await deleteLocalWorker.pause(true);
    await deleteLocalWorker.close(false);
  },
  timeoutMs: 30_000,
});

shutdownMgr.register({
  name: 'upload-worker',
  close: async () => {
    await uploadWorker.pause(true);
    await uploadWorker.close(false);
  },
  timeoutMs: Number(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 50_000),
});

// Flip /ready to 503 first
shutdownMgr.register({
  name: 'readiness-gate',
  close: async () => { healthServer.setNotReady(); },
});

shutdownMgr.listenFor('SIGINT', logger);
shutdownMgr.listenFor('SIGTERM', logger);
