// M04 — Audit log viewer: service unit tests.
//
// Uses vi.fn() mocks for AuditReader and AuditVerifier — no real DB.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Prisma so the service module can be imported without a generated client.
vi.mock("../../../src/lib/prisma.js", () => ({
  getPrisma: () => null,
  setPrismaForTests: vi.fn(),
  closePrisma: vi.fn(),
}));
import { AuditLogViewerService } from "../../../src/routes/admin/audit/service.js";
import type { AuditReader, RbacContext } from "../../../src/services/audit/reader.js";
import type { AuditVerifier, RowVerifyResult } from "../../../src/services/audit/verifier.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRbac(overrides: Partial<RbacContext> = {}): RbacContext {
  return {
    userId: 1n,
    tenantId: 1n,
    permissions: new Set(["audit:view", "audit:export"]),
    requestId: "req-1",
    ipAddress: "127.0.0.1",
    userAgent: "test",
    ...overrides,
  };
}

function makeRow(id: bigint, action = "lead.created"): Record<string, unknown> {
  return {
    id: String(id),
    tenant_id: "1",
    actor_user_id: "1",
    actor_kind: "user",
    action,
    entity_type: "lead",
    entity_id: String(id * 10n),
    before_json: null,
    after_json: null,
    request_id: null,
    ip_address: "127.0.0.1",
    user_agent: null,
    ts: new Date("2026-01-15T12:00:00Z"),
    prev_hash: "a".repeat(64),
    row_hash: "b".repeat(64),
    hash_at: new Date("2026-01-15T12:00:00Z"),
  };
}

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeMockReader(): AuditReader {
  return {
    list: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    getByCallUuid: vi.fn(),
    getAttestation: vi.fn(),
  } as unknown as AuditReader;
}

