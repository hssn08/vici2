/**
 * workers/src/lib/metrics.ts
 *
 * Shared prom-client registry + BullMQ queue metrics.
 *
 * Metrics (FROZEN per PLAN §9):
 *   vici2_bullmq_jobs_active       Gauge  (queue)
 *   vici2_bullmq_jobs_waiting      Gauge  (queue)
 *   vici2_bullmq_jobs_delayed      Gauge  (queue)
 *   vici2_bullmq_jobs_failed       Gauge  (queue)
 *   vici2_bullmq_jobs_completed    Gauge  (queue)
 *   vici2_bullmq_job_duration_seconds  Histogram  (queue, status)
 *   vici2_bullmq_job_wait_seconds      Histogram  (queue)
 *   vici2_bullmq_job_attempts_total    Counter    (queue, outcome)
 *   vici2_worker_dlq_depth         Gauge  (worker)
 */

import client, { type Registry } from 'prom-client';
import type { Queue, Worker } from 'bullmq';

// ---- Singleton registry ----
export const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'vici2_node_' });

// ---- BullMQ queue depth gauges ----

export const bullmqJobsActive = new client.Gauge({
  name: 'vici2_bullmq_jobs_active',
  help: 'Number of currently active BullMQ jobs',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const bullmqJobsWaiting = new client.Gauge({
  name: 'vici2_bullmq_jobs_waiting',
  help: 'Number of waiting BullMQ jobs',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const bullmqJobsDelayed = new client.Gauge({
  name: 'vici2_bullmq_jobs_delayed',
  help: 'Number of delayed BullMQ jobs',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const bullmqJobsFailed = new client.Gauge({
  name: 'vici2_bullmq_jobs_failed',
  help: 'Number of failed BullMQ jobs (in failed set)',
  labelNames: ['queue'] as const,
  registers: [registry],
});

export const bullmqJobsCompleted = new client.Gauge({
  name: 'vici2_bullmq_jobs_completed',
  help: 'Number of completed BullMQ jobs (in completed set)',
  labelNames: ['queue'] as const,
  registers: [registry],
});

// ---- Job timing histograms ----

export const bullmqJobDuration = new client.Histogram({
  name: 'vici2_bullmq_job_duration_seconds',
  help: 'BullMQ job execution duration in seconds',
  labelNames: ['queue', 'status'] as const,
  buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 300, 600, 1_800],
  registers: [registry],
});

export const bullmqJobWait = new client.Histogram({
  name: 'vici2_bullmq_job_wait_seconds',
  help: 'Time a BullMQ job spent waiting in queue before processing',
  labelNames: ['queue'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 5, 30, 120],
  registers: [registry],
});

// ---- Attempt counter ----

export const bullmqJobAttempts = new client.Counter({
  name: 'vici2_bullmq_job_attempts_total',
  help: 'Total BullMQ job attempt outcomes',
  labelNames: ['queue', 'outcome'] as const,
  registers: [registry],
});

// ---- DLQ depth gauge ----

export const workerDlqDepth = new client.Gauge({
  name: 'vici2_worker_dlq_depth',
  help: 'Number of entries in the per-worker DLQ stream',
  labelNames: ['worker'] as const,
  registers: [registry],
});

// ---- BullMQ event instrumentation ----

/**
 * Attach completed/failed event listeners to a BullMQ Worker to record
 * job duration, wait time, and attempt counts.
 */
export function instrumentWorker(worker: Worker, queueName: string): void {
  worker.on('completed', (job) => {
    if (!job.processedOn || !job.finishedOn || !job.timestamp) return;
    bullmqJobDuration.observe(
      { queue: queueName, status: 'completed' },
      (job.finishedOn - job.processedOn) / 1_000,
    );
    bullmqJobWait.observe(
      { queue: queueName },
      (job.processedOn - job.timestamp) / 1_000,
    );
    bullmqJobAttempts.inc({ queue: queueName, outcome: 'completed' });
  });

  worker.on('failed', (job, _err) => {
    if (!job) return;
    bullmqJobAttempts.inc({ queue: queueName, outcome: 'failed' });
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      bullmqJobAttempts.inc({ queue: queueName, outcome: 'dlq' });
    }
  });
}

/** Minimal Redis interface for the metrics poller. */
export interface MetricsRedisClient {
  xlen(key: string): Promise<number>;
}

/**
 * Poll queue depths and DLQ stream depths, updating gauges.
 * Returns a cleanup function to stop polling.
 */
export function startMetricsPoller(
  queues: Map<string, Queue>,
  dlqStreams: Map<string, string>, // worker → stream key
  redis: MetricsRedisClient,
  pollIntervalMs = 30_000,
): () => void {
  const interval = setInterval(async () => {
    for (const [name, queue] of queues) {
      try {
        const [active, waiting, delayed, failed, completed] = await Promise.all([
          queue.getActiveCount(),
          queue.getWaitingCount(),
          queue.getDelayedCount(),
          queue.getFailedCount(),
          queue.getCompletedCount(),
        ]);
        bullmqJobsActive.set({ queue: name }, active);
        bullmqJobsWaiting.set({ queue: name }, waiting);
        bullmqJobsDelayed.set({ queue: name }, delayed);
        bullmqJobsFailed.set({ queue: name }, failed);
        bullmqJobsCompleted.set({ queue: name }, completed);
      } catch {
        // non-fatal — log at debug in production
      }
    }

    for (const [worker, stream] of dlqStreams) {
      try {
        const len = await redis.xlen(stream);
        workerDlqDepth.set({ worker }, len);
      } catch {
        // non-fatal
      }
    }
  }, pollIntervalMs);

  interval.unref();
  return () => clearInterval(interval);
}

/** Create a standalone registry for tests or isolated worker packages. */
export function createRegistry(): Registry {
  return new client.Registry();
}

// ---------------------------------------------------------------------------
// N06 — RND Scrub metrics
// ---------------------------------------------------------------------------

export const rndQueriesTotal = new client.Counter({
  name: 'vici2_rnd_queries_total',
  help: 'Total RND queries issued',
  labelNames: ['tenant_id', 'result'] as const,
  registers: [registry],
});

export const rndFlaggedTotal = new client.Counter({
  name: 'vici2_rnd_flagged_total',
  help: 'Numbers flagged as reassigned by RND',
  labelNames: ['tenant_id'] as const,
  registers: [registry],
});

export const rndApiDuration = new client.Histogram({
  name: 'vici2_rnd_api_duration_seconds',
  help: 'RND API call latency in seconds',
  labelNames: ['mode'] as const,
  buckets: [0.05, 0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});

export const rndMonthlyCostCents = new client.Gauge({
  name: 'vici2_rnd_monthly_cost_cents',
  help: 'Current month estimated RND cost in cents',
  labelNames: ['tenant_id'] as const,
  registers: [registry],
});

export const rndRateLimitTotal = new client.Counter({
  name: 'vici2_rnd_rate_limit_total',
  help: 'RND API rate limit (429) hits',
  labelNames: ['tenant_id'] as const,
  registers: [registry],
});

export const rndOutageTotal = new client.Counter({
  name: 'vici2_rnd_outage_total',
  help: 'RND API outage (503/502/504) events detected',
  registers: [registry],
});

export const rndScrubJobsTotal = new client.Counter({
  name: 'vici2_rnd_scrub_jobs_total',
  help: 'Total RND scrub jobs by status and trigger reason',
  labelNames: ['status', 'trigger_reason'] as const,
  registers: [registry],
});

export const rndScrubDuration = new client.Histogram({
  name: 'vici2_rnd_scrub_duration_seconds',
  help: 'RND scrub job total duration in seconds',
  labelNames: ['query_mode'] as const,
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [registry],
});

// ---------------------------------------------------------------------------
// N05 — Branded Calling metrics
// ---------------------------------------------------------------------------

export const brandRepScoreGauge = new client.Gauge({
  name: 'vici2_branded_did_reputation_score',
  help: 'Normalized brand reputation score (0–100) for active branded DIDs',
  labelNames: ['provider', 'tenant_id'] as const,
  registers: [registry],
});

export const brandedDidCountGauge = new client.Gauge({
  name: 'vici2_branded_did_count',
  help: 'Count of active branded DID registrations per provider',
  labelNames: ['provider', 'tenant_id', 'status'] as const,
  registers: [registry],
});

// ---------------------------------------------------------------------------
// W02 — WS queue event publisher
// ---------------------------------------------------------------------------

/** Minimal Redis interface for event publishing. */
export interface QueueEventPublisher {
  xadd(key: string, id: string, ...args: string[]): Promise<unknown>;
}

/**
 * Publish a BullMQ lifecycle event to the shared jobs event stream.
 * Consumed by the API's WS broadcaster; triggers TanStack Query invalidation
 * on connected admin clients.
 *
 * Stream: events:vici2.bullmq.jobs (MAXLEN ~ 1000)
 */
export async function publishQueueEvent(
  redis: QueueEventPublisher,
  params: {
    queueName: string;
    event: 'completed' | 'failed' | 'active' | 'waiting';
    jobId: string;
    tenantId: string | number;
  },
): Promise<void> {
  try {
    await redis.xadd(
      'events:vici2.bullmq.jobs',
      'MAXLEN', '~', '1000', '*',
      'queue', params.queueName,
      'event', params.event,
      'jobId', params.jobId,
      'tenantId', String(params.tenantId),
      'ts', String(Date.now()),
    );
  } catch {
    // non-fatal — WS events are best-effort; 5s polling is the fallback
  }
}

/**
 * Attach completed/failed event listeners to a BullMQ Worker to publish
 * WS queue events in addition to Prometheus metrics.
 *
 * Call after instrumentWorker() or in place of it.
 */
export function instrumentWorkerWithEvents(
  worker: Worker,
  queueName: string,
  redis: QueueEventPublisher,
): void {
  // Instrument Prometheus metrics
  instrumentWorker(worker, queueName);

  // Publish WS events
  worker.on('completed', async (job) => {
    await publishQueueEvent(redis, {
      queueName,
      event: 'completed',
      jobId: job.id ?? '',
      tenantId: (job.data as Record<string, unknown>)?.tenantId as string ?? '0',
    });
  });

  worker.on('failed', async (job, _err) => {
    if (!job) return;
    await publishQueueEvent(redis, {
      queueName,
      event: 'failed',
      jobId: job.id ?? '',
      tenantId: (job.data as Record<string, unknown>)?.tenantId as string ?? '0',
    });
  });

  worker.on('active', async (job) => {
    await publishQueueEvent(redis, {
      queueName,
      event: 'active',
      jobId: job.id ?? '',
      tenantId: (job.data as Record<string, unknown>)?.tenantId as string ?? '0',
    });
  });
}
