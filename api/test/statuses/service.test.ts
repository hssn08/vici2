// D04 — StatusService unit tests.
// Three-layer merge, validateTransition, isSelectable, hotkeyMap.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock metrics ──────────────────────────────────────────────────────────────
vi.mock("../../src/statuses/metrics.js", () => ({
  hangupUnmappedTotal: { inc: vi.fn() },
  hangupResolutionsTotal: { inc: vi.fn() },
  cacheOpsTotal: { inc: vi.fn() },
  dispositionWritesTotal: { inc: vi.fn() },
  dispositionWriteLatencyMs: { observe: vi.fn() },
  dncSideEffectTotal: { inc: vi.fn() },
  crmWebhookTotal: { inc: vi.fn() },
  terminalRecycleWritesTotal: { inc: vi.fn() },
  illegalTransitionTotal: { inc: vi.fn() },
  d04Registry: {},
}));

// ── Mock cache ────────────────────────────────────────────────────────────────
vi.mock("../../src/statuses/cache.js", () => ({
  cacheGet: vi.fn().mockReturnValue(null),
  cacheSet: vi.fn(),
  cacheInvalidate: vi.fn(),
  publishInvalidation: vi.fn().mockResolvedValue(undefined),
  subscribeToInvalidation: vi.fn(),
  cacheClear: vi.fn(),
}));

// ── Mock hangup-map ───────────────────────────────────────────────────────────
vi.mock("../../src/statuses/hangup-map.js", () => ({
  resolveFromHangupCause: vi.fn().mockReturnValue("B-CAR"),
  loadHangupMap: vi.fn(),
  getHangupMap: vi.fn().mockReturnValue({}),
}));

import { StatusService, resetStatusService } from "../../src/statuses/service.js";
import { illegalTransitionTotal } from "../../src/statuses/metrics.js";

// ── Mock Prisma ───────────────────────────────────────────────────────────────
function makeMockPrisma(overrides: Record<string, unknown> = {}) {
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([]),
    status: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
    },
    campaignStatusOverride: {
      upsert: vi.fn().mockResolvedValue({}),
    },
    ...overrides,
  };
}

// ── 3-layer merge fixture helpers ─────────────────────────────────────────────
function makeRow(status: string, overrides: Record<string, unknown> = {}) {
  return {
    status,
    description: "Test status",
    selectable: 1,
    human_answered: 0,
    sale: 0,
    dnc: 0,
    callback: 0,
    not_interested: 0,
    hotkey: null,
    recycle_delay_seconds: -1,
    max_calls: null,
    category: "agent-outcome",
    system_owner: "__AGT__",
    source: "system",
    ...overrides,
  };
}