function makeMockVerifier(): AuditVerifier {
  const okResult: RowVerifyResult = {
    ok: true,
    failures: [],
    rowsChecked: 1,
    daysChecked: 1,
    attestationsChecked: 1,
    prevRowHashMatches: true,
    nextRowPrevHashMatches: true,
    rowHashRecomputed: "b".repeat(64),
    rowHashStored: "b".repeat(64),
    merkleAttestationDate: "2026-01-15",
    merkleInclusionProof: undefined,
  };
  return {
    verifyRow: vi.fn().mockResolvedValue(okResult),
    verifyDay: vi.fn().mockResolvedValue({
      ok: true,
      failures: [],
      rowsChecked: 5,
      daysChecked: 1,
      attestationsChecked: 1,
    }),
    verifyRange: vi.fn(),
  } as unknown as AuditVerifier;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditLogViewerService.listAuditLog", () => {
  let reader: AuditReader;
  let verifier: AuditVerifier;
  let service: AuditLogViewerService;

  beforeEach(() => {
    reader = makeMockReader();
    verifier = makeMockVerifier();
    service = new AuditLogViewerService(reader, verifier);
  });

  it("delegates to reader.list with correct params", async () => {
    vi.mocked(reader.list).mockResolvedValueOnce({ items: [makeRow(1n)], nextCursor: null });

    const result = await service.listAuditLog(
      { limit: 50 },
      makeRbac(),
    );

    expect(reader.list).toHaveBeenCalledWith(
      expect.objectContaining({ table: "audit_log", limit: 50 }),
      expect.objectContaining({ tenantId: 1n }),
    );
    expect(result.items).toHaveLength(1);
    expect(result.nextCursor).toBeNull();
  });

  it("filters by action prefix in memory", async () => {
    vi.mocked(reader.list).mockResolvedValueOnce({
      items: [
        makeRow(1n, "lead.created"),
        makeRow(2n, "lead.status.updated"),
        makeRow(3n, "user.login"),
      ],
      nextCursor: null,
    });

    const result = await service.listAuditLog(
      { limit: 50, action: "lead" },
      makeRbac(),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.every((r) => String(r.action).startsWith("lead"))).toBe(true);
  });

  it("filters by actor in memory", async () => {
    vi.mocked(reader.list).mockResolvedValueOnce({
      items: [
        { ...makeRow(1n), actor_user_id: "1" },
        { ...makeRow(2n), actor_user_id: "2" },
        { ...makeRow(3n), actor_user_id: "1" },
      ],
      nextCursor: null,
    });

    const result = await service.listAuditLog(
      { limit: 50, actor: "1" },
      makeRbac(),
    );

    expect(result.items).toHaveLength(2);
    expect(result.items.every((r) => r.actor_user_id === "1")).toBe(true);
  });

  it("filters by actorKind in memory", async () => {
    vi.mocked(reader.list).mockResolvedValueOnce({
      items: [
        { ...makeRow(1n), actor_kind: "user" },
        { ...makeRow(2n), actor_kind: "system" },
      ],
      nextCursor: null,
    });

    const result = await service.listAuditLog(
      { limit: 50, actorKind: "system" },
      makeRbac(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.actor_kind).toBe("system");
  });

  it("filters by entity_type in memory", async () => {
    vi.mocked(reader.list).mockResolvedValueOnce({
      items: [
        { ...makeRow(1n), entity_type: "lead" },
        { ...makeRow(2n), entity_type: "campaign" },
      ],
      nextCursor: null,
    });

    const result = await service.listAuditLog(
      { limit: 50, entity_type: "lead" },
      makeRbac(),
    );

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.entity_type).toBe("lead");
  });

  it("passes cursor and nextCursor through", async () => {
    vi.mocked(reader.list).mockResolvedValueOnce({
      items: [makeRow(100n)],
      nextCursor: "MTAx",
    });

    const result = await service.listAuditLog(
      { limit: 50, cursor: "OTk=" },
      makeRbac(),
    );

    expect(reader.list).toHaveBeenCalledWith(
      expect.objectContaining({ cursor: "OTk=" }),
      expect.any(Object),
    );
    expect(result.nextCursor).toBe("MTAx");
  });

  it("throws 403 when audit:view permission missing", async () => {
    const rbac = makeRbac({ permissions: new Set(["user:read"]) });
    await expect(service.listAuditLog({ limit: 50 }, rbac)).rejects.toMatchObject({
      statusCode: 403,
    });
  });
});

// ---------------------------------------------------------------------------
// verifyRow
// ---------------------------------------------------------------------------

