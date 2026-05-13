/**
 * workers/src/index.ts
 *
 * vici2 workers — BullMQ + stream consumer runner.
 *
 * Registers all workers defined in W01 PLAN §2 (11 queue topology):
 *   - lead-import (BullMQ, sandboxed processor)
 *   - audit-attest (BullMQ repeatable, nightly 03:30 UTC)
 *   - federal-dnc-sync (BullMQ repeatable, Sunday 04:00 UTC)
 *   - state-dnc-sync (BullMQ repeatable, 1st of month 04:30 UTC)
 *   - callback-fire / callback-upcoming / callback-stale (setInterval + Valkey lock)
 *   - recording-log-writer (Redis Streams XREADGROUP)
 *   - freeswitch-event-router (Redis Streams XREADGROUP — slot; wired by T01)
 *
 * Graceful shutdown (PLAN §11):
 *   SIGTERM → setNotReady → pause workers → drain in-flight → close streams
 *           → disconnect DB → disconnect Redis → close HTTP server → exit 0
 *
 * SIGTERM bug fix: previously called server.close() only (no BullMQ drain).
 * Fixed: ShutdownManager calls Worker.pause() + Worker.close(false) in order.
 */

import 'dotenv-flow/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import pino from 'pino';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Redis = require('ioredis') as typeof import('ioredis').default;
import { Queue, Worker } from 'bullmq';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client') as { PrismaClient: new () => Record<string, unknown> & { $queryRaw: (template: TemplateStringsArray) => Promise<unknown>; $disconnect: () => Promise<void> } };

import { ShutdownManager } from './lib/shutdown.js';
import { WorkerHttpServer } from './lib/health-server.js';
import { DlqWriter, dlqStream } from './lib/dlq-writer.js';
import {
  registry,
  instrumentWorker,
  startMetricsPoller,
} from './lib/metrics.js';
import {
  POOL_REAPER_QUEUE_NAME,
  POOL_REAPER_CRON,
  POOL_REAPER_JOB_ID,
  POOL_REAPER_JOB_OPTS,
  runPoolReaperJob,
} from './jobs/number-pool-reaper/index.js';
import { runHubspotSyncJob } from './jobs/hubspot-sync/index.js';
import { runHubspotPushJob } from './jobs/hubspot-push/index.js';
import { runHubspotWebhookJob } from './jobs/hubspot-webhook/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVICE = 'workers';

// ---- Logger ----------------------------------------------------------------

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: SERVICE, hostname: hostname(), pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});

// ---- Config ----------------------------------------------------------------

const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9103);
const VALKEY_URL =
  process.env.VALKEY_URL ??
  process.env.REDIS_URL ??
  'redis://localhost:6379/0';
const SHUTDOWN_TIMEOUT_MS = Number(
  process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? 50_000,
);

// ---- Connections -----------------------------------------------------------

const redis = new Redis(VALKEY_URL, {
  maxRetriesPerRequest: null, // required by BullMQ
  enableReadyCheck: false,
});

const prisma = new PrismaClient();

// ---- HTTP server -----------------------------------------------------------

const healthServer = new WorkerHttpServer({
  port: METRICS_PORT,
  metricsRegistry: registry,
  service: SERVICE,
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
        await prisma.$queryRaw`SELECT 1`;
        return true;
      },
    },
  ],
});

// ---- Queue configuration (FROZEN per PLAN §3) ------------------------------

const BASE_CONNECTION = { connection: redis };

const LEAD_IMPORT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 1_000 },
};

const AUDIT_ATTEST_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 60_000 },
  removeOnComplete: { age: 7 * 24 * 3600 },
  removeOnFail: { age: 90 * 24 * 3600, count: 100 },
};

const FEDERAL_DNC_SYNC_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 300_000 },
  removeOnComplete: { age: 30 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600, count: 100 },
};

const STATE_DNC_SYNC_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 120_000 },
  removeOnComplete: { age: 30 * 24 * 3600 },
  removeOnFail: { age: 30 * 24 * 3600, count: 100 },
};

// ---- DLQ Writer ------------------------------------------------------------

const dlqWriter = new DlqWriter(redis);

