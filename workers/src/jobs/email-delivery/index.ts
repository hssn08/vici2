// N01 — Email delivery BullMQ worker entry point.
// Queue: vici2:queue:email-delivery
// Concurrency: 5; attempts: 3; backoff: exponential(2000ms).
// DLQ: Valkey stream events:vici2.dlq.email-delivery (W01 pattern).

import "dotenv-flow/config";
import { Worker } from "bullmq";
import Redis from "ioredis";
import pino from "pino";

import { processEmailJob } from "./processor.js";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "email-delivery" },
});

const QUEUE = "vici2:queue:email-delivery";

const connection = new Redis(
  process.env.VICI2_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379/0",
  { maxRetriesPerRequest: null },
);

const worker = new Worker(QUEUE, processEmailJob, {
  connection,
  concurrency: 5,
});

worker.on("completed", (job) => {
  logger.info({ jobId: job.id }, "n01:email-delivery: job completed");
});

worker.on("failed", (job, err) => {
  if (job) {
    logger.error({ jobId: job.id, err, attempts: job.attemptsMade }, "n01:email-delivery: job failed");

    // DLQ on exhaustion (W01 pattern)
    if (job.attemptsMade >= (job.opts.attempts ?? 3)) {
      connection.xadd(
        "events:vici2.dlq.email-delivery",
        "*",
        "jobId", job.id ?? "",
        "data", JSON.stringify(job.data),
        "error", String(err.message),
        "ts", new Date().toISOString(),
      ).catch((dlqErr) => {
        logger.error({ dlqErr }, "n01:email-delivery: failed to write DLQ");
      });
    }
  }
});

logger.info({ queue: QUEUE }, "n01:email-delivery worker started");

// Graceful shutdown
let shutdownCalled = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownCalled) return;
  shutdownCalled = true;
  logger.info({ signal }, "n01:email-delivery: shutting down");
  await worker.close();
  await connection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
