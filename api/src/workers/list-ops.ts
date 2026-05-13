// D07 — BullMQ worker for async list reset and purge operations.
//
// Processes list-ops jobs in batches of 1000 using cursor-based pagination
// for O(1) memory and safe resumption after interruption.

import { Worker } from "bullmq";
import { getRedis } from "../lib/redis.js";
import { getPrisma } from "../lib/prisma.js";
import { LIST_OPS_QUEUE, setJobProgress, type ListOpJobData, type JobProgress } from "../lists/jobs.js";
import { auditList } from "../lists/audit.js";
import { invalidateStatsCache } from "../lists/stats.js";

const WORKER_CONCURRENCY = 2;

// ---------------------------------------------------------------------------
// Reset processor — UPDATE leads SET status='NEW' in cursor batches
// ---------------------------------------------------------------------------
async function processReset(
  jobId: string,
  tenantId: number,
  listId: number,
  actorUserId: number,
  requestId: string,
  batchSize: number,
): Promise<void> {
  const prisma = getPrisma();
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);

  // Count total for progress tracking (capped at 5M for safety)
  const countRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM leads
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
      LIMIT 5000001
    ) sub
  `;
  const total = Number(countRows[0]?.n ?? 0);

  const progress: JobProgress = {
    status: "running",
    processed: 0,
    total,
    pct: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
  };
  await setJobProgress(jobId, progress);

  let cursor = BigInt(0);
  let processed = 0;

  while (true) {
    // Batch update with cursor
    const result = await prisma.$executeRaw`
      UPDATE leads
      SET status = 'NEW',
          called_count = 0,
          last_called_at = NULL
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
        AND id > ${cursor}
      ORDER BY id ASC
      LIMIT ${batchSize}
    `;

    const batchAffected = Number(result);
    processed += batchAffected;

    // Advance cursor to last processed id
    if (batchAffected > 0) {
      const lastRow = await prisma.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM leads
        WHERE tenant_id = ${tid}
          AND list_id = ${lid}
          AND deleted_at IS NULL
          AND id > ${cursor}
        ORDER BY id ASC
        LIMIT 1
        OFFSET ${batchAffected - 1}
      `;
      if (lastRow[0]) {
        cursor = lastRow[0].id;
      }
    }

    // Update progress
    const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
    await setJobProgress(jobId, { ...progress, processed, pct });

    if (batchAffected < batchSize) break;
  }

  // Write completion audit row
  await auditList({
    tx: prisma,
    actorUserId,
    actorKind: "worker",
    action: "list.reset.completed",
    tenantId,
    entityId: String(listId),
    afterJson: { affected: processed, mode: "async", job_id: jobId, request_id: requestId },
  });

  // Invalidate stats cache
  await invalidateStatsCache(tenantId, listId);

  // Mark done
  const done: JobProgress = {
    ...progress,
    status: "done",
    processed,
    pct: 100,
    finished_at: new Date().toISOString(),
  };
  await setJobProgress(jobId, done);
}

// ---------------------------------------------------------------------------
// Purge processor — UPDATE leads SET status='DELETED', deleted_at=NOW()
// ---------------------------------------------------------------------------
async function processPurge(
  jobId: string,
  tenantId: number,
  listId: number,
  actorUserId: number,
  requestId: string,
  batchSize: number,
): Promise<void> {
  const prisma = getPrisma();
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);

  const countRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM leads
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
      LIMIT 5000001
    ) sub
  `;
  const total = Number(countRows[0]?.n ?? 0);

  const progress: JobProgress = {
    status: "running",
    processed: 0,
    total,
    pct: 0,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
  };
  await setJobProgress(jobId, progress);

  const now = new Date();
  let cursor = BigInt(0);
  let processed = 0;

  while (true) {
    const result = await prisma.$executeRaw`
      UPDATE leads
      SET status = 'DELETED',
          deleted_at = ${now}
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
        AND id > ${cursor}
      ORDER BY id ASC
      LIMIT ${batchSize}
    `;

    const batchAffected = Number(result);
    processed += batchAffected;

    if (batchAffected > 0) {
      const lastRow = await prisma.$queryRaw<Array<{ id: bigint }>>`
        SELECT id FROM leads
        WHERE tenant_id = ${tid}
          AND list_id = ${lid}
          AND deleted_at = ${now}
          AND id > ${cursor}
        ORDER BY id ASC
        LIMIT 1
        OFFSET ${batchAffected - 1}
      `;
      if (lastRow[0]) cursor = lastRow[0].id;
    }

    const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
    await setJobProgress(jobId, { ...progress, processed, pct });

    if (batchAffected < batchSize) break;
  }

  await auditList({
    tx: prisma,
    actorUserId,
    actorKind: "worker",
    action: "list.purge.completed",
    tenantId,
    entityId: String(listId),
    afterJson: { affected: processed, mode: "async", job_id: jobId, request_id: requestId },
  });

  await invalidateStatsCache(tenantId, listId);

  const done: JobProgress = {
    ...progress,
    status: "done",
    processed,
    pct: 100,
    finished_at: new Date().toISOString(),
  };
  await setJobProgress(jobId, done);
}

// ---------------------------------------------------------------------------
// Worker registration
// ---------------------------------------------------------------------------
export function startListOpsWorker(): Worker<ListOpJobData> {
  const redis = getRedis();

  const worker = new Worker<ListOpJobData>(
    LIST_OPS_QUEUE,
    async (job) => {
      const jobId = String(job.id);
      const data = job.data;

      try {
        if (data.type === "reset") {
          await processReset(
            jobId,
            data.tenantId,
            data.listId,
            data.actorUserId,
            data.requestId,
            data.batchSize,
          );
        } else if (data.type === "purge") {
          await processPurge(
            jobId,
            data.tenantId,
            data.listId,
            data.actorUserId,
            data.requestId,
            data.batchSize,
          );
        }
      } catch (err) {
        const errMsg = (err as Error).message ?? "unknown error";
        const failed: JobProgress = {
          status: "failed",
          processed: 0,
          total: 0,
          pct: 0,
          started_at: null,
          finished_at: new Date().toISOString(),
          error: errMsg,
        };
        await setJobProgress(jobId, failed);

        // Audit failure
        const prisma = getPrisma();
        const action = data.type === "reset" ? "list.reset.failed" : "list.purge.failed";
        await auditList({
          tx: prisma,
          actorUserId: data.actorUserId,
          actorKind: "worker",
          action,
          tenantId: data.tenantId,
          entityId: String(data.listId),
          afterJson: { error: errMsg, job_id: jobId },
        }).catch(() => undefined); // best-effort

        throw err;
      }
    },
    {
      connection: redis,
      concurrency: WORKER_CONCURRENCY,
    },
  );

  return worker;
}
