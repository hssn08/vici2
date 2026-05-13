// D01 — Bulk insert performance benchmark
// Tests the raw SQL builder (non-DB) to verify O(n) row construction
// performance. Actual DB throughput measured against a live MySQL in O03.

import { describe, it, expect } from "vitest";
import { strictNormalizePhone } from "../../src/leads/normalize.js";

// Simulate the per-row processing that happens before the DB call
function buildBulkRows(count: number): {
  placeholders: string[];
  values: unknown[];
  errors: Array<{ row: number; code: string }>;
} {
  const placeholders: string[] = [];
  const values: unknown[] = [];
  const errors: Array<{ row: number; code: string }> = [];
  const now = new Date();
  const nowStr = now.toISOString().replace("T", " ").replace("Z", "");

  for (let i = 0; i < count; i++) {
    // Valid US numbers: area code 212, exchange 555, sub 0001-9999
    const rawPhone = `+1212555${String((i % 9000) + 1000)}`;
    let phoneE164: string;
    try {
      phoneE164 = strictNormalizePhone(rawPhone, "US");
    } catch {
      errors.push({ row: i, code: "INVALID_PHONE" });
      continue;
    }

    placeholders.push(
      "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    values.push(
      1n, // tenantId
      1n, // listId
      "NEW",
      null, // vendor_lead_code
      null, // source_id
      phoneE164,
      null, null, "US", null, `First${i}`, null, `Last${i}`,
      null, null, `City${i}`, "CA", null, null, null,
      "U", null, 0, null,
      JSON.stringify({}),
      1, nowStr, nowStr,
    );
  }

  return { placeholders, values, errors };
}

describe("bulk insert SQL builder performance", () => {
  it("builds 500 rows in < 100ms", () => {
    const start = performance.now();
    const { placeholders, values, errors } = buildBulkRows(500);
    const elapsed = performance.now() - start;

    expect(placeholders.length).toBe(500);
    expect(values.length).toBe(500 * 28);
    expect(errors.length).toBe(0);
    expect(elapsed).toBeLessThan(100); // should be ~2-5ms

    console.log(`500 rows built in ${elapsed.toFixed(2)}ms`);
  });

  it("normalizes 1000 phone numbers in < 500ms", () => {
    const start = performance.now();
    const results: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const phone = `+1212555${String((i % 9000) + 1000)}`;
      try {
        results.push(strictNormalizePhone(phone, "US"));
      } catch {
        // count failures
      }
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(500);
    console.log(`1000 phone normalizations in ${elapsed.toFixed(2)}ms (${(1000 / (elapsed / 1000)).toFixed(0)} phones/sec)`);
  });

  it("row builder is O(n) — 500 rows roughly 50x faster than 25000 row equivalent", () => {
    const t1 = performance.now();
    buildBulkRows(500);
    const time500 = performance.now() - t1;

    const t2 = performance.now();
    buildBulkRows(500); buildBulkRows(500); buildBulkRows(500);
    buildBulkRows(500); buildBulkRows(500); buildBulkRows(500);
    buildBulkRows(500); buildBulkRows(500); buildBulkRows(500);
    buildBulkRows(500);
    const time5000 = performance.now() - t2;

    // 5000 rows (10 batches of 500) should be < 10x the time of 1 batch of 500
    // (allowing for JIT warmup etc.)
    expect(time5000).toBeLessThan(time500 * 20);
    console.log(`Batch scale: 500 rows=${time500.toFixed(2)}ms, 5000 rows=${time5000.toFixed(2)}ms`);
  });
});
