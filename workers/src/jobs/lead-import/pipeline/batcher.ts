// D02 Stage 7 — Batch accumulator Transform (PLAN §2.1)
// Accumulates rows, emits batches of BATCH_SIZE.

import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import type { ValidRow } from "../types.js";

const BATCH_SIZE = 500;

export class BatcherTransform extends Transform {
  private _buffer: ValidRow[] = [];
  private _batchIndex = 0;
  private _batchSize: number;

  constructor(batchSize = BATCH_SIZE) {
    super({ objectMode: true, highWaterMark: 4 });
    this._batchSize = batchSize;
    this._buffer = [];
  }

  override _transform(row: ValidRow, _enc: string, cb: TransformCallback): void {
    this._buffer.push(row);
    if (this._buffer.length >= this._batchSize) {
      const batch = this._buffer.splice(0, this._batchSize);
      this.push({ rows: batch, batchIndex: this._batchIndex++ });
    }
    cb();
  }

  override _flush(cb: TransformCallback): void {
    if (this._buffer.length > 0) {
      this.push({ rows: this._buffer.splice(0), batchIndex: this._batchIndex++ });
    }
    cb();
  }

  get batchIndex(): number {
    return this._batchIndex;
  }
}

export interface Batch {
  rows: ValidRow[];
  batchIndex: number;
}
