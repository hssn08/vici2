// N01 — Nightly notification retention cleanup worker.
// BullMQ repeatable job, schedule: "0 3 * * *" (3 AM UTC).
// Queue: vici2:queue:notif-cleanup
// Retention policy:
//   read notifications:   delete after 7 days
//   unread notifications: delete after 30 days
// Batches of 1000 per run to avoid long table locks.

import "dotenv-flow/config";
import { Worker, Queue } from "bullmq";
import { PrismaClient } from "@prisma/client";
import Redis from "ioredis";
import pino from "pino";
import client from "prom-client";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: "notif-cleanup" },
});

const cleanupTotal = new client.Counter({
  name: "vici2_n01_cleanup_deleted_total",
  help: "Total notification rows deleted by cleanup job",
});

const QUEUE = "vici2:queue:notif-cleanup";
const BATCH = 1000;

const connection = new Redis(
  process.env.VICI2_REDIS_URL ?? process.env.REDIS_URL ?? "redis://localhost:6379/0",
  { maxRetriesPerRequest: null },
);

const prisma = new PrismaClient();

async function runCleanup(): Promise<{ deleted: number }> {
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  let totalDeleted = 0;
  let batch = 0;

  // Batch until no rows remain
  do {
    const readResult = await prisma.$executeRaw`
      DELETE FROM notifications
      WHERE read_at IS NOT NULL AND created_at < ${sevenDaysAgo}
      LIMIT ${BATCH}
    `;
    const unreadResult = await prisma.$executeRaw`
      DELETE FROM notifications
      WHERE read_at IS NULL AND created_at < ${thirtyDaysAgo}
      LIMIT ${BATCH}
    `;
    batch = Number(readResult) + Number(unreadResult);
    totalDeleted += batch;
  } while (batch >= BATCH);

  return { deleted: totalDeleted };
}

// Register repeatable job on startup
const queue = new Queue(QUEUE, { connection });
void queue.add(
  "cleanup",
  {},
  {
    repeat: { cron: "0 3 * * *" },
    removeOnComplete: 5,
    removeOnFail: 5,
  },
);

const worker = new Worker(
  QUEUE,
  async () => {
    const result = await runCleanup();
    cleanupTotal.inc(result.deleted);
    logger.info({ deleted: result.deleted }, "n01:cleanup: completed");
  },
  { connection },
);

worker.on("failed", (job, err) => {
  logger.error({ jobId: job?.id, err }, "n01:cleanup: job failed");
});

logger.info({ queue: QUEUE }, "n01:cleanup worker started");

// Graceful shutdown
let shutdownCalled = false;
async function shutdown(signal: string): Promise<void> {
  if (shutdownCalled) return;
  shutdownCalled = true;
  logger.info({ signal }, "n01:cleanup: shutting down");
  await worker.close();
  await queue.close();
  await prisma.$disconnect();
  await connection.quit();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
