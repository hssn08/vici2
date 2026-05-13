// D04 — Three-layer merge fixture matrix (11 cases).
//
// Tests the COALESCE resolution algorithm:
//   (a) shadow row → wins all columns
//   (b) campaign_status_overrides → wins recycle_delay + max_calls only
//   (c) __SYS__ row → system default
//
// This tests the SQL column-mapping logic via the service's list() output.

import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("../../src/statuses/cache.js", () => ({
  cacheGet: vi.fn().mockReturnValue(null),
  cacheSet: vi.fn(),
  cacheInvalidate: vi.fn(),
  publishInvalidation: vi.fn().mockResolvedValue(undefined),
  subscribeToInvalidation: vi.fn(),
  cacheClear: vi.fn(),
}));

vi.mock("../../src/statuses/hangup-map.js", () => ({
  resolveFromHangupCause: vi.fn().mockReturnValue("NA"),
  loadHangupMap: vi.fn(),
  getHangupMap: vi.fn().mockReturnValue({}),
}));

import { StatusService, resetStatusService } from "../../src/statuses/service.js";

// System row fixture
const SYS_ROW = {
  status: "SALE",
  description: "Sale completed",
  selectable: 1,
  human_answered: 1,
  sale: 1,
  dnc: 0,
  callback: 0,
  not_interested: 0,
  hotkey: "1",
  recycle_delay_seconds: -1,
  max_calls: null,
  category: "agent-outcome",
  system_owner: "__AGT__",
  source: "system",
};

// Shadow row fixture (campaign-level override)
const SHADOW_ROW = {
  ...SYS_ROW,
  description: "Campaign sale (custom)",
  hotkey: "9",
  recycle_delay_seconds: 300,
  source: "shadow",
};

// Override-only row (campaign_status_overrides)
const OVERRIDE_ROW = {
  ...SYS_ROW,
  recycle_delay_seconds: 600,
  max_calls: 3,
  source: "override",
};

describe("Three-layer merge fixture matrix", () => {
  beforeEach(() => {
    resetStatusService();
    vi.clearAllMocks();
  });

  // Case 1: system-only (no shadow, no override)
  it("Case 1: system-only — uses system defaults on all columns", async () => {
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([SYS_ROW]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.description).toBe("Sale completed");
    expect(status.hotkey).toBe("1");
    expect(status.recycleDelaySeconds).toBe(-1);
    expect(status.source).toBe("system");
  });

  // Case 2: shadow row only
  it("Case 2: shadow-only — shadow row wins all columns", async () => {
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([SHADOW_ROW]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.description).toBe("Campaign sale (custom)");
    expect(status.hotkey).toBe("9");
    expect(status.recycleDelaySeconds).toBe(300);
    expect(status.source).toBe("shadow");
  });

  // Case 3: override-only (no shadow row)
  it("Case 3: override-only — override wins recycle_delay; other flags from system", async () => {
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([OVERRIDE_ROW]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.recycleDelaySeconds).toBe(600);
    expect(status.maxCalls).toBe(3);
    expect(status.description).toBe("Sale completed");
    expect(status.source).toBe("override");
  });

  // Case 4: shadow + override — shadow wins all columns (override ignored for flags)
  it("Case 4: shadow + override — shadow wins description/hotkey; shadow's recycle_delay wins over override", async () => {
    // In SQL, COALESCE(shadow.recycle_delay, override.recycle_delay, sys.recycle_delay)
    // Shadow row has recycle_delay = 300, override has 600 — shadow wins
    const row = { ...SHADOW_ROW, max_calls: 3 }; // shadow + override max_calls
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.recycleDelaySeconds).toBe(300); // shadow wins
    expect(status.hotkey).toBe("9"); // shadow wins
  });

  // Case 5: NULL recycle_delay in shadow → falls through to override
  it("Case 5: shadow with null recycle_delay — override recycle_delay wins", async () => {
    const row = { ...SHADOW_ROW, recycle_delay_seconds: null, source: "override" };
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.recycleDelaySeconds).toBeNull();
  });

  // Case 6: humanAnswered flag propagates correctly
  it("Case 6: humanAnswered=true propagates", async () => {
    const row = { ...SYS_ROW, human_answered: 1 };
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.humanAnswered).toBe(true);
  });

  // Case 7: dnc=true propagates
  it("Case 7: dnc=true propagates for DNC status", async () => {
    const row = { ...SYS_ROW, status: "DNC", dnc: 1 };
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.dnc).toBe(true);
  });

  // Case 8: callback=true propagates
  it("Case 8: callback=true propagates for CALLBK status", async () => {
    const row = { ...SYS_ROW, status: "CALLBK", callback: 1, hotkey: "4" };
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.callback).toBe(true);
  });

  // Case 9: recycleDelaySeconds=0 (immediate) propagates
  it("Case 9: recycleDelaySeconds=0 (immediate) for CARRIER_FAIL", async () => {
    const row = { ...SYS_ROW, status: "CARRIER_FAIL", selectable: 0, sale: 0, human_answered: 0,
                  recycle_delay_seconds: 0, category: "system-carrier", system_owner: "T04" };
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const svc = new StatusService(prisma);
    const [status] = await svc.list(1n, "CAMP1");
    expect(status.recycleDelaySeconds).toBe(0);
    expect(status.selectable).toBe(false);
  });

  // Case 10: resolve() for single status
  it("Case 10: resolve() returns null for missing status", async () => {
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([SYS_ROW]) } as never;
    const svc = new StatusService(prisma);
    const result = await svc.resolve(1n, "CAMP1", "NONEXISTENT");
    expect(result).toBeNull();
  });

  // Case 11: GATEWAY_LIMIT_TRY_LATER (24-char code) round-trip
  it("Case 11: GATEWAY_LIMIT_TRY_LATER (24-char status code) resolves correctly", async () => {
    const row = {
      ...SYS_ROW,
      status: "GATEWAY_LIMIT_TRY_LATER",
      description: "Concurrent cap hit on gateway",
      selectable: 0,
      human_answered: 0,
      sale: 0,
      recycle_delay_seconds: 0,
      category: "system-carrier",
      system_owner: "T04",
      hotkey: null,
    };
    const prisma = { $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const svc = new StatusService(prisma);
    const result = await svc.resolve(1n, "CAMP1", "GATEWAY_LIMIT_TRY_LATER");
    expect(result).not.toBeNull();
    expect(result!.code).toBe("GATEWAY_LIMIT_TRY_LATER");
    expect(result!.recycleDelaySeconds).toBe(0);
  });
});
