// D06 — Reassign tests: claim race, bulk-reassign, lead-status restoration.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/callbacks/metrics.js", () => ({
  callbackScheduledTotal: { inc: vi.fn() },
  callbackFiredTotal: { inc: vi.fn() },
  callbackDeferredTotal: { inc: vi.fn() },
  callbackCancelledTotal: { inc: vi.fn() },
  callbackSnoozedTotal: { inc: vi.fn() },
  callbackCompletedTotal: { inc: vi.fn() },
  callbackStaleTotal: { inc: vi.fn() },
  workerTickDuration: { startTimer: vi.fn(() => vi.fn()) },
  workerTickPromoted: { inc: vi.fn() },
  workerTickSkippedTotal: { inc: vi.fn() },
  bulkReassignTotal: { inc: vi.fn() },
  claimRaceTotal: { inc: vi.fn() },
  d06Registry: {},
}));

vi.mock("../../src/callbacks/events.js", () => ({
  publishCallbackEvent: vi.fn().mockResolvedValue(undefined),
  notifyAgent: vi.fn().mockResolvedValue(undefined),
  isAgentOnline: vi.fn().mockResolvedValue(false),
}));

import { claimCallback, cancelCallback, bulkReassignCallbacks } from "../../src/callbacks/service.js";
import { claimRaceTotal, callbackCancelledTotal, bulkReassignTotal } from "../../src/callbacks/metrics.js";
import type { AuthContext } from "../../src/auth/middleware.js";

function makeAuth(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    uid: 10,
    tenantId: 1,
    role: "agent",
    perms: new Set(),
    jti: "test-jti",
    totpVerified: true,
    rawClaims: {} as AuthContext["rawClaims"],
    ...overrides,
  };
}

function makeMockRedis() {
  return {
    xadd: vi.fn().mockResolvedValue("0-1"),
    publish: vi.fn().mockResolvedValue(1),
    get: vi.fn().mockResolvedValue(null),
  };
}

describe("D06 self-claim CAS", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("successful claim: updateMany returns count=1", async () => {
    const mockTx = {
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const mockPrisma = {
      callback: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findUnique: vi.fn().mockResolvedValue({
          id: BigInt(1), tenantId: BigInt(1), leadId: BigInt(1),
          campaignId: "C1", userId: BigInt(10), callbackAt: new Date(),
          status: "PENDING", comments: null, createdAt: new Date(), updatedAt: new Date(),
        }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const auth = makeAuth({ uid: 10 });
    const redis = makeMockRedis();

    const result = await claimCallback(mockPrisma as never, redis as never, auth, BigInt(1));
    expect(result.scope).toBe("AGENT");
    expect(claimRaceTotal.inc).toHaveBeenCalledWith({ outcome: "won" });
  });

  it("lost claim: updateMany returns count=0 → 409 already_claimed", async () => {
    const mockPrisma = {
      callback: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({
          id: BigInt(1), tenantId: BigInt(1), leadId: BigInt(1),
          campaignId: "C1", userId: BigInt(99),  // already claimed by uid 99
          callbackAt: new Date(), status: "PENDING", comments: null,
        }),
      },
    };
    const auth = makeAuth({ uid: 10 });
    const redis = makeMockRedis();

    await expect(claimCallback(mockPrisma as never, redis as never, auth, BigInt(1)))
      .rejects.toMatchObject({ code: "already_claimed" });
    expect(claimRaceTotal.inc).toHaveBeenCalledWith({ outcome: "lost" });
  });

  it("lost claim on terminal callback → 409 callback_terminal", async () => {
    const mockPrisma = {
      callback: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn().mockResolvedValue({
          id: BigInt(1), status: "DONE", userId: null,
        }),
      },
    };
    const auth = makeAuth();
    await expect(claimCallback(mockPrisma as never, makeMockRedis() as never, auth, BigInt(1)))
      .rejects.toMatchObject({ code: "callback_terminal" });
  });
});

describe("D06 cancel — lead status restoration", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("cancel last PENDING callback → lead.status restored to NA", async () => {
    const leadUpdate = vi.fn().mockResolvedValue({});
    const mockTx = {
      callback: {
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(0),  // 0 remaining = restore lead
      },
      lead: { update: leadUpdate },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const mockPrisma = {
      callback: {
        findFirst: vi.fn().mockResolvedValue({
          id: BigInt(1), tenantId: BigInt(1), leadId: BigInt(1),
          userId: BigInt(10), status: "PENDING",
        }),
      },
      $transaction: vi.fn().mockImplementation(async (fn) => fn(mockTx)),
    };
    const auth = makeAuth({ uid: 10 });
    const result = await cancelCallback(mockPrisma as never, makeMockRedis() as never, auth, BigInt(1));
    expect(result.cancelled).toBe(true);
    // Lead should have been updated to NA
    expect(leadUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "NA" }),
    }));
  });

  it("cancel one of two PENDING callbacks → lead.status unchanged", async () => {
    const leadUpdate = vi.fn().mockResolvedValue({});
    const mockTx = {
      callback: {
        update: vi.fn().mockResolvedValue({}),
        count: vi.fn().mockResolvedValue(1),  // 1 remaining = don't restore
      },
      lead: { update: leadUpdate },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const mockPrisma = {
      callback: {
        findFirst: vi.fn().mockResolvedValue({
          id: BigInt(1), tenantId: BigInt(1), leadId: BigInt(1),
          userId: BigInt(10), status: "PENDING",
        }),
      },
      $transaction: vi.fn().mockImplementation(async (fn) => fn(mockTx)),
    };
    const auth = makeAuth({ uid: 10 });
    await cancelCallback(mockPrisma as never, makeMockRedis() as never, auth, BigInt(1));
    expect(leadUpdate).not.toHaveBeenCalled();
  });
});

describe("D06 bulk-reassign", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("bulk-reassign uses single updateMany + single audit row", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 15 });
    const auditCreate = vi.fn().mockResolvedValue({});
    const mockTx = {
      callback: { updateMany },
      auditLog: { create: auditCreate },
    };
    const mockPrisma = {
      $transaction: vi.fn().mockImplementation(async (fn) => fn(mockTx)),
    };
    const auth = makeAuth({ role: "supervisor", uid: 5 });
    const result = await bulkReassignCallbacks(mockPrisma as never, auth, {
      from_user_id: BigInt(10),
      to_user_id: null,
      scope: "pending",
    });
    expect(result.reassigned).toBe(15);
    expect(updateMany).toHaveBeenCalledOnce();
    expect(auditCreate).toHaveBeenCalledOnce();
    expect(bulkReassignTotal.inc).toHaveBeenCalledWith({ outcome: "success" });
  });

  it("bulk-reassign with scope=all_non_terminal includes PENDING and LIVE", async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 5 });
    const mockTx = {
      callback: { updateMany },
      auditLog: { create: vi.fn().mockResolvedValue({}) },
    };
    const mockPrisma = {
      $transaction: vi.fn().mockImplementation(async (fn) => fn(mockTx)),
    };
    const auth = makeAuth({ role: "supervisor" });
    await bulkReassignCallbacks(mockPrisma as never, auth, {
      from_user_id: BigInt(1),
      to_user_id: BigInt(2),
      scope: "all_non_terminal",
    });
    const callArgs = updateMany.mock.calls[0]?.[0];
    expect(callArgs?.where?.status?.in).toContain("LIVE");
    expect(callArgs?.where?.status?.in).toContain("PENDING");
  });
});