function attachDlqOnFailed(
  worker: Worker,
  workerName: string,
  queueName: string,
): void {
  worker.on('failed', async (job, err) => {
    if (!job) return;
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      try {
        await dlqWriter.write(dlqStream(workerName), {
          worker: workerName,
          sourceQueue: queueName,
          sourceId: job.id ?? 'unknown',
          payload: job.data,
          error: err,
          attempt: job.attemptsMade,
          workerId: `${hostname()}-${process.pid}`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tenantId: (job.data as any)?.tenantId ?? '0',
        });
      } catch (dlqErr) {
        logger.error({ dlqErr }, `${workerName}: failed to write DLQ entry`);
      }
    }
  });
}

// ---- Queue registry (for metrics depth polling) ----------------------------

const queues = new Map<string, Queue>();

function registerQueue(
  name: string,
  defaultJobOptions?: object,
): Queue {
  const q = new Queue(name, {
    ...BASE_CONNECTION,
    ...(defaultJobOptions ? { defaultJobOptions } : {}),
  });
  queues.set(name, q);
  return q;
}

// ---- DLQ stream map for Prometheus gauge -----------------------------------

const DLQ_STREAMS = new Map([
  ['lead-import',             dlqStream('lead-import')],
  ['audit-attest',            dlqStream('audit-attest')],
  ['federal-dnc-sync',        dlqStream('federal-dnc-sync')],
  ['state-dnc-sync',          dlqStream('state-dnc-sync')],
  ['recording-log-writer',    dlqStream('recording-log-writer')],
  ['freeswitch-event-router', dlqStream('freeswitch-event-router')],
  ['callback-fire',           dlqStream('callback-fire')],
  ['number-pool-reaper',      dlqStream('number-pool-reaper')],
  // N04 — HubSpot integration
  ['hubspot-sync',            dlqStream('hubspot-sync')],
  ['hubspot-push',            dlqStream('hubspot-push')],
  ['hubspot-webhook',         dlqStream('hubspot-webhook')],
]);

// ---- Workers startup -------------------------------------------------------

// N04 HubSpot queue names
const HUBSPOT_SYNC_QUEUE_NAME    = 'vici2:queue:hubspot-sync';
const HUBSPOT_PUSH_QUEUE_NAME    = 'vici2:queue:hubspot-push';
const HUBSPOT_WEBHOOK_QUEUE_NAME = 'vici2:queue:hubspot-webhook';

const HUBSPOT_SYNC_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 30_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 500 },
};

const HUBSPOT_PUSH_JOB_OPTS = {
  attempts: 5,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 3 * 24 * 3600, count: 10_000 },
  removeOnFail: { age: 30 * 24 * 3600, count: 1_000 },
};

const HUBSPOT_WEBHOOK_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 500 },
};

