// D07 — List routes integration tests.
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
import { registerListRoutes } from "../../src/lists/index.js";

// ---------------------------------------------------------------------------
// Token helper
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

// ---------------------------------------------------------------------------
// Stub data
// ---------------------------------------------------------------------------

const TENANT_ID = 1n;
const LIST_ID = 1n;

function makeList(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: LIST_ID,
    tenantId: TENANT_ID,
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
function buildStubPrisma(lists: Record<string, unknown>[] = [makeList()]): any {
  const auditLog: unknown[] = [];
  const campaignLinks: unknown[] = [];

  const prisma = {
    _audit: auditLog,
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
    $queryRaw: vi.fn(async () => [{ n: 5n }]),
    $executeRaw: vi.fn(async () => 3),
    auditLog: {
      create: vi.fn(async (a: unknown) => { auditLog.push(a); return {}; }),
    },
    list: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        lists.filter((l) => l.tenantId === where.tenantId),
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        lists.find((l) => l.tenantId === where.tenantId && l.id === where.id) ?? null,
      ),
      count: vi.fn(async () => lists.length),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: 2n, ...data, createdAt: new Date(), updatedAt: new Date(),
      })),
      update: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const found = lists.find((l) => l.id === where.id);
        if (!found) throw new Error("not found");
        return { ...found, ...data, updatedAt: new Date() };
      }),
      delete: vi.fn(async () => undefined),
    },
    campaignList: {
      findMany: vi.fn(async () => campaignLinks),
      findFirst: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ ...create, createdAt: new Date() })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ ...data })),
      delete: vi.fn(async () => undefined),
    },
  };

  return prisma;
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

async function buildApp(customLists?: Record<string, unknown>[]): Promise<FastifyInstance> {
  resetJwtForTests();
  await registerKeyPairForTests("ed25519-list-test");

  const redis = new RedisMock({ data: {} }) as unknown as Parameters<typeof setRedisForTests>[0];
  setRedisForTests(redis);

  const stub = buildStubPrisma(customLists);
  setPrismaForTests(stub);

  const app = Fastify({ logger: false });
  await registerAuthDecorators(app);
  await registerListRoutes(app);
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/lists", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let agentToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
    agentToken = await mintToken("agent");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("returns 200 with lists for admin", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/lists",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[]; total: number };
    expect(body.data).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("returns 403 for agent (no list:read on agent role)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/lists",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    // Agent has no list:read per RBAC matrix
    expect(res.statusCode).toBe(403);
  });

  it("returns 401 with no token", async () => {
    const res = await app.inject({ method: "GET", url: "/api/lists" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /api/lists", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let agentToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
    agentToken = await mintToken("agent");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("creates a list and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "New List" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { name: string };
    expect(body.name).toBe("New List");
  });

  it("returns 400 for missing name", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns 403 for agent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists",
      headers: {
        authorization: `Bearer ${agentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Agent List" }),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("GET /api/lists/:id", () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("returns 200 for existing list", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/lists/1",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { name: string };
    expect(body.name).toBe("Test List");
  });

  it("returns 404 for non-existent list", async () => {
    // Use empty list stub
    const app2 = await buildApp([]);
    const tok = await mintToken("admin");
    const res = await app2.inject({
      method: "GET",
      url: "/api/lists/999",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(404);
    await app2.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });
});

describe("PATCH /api/lists/:id", () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("updates list and returns 200", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/lists/1",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ active: false }),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("DELETE /api/lists/:id", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let agentToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
    agentToken = await mintToken("agent");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("deletes list and returns 204", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/lists/1",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it("returns 403 for agent", async () => {
    const res = await app.inject({
      method: "DELETE",
      url: "/api/lists/1",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/lists/:id/reset (sync path)", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let agentToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
    agentToken = await mintToken("agent");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("returns 200 sync result for small list (count=5 < 10000)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists/1/reset",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { mode: string };
    expect(body.mode).toBe("sync");
  });

  it("returns 403 for agent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists/1/reset",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/lists/:id/purge (sync path)", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let agentToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
    agentToken = await mintToken("agent");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("returns 200 sync result for small list", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists/1/purge",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { mode: string };
    expect(body.mode).toBe("sync");
  });

  it("returns 403 for agent", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists/1/purge",
      headers: { authorization: `Bearer ${agentToken}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("POST /api/lists/:id/clone", () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("returns 201 with new list", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists/1/clone",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Clone of Test" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { list: { name: string } };
    expect(body.list.name).toBe("Clone of Test");
  });

  it("returns 400 if name missing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists/1/clone",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /api/lists/:id/campaigns (link)", () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("links a campaign and returns 201", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/lists/1/campaigns",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ campaign_id: "camp-01" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body) as { campaign_id: string };
    expect(body.campaign_id).toBe("camp-01");
  });
});

describe("GET /api/lists/:id/campaigns", () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeEach(async () => {
    app = await buildApp();
    adminToken = await mintToken("admin");
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
    setPrismaForTests(null);
    setRedisForTests(null);
  });

  it("returns campaign assignments", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/lists/1/campaigns",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { data: unknown[] };
    expect(Array.isArray(body.data)).toBe(true);
  });
});
