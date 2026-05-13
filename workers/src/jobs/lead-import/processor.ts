// D02 — BullMQ sandboxed processor (PLAN §6.1)
// This file is compiled to processor.cjs and loaded in a sandboxed child process.
// Crash in the hot loop only kills the child; parent worker respawns.

import "dotenv-flow/config";
// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const { PrismaClient } = require("@prisma/client") as any;
import { Redis } from "ioredis";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { detectEncoding, createEncodingTransform } from "./pipeline/encoding-detect.js";
import { createDirectCsvTransform } from "./pipeline/csv-parser.js";
import { ApplyMappingTransform } from "./pipeline/apply-mapping.js";
import { NormalizeValidateTransform } from "./pipeline/normalize-validate.js";
import { InFileDedupTransform } from "./pipeline/in-file-dedup.js";
import { DncTcpaScrubTransform } from "./pipeline/dnc-tcpa-scrub.js";
import { BatcherTransform } from "./pipeline/batcher.js";
import { DbWriterWritable } from "./pipeline/db-writer.js";
import { ErrorsCollector } from "./pipeline/errors-stream.js";
import { VICIDIAL_DEFAULT_MAPPING, validateMapping } from "./mapping.js";
import type { ImportJobPayload, ImportMeta, ColumnMapping, RowError } from "./types.js";

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
});

const redis = new Redis(process.env.VICI2_REDIS_URL ?? "redis://localhost:6379/0", {
  lazyConnect: true,
  maxRetriesPerRequest: 1,
});

