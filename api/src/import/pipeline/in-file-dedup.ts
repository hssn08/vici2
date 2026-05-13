// D02 Stage 5 — In-file dedup Transform (PLAN §8.1)
// Set<string> of E.164 phones seen in this file. Second occurrence → error.
// Memory: 1M × ~16 bytes ≈ 16 MB (acceptable).

import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import type { NormalizedRow, RowError, ValidRow } from "./types.js";

export class InFileDedupTransform extends Transform {
  private _seen: Map<string, number> = new Map(); // phone → sourceLine

  constructor() {
    super({ objectMode: true, highWaterMark: 16 });
  }

  override _transform(row: NormalizedRow, _enc: string, cb: TransformCallback): void {
    if (!row.lead) {
      // Already has fatal error — pass through as error row signal
      // We push a special marker so errors-stream can pick it up
      this.emit("rowError", row.errors);
      cb();
      return;
    }

    const phone = row.lead.phoneE164;
    const prevLine = this._seen.get(phone);

    if (prevLine !== undefined) {
      const err: RowError = {
        code: "DUPLICATE_IN_FILE",
        message: `Phone ${phone} already on line ${prevLine} of this file`,
        sourceLine: row.info.lines,
        sourceRecord: row.info.records,
        rawRecord: row.rawRecord,
      };
      this.emit("rowError", [err]);
      cb();
      return;
    }

    this._seen.set(phone, row.info.lines);

    const validRow: ValidRow = {
      lead: row.lead,
      rawRecord: row.rawRecord,
      info: row.info,
    };
    this.push(validRow);
    cb();
  }

  override _flush(cb: TransformCallback): void {
    // Don't clear _seen here; caller reads seenCount after stream ends
    cb();
  }

  get seenCount(): number {
    return this._seen.size;
  }
}
