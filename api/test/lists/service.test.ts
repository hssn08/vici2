// D07 — List service unit tests (stub Prisma, no real DB).

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listLists,
  getList,
  createList,
  updateList,
  deleteList,
  listCampaignAssignments,
  countActiveLeads,
  SYNC_LEAD_THRESHOLD,
} from "../../src/lists/service.js";

// Stub Prisma
function makeList(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    tenantId: 1n,
    name: "Test List",
    description: null,
    active: true,
    ownerUserId: null,
    callerIdOverride: null,
    callerIdName: null,
    settings: { max_attempts: 5, recycle_delay_default: 600, override_tz: null, callable_status_codes: ["NEW"] },
    source: null,
    resetTime: null,
    expiration: null,
    columnMapping: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildStubPrisma(): any {
  const lists: Record<string, unknown>[] = [makeList()];
  const campaignLinks: Record<string, unknown>[] = [];
  const auditLog: unknown[] = [];

  const prisma = {
    _audit: auditLog,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn(prisma);
    }),
    $queryRaw: vi.fn(async () => [{ n: 5n }]),
    $executeRaw: vi.fn(async () => 3),
    auditLog: {
      create: vi.fn(async (args: unknown) => { auditLog.push(args); return {}; }),
    },
    list: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return lists.filter((l) => l.tenantId === where.tenantId);
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return lists.find((l) =>
          l.tenantId === where.tenantId && l.id === where.id,
        ) ?? null;
      }),
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        return lists.filter((l) => l.tenantId === where.tenantId).length;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const newList = { id: BigInt(lists.length + 1), ...data, createdAt: new Date(), updatedAt: new Date() };
        lists.push(newList);
        return newList;
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const idx = lists.findIndex((l) => l.id === where.id);
        if (idx < 0) throw new Error("not found");
        lists[idx] = { ...lists[idx], ...data, updatedAt: new Date() };
        return lists[idx];
      }),
      delete: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const idx = lists.findIndex((l) => l.id === where.id);
        if (idx >= 0) lists.splice(idx, 1);
      }),
    },
    campaignList: {
      findMany: vi.fn(async () => campaignLinks),
      findFirst: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => {
        const link = { ...create, createdAt: new Date() };
        campaignLinks.push(link);
        return link;
      }),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const idx = campaignLinks.findIndex(
          (cl) => cl.campaignId === (where.tenantId_campaignId_listId as Record<string,unknown>).campaignId,
        );
        if (idx < 0) throw new Error("not found");
        campaignLinks[idx] = { ...campaignLinks[idx], ...data };
        return campaignLinks[idx];
      }),
      delete: vi.fn(async () => undefined),
    },
  };

  return prisma;
}

describe("listLists", () => {
  it("returns lists for tenant", async () => {
    const prisma = buildStubPrisma();
    const result = await listLists(prisma, 1, { page: 1, page_size: 50 });
    expect(result.data).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.data[0].name).toBe("Test List");
  });
});

describe("getList", () => {
  it("returns list when found", async () => {
    const prisma = buildStubPrisma();
    const list = await getList(prisma, 1, 1);
    expect(list).not.toBeNull();
    expect(list?.name).toBe("Test List");
  });

  it("returns null when not found", async () => {
    const prisma = buildStubPrisma();
    prisma.list.findFirst = vi.fn(async () => null);
    const list = await getList(prisma, 1, 999);
    expect(list).toBeNull();
  });
});

describe("createList", () => {
  it("creates a list and emits audit", async () => {
    const prisma = buildStubPrisma();
    const result = await createList(
      prisma,
      1,
      { name: "New List", active: true, settings: { max_attempts: 5, recycle_delay_default: 600, override_tz: null, callable_status_codes: ["NEW"] } },
      42,
    );
    expect(result.name).toBe("New List");
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });
});

describe("updateList", () => {
  it("updates a list and emits audit", async () => {
    const prisma = buildStubPrisma();
    const result = await updateList(prisma, 1, 1, { name: "Updated Name" }, 42);
    expect(result?.name).toBe("Updated Name");
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });

  it("returns null if list not found", async () => {
    const prisma = buildStubPrisma();
    prisma.list.findFirst = vi.fn(async () => null);
    const result = await updateList(prisma, 1, 999, { name: "X" }, 42);
    expect(result).toBeNull();
  });
});

describe("deleteList", () => {
  it("deletes list and emits audit", async () => {
    const prisma = buildStubPrisma();
    const result = await deleteList(prisma, 1, 1, 42);
    expect(result).toBe(true);
    expect(prisma.auditLog.create).toHaveBeenCalledOnce();
  });

  it("returns false if not found", async () => {
    const prisma = buildStubPrisma();
    prisma.list.findFirst = vi.fn(async () => null);
    const result = await deleteList(prisma, 1, 999, 42);
    expect(result).toBe(false);
  });
});

describe("listCampaignAssignments", () => {
  it("returns empty array when no links", async () => {
    const prisma = buildStubPrisma();
    const result = await listCampaignAssignments(prisma, 1, 1);
    expect(result).toHaveLength(0);
  });
});

describe("countActiveLeads", () => {
  it("returns numeric count", async () => {
    const prisma = buildStubPrisma();
    prisma.$queryRaw = vi.fn(async () => [{ n: 50n }]);
    const count = await countActiveLeads(prisma, 1, 1);
    expect(count).toBe(50);
  });

  it("SYNC_LEAD_THRESHOLD is 10000", () => {
    expect(SYNC_LEAD_THRESHOLD).toBe(10_000);
  });
});
