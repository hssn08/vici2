// D02 Stage 2 — csv-parse Transform factory (PLAN §2.1, §3.1-3.2)
// Pinned options per PLAN §0.2

import { parse } from "csv-parse";
import { Transform } from "node:stream";
import type { RawCsvRow } from "./types.js";

export interface CsvParserOptions {
  delimiter?: "," | "\t" | ";";
  header_row?: boolean;
  skip_rows?: number;
}

/**
 * Creates a csv-parse Transform that emits RawCsvRow objects.
 * The info option provides source-line and record-index for error reporting.
 */
export function createCsvParser(opts: CsvParserOptions = {}): Transform {
  const delimiter = opts.delimiter ?? ",";
  const hasHeader = opts.header_row !== false;

  const parser = parse({
    bom: true,
    relax_quotes: true,
    skip_records_with_error: false,
    trim: true,
    max_record_size: 1048576,  // 1 MB cap per row
    columns: false,            // raw string arrays; we apply mapping separately
    info: true,                // include { lines, records, columns } per record
    record_delimiter: ["\n", "\r\n", "\r"],
    delimiter,
    from_line: hasHeader ? 1 : (opts.skip_rows ?? 0) + 1,
  });

  let headerSkipped = false;
  let skipCount = opts.skip_rows ?? 0;

  const transform = new Transform({
    objectMode: true,
    highWaterMark: 16,
    transform(chunk: { record: string[]; info: { lines: number; records: number } }, _enc, cb) {
      // Skip leading rows if requested
      if (skipCount > 0) {
        skipCount--;
        cb();
        return;
      }

      // First data row = header row (when header_row=true); emit for metadata only
      if (hasHeader && !headerSkipped) {
        headerSkipped = true;
        // Emit header as special signal (record index 0 = header)
        // Downstream apply-mapping picks up column names from info
        this.push({
          record: chunk.record,
          info: { ...chunk.info, isHeader: true },
        } satisfies RawCsvRow & { info: { isHeader?: boolean; lines: number; records: number } });
        cb();
        return;
      }

      const row: RawCsvRow = {
        record: chunk.record,
        info: { lines: chunk.info.lines, records: chunk.info.records },
      };
      this.push(row);
      cb();
    },
  });

  // Pipe parse errors through as error events on the transform
  parser.on("error", (err: Error) => transform.emit("error", err));
  parser.pipe(transform, { end: true });

  // The actual input stream we expose is parser
  // Return a wrapper that takes bytes and emits RawCsvRow
  const wrapper = new Transform({
    objectMode: false,
    highWaterMark: 64 * 1024,
    transform(chunk, _enc, cb) {
      if (!parser.write(chunk)) {
        parser.once("drain", cb);
      } else {
        cb();
      }
    },
    flush(cb) {
      parser.end();
      parser.once("end", cb);
      parser.once("error", cb);
    },
  });

  wrapper.on("error", (err) => transform.emit("error", err));
  transform.on("error", (err) => wrapper.emit("error", err));

  // Pipe transform output through to wrapper's readable side is tricky
  // Use a simpler direct approach — return a Transform that uses parse internally
  return createDirectCsvTransform(opts);
}

/**
 * Direct single-Transform approach: takes bytes, emits RawCsvRow objects.
 */
export function createDirectCsvTransform(opts: CsvParserOptions = {}): Transform {
  const delimiter = opts.delimiter ?? ",";
  const hasHeader = opts.header_row !== false;
  const skipRows = opts.skip_rows ?? 0;

  let internalRowIdx = 0;
  let headerRecord: string[] | null = null;
  let initialized = false;

  const parser = parse({
    bom: true,
    relax_quotes: true,
    skip_records_with_error: false,
    trim: true,
    max_record_size: 1048576,
    columns: false,
    info: true,
    record_delimiter: ["\n", "\r\n", "\r"],
    delimiter,
  });

  const out = new Transform({
    writableObjectMode: false,
    readableObjectMode: true,
    highWaterMark: 16,

    transform(chunk: Buffer, _enc, cb) {
      if (!parser.write(chunk)) {
        parser.once("drain", cb);
      } else {
        cb();
      }
    },

    flush(cb) {
      parser.end();
      parser.once("finish", cb);
      parser.once("error", cb);
    },
  });

  parser.on("readable", () => {
    let item: { record: string[]; info: { lines: number; records: number } } | null;
    while ((item = parser.read()) !== null) {
      internalRowIdx++;
      if (internalRowIdx <= skipRows) continue;

      if (hasHeader && !initialized) {
        initialized = true;
        headerRecord = item.record;
        // Emit header row with isHeader flag
        out.push({
          record: item.record,
          info: { lines: item.info.lines, records: item.info.records, isHeader: true, headerRecord: item.record },
        });
        continue;
      }

      if (!initialized && !hasHeader) {
        initialized = true;
      }

      const row: RawCsvRow = {
        record: item.record,
        info: { lines: item.info.lines, records: item.info.records },
      };
      out.push(row);
    }
  });

  parser.on("error", (err: Error) => {
    // Translate csv-parse errors into row errors if possible
    const maxSizeErr = /max_record_size/i.test(err.message);
    if (maxSizeErr) {
      // Emit a synthetic error row
      out.push({
        record: [],
        info: { lines: -1, records: -1 },
        parseError: { code: "MAX_RECORD_SIZE_EXCEEDED", message: err.message },
      });
    } else {
      out.emit("error", err);
    }
  });

  void headerRecord; // reference to suppress TS unused warning
  return out;
}
