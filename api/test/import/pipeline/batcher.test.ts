// D02 — batcher.ts unit tests

import { describe, it, expect } from "vitest";
import { BatcherTransform } from "../../../src/import/pipeline/batcher.js";
import type { ValidRow } from "../../../src/import/pipeline/types.js";

function makeRow(phone: string): ValidRow {
  return {
    lead: {
      phoneE164: phone, countryCode: "US", status: "NEW",
      tzBlocked: false, dncBlocked: false, customData: {},
    },
    rawRecord: [phone],
    info: { lines: 1, records: 0 },
  };
}

describe("BatcherTransform", () => {
  it("emits batch after BATCH_SIZE rows", async () => {
    const batcher = new BatcherTransform(3);
    const batches: unknown[] = [];
    batcher.on("data", (b) => batches.push(b));

    for (let i = 0; i < 3; i++) batcher.write(makeRow(`+1555000000${i}`));
    batcher.end();
    await new Promise<void>((r) => batcher.on("finish", r));

    expect(batches.length).toBe(1);
    expect((batches[0] as { rows: unknown[] }).rows.length).toBe(3);
    expect((batches[0] as { batchIndex: number }).batchIndex).toBe(0);
  });

  it("emits partial last batch", async () => {
    const batcher = new BatcherTransform(3);
    const batches: unknown[] = [];
    batcher.on("data", (b) => batches.push(b));

    for (let i = 0; i < 5; i++) batcher.write(makeRow(`+1555000000${i}`));
    batcher.end();
    await new Promise<void>((r) => batcher.on("finish", r));

    // 5 rows with batch_size=3: one full batch + one partial
    expect(batches.length).toBe(2);
    expect((batches[0] as { rows: unknown[] }).rows.length).toBe(3);
    expect((batches[1] as { rows: unknown[] }).rows.length).toBe(2);
  });

  it("assigns sequential batchIndex values", async () => {
    const batcher = new BatcherTransform(2);
    const batches: { batchIndex: number }[] = [];
    batcher.on("data", (b) => batches.push(b));

    for (let i = 0; i < 6; i++) batcher.write(makeRow(`+1555000000${i}`));
    batcher.end();
    await new Promise<void>((r) => batcher.on("finish", r));

    expect(batches.map((b) => b.batchIndex)).toEqual([0, 1, 2]);
  });

  it("emits nothing if no rows", async () => {
    const batcher = new BatcherTransform(500);
    const batches: unknown[] = [];
    batcher.on("data", (b) => batches.push(b));
    batcher.end();
    await new Promise<void>((r) => batcher.on("finish", r));
    expect(batches.length).toBe(0);
  });
});