async function startWorkers(): Promise<{
  leadImportWorker: Worker;
  auditAttestWorker: Worker;
  federalDncWorker: Worker;
  stateDncWorker: Worker;
  poolReaperWorker: Worker;
  hubspotSyncWorker: Worker;
  hubspotPushWorker: Worker;
  hubspotWebhookWorker: Worker;
  intervals: NodeJS.Timeout[];
}> {
  // -- Lead Import (sandboxed processor, PLAN §4) ---------------------------
  const leadImportQueueName = 'vici2:queue:lead-import';
  registerQueue(leadImportQueueName, LEAD_IMPORT_JOB_OPTS);

  // Sandboxed processor: compiled to CJS via tsconfig.processor.json
  const processorPath = path.resolve(
    __dirname,
    'jobs/lead-import/processor.cjs',
  );

  const leadImportWorker = new Worker(leadImportQueueName, processorPath, {
    ...BASE_CONNECTION,
    concurrency: 2,
    lockDuration: 60_000,
    stalledInterval: 30_000,
    useWorkerThreads: false,
    limiter: { max: 5, duration: 60_000 },
  });
  instrumentWorker(leadImportWorker, leadImportQueueName);
  attachDlqOnFailed(leadImportWorker, 'lead-import', leadImportQueueName);
  leadImportWorker.on('error', (err) =>
    logger.error({ err }, 'lead-import-worker: error'),
  );

  // -- Audit Attest (nightly cron 03:30 UTC, avoids O02 backup window) ------
  const auditAttestQueueName = 'vici2:queue:audit-attest';
  const auditAttestQueue = registerQueue(auditAttestQueueName);

  await auditAttestQueue.add('attest', {}, {
    repeat: { pattern: '30 3 * * *', tz: 'UTC' },
    jobId: 'audit-attest-cron-v1',
    ...AUDIT_ATTEST_JOB_OPTS,
  });

  const auditAttestWorker = new Worker(
    auditAttestQueueName,
    async (job) => {
      // C03 IMPLEMENT wires the actual attestation logic here.
      logger.info(
        { jobId: job.id },
        'audit-attest: stub — awaiting C03 IMPLEMENT',
      );
    },
    {
      ...BASE_CONNECTION,
      concurrency: 1,
      lockDuration: 300_000,
      stalledInterval: 60_000,
    },
  );
  instrumentWorker(auditAttestWorker, auditAttestQueueName);
  attachDlqOnFailed(auditAttestWorker, 'audit-attest', auditAttestQueueName);
  auditAttestWorker.on('error', (err) =>
    logger.error({ err }, 'audit-attest-worker: error'),
  );

  // -- Federal DNC Sync (weekly cron Sunday 04:00 UTC) ----------------------
  const federalDncQueueName = 'vici2:queue:federal-dnc-sync';
  const federalDncQueue = registerQueue(federalDncQueueName);

  await federalDncQueue.add('sync', {}, {
    repeat: { pattern: '0 4 * * 0', tz: 'UTC' },
    jobId: 'federal-dnc-sync-cron-v1',
    ...FEDERAL_DNC_SYNC_JOB_OPTS,
  });

  const federalDncWorker = new Worker(
    federalDncQueueName,
    async (job) => {
      logger.info(
        { jobId: job.id },
        'federal-dnc-sync: stub — awaiting D05 IMPLEMENT',
      );
    },
    {
      ...BASE_CONNECTION,
      concurrency: 1,
      lockDuration: 1_800_000,
      stalledInterval: 300_000,
    },
  );
  instrumentWorker(federalDncWorker, federalDncQueueName);
  attachDlqOnFailed(federalDncWorker, 'federal-dnc-sync', federalDncQueueName);
  federalDncWorker.on('error', (err) =>
    logger.error({ err }, 'federal-dnc-worker: error'),
  );

  // -- State DNC Sync (monthly cron 1st of month 04:30 UTC) -----------------
  const stateDncQueueName = 'vici2:queue:state-dnc-sync';
  const stateDncQueue = registerQueue(stateDncQueueName);

  await stateDncQueue.add('sync', {}, {
    repeat: { pattern: '30 4 1 * *', tz: 'UTC' },
    jobId: 'state-dnc-sync-cron-v1',
    ...STATE_DNC_SYNC_JOB_OPTS,
  });

  const stateDncWorker = new Worker(
    stateDncQueueName,
    async (job) => {
      logger.info(
        { jobId: job.id },
        'state-dnc-sync: stub — awaiting D05 IMPLEMENT',
      );
    },
    {
      ...BASE_CONNECTION,
      concurrency: 3,
      lockDuration: 900_000,
      stalledInterval: 120_000,
    },
  );
  instrumentWorker(stateDncWorker, stateDncQueueName);
  attachDlqOnFailed(stateDncWorker, 'state-dnc-sync', stateDncQueueName);
  stateDncWorker.on('error', (err) =>
    logger.error({ err }, 'state-dnc-worker: error'),
  );

  // -- X04 Number Pool Reaper (hourly cron 0 * * * * UTC) ------------------
  const poolReaperQueueName = POOL_REAPER_QUEUE_NAME;
  const poolReaperQueue = registerQueue(poolReaperQueueName);

  await poolReaperQueue.add('reap', {}, {
    repeat: { pattern: POOL_REAPER_CRON, tz: 'UTC' },
    jobId: POOL_REAPER_JOB_ID,
    ...POOL_REAPER_JOB_OPTS,
  });

  const poolReaperWorker = new Worker(
    poolReaperQueueName,
    async (_job) => {
      await runPoolReaperJob(prisma, logger);
    },
    {
      ...BASE_CONNECTION,
      concurrency: 1,
      lockDuration: 300_000,
      stalledInterval: 60_000,
    },
  );
  instrumentWorker(poolReaperWorker, poolReaperQueueName);
  attachDlqOnFailed(poolReaperWorker, 'number-pool-reaper', poolReaperQueueName);
  poolReaperWorker.on('error', (err) =>
    logger.error({ err }, 'pool-reaper-worker: error'),
  );

  // -- N04 HubSpot Sync (per-tenant repeatable, concurrency 2) ---------------
  registerQueue(HUBSPOT_SYNC_QUEUE_NAME, HUBSPOT_SYNC_JOB_OPTS);

  const hubspotSyncWorker = new Worker(
    HUBSPOT_SYNC_QUEUE_NAME,
    async (job) => {
      await runHubspotSyncJob(job as Parameters<typeof runHubspotSyncJob>[0], prisma);
    },
    {
      ...BASE_CONNECTION,
      concurrency: 2,
      lockDuration: 600_000,
      stalledInterval: 60_000,
    },
  );
  instrumentWorker(hubspotSyncWorker, HUBSPOT_SYNC_QUEUE_NAME);
  attachDlqOnFailed(hubspotSyncWorker, 'hubspot-sync', HUBSPOT_SYNC_QUEUE_NAME);
  hubspotSyncWorker.on('error', (err) =>
    logger.error({ err }, 'hubspot-sync-worker: error'),
  );

  // -- N04 HubSpot Push (engagement write-back, concurrency 10) -------------
  registerQueue(HUBSPOT_PUSH_QUEUE_NAME, HUBSPOT_PUSH_JOB_OPTS);

  const hubspotPushWorker = new Worker(
    HUBSPOT_PUSH_QUEUE_NAME,
    async (job) => {
      await runHubspotPushJob(job as Parameters<typeof runHubspotPushJob>[0], prisma);
    },
    {
      ...BASE_CONNECTION,
      concurrency: 10,
      lockDuration: 60_000,
      stalledInterval: 30_000,
    },
  );
  instrumentWorker(hubspotPushWorker, HUBSPOT_PUSH_QUEUE_NAME);
  attachDlqOnFailed(hubspotPushWorker, 'hubspot-push', HUBSPOT_PUSH_QUEUE_NAME);
  hubspotPushWorker.on('error', (err) =>
    logger.error({ err }, 'hubspot-push-worker: error'),
  );

  // -- N04 HubSpot Webhook (inbound event processor, concurrency 5) ----------
  registerQueue(HUBSPOT_WEBHOOK_QUEUE_NAME, HUBSPOT_WEBHOOK_JOB_OPTS);

  const hubspotWebhookWorker = new Worker(
    HUBSPOT_WEBHOOK_QUEUE_NAME,
    async (job) => {
      await runHubspotWebhookJob(job as Parameters<typeof runHubspotWebhookJob>[0], prisma);
    },
    {
      ...BASE_CONNECTION,
      concurrency: 5,
      lockDuration: 60_000,
      stalledInterval: 30_000,
    },
  );
  instrumentWorker(hubspotWebhookWorker, HUBSPOT_WEBHOOK_QUEUE_NAME);
  attachDlqOnFailed(hubspotWebhookWorker, 'hubspot-webhook', HUBSPOT_WEBHOOK_QUEUE_NAME);
  hubspotWebhookWorker.on('error', (err) =>
    logger.error({ err }, 'hubspot-webhook-worker: error'),
  );

  // -- Callback tick workers (setInterval + Valkey lock, PLAN §2.3) ---------
  // D06 IMPLEMENT replaces these stubs with full tick logic.
  const intervals: NodeJS.Timeout[] = [];
  const TENANT_ID = BigInt(process.env.VICI2_TENANT_ID ?? 1);

  intervals.push(
    setInterval(() => {
      logger.debug({ tenantId: String(TENANT_ID) }, 'callback-fire: tick (stub)');
    }, 30_000),
  );

  intervals.push(
    setInterval(() => {
      logger.debug({ tenantId: String(TENANT_ID) }, 'callback-upcoming: tick (stub)');
    }, 60_000),
  );

  intervals.push(
    setInterval(() => {
      logger.debug({ tenantId: String(TENANT_ID) }, 'callback-stale: tick (stub)');
    }, 5 * 60_000),
  );

  return {
    leadImportWorker,
    auditAttestWorker,
    federalDncWorker,
    stateDncWorker,
    poolReaperWorker,
    hubspotSyncWorker,
    hubspotPushWorker,
    hubspotWebhookWorker,
    intervals,
  };
}

