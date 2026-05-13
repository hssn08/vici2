// E01 — Campaign routes integration tests.
// Uses stub Prisma (no real DB) + ioredis-mock.

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import RedisMock from "ioredis-mock";

import {
  registerKeyPairForTests,
  resetJwtForTests,
  signAccessToken,
} from "../../src/auth/jwt.js";
import { registerAuthDecorators } from "../../src/auth/middleware.js";
import { setRedisForTests } from "../../src/lib/redis.js";
import { setPrismaForTests } from "../../src/lib/prisma.js";
import { registerCampaignRoutes } from "../../src/routes/campaigns/index.js";

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

const TENANT_ID = 1n;
const CAMPAIGN_ID = "camp-01";

function makeCampaign(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenantId: TENANT_ID,
    id: CAMPAIGN_ID,
    name: "Test Campaign",
    active: true,
    dialMethod: "RATIO",
    autoDialLevel: "0.00",
    adaptiveMaxLevel: "3.00",
    adaptiveDropPct: "1.50",
    dialTimeoutSec: 22,
    wrapupSeconds: 10,
    nextAgentCall: "longest_wait",
    availableOnlyTally: false,
    hopperSizeTarget: 0,
    hopperMultiplier: "2.0",
    callerIdCarrierId: null,
    callerIdOverride: null,
    recordingMode: "ALL",
    amdEnabled: false,
    amdAction: "drop",
    vmdropAudio: null,
    safeHarborAudio: null,
    scriptId: null,
    webformUrl: null,
    dialStatusFilter: ["NEW", "NA"],
    callTimeId: null,
    useInternalDnc: true,
    useFederalDnc: true,
    useStateDnc: true,
    pauseCodesRequired: "OPTIONAL",
    hotKeysActive: true,
    closerIngroups: [],
    unknownTzPolicy: "deny",
    dialLevel: "1.50",
    lockTtlSec: 30,
    minHopperLevel: 50,
    maxHopperLevel: 5000,
    hopperBufferMultiplier: "1.5",
    recycleDelaySeconds: 600,
    maxCallsPerLead: 5,
    dialStatuses: ["NEW", "NA", "B", "CALLBK"],
    lowWaterPct: 25,
    highWaterPct: 90,
    overFetchRatio: "1.5",
    machineTerminal: true,
    leadFilterSql: null,
    multiListMix: "EVEN",
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    campaignLists: [],
    statusOverrides: [],
    ...overrides,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildStubPrisma(campaigns: Record<string, unknown>[] = []): any {
  const audit: unknown[] = [];
  const campMap = new Map(campaigns.map((c) => [`${c.tenantId}:${c.id}`, c]));
  const listLinks = new Map<string, unknown[]>(); // campaignId → links
  const overrides = new Map<string, unknown[]>(); // campaignId → overrides

  const makeCount = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    const tenantId = where.tenantId as bigint;
    return [...campMap.values()].filter((c) => c.tenantId === tenantId).length;
  });

  return {
    _audit: audit,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(this)),
    campaign: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const tid = where.tenantId as bigint;
        return [...campMap.values()].filter((c) => c.tenantId === tid);
      }),
      count: makeCount,
      findUnique: vi.fn(async ({ where }: { where: { tenantId_id?: { tenantId: bigint; id: string } } }) => {
        if (where.tenantId_id) {
          return campMap.get(`${where.tenantId_id.tenantId}:${where.tenantId_id.id}`) ?? null;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { ...makeCampaign(), ...data, campaignLists: [], statusOverrides: [] };
        campMap.set(`${row.tenantId}:${row.id}`, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: { where: { tenantId_id: { tenantId: bigint; id: string } }; data: Record<string, unknown> }) => {
        const key = `${where.tenantId_id.tenantId}:${where.tenantId_id.id}`;
        const existing = campMap.get(key);
        if (!existing) throw new Error("not found");
        const updated = { ...existing, ...data, campaignLists: listLinks.get(where.tenantId_id.id) ?? [], statusOverrides: overrides.get(where.tenantId_id.id) ?? [] };
        campMap.set(key, updated);
        return updated;
      }),
      delete: vi.fn(async ({ where }: { where: { tenantId_id: { tenantId: bigint; id: string } } }) => {
        const key = `${where.tenantId_id.tenantId}:${where.tenantId_id.id}`;
        campMap.delete(key);
      }),
    },
    campaignList: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => create),
      delete: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    campaignStatusOverride: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        ...create,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      delete: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({ count: 0 })),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        audit.push(data);
        return data;
      }),
    },
  };
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