describe("AuditLogViewerService.verifyRow", () => {
  it("delegates to AuditVerifier.verifyRow with correct params", async () => {
    const reader = makeMockReader();
    const verifier = makeMockVerifier();
    const service = new AuditLogViewerService(reader, verifier);

    const result = await service.verifyRow(42n, makeRbac());

    expect(verifier.verifyRow).toHaveBeenCalledWith({
      tenantId: 1n,
      table: "audit_log",
      id: 42n,
    });
    expect(result.ok).toBe(true);
  });

  it("throws 403 when audit:view permission missing", async () => {
    const reader = makeMockReader();
    const verifier = makeMockVerifier();
    const service = new AuditLogViewerService(reader, verifier);

    const rbac = makeRbac({ permissions: new Set() });
    await expect(service.verifyRow(1n, rbac)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("returns failure details when verifier fails", async () => {
    const reader = makeMockReader();
    const verifier = makeMockVerifier();
    vi.mocked(verifier.verifyRow).mockResolvedValueOnce({
      ok: false,
      failures: [
        {
          kind: "row_hash_mismatch",
          table: "audit_log",
          tenantId: 1n,
          id: 42n,
          expected: "a".repeat(64),
          actual: "b".repeat(64),
        },
      ],
      rowsChecked: 1,
      daysChecked: 0,
      attestationsChecked: 0,
      prevRowHashMatches: true,
      nextRowPrevHashMatches: true,
      rowHashRecomputed: "a".repeat(64),
      rowHashStored: "b".repeat(64),
      merkleAttestationDate: undefined,
    });

    const service = new AuditLogViewerService(reader, verifier);
    const result = await service.verifyRow(42n, makeRbac());

    expect(result.ok).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.kind).toBe("row_hash_mismatch");
  });
});

// ---------------------------------------------------------------------------
// exportAuditLog — CSV header + JSON line format
// ---------------------------------------------------------------------------

describe("AuditLogViewerService.exportAuditLog", () => {
  it("yields CSV header as first chunk", async () => {
    const reader = makeMockReader();
    vi.mocked(reader.list).mockResolvedValueOnce({ items: [], nextCursor: null });
    const verifier = makeMockVerifier();
    const service = new AuditLogViewerService(reader, verifier);

    const chunks: string[] = [];
    for await (const chunk of service.exportAuditLog({ format: "csv" }, makeRbac())) {
      chunks.push(chunk);
    }

    expect(chunks[0]).toContain("id,ts,action,actor_kind");
  });

  it("yields JSON lines (no header) for json format", async () => {
    const reader = makeMockReader();
    vi.mocked(reader.list).mockResolvedValueOnce({
      items: [makeRow(1n)],
      nextCursor: null,
    });
    const verifier = makeMockVerifier();
    const service = new AuditLogViewerService(reader, verifier);

    const chunks: string[] = [];
    for await (const chunk of service.exportAuditLog({ format: "json" }, makeRbac())) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    const parsed = JSON.parse(chunks[0]!.trim());
    expect(parsed).toHaveProperty("id");
    expect(parsed).toHaveProperty("action");
  });

  it("paginates until nextCursor is null", async () => {
    const reader = makeMockReader();
    vi.mocked(reader.list)
      .mockResolvedValueOnce({ items: [makeRow(1n)], nextCursor: "Mg==" })
      .mockResolvedValueOnce({ items: [makeRow(2n)], nextCursor: null });

    const verifier = makeMockVerifier();
    const service = new AuditLogViewerService(reader, verifier);

    const chunks: string[] = [];
    for await (const chunk of service.exportAuditLog({ format: "csv" }, makeRbac())) {
      chunks.push(chunk);
    }

    // header + 2 data rows
    expect(chunks).toHaveLength(3);
    expect(reader.list).toHaveBeenCalledTimes(2);
  });

  it("throws 403 when audit:export permission missing", async () => {
    const reader = makeMockReader();
    const verifier = makeMockVerifier();
    const service = new AuditLogViewerService(reader, verifier);

    const rbac = makeRbac({ permissions: new Set(["audit:view"]) });
    const gen = service.exportAuditLog({ format: "csv" }, rbac);
    await expect(gen.next()).rejects.toMatchObject({ statusCode: 403 });
  });
});

// ---------------------------------------------------------------------------
// Cursor math — nextCursor propagation
// ---------------------------------------------------------------------------

describe("cursor pagination", () => {
  it("nextCursor from reader propagates to response", async () => {
    const reader = makeMockReader();
    vi.mocked(reader.list).mockResolvedValueOnce({
      items: [makeRow(50n)],
      nextCursor: "NTA=",
    });
    const verifier = makeMockVerifier();
    const service = new AuditLogViewerService(reader, verifier);

    const result = await service.listAuditLog({ limit: 1 }, makeRbac());
    expect(result.nextCursor).toBe("NTA=");
  });

  it("null nextCursor when no more rows", async () => {
    const reader = makeMockReader();
    vi.mocked(reader.list).mockResolvedValueOnce({ items: [], nextCursor: null });
    const verifier = makeMockVerifier();
    const service = new AuditLogViewerService(reader, verifier);

    const result = await service.listAuditLog({ limit: 50 }, makeRbac());
    expect(result.nextCursor).toBeNull();
  });
});
