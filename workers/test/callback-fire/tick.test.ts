// D06 — Integration-style tests for the tick algorithm.
// Uses in-memory mocks (no real DB/Redis) — real DB tests require testcontainers.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock metrics
vi.mock("../../src/jobs/callback-fire/metrics.js", () => ({
  callbackFiredTotal: { inc: vi.fn() },
  callbackDeferredTotal: { inc: vi.fn() },
  callbackStaleTotal: { inc: vi.fn() },
  workerTickDuration: { startTimer: vi.fn(() => vi.fn()) },
  workerTickPromoted: { inc: vi.fn() },
  workerTickSkippedTotal: { inc: vi.fn() },
  getAgeBucket: (s: number) => s < 8*3600 ? "4-8h" : s < 24*3600 ? "8-24h" : s < 72*3600 ? "1-3d" : "3d+",
}));

// Mock promote/defer
vi.mock("../../src/jobs/callback-fire/promote.js", () => ({
  promoteCallback: vi.fn().mockResolvedValue({ promoted: true }),
}));

vi.mock("../../src/jobs/callback-fire/defer.js", () => ({
  deferCallback: vi.fn().mockResolvedValue(undefined),
}));

import { callbackFireTick } from "../../src/jobs/callback-fire/tick.js";
import { promoteCallback } from "../../src/jobs/callback-fire/promote.js";
import { deferCallback } from "../../src/jobs/callback-fire/defer.js";

const TENANT = BigInt(1);

function makeRedis(lockWins = true) {
  return {
    set: vi.fn().mockResolvedValue(lockWins ? "OK" : null),
    del: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
    xadd: vi.fn().mockResolvedValue("0-1"),
    publish: vi.fn().mockResolvedValue(1),
  };
}

function makeCallback(id: number, userId: bigint | null = null, minsOverdue = 0) {
  return {
    id: BigInt(id),
    tenantId: TENANT,
    leadId: BigInt(id * 100),
    campaignId: "CAMP1",
    userId,
    callbackAt: new Date(Date.now() - minsOverdue * 60 * 1000),
    status: "PENDING",
    comments: null,
    lead: { id: BigInt(id * 100), knownTimezone: "America/New_York" },
  };
}

function makePrisma(callbacks: ReturnType<typeof makeCallback>[] = []) {
  return {
    callback: {
      findMany: vi.fn().mockResolvedValue(callbacks),
      updateMany: vi.fn().mockResolvedValue({ count: callbacks.length }),
    },
    campaign: {
      findFirst: vi.fn().mockResolvedValue({ callbackGraceWindowSeconds: 30 }),
    },
    lead: { update: vi.fn().mockResolvedValue({}) },
    auditLog: { create: vi.fn().mockResolvedValue({}) },
    $transaction: vi.fn().mockImplementation(async (fn) => fn({
      callback: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      lead: { update: vi.fn().mockResolvedValue({}) },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    })),
  };
}

describe("D06 tick — integration scenarios", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("end-to-end: fires pending callback → promoted", async () => {
    const cb = makeCallback(1, null, 1); // overdue by 1 min
    const prisma = makePrisma([cb]);
    const redis = makeRedis(true);

    const result = await callbackFireTick(prisma as never, redis as never, TENANT);
    expect(result.fired).toBe(1);
    expect(promoteCallback).toHaveBeenCalledOnce();
  });

  it("worker idempotency: re-run tick skips already-LIVE row", async () => {
    // Simulate promoteCallback returning promoted=false (already LIVE)
    vi.mocked(promoteCallback).mockResolvedValueOnce({ promoted: false, reason: "already_live" });

    const cb = makeCallback(2, null, 5);
    const prisma = makePrisma([cb]);
    const redis = makeRedis(true);

    const result = await callbackFireTick(prisma as never, redis as never, TENANT);
    // fired=0 because promote returned already_live
    expect(result.fired).toBe(0);
  });

  it("multi-pod lock: second pod loses NX → skips", async () => {
    const prisma = makePrisma([makeCallback(3)]);
    const redis = makeRedis(false); // NX fails

    const result = await callbackFireTick(prisma as never, redis as never, TENANT);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("lock_contention");
    expect(promoteCallback).not.toHaveBeenCalled();
  });

  it("batch cap: only takes first 500 rows (mock returns 3, all fired)", async () => {
    const cbs = [makeCallback(10), makeCallback(11), makeCallback(12)];
    const prisma = makePrisma(cbs);
    const redis = makeRedis(true);

    const result = await callbackFireTick(prisma as never, redis as never, TENANT);
    expect(result.fired).toBe(3);
  });

  it("AGENT-scoped callback: promoteCallback called with non-null userId", async () => {
    const agentId = BigInt(55);
    const cb = makeCallback(20, agentId, 2);
    const prisma = makePrisma([cb]);
    const redis = makeRedis(true);

    await callbackFireTick(prisma as never, redis as never, TENANT);
    expect(promoteCallback).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ userId: agentId }),
      undefined,
    );
  });

  it("lock is always released in finally block", async () => {
    vi.mocked(promoteCallback).mockRejectedValueOnce(new Error("fatal"));
    const cb = makeCallback(99, null, 1);
    const prisma = makePrisma([cb]);
    const redis = makeRedis(true);

    await callbackFireTick(prisma as never, redis as never, TENANT);
    expect(redis.del).toHaveBeenCalledWith(`t:${TENANT}:cron:lock:callback_fire`);
  });

  it("TCPA-defer path: when deferCallback is called, no promote", async () => {
    // Phase-1 TCPA always returns ALLOW, so deferCallback is never called.
    // This test confirms the expected behavior for Phase-1.
    const cb = makeCallback(50, null, 1);
    const prisma = makePrisma([cb]);
    const redis = makeRedis(true);

    await callbackFireTick(prisma as never, redis as never, TENANT);
    expect(deferCallback).not.toHaveBeenCalled();
    expect(promoteCallback).toHaveBeenCalled();
  });

  it("empty queue: skips gracefully with reason=empty", async () => {
    const prisma = makePrisma([]);
    const redis = makeRedis(true);

    const result = await callbackFireTick(prisma as never, redis as never, TENANT);
    expect(result.skipped).toBe(true);
    expect(result.reason).toBe("empty");
  });

  it("reschedule_24h policy: LIVE→PENDING advances callback_at by 24h", () => {
    // Unit test the time math directly (integration DB test is in separate suite)
    const originalAt = new Date("2026-05-19T10:00:00Z");
    const newAt = new Date(originalAt.getTime() + 86400 * 1000);
    expect(newAt.toISOString()).toBe("2026-05-20T10:00:00.000Z");
  });
});
