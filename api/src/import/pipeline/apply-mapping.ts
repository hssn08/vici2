// D02 Stage 3 — Apply column mapping Transform (PLAN §2.1)
// Loads mapping snapshot, applies source→target remap + transforms.

import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import type { ColumnMapping, MappedRow, RawCsvRow } from "./types.js";
import { applyMapping } from "./mapping.js";

export interface ApplyMappingOptions {
  mapping: ColumnMapping;
  hasHeader: boolean;
}

export class ApplyMappingTransform extends Transform {
  private _mapping: ColumnMapping;
  private _headerRecord: string[] | null = null;
  private _hasHeader: boolean;

  constructor(opts: ApplyMappingOptions) {
    super({ objectMode: true, highWaterMark: 16 });
    this._mapping = opts.mapping;
    this._hasHeader = opts.hasHeader;
  }

  override _transform(
    row: RawCsvRow & { info: { isHeader?: boolean; headerRecord?: string[]; lines: number; records: number } },
    _enc: string,
    cb: TransformCallback,
  ): void {
    if (row.info.isHeader) {
      this._headerRecord = row.record;
      cb();
      return;
    }

    const header = this._headerRecord ?? [];
    const mapped = this._hasHeader
      ? applyMapping(row.record, header, this._mapping)
      : this._applyPositional(row.record);

    const out: MappedRow = {
      mapped,
      rawRecord: row.record,
      info: { lines: row.info.lines, records: row.info.records },
    };
    this.push(out);
    cb();
  }

  private _applyPositional(record: string[]): Record<string, string> {
    const result: Record<string, string> = {};
    for (let i = 0; i < this._mapping.rows.length; i++) {
      const row = this._mapping.rows[i]!;
      result[row.target] = record[i] ?? "";
    }
    return result;
  }

  override _flush(cb: TransformCallback): void {
    cb();
  }
}
