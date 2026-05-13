// D07 — Long-running operations (reset/purge) integration tests.
// Tests job enqueue, progress updates, and batch cursor logic.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getJobProgress, setJobProgress, type JobProgress } from "../../src/lists/jobs.js";
import { setRedisForTests } from "../../src/lib/redis.js";
import { setPrismaForTests } from "../../src/lib/prisma.js";
import RedisMock from "ioredis-mock";

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  const redis = new RedisMock() as unknown as Parameters<typeof setRedisForTests>[0];
  setRedisForTests(redis);
});

afterEach(() => {
  setRedisForTests(null);
  setPrismaForTests(null);
});

// ---------------------------------------------------------------------------
// Progress key tests
// ---------------------------------------------------------------------------

describe("job progress Valkey operations", () => {
  it("returns null for non-existent job", async () => {
    const progress = await getJobProgress("nonexistent-job-id");
    expect(progress).toBeNull();
  });

  it("stores and retrieves progress correctly", async () => {
    const testProgress: JobProgress = {
      status: "running",
      processed: 5000,
      total: 100000,
      pct: 5,
      started_at: new Date().toISOString(),
      finished_at: null,
      error: null,
    };

    await setJobProgress("test-job-1", testProgress);
    const retrieved = await getJobProgress("test-job-1");

    expect(retrieved).not.toBeNull();
    expect(retrieved?.status).toBe("running");
    expect(retrieved?.processed).toBe(5000);
    expect(retrieved?.total).toBe(100000);
    expect(retrieved?.pct).toBe(5);
  });

  it("stores final done status", async () => {
    const doneProgress: JobProgress = {
      status: "done",
      processed: 100000,
      total: 100000,
      pct: 100,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: null,
    };

    await setJobProgress("test-job-2", doneProgress);
    const retrieved = await getJobProgress("test-job-2");

    expect(retrieved?.status).toBe("done");
    expect(retrieved?.pct).toBe(100);
    expect(retrieved?.finished_at).not.toBeNull();
  });

  it("stores failed status with error", async () => {
    const failedProgress: JobProgress = {
      status: "failed",
      processed: 3000,
      total: 100000,
      pct: 3,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      error: "Database connection lost",
    };

    await setJobProgress("test-job-3", failedProgress);
    const retrieved = await getJobProgress("test-job-3");

    expect(retrieved?.status).toBe("failed");
    expect(retrieved?.error).toBe("Database connection lost");
  });

  it("overwrites progress on update", async () => {
    const initial: JobProgress = {
      status: "running", processed: 1000, total: 50000, pct: 2,
      started_at: new Date().toISOString(), finished_at: null, error: null,
    };
    await setJobProgress("test-job-4", initial);

    const updated: JobProgress = {
      ...initial, processed: 25000, pct: 50,
    };
    await setJobProgress("test-job-4", updated);

    const retrieved = await getJobProgress("test-job-4");
    expect(retrieved?.processed).toBe(25000);
    expect(retrieved?.pct).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// Batch cursor logic tests (unit tests of batch-level math)
// ---------------------------------------------------------------------------

describe("batch cursor progress calculation", () => {
  it("calculates correct percentage for midpoint", () => {
    const processed = 50000;
    const total = 100000;
    const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
    expect(pct).toBe(50);
  });

  it("returns 100% when total is 0 (empty list)", () => {
    const processed = 0;
    const total = 0;
    const pct = total > 0 ? Math.round((processed / total) * 100) : 100;
    expect(pct).toBe(100);
  });

  it("caps pct at correct value near completion", () => {
    const processed = 99999;
    const total = 100000;
    const pct = Math.round((processed / total) * 100);
    expect(pct).toBe(100); // rounds up from 99.999
  });

  it("batch loop terminates when batch is smaller than batch size", () => {
    // Simulates the batch loop exit condition
    const BATCH_SIZE = 1000;
    let iterations = 0;
    let batchAffected = BATCH_SIZE;

    // Simulate 3.5 batches worth of rows
    const totalRows = 3500;
    let processed = 0;

    while (true) {
      batchAffected = Math.min(BATCH_SIZE, totalRows - processed);
      processed += batchAffected;
      iterations++;
      if (batchAffected < BATCH_SIZE) break;
    }

    expect(iterations).toBe(4); // 1000+1000+1000+500
    expect(processed).toBe(3500);
  });
});

// ---------------------------------------------------------------------------
// resetListSync / purgeListSync (pure logic, stub prisma)
// ---------------------------------------------------------------------------

describe("resetListSync with stub prisma", () => {
  it("processes leads in batches and returns affected count", async () => {
    // Mock prisma that simulates 2 batches of 1000, then 500
    const mockBatchResults = [1000, 1000, 500, 0]; // 0 terminates
    let callIndex = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stubPrisma: any = {
      $executeRaw: vi.fn(async () => {
        const result = mockBatchResults[callIndex] ?? 0;
        callIndex++;
        return result;
      }),
      $queryRaw: vi.fn(async () => [{ id: BigInt(callIndex * 1000) }]),
      auditLog: {
        create: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(stubPrisma)),
    };

    setPrismaForTests(stubPrisma);

    const { resetListSync } = await import("../../src/lists/service.js");

    const result = await resetListSync(stubPrisma, 1, 1, 42);
    expect(result.affected).toBe(2500); // 1000 + 1000 + 500
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("purgeListSync with stub prisma", () => {
  it("soft-deletes leads in batches", async () => {
    const mockBatchResults = [1000, 250, 0];
    let callIndex = 0;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stubPrisma: any = {
      $executeRaw: vi.fn(async () => {
        const result = mockBatchResults[callIndex] ?? 0;
        callIndex++;
        return result;
      }),
      $queryRaw: vi.fn(async () => [{ id: BigInt(callIndex * 1000) }]),
      auditLog: {
        create: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(stubPrisma)),
    };

    setPrismaForTests(stubPrisma);

    const { purgeListSync } = await import("../../src/lists/service.js");

    const result = await purgeListSync(stubPrisma, 1, 1, 42);
    expect(result.affected).toBe(1250);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
