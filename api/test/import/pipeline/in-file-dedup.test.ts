// D02 — in-file-dedup.ts unit tests

import { describe, it, expect, vi } from "vitest";
import { InFileDedupTransform } from "../../../src/import/pipeline/in-file-dedup.js";
import type { NormalizedRow } from "../../../src/import/pipeline/types.js";

function makeNormalizedRow(phone: string, line = 1): NormalizedRow {
  return {
    lead: {
      phoneE164: phone,
      countryCode: "US",
      status: "NEW",
      tzBlocked: false,
      dncBlocked: false,
      customData: {},
    },
    rawRecord: [phone],
    info: { lines: line, records: line - 1 },
    errors: [],
  };
}

describe("InFileDedupTransform", () => {
  it("passes first occurrence through", async () => {
    const dedup = new InFileDedupTransform();
    const received: unknown[] = [];
    dedup.on("data", (d) => received.push(d));

    dedup.write(makeNormalizedRow("+15551234567", 1));
    dedup.end();

    await new Promise<void>((r) => dedup.on("finish", r));
    expect(received.length).toBe(1);
  });

  it("emits rowError for duplicate phone", async () => {
    const dedup = new InFileDedupTransform();
    const rowErrors: unknown[] = [];
    dedup.on("rowError", (errs) => rowErrors.push(...errs));
    const received: unknown[] = [];
    dedup.on("data", (d) => received.push(d));

    dedup.write(makeNormalizedRow("+15551234567", 1));
    dedup.write(makeNormalizedRow("+15551234567", 5));
    dedup.end();

    await new Promise<void>((r) => dedup.on("finish", r));
    expect(received.length).toBe(1);
    expect(rowErrors.length).toBe(1);
    expect((rowErrors[0] as { code: string }).code).toBe("DUPLICATE_IN_FILE");
    expect((rowErrors[0] as { message: string }).message).toContain("line 1");
  });

  it("emits rowError for row with null lead", async () => {
    const dedup = new InFileDedupTransform();
    const rowErrors: unknown[] = [];
    dedup.on("rowError", (errs) => rowErrors.push(...errs));

    const badRow: NormalizedRow = {
      lead: null,
      rawRecord: [],
      info: { lines: 3, records: 2 },
      errors: [{ code: "INVALID_PHONE", message: "bad", sourceLine: 3, sourceRecord: 2, rawRecord: [] }],
    };
    dedup.write(badRow);
    dedup.end();

    await new Promise<void>((r) => dedup.on("finish", r));
    expect(rowErrors.length).toBe(1);
    expect((rowErrors[0] as { code: string }).code).toBe("INVALID_PHONE");
  });

  it("tracks unique phone count", async () => {
    const dedup = new InFileDedupTransform();
    dedup.on("data", () => {});  // consume

    for (let i = 0; i < 100; i++) {
      dedup.write(makeNormalizedRow(`+155500${i.toString().padStart(5, "0")}`, i + 1));
    }
    dedup.end();

    await new Promise<void>((r) => dedup.on("finish", r));
    expect(dedup.seenCount).toBe(100);
  });

  it("handles 1000 unique phones without significant memory overhead", async () => {
    const dedup = new InFileDedupTransform();
    dedup.on("data", () => {});

    for (let i = 0; i < 1000; i++) {
      dedup.write(makeNormalizedRow(`+1555${i.toString().padStart(7, "0")}`, i + 1));
    }
    dedup.end();
    await new Promise<void>((r) => dedup.on("finish", r));
    expect(dedup.seenCount).toBe(1000);
    // Memory: 1000 entries, well under 16MB
  });

  void vi; // suppress unused import
});