async function mintToken(role: string, tenantId = 1, uid = 42): Promise<string> {
  const access = await signAccessToken({
    uid,
    tenantId,
    role: role as never,
    perms: [],
    totpVerified: true,
    aud: "api",
    ttlSec: 300,
  });
  return access.token;
}

describe("campaign routes", () => {
  let app: FastifyInstance;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let adminToken: string;
  let supervisorToken: string;

  beforeEach(async () => {
    resetJwtForTests();
    await registerKeyPairForTests("ed25519-camp-test");
    const redis = new RedisMock({ data: {} });
    await redis.flushall();
    setRedisForTests(redis as never);

    prisma = buildStubPrisma([makeCampaign()]);
    // Support both array form $transaction([...]) and callback form $transaction(fn)
    prisma.$transaction = vi.fn(async (fnOrArray: ((tx: unknown) => Promise<unknown>) | Promise<unknown>[]) => {
      if (Array.isArray(fnOrArray)) {
        return Promise.all(fnOrArray);
      }
      return fnOrArray(prisma);
    });
    setPrismaForTests(prisma);

    app = Fastify({ logger: false });
    await registerAuthDecorators(app);
    await registerCampaignRoutes(app);
    await app.ready();

    adminToken = await mintToken("admin");
    supervisorToken = await mintToken("supervisor");
  });

  afterEach(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // Auth guard
  // -------------------------------------------------------------------------

  it("GET /api/campaigns → 401 without token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/campaigns" });
    expect(res.statusCode).toBe(401);
  });

  it("GET /api/campaigns → 403 for agent (no campaign:read)", async () => {
    const agentToken = await mintToken("agent");
    const res = await app.inject({
      method: "GET",
      url: "/api/campaigns",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------

  it("GET /api/campaigns → 200 list for supervisor", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/campaigns",
      headers: { authorization: `Bearer ${supervisorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ items: unknown[]; total: number }>();
    expect(body).toHaveProperty("items");
    expect(body).toHaveProperty("total");
    expect(Array.isArray(body.items)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Get single
  // -------------------------------------------------------------------------

  it("GET /api/campaigns/:id → 200 for existing campaign", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: `Bearer ${supervisorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: string }>();
    expect(body.id).toBe(CAMPAIGN_ID);
  });

  it("GET /api/campaigns/:id → 404 for missing campaign", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/campaigns/does-not-exist",
      headers: { authorization: `Bearer ${supervisorToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------

  it("POST /api/campaigns → 201 for admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "new-camp",
        name: "New Campaign",
        dial_method: "RATIO",
        dial_timeout_sec: 22,
        lock_ttl_sec: 30,
      }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; name: string }>();
    expect(body.id).toBe("new-camp");
    expect(body.name).toBe("New Campaign");
  });

  it("POST /api/campaigns → 403 for supervisor (no campaign:create)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: {
        authorization: `Bearer ${supervisorToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "x", name: "Y" }),
    });
    expect(res.statusCode).toBe(403);
  });

  it("POST /api/campaigns → 400 for invalid lock_ttl_sec", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "bad",
        name: "Bad",
        dial_timeout_sec: 30,
        lock_ttl_sec: 30, // <= 30 + 5
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/campaigns → 400 for dangerous lead_filter_sql", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: "sql-bad",
        name: "SQL Bad",
        lead_filter_sql: "1=1; DROP TABLE leads",
      }),
    });
    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Update (PATCH)
  // -------------------------------------------------------------------------

  it("PATCH /api/campaigns/:id → 200 for admin", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/campaigns/${CAMPAIGN_ID}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Updated Name" }),
    });
    expect(res.statusCode).toBe(200);
  });

  it("PATCH /api/campaigns/:id → 404 for missing campaign", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/campaigns/no-exist",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "X" }),
    });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Delete
  // -------------------------------------------------------------------------

  it("DELETE /api/campaigns/:id → 204 for admin", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it("DELETE /api/campaigns/:id → 404 for missing", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/campaigns/ghost",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Clone
  // -------------------------------------------------------------------------

  it("POST /api/campaigns/:id/clone → 201 with new campaign", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/campaigns/${CAMPAIGN_ID}/clone`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ new_id: "clone-01", new_name: "Clone" }),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it("POST /api/campaigns/:id/clone → 404 for missing source", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/campaigns/ghost/clone",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ new_id: "clone-02", new_name: "Clone2" }),
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/campaigns/:id/clone → 400 for missing new_id", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/campaigns/${CAMPAIGN_ID}/clone`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ new_name: "No ID" }),
    });
    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Action (start / pause / stop)
  // -------------------------------------------------------------------------

  it("POST /api/campaigns/:id/action → 200 start", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/campaigns/${CAMPAIGN_ID}/action`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "start" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean }>();
    expect(body.active).toBe(true);
  });

  it("POST /api/campaigns/:id/action → 200 pause → active=false", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/campaigns/${CAMPAIGN_ID}/action`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "pause" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ active: boolean }>();
    expect(body.active).toBe(false);
  });

  it("POST /api/campaigns/:id/action → 400 for invalid action", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/campaigns/${CAMPAIGN_ID}/action`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "launch" }),
    });
    expect(res.statusCode).toBe(400);
  });

  // -------------------------------------------------------------------------
  // Lists linkage
  // -------------------------------------------------------------------------

  it("GET /api/campaigns/:id/lists → 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/campaigns/${CAMPAIGN_ID}/lists`,
      headers: { authorization: `Bearer ${supervisorToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ items: unknown[] }>()).toHaveProperty("items");
  });

  it("POST /api/campaigns/:id/lists → 204 for admin", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/campaigns/${CAMPAIGN_ID}/lists`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ list_id: 99, priority: 0 }),
    });
    expect(res.statusCode).toBe(204);
  });

  it("DELETE /api/campaigns/:id/lists/:listId → 404 for missing link", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${CAMPAIGN_ID}/lists/999`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Status overrides
  // -------------------------------------------------------------------------

  it("GET /api/campaigns/:id/status-overrides → 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/campaigns/${CAMPAIGN_ID}/status-overrides`,
      headers: { authorization: `Bearer ${supervisorToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("PUT /api/campaigns/:id/status-overrides/NA → 200 upsert", async () => {
    const res = await app.inject({
      method: "PUT",
      url: `/api/campaigns/${CAMPAIGN_ID}/status-overrides/NA`,
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ recycle_delay_seconds: 120, notes: "Faster recycle" }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status_code: string }>();
    expect(body.status_code).toBe("NA");
  });

  it("DELETE /api/campaigns/:id/status-overrides/NA → 404 for missing override", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${CAMPAIGN_ID}/status-overrides/NA`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // Audit log written on create
  // -------------------------------------------------------------------------

  it("creates audit log on campaign create", async () => {
    await app.inject({
      method: "POST",
      url: "/api/campaigns",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "audit-test", name: "Audit Test" }),
    });
    expect(prisma.auditLog.create).toHaveBeenCalled();
    const firstCall = prisma.auditLog.create.mock.calls[0][0].data;
    expect(firstCall.action).toBe("campaign.created");
    expect(firstCall.entityType).toBe("campaign");
  });

  it("creates audit log on campaign delete", async () => {
    prisma.auditLog.create.mockClear();
    await app.inject({
      method: "DELETE",
      url: `/api/campaigns/${CAMPAIGN_ID}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const calls = prisma.auditLog.create.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const lastCall = calls[calls.length - 1][0].data;
    expect(lastCall.action).toBe("campaign.deleted");
  });
});