describe("StatusService", () => {
  beforeEach(() => {
    resetStatusService();
    vi.clearAllMocks();
  });

  describe("list()", () => {
    it("returns empty array when no statuses found", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.list(1n, "CAMP1");
      expect(result).toEqual([]);
    });

    it("maps raw SQL rows to EffectiveStatus shape", async () => {
      const row = makeRow("SALE", { selectable: 1, human_answered: 1, sale: 1, hotkey: "1" });
      const prisma = makeMockPrisma({
        $queryRawUnsafe: vi.fn().mockResolvedValue([row]),
      });
      const svc = new StatusService(prisma as never);
      const result = await svc.list(1n, "CAMP1");
      expect(result).toHaveLength(1);
      expect(result[0].code).toBe("SALE");
      expect(result[0].selectable).toBe(true);
      expect(result[0].humanAnswered).toBe(true);
      expect(result[0].sale).toBe(true);
      expect(result[0].hotkey).toBe("1");
    });

    it("handles MySQL boolean 0/1 values correctly", async () => {
      const row = makeRow("NI", { selectable: 1, not_interested: 1, human_answered: 1, selectable_val: 1 });
      const prisma = makeMockPrisma({
        $queryRawUnsafe: vi.fn().mockResolvedValue([row]),
      });
      const svc = new StatusService(prisma as never);
      const [status] = await svc.list(1n, "CAMP1");
      expect(status.notInterested).toBe(true);
    });
  });

  describe("resolve()", () => {
    it("returns null when status not found", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.resolve(1n, "CAMP1", "NONEXISTENT");
      expect(result).toBeNull();
    });

    it("returns the matching status", async () => {
      const row = makeRow("SALE", { hotkey: "1" });
      const prisma = makeMockPrisma({
        $queryRawUnsafe: vi.fn().mockResolvedValue([row]),
      });
      const svc = new StatusService(prisma as never);
      const result = await svc.resolve(1n, "CAMP1", "SALE");
      expect(result?.code).toBe("SALE");
    });
  });

  describe("isSelectable()", () => {
    it("returns false for unknown status", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      expect(await svc.isSelectable(1n, "CAMP1", "UNKNOWN")).toBe(false);
    });

    it("returns true for selectable status", async () => {
      const row = makeRow("SALE", { selectable: 1 });
      const prisma = makeMockPrisma({
        $queryRawUnsafe: vi.fn().mockResolvedValue([row]),
      });
      const svc = new StatusService(prisma as never);
      expect(await svc.isSelectable(1n, "CAMP1", "SALE")).toBe(true);
    });

    it("returns false for non-selectable status", async () => {
      const row = makeRow("INCALL", { selectable: 0 });
      const prisma = makeMockPrisma({
        $queryRawUnsafe: vi.fn().mockResolvedValue([row]),
      });
      const svc = new StatusService(prisma as never);
      expect(await svc.isSelectable(1n, "CAMP1", "INCALL")).toBe(false);
    });
  });

  describe("hotkeyMap()", () => {
    it("returns empty object when no hotkeys", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      expect(await svc.hotkeyMap(1n, "CAMP1")).toEqual({});
    });

    it("builds hotkey → code map", async () => {
      const rows = [
        makeRow("SALE", { hotkey: "1" }),
        makeRow("NI", { hotkey: "2" }),
        makeRow("NP", { hotkey: "3" }),
        makeRow("CALLBK", { hotkey: null }),
      ];
      const prisma = makeMockPrisma({
        $queryRawUnsafe: vi.fn().mockResolvedValue(rows),
      });
      const svc = new StatusService(prisma as never);
      const map = await svc.hotkeyMap(1n, "CAMP1");
      expect(map["1"]).toBe("SALE");
      expect(map["2"]).toBe("NI");
      expect(map["3"]).toBe("NP");
      expect(map["4"]).toBeUndefined();
    });
  });

  describe("validateTransition()", () => {
    it("blocks transition to INCALL (T01 only)", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.validateTransition(1n, "NEW", "INCALL");
      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe("illegal_to_incall");
      expect(illegalTransitionTotal.inc).toHaveBeenCalled();
    });

    it("blocks transition to QUEUE (E01 only)", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.validateTransition(1n, "NEW", "QUEUE");
      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe("illegal_to_queue");
    });

    it("blocks transition to NEW (cannot un-call a lead)", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.validateTransition(1n, "SALE", "NEW");
      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe("illegal_to_new");
    });

    it("blocks any transition from SALE (sales are sacred)", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.validateTransition(1n, "SALE", "NI");
      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe("sale_immutable");
    });

    it("blocks transition to INVALID (T04 only)", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.validateTransition(1n, "NEW", "INVALID");
      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe("illegal_to_invalid");
    });

    it("blocks any transition from DNC (FTC TSR sticky)", async () => {
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.validateTransition(1n, "DNC", "SALE");
      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe("dnc_immutable");
    });

    it("blocks transition out of terminal status", async () => {
      const prisma = makeMockPrisma({
        status: {
          findUnique: vi.fn().mockResolvedValue({ recycleDelaySeconds: -1 }),
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          findMany: vi.fn(),
        },
      });
      const svc = new StatusService(prisma as never);
      const result = await svc.validateTransition(1n, "NI", "B");
      expect(result.allowed).toBe(false);
      expect(result.errorCode).toBe("terminal_status");
    });

    it("allows valid transition", async () => {
      const prisma = makeMockPrisma({
        status: {
          findUnique: vi.fn().mockResolvedValue({ recycleDelaySeconds: 120 }), // non-terminal
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
          findMany: vi.fn(),
        },
      });
      const svc = new StatusService(prisma as never);
      const result = await svc.validateTransition(1n, "B", "SALE");
      expect(result.allowed).toBe(true);
    });
  });

  describe("resolveFromHangup()", () => {
    it("delegates to hangup-map resolveFromHangupCause", async () => {
      const { resolveFromHangupCause } = await import("../../src/statuses/hangup-map.js");
      const prisma = makeMockPrisma();
      const svc = new StatusService(prisma as never);
      const result = await svc.resolveFromHangup(1n, "CAMP1", "USER_BUSY");
      expect(result).toBe("B-CAR");
      expect(resolveFromHangupCause).toHaveBeenCalledWith("USER_BUSY");
    });
  });
});