export default async function processImport(
  job: { id: string; data: ImportJobPayload; updateProgress: (p: unknown) => Promise<void> }
): Promise<{ inserted: number; skipped: number; errored: number }> {
  const { importId, tenantId, listId, ownerUserId } = job.data;

  // ── Load import record ────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const importRow: { source_key: string; meta: string; row_count_processed: number; error_limit: number } | undefined = await (prisma.$queryRawUnsafe as any)(
    "SELECT source_key, meta, row_count_processed, error_limit FROM imports WHERE id = ? LIMIT 1",
    importId,
  ).then((rows: { source_key: string; meta: string; row_count_processed: number; error_limit: number }[]) => rows[0]);

  if (!importRow) throw new Error(`Import ${importId} not found`);

  const meta: ImportMeta = typeof importRow.meta === "string"
    ? JSON.parse(importRow.meta)
    : importRow.meta;

  const sourceKey = importRow.source_key;
  const resumeFromBatch = Math.floor(importRow.row_count_processed / 500);

  // ── Resolve mapping ───────────────────────────────────────────────────────
  let mapping: ColumnMapping;
  if (meta.mapping === "vicidial_default") {
    mapping = { version: 1, rows: VICIDIAL_DEFAULT_MAPPING, options: {} };
  } else if (meta.mapping === "inherit" || !meta.mapping) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listRow: { column_mapping: string | null } | undefined = await (prisma.$queryRawUnsafe as any)(
      "SELECT column_mapping FROM lists WHERE id = ? LIMIT 1",
      listId,
    ).then((rows: { column_mapping: string | null }[]) => rows[0]);

    if (!listRow?.column_mapping) {
      throw new Error("HEADER_MISMATCH: No column_mapping saved for this list; use explicit mapping");
    }
    const saved = typeof listRow.column_mapping === "string"
      ? JSON.parse(listRow.column_mapping)
      : listRow.column_mapping;
    mapping = validateMapping(saved);
  } else {
    mapping = validateMapping(meta.mapping);
  }

  // ── Setup errors collector ─────────────────────────────────────────────────
  const errorsFilePath = sourceKey.replace(/\.csv$/i, ".errors.csv")
    .replace(/^s3:\/\/[^/]+\//, join(tmpdir(), "d02-errors/"));
  const errorsKey = sourceKey.includes("s3://")
    ? sourceKey.replace(/\.csv$/i, ".errors.csv")
    : errorsFilePath;

  const errorsCollector = new ErrorsCollector({
    errorsFilePath,
    importId,
    tenantId,
    persistRawErrors: meta.options?.persist_raw_errors ?? false,
    prisma,
  });

  // ── Detect encoding + delimiter ────────────────────────────────────────────
  const filePath = sourceKey.startsWith("s3://")
    ? join(tmpdir(), "d02-download", importId + ".csv")  // S3 download path (Phase 2)
    : sourceKey;

  const encoding = await detectEncoding(filePath);
  const encodingTransform = createEncodingTransform(encoding);

  const delimiter = meta.delimiter === "auto" || !meta.delimiter
    ? ","  // Will be auto-detected; simplified here
    : meta.delimiter;

  // ── Build pipeline stages ─────────────────────────────────────────────────
  // Source declared with let so onRowError closure can reference it
  // eslint-disable-next-line prefer-const
  let source = createReadStream(filePath);

  const onRowError = (errors: RowError[]): void => {
    const ok = errorsCollector.addErrors(errors);
    if (!ok) {
      // MAX_ERRORS_EXCEEDED — abort via source stream destroy
      source.destroy(new Error("MAX_ERRORS_EXCEEDED"));
    }
  };
  const csvParser = createDirectCsvTransform({
    delimiter,
    header_row: meta.header_row !== false,
    skip_rows: meta.skip_rows ?? 0,
  });
  const applyMappingStage = new ApplyMappingTransform({
    mapping,
    hasHeader: meta.header_row !== false,
  });
  const normalizeValidate = new NormalizeValidateTransform({
    defaultCountry: meta.default_country ?? "US",
    defaultStatus: meta.default_status ?? "NEW",
    strictPhone: meta.options?.strict_phone ?? true,
    lookupStateFromZip: meta.options?.lookup_state_from_zip ?? true,
  });
  const inFileDedup = new InFileDedupTransform();
  const dncTcpaScrub = new DncTcpaScrubTransform({
    redis: redis.status === "ready" ? redis : null,
    prisma,
    tenantId,
    dncPolicy: meta.dnc_policy ?? "skip",
    tzPolicy: meta.tz_policy ?? "mark",
    onRowError,
  });
  const batcher = new BatcherTransform(500);
  const dbWriter = new DbWriterWritable({
    prisma,
    importId,
    tenantId: BigInt(tenantId),
    listId: BigInt(listId),
    ownerUserId: BigInt(ownerUserId),
    resumeFromBatch: resumeFromBatch > 0 ? resumeFromBatch : undefined,
    onProgress: async (progress) => {
      await job.updateProgress(progress);
      // Update DB checkpoint
      await prisma.$executeRawUnsafe(
        `UPDATE imports SET
           row_count_processed = ?,
           row_count_inserted = ?,
           row_count_skipped = ?,
           row_count_errored = ?,
           updated_at = NOW(6)
         WHERE id = ?`,
        progress.processed,
        progress.inserted,
        progress.skipped,
        errorsCollector.count,
        importId,
      );
    },
    onBatchComplete: async (_batchIndex, _inserted, _skipped) => {
      // Per-batch checkpoint is handled in onProgress
    },
  });

  // Hook error events from dedup stage
  inFileDedup.on("rowError", (errors: RowError[]) => {
    onRowError(errors);
    dbWriter.incrementErrored(errors.length);
  });

  // Hook normalizeValidate errors (rows with lead=null get emitted as error rows)
  // These are caught by the InFileDedupTransform rowError emission

  // Mark import as running
  await prisma.$executeRawUnsafe(
    "UPDATE imports SET status = 'running', started_at = NOW(6) WHERE id = ? AND status = 'queued'",
    importId,
  );

  // ── Run the pipeline ──────────────────────────────────────────────────────
  try {
    const stages = encodingTransform
      ? [source, encodingTransform, csvParser, applyMappingStage, normalizeValidate, inFileDedup, dncTcpaScrub, batcher, dbWriter]
      : [source, csvParser, applyMappingStage, normalizeValidate, inFileDedup, dncTcpaScrub, batcher, dbWriter];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (pipeline as any)(...stages);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === "MAX_ERRORS_EXCEEDED") {
      // Abort is expected; finalize errors
    } else {
      // Update import as failed
      await prisma.$executeRawUnsafe(
        "UPDATE imports SET status = 'failed', failed_reason = ? WHERE id = ?",
        msg.slice(0, 255),
        importId,
      );
      throw err;
    }
  }

  // ── Flush errors CSV ──────────────────────────────────────────────────────
  await errorsCollector.flush();

  const stats = dbWriter.stats;

  // ── Mark import done ──────────────────────────────────────────────────────
  const finalStatus = errorsCollector.exceeded ? "done" : "done"; // always done if we get here
  await prisma.$executeRawUnsafe(
    `UPDATE imports SET
       status = ?,
       completed_at = NOW(6),
       row_count_processed = ?,
       row_count_inserted = ?,
       row_count_skipped = ?,
       row_count_errored = ?,
       errors_key = ?,
       error_summary = ?,
       updated_at = NOW(6)
     WHERE id = ?`,
    finalStatus,
    stats.processed,
    stats.inserted,
    stats.skipped,
    errorsCollector.count,
    errorsKey,
    JSON.stringify({ byCode: errorsCollector.summary }),
    importId,
  );

  // ── Persist column mapping to list ────────────────────────────────────────
  if (meta.mapping !== "inherit" && meta.mapping !== "vicidial_default") {
    await prisma.$executeRawUnsafe(
      "UPDATE lists SET column_mapping = ?, updated_at = NOW(6) WHERE id = ?",
      JSON.stringify(mapping),
      listId,
    );
  }

  await prisma.$disconnect();

  return { inserted: stats.inserted, skipped: stats.skipped, errored: errorsCollector.count };
}
