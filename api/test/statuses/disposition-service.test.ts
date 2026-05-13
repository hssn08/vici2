// D04 — dispositionService.submit() unit tests.
// Side-effects, transition guards, event emission.

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

vi.mock("../../src/statuses/events.js", () => ({
  publishLeadStatusChanged: vi.fn().mockResolvedValue(undefined),
}));

import { DispositionService } from "../../src/statuses/disposition-service.js";
import { StatusService, resetStatusService } from "../../src/statuses/service.js";
import { publishLeadStatusChanged } from "../../src/statuses/events.js";
import { dncSideEffectTotal } from "../../src/statuses/metrics.js";
import type { EffectiveStatus } from "@vici2/types";

function makeStatus(overrides: Partial<EffectiveStatus> = {}): EffectiveStatus {
  return {
    code: "SALE",
    description: "Sale",
    selectable: true,
    humanAnswered: true,
    sale: true,
    dnc: false,
    callback: false,
    notInterested: false,
    hotkey: "1",
    recycleDelaySeconds: -1,
    maxCalls: null,
    category: "agent-outcome",
    systemOwner: "__AGT__",
    source: "system",
    ...overrides,
  };
}

function makePrisma(opts: { leadRowCount?: number; dispositionsExist?: boolean } = {}) {
  const { leadRowCount = 1, dispositionsExist = false } = opts;
  return {
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ ...{ status: "SALE", description: "Sale", selectable: 1, human_answered: 1, sale: 1, dnc: 0, callback: 0, not_interested: 0, hotkey: "1", recycle_delay_seconds: -1, max_calls: null, category: "agent-outcome", system_owner: "__AGT__", source: "system" } }]),
    $transaction: vi.fn().mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $executeRawUnsafe: vi.fn().mockImplementation((sql: string) => {
          if (sql.includes("INSERT INTO dispositions") && !dispositionsExist) {
            return Promise.reject(Object.assign(new Error("Table 'dispositions' doesn't exist"), { code: "P2002" }));
          }
          if (sql.includes("UPDATE leads")) {
            return Promise.resolve(leadRowCount);
          }
          return Promise.resolve(1);
        }),
      };
      return fn(tx);
    }),
    status: {
      findUnique: vi.fn().mockResolvedValue(null),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    campaignStatusOverride: {
      upsert: vi.fn().mockResolvedValue({}),
    },
  };
}

const mockRedis = { publish: vi.fn().mockResolvedValue(1) };

