/**
 * workers/transcription/src/index.ts
 *
 * N07 Transcription worker entry point.
 * Starts: stream-consumer (events:vici2.transcription.requested) + BullMQ worker.
 * N07 PLAN §3.1.
 */

import 'dotenv-flow/config';
import http from 'node:http';
import { Redis } from 'ioredis';
import { Worker, Queue } from 'bullmq';
import { S3Client } from '@aws-sdk/client-s3';
import pino from 'pino';
import { parseEnv, TenantTranscriptionSettingsSchema, getCachedSettings, setCachedSettings } from './config.js';
import { TranscriptionStreamConsumer } from './stream-consumer.js';
import {
  processTranscriptionJob,
  handleTranscriptionFailure,
  NoopAuditWriter,
} from './jobs/transcription-job.js';
import { registry, queueDepth } from './metrics.js';

// ---------------------------------------------------------------------------
// Unified DB client interface (superset of both stream-consumer + job needs)
// ---------------------------------------------------------------------------

interface FullDbClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $queryRaw<T = any>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T>;
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $disconnect(): Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client') as { PrismaClient: new () => FullDbClient };

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const env = parseEnv();

const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'transcription-worker' },
  timestamp: pino.stdTimeFunctions.isoTime,
});

const prisma = new PrismaClient();
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

const s3 = new S3Client({
  region: env.N07_S3_REGION,
  endpoint: env.N07_S3_ENDPOINT,
  forcePathStyle: env.N07_S3_FORCE_PATH_STYLE,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

const audit = new NoopAuditWriter(); // TODO: wire C03 AuditWriter when C03 ships

// ---------------------------------------------------------------------------
// Tenant settings loader (60 s TTL cache)
// ---------------------------------------------------------------------------

async function loadTenantSettings(tenantId: bigint) {
  const cached = getCachedSettings(tenantId);
  if (cached) return cached;

  const rows = await prisma.$queryRaw<Array<{ settings: unknown }>>`
    SELECT settings FROM tenants WHERE id = ${tenantId} LIMIT 1
  `;
  const raw = rows[0]?.settings ?? {};
  const parsed = TenantTranscriptionSettingsSchema.parse(raw);
  setCachedSettings(tenantId, parsed);
  return parsed;
}

// ---------------------------------------------------------------------------
// BullMQ queues + workers
// ---------------------------------------------------------------------------

const connection = {
  host: new URL(env.REDIS_URL).hostname,
  port: Number(new URL(env.REDIS_URL).port || 6379),
};

const transcriptionQueue = new Queue('transcription', { connection });
const dlqQueue = new Queue('transcription-dlq', { connection });

const transcriptionWorker = new Worker(
  'transcription',
  async (job) => {
    await processTranscriptionJob(job, {
      db: prisma,
      s3,
      audit,
      tenantSettingsLoader: loadTenantSettings,
      defaultBucket: env.N07_DEFAULT_BUCKET,
      pythonSidecarUrl: env.N07_PYTHON_SIDECAR_URL,
      pythonSidecarTimeoutMs: env.N07_PYTHON_SIDECAR_TIMEOUT_MS,
      retentionYears: env.N07_RETENTION_YEARS,
      logger,
    });
  },
  { connection, concurrency: env.N07_CONCURRENCY },
);

transcriptionWorker.on('failed', (job, err) => {
  if (!job) return;
  if (job.attemptsMade >= (job.opts.attempts ?? 6)) {
    void handleTranscriptionFailure(job, err, prisma, audit, dlqQueue, logger);
  } else {
    logger.warn(
      { jobId: job.id, attempt: job.attemptsMade, err: err.message },
      'transcription job attempt failed — will retry',
    );
  }
});

logger.info({ concurrency: env.N07_CONCURRENCY }, 'BullMQ transcription worker started');

// ---------------------------------------------------------------------------
// Stream consumer
// ---------------------------------------------------------------------------

const consumer = new TranscriptionStreamConsumer({
  redis,
  transcriptionQueue,
  db: prisma,
  logger,
});

consumer.start().catch((err: unknown) => {
  logger.error({ err }, 'n07 stream-consumer fatal error');
  process.exit(1);
});

// ---------------------------------------------------------------------------
// Queue depth gauge (every 15 s)
// ---------------------------------------------------------------------------

setInterval(() => {
  void (async () => {
    try {
      const [waiting, active, dlq] = await Promise.all([
        transcriptionQueue.getWaitingCount(),
        transcriptionQueue.getActiveCount(),
        dlqQueue.count(),
      ]);
      queueDepth.set({ queue: 'transcription' }, waiting + active);
      queueDepth.set({ queue: 'transcription-dlq' }, dlq);
    } catch { /* non-fatal */ }
  })();
}, 15_000);

// ---------------------------------------------------------------------------
// Metrics HTTP server
// ---------------------------------------------------------------------------

const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('content-type', registry.contentType);
    res.end(await registry.metrics());
    return;
  }
  if (req.url === '/health') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', service: 'transcription-worker' }));
    return;
  }
  res.statusCode = 404;
  res.end();
});

metricsServer.listen(env.N07_METRICS_PORT, () => {
  logger.info({ port: env.N07_METRICS_PORT }, 'n07 metrics listening');
});

// ---------------------------------------------------------------------------
// Export for API route use (dependency injection)
// ---------------------------------------------------------------------------

export { transcriptionQueue };

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------

const shutdown = async (signal: string): Promise<void> => {
  logger.info({ signal }, 'shutting down');
  consumer.stop();
  await transcriptionWorker.close();
  await prisma.$disconnect();
  metricsServer.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
