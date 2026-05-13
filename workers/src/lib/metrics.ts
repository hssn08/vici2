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