// ---- Shutdown Manager -------------------------------------------------------

const shutdownMgr = new ShutdownManager();

// ---- Main ------------------------------------------------------------------

async function main(): Promise<void> {
  logger.info('workers: starting');

  await healthServer.listen();
  logger.info({ port: METRICS_PORT }, 'workers: HTTP server listening');

  const {
    leadImportWorker,
    auditAttestWorker,
    federalDncWorker,
    stateDncWorker,
    poolReaperWorker,
    hubspotSyncWorker,
    hubspotPushWorker,
    hubspotWebhookWorker,
    intervals,
  } = await startWorkers();

  const stopPoller = startMetricsPoller(queues, DLQ_STREAMS, redis);

  // Shutdown registration (PLAN §11.2) — reversed at shutdown time.
  // Register last-closed first. Readiness gate must flip first → register last.

  // HTTP server (closed last so load balancers see /ready:503 before it stops)
  shutdownMgr.register({
    name: 'http-server',
    close: () => healthServer.close(),
  });

  // Redis disconnect (after all workers have stopped)
  shutdownMgr.register({
    name: 'redis',
    close: async () => { redis.disconnect(); },
  });

  // Prisma disconnect
  shutdownMgr.register({
    name: 'prisma',
    close: async () => { await prisma.$disconnect(); },
  });

  // Metrics poller stop
  shutdownMgr.register({
    name: 'metrics-poller',
    close: async () => { stopPoller(); },
  });

  // Callback intervals
  shutdownMgr.register({
    name: 'callback-ticks',
    close: async () => { intervals.forEach(clearInterval); },
  });

  // BullMQ workers — drain with timeout (in reverse order of shutdown priority)
  shutdownMgr.register({
    name: 'hubspot-webhook-worker',
    close: async () => {
      await hubspotWebhookWorker.pause(true);
      await hubspotWebhookWorker.close(false);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  shutdownMgr.register({
    name: 'hubspot-push-worker',
    close: async () => {
      await hubspotPushWorker.pause(true);
      await hubspotPushWorker.close(false);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  shutdownMgr.register({
    name: 'hubspot-sync-worker',
    close: async () => {
      await hubspotSyncWorker.pause(true);
      await hubspotSyncWorker.close(false);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  shutdownMgr.register({
    name: 'pool-reaper-worker',
    close: async () => {
      await poolReaperWorker.pause(true);
      await poolReaperWorker.close(false);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  shutdownMgr.register({
    name: 'state-dnc-worker',
    close: async () => {
      await stateDncWorker.pause(true);
      await stateDncWorker.close(false);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  shutdownMgr.register({
    name: 'federal-dnc-worker',
    close: async () => {
      await federalDncWorker.pause(true);
      await federalDncWorker.close(false);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  shutdownMgr.register({
    name: 'audit-attest-worker',
    close: async () => {
      await auditAttestWorker.pause(true);
      await auditAttestWorker.close(false);
    },
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  // Lead import: 5-min drain (long-running CSV jobs, PLAN §11.3)
  shutdownMgr.register({
    name: 'lead-import-worker',
    close: async () => {
      await leadImportWorker.pause(true);
      await leadImportWorker.close(false);
    },
    timeoutMs: 300_000,
  });

  // Readiness gate (closed first = registered last = executed first in reversal)
  shutdownMgr.register({
    name: 'readiness-gate',
    close: async () => { healthServer.setNotReady(); },
  });

  // Bind OS signals
  shutdownMgr.listenFor('SIGTERM', logger);
  shutdownMgr.listenFor('SIGINT', logger);

  logger.info('workers: all workers registered; /ready is healthy');
}

main().catch((err: unknown) => {
  logger.error({ err }, 'workers: fatal startup error');
  process.exit(1);
});
