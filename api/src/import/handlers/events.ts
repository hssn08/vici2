// D02 — GET /api/admin/imports/:id/events (SSE progress) (PLAN §11)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

import { getRedis } from "../../lib/redis.js";
import { getPrisma } from "../../lib/prisma.js";
import { setupSseHeaders, writeSseEvent, writeSseHeartbeat, startHeartbeat } from "../sse.js";

const POLL_INTERVAL_MS = 1_000;  // 1s polling in fallback mode

export function registerImportEventsRoute(app: AnyApp): void {
  app.get(
    "/api/admin/imports/:id/events",
    {
      preValidation: [app.requireAuth, app.requirePermission("lead:import")],
      config: {
        compress: false,  // Disable compression for SSE
      },
    },
    async (req: AnyApp, reply: AnyApp) => {
      const { id } = req.params as { id: string };
      const tenantId = BigInt(req.auth.tenantId);
      const prisma = getPrisma();

      // Verify import exists and belongs to tenant
      const rows = await prisma.$queryRawUnsafe<Array<{
        id: string;
        status: string;
        row_count_processed: number;
        row_count_total: number | null;
        row_count_inserted: number;
        row_count_skipped: number;
        row_count_errored: number;
        completed_at: Date | null;
        failed_reason: string | null;
      }>>(
        `SELECT id, status, row_count_processed, row_count_total,
                row_count_inserted, row_count_skipped, row_count_errored,
                completed_at, failed_reason
         FROM imports WHERE id = ? AND tenant_id = ? LIMIT 1`,
        id, tenantId,
      );

      if (!rows || rows.length === 0) {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }

      let importData = rows[0]!;

      // Already done — emit final event immediately
      if (importData.status === "done" || importData.status === "failed" || importData.status === "cancelled") {
        setupSseHeaders(reply);
        reply.raw.statusCode = 200;

        const event = importData.status === "done" ? "done" :
                      importData.status === "failed" ? "failed" : "cancelled";

        writeSseEvent(reply, event, {
          status: importData.status,
          import_id: id,
          processed: importData.row_count_processed,
          inserted: importData.row_count_inserted,
          skipped: importData.row_count_skipped,
          errored: importData.row_count_errored,
          completed_at: importData.completed_at?.toISOString() ?? null,
          reason: importData.failed_reason ?? null,
        });

        reply.raw.end();
        return reply;
      }

      // Setup SSE response
      setupSseHeaders(reply);
      reply.raw.statusCode = 200;

      const stopHeartbeat = startHeartbeat(reply);
      const redis = getRedis();

      // Subscribe to BullMQ progress channel via Valkey pub/sub
      const PROGRESS_CHANNEL = `bull:${id}:progress`;
      let subscribeClient: typeof redis | null = null;

      const cleanup = (): void => {
        stopHeartbeat();
        subscribeClient?.unsubscribe(PROGRESS_CHANNEL).catch(() => null);
        subscribeClient?.quit().catch(() => null);
      };

      req.raw.on("close", cleanup);
      req.raw.on("aborted", cleanup);

      try {
        // Try Valkey pub/sub first
        subscribeClient = redis.duplicate();
        await subscribeClient.subscribe(PROGRESS_CHANNEL);

        subscribeClient.on("message", (_channel: string, message: string) => {
          try {
            const progress = JSON.parse(message);
            writeSseEvent(reply, "progress", progress);
          } catch { /* ignore malformed */ }
        });

        // Send initial state immediately
        writeSseEvent(reply, "progress", {
          processed: importData.row_count_processed,
          total: importData.row_count_total,
          inserted: importData.row_count_inserted,
          skipped: importData.row_count_skipped,
          errored: importData.row_count_errored,
        });
        writeSseHeartbeat(reply);

        // Poll DB for final status (workers update DB per batch, pub/sub for live)
        const pollTimer = setInterval(async () => {
          if (reply.raw.destroyed) {
            clearInterval(pollTimer);
            return;
          }

          try {
            const updated = await prisma.$queryRawUnsafe<typeof rows>(
              `SELECT id, status, row_count_processed, row_count_total,
                      row_count_inserted, row_count_skipped, row_count_errored,
                      completed_at, failed_reason
               FROM imports WHERE id = ? AND tenant_id = ? LIMIT 1`,
              id, tenantId,
            );

            if (!updated || updated.length === 0) return;
            importData = updated[0]!;

            if (importData.status === "done") {
              clearInterval(pollTimer);
              writeSseEvent(reply, "done", {
                status: "done",
                import_id: id,
                completed_at: importData.completed_at?.toISOString() ?? null,
              });
              cleanup();
              reply.raw.end();
            } else if (importData.status === "failed") {
              clearInterval(pollTimer);
              writeSseEvent(reply, "failed", {
                status: "failed",
                import_id: id,
                reason: importData.failed_reason,
              });
              cleanup();
              reply.raw.end();
            }
          } catch { /* ignore */ }
        }, POLL_INTERVAL_MS);

        // Keep the request alive until client disconnects or import finishes
        await new Promise<void>((resolve) => {
          reply.raw.on("close", resolve);
          reply.raw.on("finish", resolve);
        });

        clearInterval(pollTimer);
      } catch {
        // Fallback to polling only
      }

      cleanup();
      return reply;
    },
  );
}
