// M06 — Carrier + Gateway service unit tests (Prisma mock).
//
// Tests verify CRUD responses, credential masking, and kind mapping.
// A mock PrismaClient is injected via setPrismaForTests().

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setPrismaForTests } from "../../src/lib/prisma.js";
import {
  encryptCredential,
  decryptCredential,
  listCarriers,
  createCarrier,
} from "../../src/routes/admin/carriers/service.js";
import { parseCsvRows } from "../../src/routes/admin/dids/service.js";

// ---------------------------------------------------------------------------
// Helper to create a mock PrismaClient with the needed shape
// ---------------------------------------------------------------------------

function makeMockPrisma() {
  const mockAuditCreate = vi.fn().mockResolvedValue({ id: 1n });
  const mockCarrierCreate = vi.fn();
  const mockCarrierFindMany = vi.fn();
  const mockCarrierFindFirst = vi.fn();
  const mockCarrierCount = vi.fn().mockResolvedValue(0);
  const mockCarrierUpdate = vi.fn();
  const mockCarrierDelete = vi.fn();
  const mockGatewayFindMany = vi.fn();
  const mockGatewayCreate = vi.fn();

  const tx = {
    carrier: {
      create: mockCarrierCreate,
      findMany: mockCarrierFindMany,
      findFirst: mockCarrierFindFirst,
      count: mockCarrierCount,
      update: mockCarrierUpdate,
      delete: mockCarrierDelete,
    },
    gateway: {
      findMany: mockGatewayFindMany,
      findFirst: vi.fn(),
      create: mockGatewayCreate,
      update: vi.fn(),
      delete: vi.fn(),
    },
    auditLog: { create: mockAuditCreate },
  };

  const prisma = {
    ...tx,
    $transaction: vi.fn().mockImplementation(async (fn: (tx: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  return { prisma, mockCarrierCreate, mockCarrierFindMany, mockCarrierFindFirst, mockCarrierCount, mockAuditCreate, mockGatewayFindMany, mockGatewayCreate };
}

// ---------------------------------------------------------------------------
// Sample carrier row
// ---------------------------------------------------------------------------

function makeCarrierRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n,
    tenantId: 1n,
    name: "Twilio Prod",
    kind: "twilio",
    proxy: "acme.pstn.twilio.com",
    usernameCt: null,
    passwordCt: null,
    kekVersion: 1,
    register: false,
    callerIdE164: null,
    active: true,
    ipAllowlist: [],
    configJson: {},
    sendPai: false,
    isEmergency: false,
    maxConcurrent: null,
    notes: {},
    version: 1,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    _count: { gateways: 0 },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Credential encryption round-trip
// ---------------------------------------------------------------------------

describe("credential encryption", () => {
  it("round-trips plaintext through AES-GCM", () => {
    const plaintext = "my-sip-password";
    const ct = encryptCredential(plaintext);
    const decoded = decryptCredential(ct);
    expect(decoded).toBe(plaintext);
  });

  it("produces different ciphertext each time (random IV)", () => {
    const ct1 = encryptCredential("same");
    const ct2 = encryptCredential("same");
    expect(ct1.equals(ct2)).toBe(false);
  });

  it("returns a Buffer", () => {
    const ct = encryptCredential("test");
    expect(ct).toBeInstanceOf(Buffer);
    // iv(12) + tag(16) + body >= 28 bytes
    expect(ct.length).toBeGreaterThanOrEqual(28);
  });
});

// ---------------------------------------------------------------------------
// listCarriers — credential masking
// ---------------------------------------------------------------------------

describe("listCarriers", () => {
  afterEach(() => {
    setPrismaForTests(null);
    vi.clearAllMocks();
  });

  it("masks username_ct as credentialStatus=set", async () => {
    const { prisma, mockCarrierFindMany, mockCarrierCount } = makeMockPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPrismaForTests(prisma as any);

    const fakeRow = makeCarrierRow({ usernameCt: Buffer.from("encrypted") });
    mockCarrierFindMany.mockResolvedValue([fakeRow]);
    mockCarrierCount.mockResolvedValue(1);

    const result = await listCarriers(1, { page: 1, pageSize: 50, active: "all" });

    expect(result.data).toHaveLength(1);
    expect(result.data[0].credentialStatus).toBe("set");
    // Ensure no raw bytes leaked
    expect((result.data[0] as Record<string, unknown>).usernameCt).toBeUndefined();
    expect((result.data[0] as Record<string, unknown>).passwordCt).toBeUndefined();
  });

  it("returns credentialStatus=unset when no credentials", async () => {
    const { prisma, mockCarrierFindMany, mockCarrierCount } = makeMockPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPrismaForTests(prisma as any);

    mockCarrierFindMany.mockResolvedValue([makeCarrierRow()]);
    mockCarrierCount.mockResolvedValue(1);

    const result = await listCarriers(1, { page: 1, pageSize: 50, active: "all" });

    expect(result.data[0].credentialStatus).toBe("unset");
  });

  it("maps telnyx_creds kind to telnyx-creds in response", async () => {
    const { prisma, mockCarrierFindMany, mockCarrierCount } = makeMockPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPrismaForTests(prisma as any);

    mockCarrierFindMany.mockResolvedValue([makeCarrierRow({ kind: "telnyx_creds" })]);
    mockCarrierCount.mockResolvedValue(1);

    const result = await listCarriers(1, { page: 1, pageSize: 50, active: "all" });

    expect(result.data[0].kind).toBe("telnyx-creds");
  });

  it("includes gateway count from _count", async () => {
    const { prisma, mockCarrierFindMany, mockCarrierCount } = makeMockPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPrismaForTests(prisma as any);

    mockCarrierFindMany.mockResolvedValue([makeCarrierRow({ _count: { gateways: 7 } })]);
    mockCarrierCount.mockResolvedValue(1);

    const result = await listCarriers(1, { page: 1, pageSize: 50, active: "all" });

    expect(result.data[0].gatewayCount).toBe(7);
  });

  it("returns empty data when no carriers", async () => {
    const { prisma, mockCarrierFindMany, mockCarrierCount } = makeMockPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPrismaForTests(prisma as any);

    mockCarrierFindMany.mockResolvedValue([]);
    mockCarrierCount.mockResolvedValue(0);

    const result = await listCarriers(1, { page: 1, pageSize: 50, active: "all" });

    expect(result.data).toHaveLength(0);
    expect(result.totalCount).toBe(0);
    expect(result.totalPages).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createCarrier — audit + encryption
// ---------------------------------------------------------------------------

describe("createCarrier", () => {
  afterEach(() => {
    setPrismaForTests(null);
    vi.clearAllMocks();
  });

  it("calls auditLog.create with carrier.created action", async () => {
    const { prisma, mockCarrierCreate, mockAuditCreate } = makeMockPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPrismaForTests(prisma as any);

    const createdRow = makeCarrierRow();
    mockCarrierCreate.mockResolvedValue(createdRow);

    await createCarrier(1, 42, {
      name: "Twilio Prod",
      kind: "twilio",
      proxy: "acme.pstn.twilio.com",
      register: false,
      active: true,
      ipAllowlist: [],
      configJson: {},
      sendPai: false,
      isEmergency: false,
      notes: {},
      priority: 100,
    });

    expect(mockAuditCreate).toHaveBeenCalledOnce();
    const call = mockAuditCreate.mock.calls[0][0];
    expect(call.data.action).toBe("carrier.created");
    expect(call.data.entityType).toBe("carrier");
  });

  it("encrypts credentials before storing", async () => {
    const { prisma, mockCarrierCreate } = makeMockPrisma();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setPrismaForTests(prisma as any);

    mockCarrierCreate.mockResolvedValue(makeCarrierRow());

    await createCarrier(1, 42, {
      name: "Test",
      kind: "byoc",
      proxy: "sip.example.com",
      username: "user",
      password: "pass",
      register: false,
      active: true,
      ipAllowlist: [],
      configJson: {},
      sendPai: false,
      isEmergency: false,
      notes: {},
      priority: 100,
    });

    const call = mockCarrierCreate.mock.calls[0][0];
    // usernameCt and passwordCt must be Buffer (not plaintext strings)
    expect(call.data.usernameCt).toBeInstanceOf(Buffer);
    expect(call.data.passwordCt).toBeInstanceOf(Buffer);
    // Plaintext must NOT appear in the stored data
    expect(call.data.username).toBeUndefined();
    expect(call.data.password).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// CSV parser (parseCsvRows)
// ---------------------------------------------------------------------------

describe("parseCsvRows (from dids/service)", () => {
  it("parses header + data rows", () => {
    const csv = `e164,carrier_id,route_kind,route_target
+12065551234,1,ingroup,SALES
+12065555678,1,ivr,main_menu`;

    const rows = parseCsvRows(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].e164).toBe("+12065551234");
    expect(rows[0].route_kind).toBe("ingroup");
    expect(rows[1].e164).toBe("+12065555678");
  });

  it("returns empty array for header-only CSV", () => {
    const rows = parseCsvRows("e164,carrier_id,route_kind,route_target\n");
    expect(rows).toHaveLength(0);
  });

  it("handles CRLF line endings", () => {
    const csv = "e164,carrier_id,route_kind,route_target\r\n+12065551234,1,ingroup,SALES\r\n";
    const rows = parseCsvRows(csv);
    expect(rows).toHaveLength(1);
  });

  it("trims whitespace from values", () => {
    const csv = "e164,carrier_id,route_kind,route_target\n +12065551234 , 1 , ingroup , SALES ";
    const rows = parseCsvRows(csv);
    expect(rows[0].e164).toBe("+12065551234");
    expect(rows[0].carrier_id).toBe("1");
  });
});
