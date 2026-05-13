// D06 — Create + validation edge cases.
// Tests validateCallbackAt, resolveUserId, scope resolution.

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

import { validateCallbackAt, CreateCallbackBody } from "../../src/callbacks/schemas.js";
import { resolveUserId } from "../../src/callbacks/service.js";
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

describe("D06 validateCallbackAt", () => {
  it("rejects callback_at < NOW + 5 min", () => {
    const tooSoon = new Date(Date.now() + 60_000).toISOString(); // 1 minute from now
    const result = validateCallbackAt(tooSoon);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("callback_too_soon");
  });

  it("rejects callback_at > NOW + 365 days", () => {
    const tooFar = new Date(Date.now() + 366 * 24 * 3600 * 1000).toISOString();
    const result = validateCallbackAt(tooFar);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("callback_too_far");
  });

  it("accepts callback_at in valid range", () => {
    const valid = new Date(Date.now() + 6 * 60 * 1000).toISOString(); // 6 min from now
    const result = validateCallbackAt(valid);
    expect(result.ok).toBe(true);
  });
});

describe("D06 resolveUserId scope resolution", () => {
  const supervisor = makeAuth({ role: "supervisor", uid: 99 });
  const agent = makeAuth({ role: "agent", uid: 10 });

  it("agent_only=false → user_id=null (GLOBAL)", () => {
    const r = resolveUserId({ agent_only: false }, agent);
    expect(r.userId).toBeNull();
    expect(r.error).toBeUndefined();
  });

  it("agent_only=true → user_id=req.auth.uid (AGENT)", () => {
    const r = resolveUserId({ agent_only: true }, agent);
    expect(r.userId).toBe(BigInt(agent.uid));
  });

  it("explicit user_id by supervisor → accepted", () => {
    const r = resolveUserId({ user_id: BigInt(42) }, supervisor);
    expect(r.userId).toBe(BigInt(42));
    expect(r.error).toBeUndefined();
  });

  it("explicit user_id by agent → rejected with invalid_scope", () => {
    const r = resolveUserId({ user_id: BigInt(99) }, agent);
    expect(r.error).toBe("invalid_scope");
  });

  it("agent_only=true + user_id=other by supervisor → invalid_scope", () => {
    const r = resolveUserId({ agent_only: true, user_id: BigInt(77) }, supervisor);
    expect(r.error).toBe("invalid_scope");
  });
});

describe("D06 CreateCallbackBody schema validation", () => {
  it("requires lead_id", () => {
    const r = CreateCallbackBody.safeParse({
      campaign_id: "CAMP1",
      callback_at: new Date(Date.now() + 7 * 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(false);
  });

  it("limits comments to 255 chars", () => {
    const r = CreateCallbackBody.safeParse({
      lead_id: "1",
      campaign_id: "CAMP1",
      callback_at: new Date(Date.now() + 7 * 60 * 1000).toISOString(),
      comments: "x".repeat(256),
    });
    expect(r.success).toBe(false);
  });

  it("accepts valid minimal payload", () => {
    const r = CreateCallbackBody.safeParse({
      lead_id: "1",
      campaign_id: "CAMP1",
      callback_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.agent_only).toBe(false);
      expect(r.data.lead_id).toBe(1n);
    }
  });
});

describe("D06 TZ conversion", () => {
  it("ISO-8601 Z string parses to correct UTC Date", () => {
    // Agent picks "Tue 3:00 PM lead-PST" → browser sends UTC = Tue 23:00:00Z
    const iso = "2026-05-19T23:00:00.000Z";
    const d = new Date(iso);
    expect(d.getUTCHours()).toBe(23);
    expect(d.getUTCMinutes()).toBe(0);
    // Represents 3 PM PST (UTC-8)
    const pstHour = d.getUTCHours() - 8;
    expect(pstHour).toBe(15);
  });
});
