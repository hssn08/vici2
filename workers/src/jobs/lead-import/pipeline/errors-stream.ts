// D02 — Error stream writer (PLAN §10)
// Collects RowErrors, writes them to errors.csv via csv-stringify streaming.
// Also optionally INSERTs into import_errors table.

import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { stringify } from "csv-stringify";
import type { RowError } from "../types.js";
import { ERROR_CODE_SET } from "../error-codes.js";

const MAX_ERRORS = 10_000;

export interface ErrorsStreamOptions {
  errorsFilePath: string;
  importId: string;
  tenantId: number;
  persistRawErrors?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma?: any;
  originalHeaders?: string[];
}

export class ErrorsCollector {
  private _errors: RowError[] = [];
  private _errorCount = 0;
  private _exceeded = false;
  private _opts: ErrorsStreamOptions;
  private _byCode: Record<string, number> = {};

  constructor(opts: ErrorsStreamOptions) {
    this._opts = opts;
  }

  get count(): number {
    return this._errorCount;
  }

  get exceeded(): boolean {
    return this._exceeded;
  }

  get summary(): Record<string, number> {
    return { ...this._byCode };
  }

  /** Add errors from a row. Returns true if max not exceeded. */
  addErrors(errors: RowError[]): boolean {
    if (this._exceeded) return false;

    for (const err of errors) {
      // Validate error code is in frozen vocabulary
      if (!ERROR_CODE_SET.has(err.code)) {
        throw new Error(`D02 invariant: unknown error code "${err.code}"`);
      }

      this._errors.push(err);
      this._errorCount++;
      this._byCode[err.code] = (this._byCode[err.code] ?? 0) + 1;

      if (this._errorCount >= MAX_ERRORS) {
        this._exceeded = true;
        this._errors.push({
          code: "MAX_ERRORS_EXCEEDED",
          message: `Error cap of ${MAX_ERRORS} reached; import aborted`,
          sourceLine: err.sourceLine,
          sourceRecord: err.sourceRecord,
          rawRecord: [],
        });
        this._byCode["MAX_ERRORS_EXCEEDED"] = 1;
        return false;
      }
    }
    return true;
  }

  /** Write all collected errors to errors.csv and optionally to import_errors table. */
  async flush(): Promise<void> {
    if (this._errors.length === 0) return;

    // Ensure output directory exists
    mkdirSync(dirname(this._opts.errorsFilePath), { recursive: true });

    // Build CSV headers
    const csvHeaders = [
      "_source_line",
      "_source_record",
      "_error_code",
      "_error_message",
      ...(this._opts.originalHeaders ?? []),
    ];

    const rows = this._errors.map((err) => [
      err.sourceLine,
      err.sourceRecord,
      err.code,
      err.message,
      ...err.rawRecord,
    ]);

    // Write via csv-stringify pipeline
    const readable = Readable.from(rows);
    const stringifier = stringify({
      header: true,
      columns: csvHeaders,
    });
    const writer = createWriteStream(this._opts.errorsFilePath);

    await pipeline(readable, stringifier, writer);

    // Optionally persist to import_errors table
    if (this._opts.persistRawErrors && this._opts.prisma) {
      const insertRows = this._errors.slice(0, MAX_ERRORS).map((err) => ({
        tenant_id: BigInt(this._opts.tenantId),
        import_id: this._opts.importId,
        source_line: err.sourceLine,
        source_record: err.sourceRecord,
        error_code: err.code,
        error_msg: err.message.slice(0, 512),
        raw_row: err.rawRecord.length > 0
          ? JSON.stringify(err.rawRecord).slice(0, 4096)
          : null,
      }));

      // Batch insert to avoid N+1
      if (insertRows.length > 0) {
        const placeholders = insertRows.map(() =>
          "(?, ?, ?, ?, ?, ?, ?)"
        ).join(", ");
        const values = insertRows.flatMap((r) => [
          r.tenant_id, r.import_id, r.source_line, r.source_record,
          r.error_code, r.error_msg, r.raw_row,
        ]);
        await this._opts.prisma.$executeRawUnsafe(
          `INSERT INTO import_errors
            (tenant_id, import_id, source_line, source_record, error_code, error_msg, raw_row)
           VALUES ${placeholders}`,
          ...values,
        );
      }
    }
  }
}
