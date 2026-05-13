// S03 — Script service unit tests (no DB; uses mocked Prisma).
//
// Run: pnpm test (vitest)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock Prisma and dependencies BEFORE importing service
// ---------------------------------------------------------------------------

vi.mock("../../lib/prisma.js", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("../sanitize.js", () => ({
  sanitizeBody: (raw: string) => raw, // pass-through in tests
}));

// Mock libphonenumber-js for interpolate.ts
vi.mock("libphonenumber-js/min", () => ({
  parsePhoneNumberFromString: () => ({ formatNational: () => "(555) 000-0000" }),
}));

import { getPrisma } from "../../lib/prisma.js";
import {
  listScripts,
  createScript,
  updateScript,
  deleteScript,
  listScriptVersions,
  getScriptVersion,
} from "../service.js";

// ---------------------------------------------------------------------------
// Helpers to build mock db objects
// ---------------------------------------------------------------------------

function makeScript(overrides = {}) {
  return {
    id: 1n,
    tenantId: 1n,
    name: "Test Script",
    body: "<p>Hello {lead.first_name}</p>",
    campaignId: null,
    active: true,
    version: 1,
    variables: [{ name: "lead.first_name" }],
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

function makeVersion(overrides = {}) {
  return {
    id: 100n,
    tenantId: 1n,
    scriptId: 1n,
    version: 1,
    name: "Test Script",
    body: "<p>Old body</p>",
    variables: [],
    savedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests: listScripts
// ---------------------------------------------------------------------------

describe("listScripts", () => {
  it("returns paginated results", async () => {
    // $transaction in service passes an array of promises to db.$transaction
    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      $transaction: async (arr: Promise<unknown>[]) => await Promise.all(arr),
      script: {
        findMany: vi.fn().mockResolvedValue([makeScript()]),
        count: vi.fn().mockResolvedValue(5),
      },
    });

    const result = await listScripts(1, { page: 1, pageSize: 50 });
    expect(result.totalCount).toBe(5);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.name).toBe("Test Script");
  });
});

// ---------------------------------------------------------------------------
// Tests: createScript
// ---------------------------------------------------------------------------

describe("createScript", () => {
  beforeEach(() => {
    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        create: vi.fn().mockResolvedValue(makeScript()),
      },
    });
  });

  it("creates a script and returns response", async () => {
    const result = await createScript(1, {
      name: "Test Script",
      body: "<p>Hello {lead.first_name}</p>",
    });
    expect(result.name).toBe("Test Script");
    expect(result.id).toBe("1");
    expect(result.version).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: updateScript — version bumping
// ---------------------------------------------------------------------------

describe("updateScript — version bumping", () => {
  it("bumps version when body changes", async () => {
    const existing = makeScript({ version: 3 });
    const updated = makeScript({ version: 4, body: "<p>New body</p>" });

    const mockTx = {
      scriptVersion: {
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue([
          makeVersion({ version: 3 }),
          makeVersion({ version: 2 }),
          makeVersion({ version: 1 }),
        ]),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
      script: {
        update: vi.fn().mockResolvedValue(updated),
      },
    };

    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(existing),
      },
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    });

    const result = await updateScript(1, 1n, { body: "<p>New body</p>" });
    expect(result?.version).toBe(4);
    expect(mockTx.scriptVersion.create).toHaveBeenCalledOnce();
  });

  it("does NOT bump version when only active flag changes", async () => {
    const existing = makeScript({ version: 2 });
    const updated = makeScript({ version: 2, active: false });

    const mockTx = {
      scriptVersion: {
        create: vi.fn(),
        findMany: vi.fn(),
        deleteMany: vi.fn(),
      },
      script: {
        update: vi.fn().mockResolvedValue(updated),
      },
    };

    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(existing),
      },
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    });

    const result = await updateScript(1, 1n, { active: false });
    expect(result?.version).toBe(2);
    expect(mockTx.scriptVersion.create).not.toHaveBeenCalled();
  });

  it("prunes versions beyond MAX_VERSIONS (10)", async () => {
    const existing = makeScript({ version: 11 });
    const updated = makeScript({ version: 12 });

    // Simulate 11 stored versions (after adding the new one, we have 11 → prune 1)
    const storedVersions = Array.from({ length: 11 }, (_, i) =>
      makeVersion({ id: BigInt(i + 1), version: 11 - i }),
    );

    const mockTx = {
      scriptVersion: {
        create: vi.fn().mockResolvedValue({}),
        findMany: vi.fn().mockResolvedValue(storedVersions),
        deleteMany: vi.fn().mockResolvedValue({}),
      },
      script: {
        update: vi.fn().mockResolvedValue(updated),
      },
    };

    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(existing),
      },
      $transaction: vi.fn(async (fn: (tx: typeof mockTx) => Promise<unknown>) => fn(mockTx)),
    });

    await updateScript(1, 1n, { body: "<p>New</p>" });

    // Should have called deleteMany with the oldest versions (beyond MAX 10)
    expect(mockTx.scriptVersion.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: [storedVersions[10]?.id] } },
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: deleteScript (soft-delete)
// ---------------------------------------------------------------------------

describe("deleteScript", () => {
  it("sets active=false and returns true", async () => {
    const mockUpdate = vi.fn().mockResolvedValue({});
    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(makeScript()),
        update: mockUpdate,
      },
    });

    const ok = await deleteScript(1, 1n);
    expect(ok).toBe(true);
    expect(mockUpdate).toHaveBeenCalledWith({
      where: { id: 1n },
      data: { active: false },
    });
  });

  it("returns false when script not found", async () => {
    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });

    const ok = await deleteScript(1, 999n);
    expect(ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: listScriptVersions
// ---------------------------------------------------------------------------

describe("listScriptVersions", () => {
  it("returns versions for a valid script", async () => {
    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(makeScript()),
      },
      scriptVersion: {
        findMany: vi.fn().mockResolvedValue([
          makeVersion({ version: 2 }),
          makeVersion({ version: 1 }),
        ]),
      },
    });

    const result = await listScriptVersions(1, 1n);
    expect(result).toHaveLength(2);
    expect(result[0]?.version).toBe(2);
  });

  it("returns empty array when script not found", async () => {
    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await listScriptVersions(1, 999n);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests: getScriptVersion
// ---------------------------------------------------------------------------

describe("getScriptVersion", () => {
  it("returns specific version", async () => {
    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(makeScript()),
      },
      scriptVersion: {
        findFirst: vi.fn().mockResolvedValue(makeVersion({ version: 1 })),
      },
    });

    const result = await getScriptVersion(1, 1n, 1);
    expect(result?.version).toBe(1);
  });

  it("returns null when version not found", async () => {
    (getPrisma as ReturnType<typeof vi.fn>).mockReturnValue({
      script: {
        findFirst: vi.fn().mockResolvedValue(makeScript()),
      },
      scriptVersion: {
        findFirst: vi.fn().mockResolvedValue(null),
      },
    });

    const result = await getScriptVersion(1, 1n, 999);
    expect(result).toBeNull();
  });
});