describe("DispositionService", () => {
  beforeEach(() => {
    resetStatusService();
    vi.clearAllMocks();
  });

  it("throws 404 when status not found", async () => {
    const prisma = { ...makePrisma(), $queryRawUnsafe: vi.fn().mockResolvedValue([]) } as never;
    const statusSvc = new StatusService(prisma);
    const svc = new DispositionService(prisma, statusSvc, mockRedis);

    await expect(svc.submit({
      tenantId: 1n,
      campaignId: "CAMP1",
      leadId: 42n,
      callUuid: "uuid-1",
      statusCode: "NONEXISTENT",
      previousStatus: "INCALL",
      phoneE164: "+14155551212",
    })).rejects.toMatchObject({ message: "status_not_found" });
  });

  it("throws 403 when status is not selectable", async () => {
    const row = {
      status: "INCALL",
      description: "Talking",
      selectable: 0,
      human_answered: 1,
      sale: 0,
      dnc: 0,
      callback: 0,
      not_interested: 0,
      hotkey: null,
      recycle_delay_seconds: -1,
      max_calls: null,
      category: "lifecycle",
      system_owner: "T01",
      source: "system",
    };
    const prisma = { ...makePrisma(), $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const statusSvc = new StatusService(prisma);
    const svc = new DispositionService(prisma, statusSvc, mockRedis);

    await expect(svc.submit({
      tenantId: 1n,
      campaignId: "CAMP1",
      leadId: 42n,
      callUuid: "uuid-1",
      statusCode: "INCALL",
      previousStatus: "QUEUE",
      phoneE164: "+14155551212",
    })).rejects.toMatchObject({ message: "status_not_agent_selectable" });
  });

  it("throws 400 for system-only codes (QUEUE, INCALL, NEW, INVALID)", async () => {
    const row = {
      status: "QUEUE",
      description: "In hopper",
      selectable: 1, // hypothetically selectable
      human_answered: 0,
      sale: 0,
      dnc: 0,
      callback: 0,
      not_interested: 0,
      hotkey: null,
      recycle_delay_seconds: -1,
      max_calls: null,
      category: "lifecycle",
      system_owner: "E01",
      source: "system",
    };
    const prisma = { ...makePrisma(), $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const statusSvc = new StatusService(prisma);
    const svc = new DispositionService(prisma, statusSvc, mockRedis);

    await expect(svc.submit({
      tenantId: 1n,
      campaignId: "CAMP1",
      leadId: 42n,
      callUuid: "uuid-1",
      statusCode: "QUEUE",
      previousStatus: "INCALL",
      phoneE164: "+14155551212",
    })).rejects.toMatchObject({ message: "illegal_disposition_code" });
  });

  it("emits lead.status_changed event after commit", async () => {
    const row = {
      status: "SALE",
      description: "Sale",
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
    const prisma = { ...makePrisma(), $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const statusSvc = new StatusService(prisma);
    const svc = new DispositionService(prisma, statusSvc, mockRedis);

    await svc.submit({
      tenantId: 1n,
      campaignId: "CAMP1",
      leadId: 42n,
      callUuid: "uuid-1",
      statusCode: "SALE",
      previousStatus: "INCALL",
      phoneE164: "+14155551212",
      userId: 7,
    });

    // Allow microtasks to flush (non-blocking)
    await new Promise((r) => setTimeout(r, 0));

    expect(publishLeadStatusChanged).toHaveBeenCalledWith(
      mockRedis,
      expect.objectContaining({
        newStatus: "SALE",
        oldStatus: "INCALL",
        leadId: 42n,
        userId: 7,
      }),
    );
  });

  it("fires DNC side-effect for dnc=true status", async () => {
    const row = {
      status: "DNC",
      description: "Do not call",
      selectable: 1,
      human_answered: 1,
      sale: 0,
      dnc: 1,
      callback: 0,
      not_interested: 0,
      hotkey: "5",
      recycle_delay_seconds: -1,
      max_calls: null,
      category: "agent-outcome",
      system_owner: "__AGT__",
      source: "system",
    };
    const prisma = { ...makePrisma(), $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const statusSvc = new StatusService(prisma);

    const dncService = { addInternal: vi.fn().mockResolvedValue(undefined) };
    const svc = new DispositionService(prisma, statusSvc, mockRedis, dncService);

    await svc.submit({
      tenantId: 1n,
      campaignId: "CAMP1",
      leadId: 42n,
      callUuid: "uuid-1",
      statusCode: "DNC",
      previousStatus: "INCALL",
      phoneE164: "+14155551212",
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(dncService.addInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        phoneE164: "+14155551212",
        campaignId: "__GLOBAL__",
      }),
    );
    expect(dncSideEffectTotal.inc).toHaveBeenCalledWith({ outcome: "ok" });
  });

  it("DNC failure is non-blocking and does not roll back disposition", async () => {
    const row = {
      status: "DNC",
      description: "Do not call",
      selectable: 1,
      human_answered: 1,
      sale: 0,
      dnc: 1,
      callback: 0,
      not_interested: 0,
      hotkey: "5",
      recycle_delay_seconds: -1,
      max_calls: null,
      category: "agent-outcome",
      system_owner: "__AGT__",
      source: "system",
    };
    const prisma = { ...makePrisma(), $queryRawUnsafe: vi.fn().mockResolvedValue([row]) } as never;
    const statusSvc = new StatusService(prisma);

    const dncService = { addInternal: vi.fn().mockRejectedValue(new Error("DNC service down")) };
    const svc = new DispositionService(prisma, statusSvc, mockRedis, dncService);

    // Should not throw even though DNC failed
    const result = await svc.submit({
      tenantId: 1n,
      campaignId: "CAMP1",
      leadId: 42n,
      callUuid: "uuid-1",
      statusCode: "DNC",
      previousStatus: "INCALL",
      phoneE164: "+14155551212",
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(result.statusCode).toBe("DNC");
    expect(dncSideEffectTotal.inc).toHaveBeenCalledWith({ outcome: "error" });
  });
});
