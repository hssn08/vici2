// D02 — POST /api/admin/lists/:listId/mapping/preview (PLAN §5.4)
// Streams first 100 rows only; no DB writes.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

import { createReadStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { getPrisma } from "../../lib/prisma.js";
import { autoDetectMapping } from "../mapping/auto-detect.js";
import { applyMapping, validateMapping } from "../mapping/apply.js";
import type { ColumnMapping } from "./preview-types.js";
import { VICIDIAL_DEFAULT_MAPPING } from "../mapping/auto-detect.js";
import { parse as csvParse } from "csv-parse";
import * as chardet from "chardet";
import * as iconv from "iconv-lite";

const PREVIEW_ROW_LIMIT = 100;

export function registerPreviewRoute(app: AnyApp): void {
  app.post(
    "/api/admin/lists/:listId/mapping/preview",
    {
      preValidation: [app.requireAuth, app.requirePermission("lead:import")],
    },
    async (req: AnyApp, reply: AnyApp) => {
      const listId = BigInt(req.params.listId);
      const tenantId = BigInt(req.auth.tenantId);
      const prisma = getPrisma();

      const body = req.body as {
        source_key?: string;
        mapping?: unknown;
        delimiter?: string;
        header_row?: boolean;
      };

      // Verify list exists
      const list = await prisma.$queryRawUnsafe<Array<{ id: bigint; column_mapping: string | null }>>(
        "SELECT id, column_mapping FROM lists WHERE id = ? AND tenant_id = ? LIMIT 1",
        listId, tenantId,
      ).then((rows: Array<{ id: bigint; column_mapping: string | null }>) => rows[0]);

      if (!list) {
        return reply.code(404).send({ error: "LIST_NOT_FOUND" });
      }

      if (!body.source_key) {
        return reply.code(400).send({ error: "MISSING_SOURCE_KEY" });
      }

      // Determine file path
      const filePath = body.source_key.startsWith("s3://")
        ? null  // S3 not supported in Phase 1 preview
        : body.source_key;

      if (!filePath) {
        return reply.code(400).send({ error: "S3_NOT_SUPPORTED", message: "Phase 1: local files only" });
      }

      // Detect encoding via chardet sample
      let encodingTransform: ReturnType<typeof iconv.decodeStream> | null = null;
      try {
        const { readFileSync } = await import("node:fs");
        const sample = Buffer.alloc(32 * 1024);
        const fd = (await import("node:fs")).openSync(filePath, "r");
        const bytesRead = (await import("node:fs")).readSync(fd, sample, 0, 32 * 1024, 0);
        (await import("node:fs")).closeSync(fd);
        const buf = sample.subarray(0, bytesRead);
        const detected = chardet.detect(buf);
        void readFileSync;
        if (detected && /windows-1252|1252/i.test(detected)) {
          encodingTransform = iconv.decodeStream("windows-1252");
        } else if (detected && /utf-16be/i.test(detected)) {
          encodingTransform = iconv.decodeStream("utf-16be");
        }
      } catch { /* use default UTF-8 */ }

      // Collect first PREVIEW_ROW_LIMIT rows
      const rawRows: string[][] = [];
      let headerRow: string[] | null = null;
      const delimiter = (body.delimiter === "auto" || !body.delimiter) ? "," : body.delimiter as "," | "\t" | ";";
      const hasHeader = body.header_row !== false;
      let internalRowIdx = 0;
      let headerInitialized = false;

      const csvParser = csvParse({
        bom: true, relax_quotes: true, trim: true,
        max_record_size: 1048576, columns: false,
        delimiter,
      });

      const collector = new Transform({
        writableObjectMode: true,
        readableObjectMode: true,
        transform(record: string[], _enc, cb) {
          internalRowIdx++;
          if (rawRows.length >= PREVIEW_ROW_LIMIT) { cb(); return; }
          if (hasHeader && !headerInitialized) {
            headerInitialized = true;
            headerRow = record;
          } else {
            rawRows.push(record);
          }
          cb();
        },
      });

      csvParser.pipe(collector);

      const source = createReadStream(filePath) as unknown as Readable;
      const inputStages: Readable[] = encodingTransform
        ? [source, encodingTransform as unknown as Readable]
        : [source];

      try {
        for await (const chunk of source) {
          if (encodingTransform) {
            encodingTransform.write(chunk);
          } else {
            csvParser.write(chunk);
          }
          if (rawRows.length >= PREVIEW_ROW_LIMIT) break;
        }
      } catch { /* ignore read errors */ }

      csvParser.end();
      await new Promise<void>((r) => collector.on("finish", r));

      void inputStages; void pipeline; void internalRowIdx;

      const headers = headerRow ?? [];

      // Resolve mapping
      let mapping: ColumnMapping | null = null;
      const autoDetect: Record<string, { target: string; confidence: number }> = {};

      if (body.mapping === "vicidial_default") {
        mapping = { version: 1, rows: VICIDIAL_DEFAULT_MAPPING };
      } else if (body.mapping === "inherit") {
        if (list.column_mapping) {
          const saved = typeof list.column_mapping === "string"
            ? JSON.parse(list.column_mapping)
            : list.column_mapping;
          mapping = validateMapping(saved);
        }
      } else if (body.mapping && typeof body.mapping === "object") {
        mapping = validateMapping(body.mapping);
      } else {
        // Auto-detect
        const detected = autoDetectMapping(headers);
        mapping = { version: 1, rows: detected.rows };
        Object.assign(autoDetect, detected.autoDetect);
      }

      // Apply mapping to preview rows
      const mappingApplied = mapping
        ? rawRows.map((record) => applyMapping(record, headers, mapping!))
        : rawRows.map(() => ({}));

      return reply.send({
        headers,
        rows: rawRows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))),
        auto_detect: autoDetect,
        mapping_applied: mappingApplied,
        row_count_preview: rawRows.length,
      });
    },
  );
}
