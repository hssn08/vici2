// D05 — Bulk import unit tests

import { describe, it, expect, vi } from "vitest";
import { bulkImportDnc } from "../../src/dnc/bulk-import.js";
import RedisMock from "ioredis-mock";

function makeRedis() {
  return new RedisMock() as unknown as import("ioredis").Redis;
}

function makePrisma(results: number[] = []) {
  return {
    $executeRawUnsafe: vi.fn().mockResolvedValue(results[0] ?? 0),
  };
}

const CSV_3_ROWS = `phone,notes
+14155551212,test note
+12125559999,another note
+13105558888,`;

const CSV_INVALID = `phone
notaphone
+14155551212
also-invalid`;

describe("bulkImportDnc", () => {
  it("adds valid rows and rejects invalid", async () => {
    const redis = makeRedis();
    const prisma = makePrisma();
    // Mock BF.MADD to not error
    (redis as never as { call: ReturnType<typeof vi.fn> }).call = vi.fn().mockResolvedValue(null);

    const result = await bulkImportDnc(redis, prisma as never, {
      tenantId: 1,
      source: "internal",
      csvText: CSV_INVALID,
    });

    expect(result.added).toBe(1); // only "+14155551212" is valid
    expect(result.rejected).toBeGreaterThanOrEqual(2); // "notaphone", "also-invalid"
  });

  it("processes all 3 valid rows in CSV", async () => {
    const redis = makeRedis();
    const prisma = makePrisma();
    (redis as never as { call: ReturnType<typeof vi.fn> }).call = vi.fn().mockResolvedValue(null);

    const result = await bulkImportDnc(redis, prisma as never, {
      tenantId: 1,
      source: "internal",
      csvText: CSV_3_ROWS,
    });

    expect(result.added).toBe(3);
    expect(result.rejected).toBe(0);
  });

  it("caps at 5000 rows", async () => {
    // Generate 5001 rows
    const lines = ["phone"];
    for (let i = 0; i < 5001; i++) {
      lines.push(`+1415555${String(i).padStart(4, "0")}`);
    }
    const redis = makeRedis();
    const prisma = makePrisma();
    (redis as never as { call: ReturnType<typeof vi.fn> }).call = vi.fn().mockResolvedValue(null);

    const result = await bulkImportDnc(redis, prisma as never, {
      tenantId: 1,
      source: "internal",
      csvText: lines.join("\n"),
    });

    // 5001 submitted, 1 over cap → 1 rejected at cap level
    expect(result.rejected).toBeGreaterThanOrEqual(1);
    expect(result.added + result.rejected).toBe(5001);
  });
});
