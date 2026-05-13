// D02 — BullMQ Worker constructor + lifecycle hooks (PLAN §6.1-6.2)

import "dotenv-flow/config";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const { PrismaClient } = require("@prisma/client") as any;
import pino from "pino";
import type { ImportJobPayload } from "./types.js";
import processImport from "./processor.js";

const logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
const QUEUE_NAME = "vici2:queue:lead-import";

const redis = new Redis(process.env.VICI2_REDIS_URL ?? "redis://localhost:6379/0", {
  maxRetriesPerRequest: null,  // Required by BullMQ
  lazyConnect: false,
});

const prisma = new PrismaClient();

export function startLeadImportWorker(): Worker<ImportJobPayload> {
  const worker = new Worker<ImportJobPayload>(
    QUEUE_NAME,
    async (job: Job<ImportJobPayload>) => {
      logger.info({ importId: job.data.importId, jobId: job.id }, "lead-import job started");
      return processImport(job as { id: string; data: ImportJobPayload; updateProgress: (p: unknown) => Promise<void> });
    },
    {
      connection: redis,
      concurrency: 2,
      lockDuration: 60_000,
      stalledInterval: 30_000,
    },
  );

  worker.on("active", async (job) => {
    logger.info({ importId: job.data.importId }, "import active");
    await prisma.$executeRawUnsafe(
      "UPDATE imports SET status = 'running', started_at = NOW(6) WHERE id = ? AND status = 'queued'",
      job.data.importId,
    );
  });

  worker.on("completed", async (job, result) => {
    logger.info({ importId: job.data.importId, ...result }, "import completed");
  });

  worker.on("failed", async (job, err) => {
    if (!job) return;
    const reason = err?.message?.slice(0, 255) ?? "unknown";
    logger.error({ importId: job.data.importId, err }, "import failed");
    // Only mark failed after final retry (attempts exhausted)
    if (job.attemptsMade >= (job.opts?.attempts ?? 3)) {
      await prisma.$executeRawUnsafe(
        "UPDATE imports SET status = 'failed', failed_reason = ? WHERE id = ?",
        reason,
        job.data.importId,
      );
    }
  });

  worker.on("error", (err) => {
    logger.error({ err }, "worker error");
  });

  return worker;
}
