// D02 — POST /api/admin/lists/:listId/imports (PLAN §5.2)
// Multipart upload → local/S3 storage → BullMQ job.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

import { ulid } from "ulidx";
import { Queue } from "bullmq";
import { getRedis } from "../../lib/redis.js";
import { getPrisma } from "../../lib/prisma.js";
import { ImportMetaSchema } from "../schemas.js";
import { uploadLocalStream, sourceKey, MAX_UPLOAD_BYTES } from "../storage.js";

const QUEUE_NAME = "vici2:queue:lead-import";

function getQueue(): Queue {
  return new Queue(QUEUE_NAME, {
    connection: getRedis(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: { age: 7 * 24 * 3600, count: 10_000 },
      removeOnFail: { age: 30 * 24 * 3600 },
    },
  });
}

export function registerCreateImportRoute(app: AnyApp): void {
  app.post(
    "/api/admin/lists/:listId/imports",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:import"),
      ],
      config: {
        bodyTimeout: 1_800_000,  // 30 min for slow uplinks
      },
    },
    async (req: AnyApp, reply: AnyApp) => {
      const listId = BigInt(req.params.listId);
      const tenantId = BigInt(req.auth.tenantId);
      const ownerUserId = BigInt(req.auth.uid);
      const prisma = getPrisma();

      // Verify list belongs to tenant
      const list = await prisma.$queryRawUnsafe<Array<{ id: bigint }>>(
        "SELECT id FROM lists WHERE id = ? AND tenant_id = ? LIMIT 1",
        listId, tenantId,
      ).then((rows: Array<{ id: bigint }>) => rows[0]);

      if (!list) {
        return reply.code(404).send({ error: "LIST_NOT_FOUND" });
      }

      // Parse multipart
      const parts = req.parts();

      let fileStream: AnyApp = null;
      let filename = "upload.csv";
      let metaRaw: Record<string, unknown> = {};

      for await (const part of parts) {
        if (part.type === "file" && part.fieldname === "file") {
          filename = part.filename ?? "upload.csv";
          fileStream = part.file;
        } else if (part.type === "field" && part.fieldname === "meta") {
          try {
            metaRaw = JSON.parse(part.value as string);
          } catch {
            return reply.code(400).send({ error: "INVALID_META", message: "meta must be valid JSON" });
          }
        }
      }

      if (!fileStream) {
        return reply.code(400).send({ error: "MISSING_FILE", message: "file part required" });
      }

      // Validate meta
      const metaParsed = ImportMetaSchema.safeParse(metaRaw);
      if (!metaParsed.success) {
        return reply.code(400).send({ error: "INVALID_META", issues: metaParsed.error.issues });
      }
      const meta = metaParsed.data;

      // Validate filename safety (no path traversal)
      if (/[/\\]|\.\./.test(filename)) {
        return reply.code(400).send({ error: "INVALID_FILENAME" });
      }

      // Only CSV/TSV supported in Phase 1
      const ext = filename.toLowerCase().split(".").pop();
      if (!["csv", "tsv", "txt"].includes(ext ?? "")) {
        return reply.code(400).send({
          error: "UNSUPPORTED_FORMAT",
          message: "Only CSV/TSV files supported in Phase 1. XLSX: save as CSV.",
        });
      }

      // Generate import ID
      const importId = ulid();
      const key = sourceKey(importId, filename);

      // Upload file
      let fileBytes = 0;
      try {
        const result = await uploadLocalStream(fileStream, key, MAX_UPLOAD_BYTES);
        fileBytes = result.bytesWritten;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FILE_TOO_LARGE") {
          return reply.code(413).send({ error: "FILE_TOO_LARGE", message: (err as Error).message });
        }
        throw err;
      }

      // Insert import record
      await prisma.$executeRawUnsafe(
        `INSERT INTO imports
           (id, tenant_id, list_id, owner_user_id, status, source_key,
            file_bytes, meta, error_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, 10000, NOW(6), NOW(6))`,
        importId,
        tenantId,
        listId,
        ownerUserId,
        key,
        fileBytes,
        JSON.stringify(meta),
      );

      // Enqueue BullMQ job
      const queue = getQueue();
      await queue.add("import", {
        importId,
        tenantId: Number(tenantId),
        listId: Number(listId),
        ownerUserId: Number(ownerUserId),
      }, {
        jobId: importId,
      });
      await queue.close();

      return reply.code(202).send({
        import_id: importId,
        status: "queued",
        estimated_rows: null,
      });
    },
  );
}
