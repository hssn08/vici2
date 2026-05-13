// D05 — DNC check unit tests

import { describe, it, expect, vi } from "vitest";
import { dncCheck } from "../../src/dnc/check.js";
import type { CheckRequest } from "../../src/dnc/types.js";

// ── Mock Redis ────────────────────────────────────────────────────────────────

function makeMockRedis(bloomResults: number[]) {
  const pipe = {
    call: vi.fn(),
    exec: vi.fn().mockResolvedValue(bloomResults.map((r) => [null, r])),
  };
  return {
    pipeline: vi.fn().mockReturnValue(pipe),
  };
}

// ── Mock Prisma ───────────────────────────────────────────────────────────────

function makeMockPrisma(rows: Array<{ source: string }> = []) {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue(rows),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("dncCheck", () => {
  it("returns IsDNC=true with reason=malformed for invalid phone", async () => {
    const redis = makeMockRedis([]);
    const prisma = makeMockPrisma();
    const req: CheckRequest = {
      phoneE164: "not-a-phone",
      tenantId: 1,
      sources: ["federal"],
    };
    const result = await dncCheck(redis as never, prisma as never, req);
    expect(result.isDnc).toBe(true);
    expect(result.reason).toBe("malformed");
  });

  it("returns IsDNC=false on all-negative Bloom (fast path)", async () => {
    // All bloom results = 0 → negative
    const redis = makeMockRedis([0, 0]);
    const prisma = makeMockPrisma();
    const req: CheckRequest = {
      phoneE164: "+14155551212",
      tenantId: 1,
      sources: ["federal", "internal"],
    };
    const result = await dncCheck(redis as never, prisma as never, req);
    expect(result.isDnc).toBe(false);
    expect(result.sources).toHaveLength(0);
    expect(result.bloomFalsePositive).toBe(false);
  });

  it("returns IsDNC=true when Bloom positive + MySQL confirms", async () => {
    const redis = makeMockRedis([1, 0]); // federal bloom positive
    const prisma = makeMockPrisma([{ source: "federal" }]);
    const req: CheckRequest = {
      phoneE164: "+14155551212",
      tenantId: 1,
      sources: ["federal", "internal"],
    };
    const result = await dncCheck(redis as never, prisma as never, req);
    expect(result.isDnc).toBe(true);
    expect(result.sources).toContain("federal");
  });

  it("returns IsDNC=false + bloomFalsePositive=true when MySQL denies", async () => {
    const redis = makeMockRedis([1]); // internal bloom positive
    const prisma = makeMockPrisma([]); // MySQL: not found → false positive
    const req: CheckRequest = {
      phoneE164: "+14155551212",
      tenantId: 1,
      sources: ["internal"],
    };
    const result = await dncCheck(redis as never, prisma as never, req);
    expect(result.isDnc).toBe(false);
    expect(result.bloomFalsePositive).toBe(true);
  });

  it("sorts sources by priority: internal > state > federal", async () => {
    const redis = makeMockRedis([1, 1, 1]); // all positive
    const prisma = makeMockPrisma([
      { source: "federal" },
      { source: "internal" },
      { source: "state" },
    ]);
    const req: CheckRequest = {
      phoneE164: "+14155551212",
      tenantId: 1,
      sources: ["federal", "state", "internal"],
    };
    const result = await dncCheck(redis as never, prisma as never, req);
    expect(result.isDnc).toBe(true);
    expect(result.sources[0]).toBe("internal");
    expect(result.sources[1]).toBe("state");
    expect(result.sources[2]).toBe("federal");
  });

  it("fails-closed when MySQL throws", async () => {
    const redis = makeMockRedis([1]);
    const prisma = {
      $queryRawUnsafe: vi.fn().mockRejectedValue(new Error("DB down")),
    };
    const req: CheckRequest = {
      phoneE164: "+14155551212",
      tenantId: 1,
      sources: ["federal"],
    };
    const result = await dncCheck(redis as never, prisma as never, req);
    // Fail-closed: treat as DNC
    expect(result.isDnc).toBe(true);
  });

  it("records latency in microseconds", async () => {
    const redis = makeMockRedis([0]);
    const prisma = makeMockPrisma();
    const req: CheckRequest = {
      phoneE164: "+14155551212",
      tenantId: 1,
      sources: ["federal"],
    };
    const result = await dncCheck(redis as never, prisma as never, req);
    expect(result.latencyMicros).toBeGreaterThanOrEqual(0);
  });
});
