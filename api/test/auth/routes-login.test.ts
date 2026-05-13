// Integration test for /api/auth/login + /api/auth/refresh + /api/auth/logout
// using ioredis-mock + a stub Prisma client. Verifies the HTTP contract.

import Fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { hashPassword } from "../../src/auth/argon2.js";
import {
  registerKeyPairForTests,
  resetJwtForTests,
  verifyAccessToken,
} from "../../src/auth/jwt.js";
import { registerLoginRoute } from "../../src/routes/auth/login.js";
import { registerRefreshRoute } from "../../src/routes/auth/refresh.js";
import { registerLogoutRoutes } from "../../src/routes/auth/logout.js";
import { registerMeRoute } from "../../src/routes/auth/me.js";
import { registerAuthDecorators } from "../../src/auth/middleware.js";
import { setRedisForTests } from "../../src/lib/redis.js";
import { setPrismaForTests } from "../../src/lib/prisma.js";

interface StubUser {
  id: bigint;
  tenantId: bigint;
  username: string;
  email: string | null;
  fullName: string | null;
  passwordHash: string;
  role: string;
  active: boolean;
  totpRequired: boolean;
  lastLoginAt: Date | null;
}

function buildStubPrisma(users: StubUser[]): unknown {
  const auditWrites: unknown[] = [];
  const updates: { id: bigint; data: Record<string, unknown> }[] = [];

  return {
    user: {
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if (where.id !== undefined) {
          return users.find((u) => u.id === (where.id as bigint)) ?? null;
        }
        const k = where.tenantId_username as
          | { tenantId: bigint; username: string }
          | undefined;
        if (k) {
          return users.find((u) => u.tenantId === k.tenantId && u.username === k.username) ?? null;
        }
        return null;
      }),
      update: vi.fn(async ({ where, data }: { where: { id: bigint }; data: Record<string, unknown> }) => {
        const u = users.find((x) => x.id === where.id);
        if (u) Object.assign(u, data);
        updates.push({ id: where.id, data });
        return u;
      }),
    },
    auditLog: {
      create: vi.fn(async ({ data }: { data: unknown }) => {
        auditWrites.push(data);
        return data;
      }),
    },
    sipCredential: {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1n, ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 1n, ...data })),
    },
    _audit: auditWrites,
    _updates: updates,
  };
}

describe("auth routes — login/refresh/logout/me", () => {
  let app: FastifyInstance;
  let redis: InstanceType<typeof RedisMock>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  let users: StubUser[];

  beforeEach(async () => {
    resetJwtForTests();
    await registerKeyPairForTests("ed25519-int-test");
    redis = new RedisMock({ data: {} });
    await redis.flushall();
    setRedisForTests(redis as never);

    const pwHash = await hashPassword("CorrectHorseBatteryStaple1!");
    users = [
      {
        id: 1n,
        tenantId: 1n,
        username: "alice",
        email: "alice@example.com",
        fullName: "Alice",
        passwordHash: pwHash,
        role: "agent",
        active: true,
        totpRequired: false,
        lastLoginAt: null,
      },
    ];
    prisma = buildStubPrisma(users);
    setPrismaForTests(prisma);

    app = Fastify();
    await registerAuthDecorators(app);
    registerLoginRoute(app);
    registerRefreshRoute(app);
    registerLogoutRoutes(app);
    registerMeRoute(app);
  });

  afterEach(async () => {
    await app.close();
    setRedisForTests(null);
    setPrismaForTests(null);
    resetJwtForTests();
  });

  it("logs in with valid credentials and returns access + refresh", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "CorrectHorseBatteryStaple1!" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    expect(body.family_id).toBeTruthy();
    expect(body.user.username).toBe("alice");
    const claims = await verifyAccessToken(body.access_token, { expectedAud: "api" });
    expect(claims.uid).toBe(1);
    expect(claims.role).toBe("agent");
  });

  it("rejects wrong password and audits failure", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "wrong" },
    });
    expect(res.statusCode).toBe(401);
    expect(prisma._audit.length).toBeGreaterThan(0);
  });

  it("rejects unknown user", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "ghost", password: "whatever1234567" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("locks the account after 5 failures", async () => {
    for (let i = 0; i < 5; i++) {
      await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "alice", password: "wrong" },
      });
    }
    const last = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "CorrectHorseBatteryStaple1!" },
    });
    expect(last.statusCode).toBe(429);
  });

  it("rotates refresh token and rejects reuse", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "CorrectHorseBatteryStaple1!" },
    });
    const { refresh_token, family_id } = login.json();

    const rot = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh_token, family_id },
    });
    expect(rot.statusCode).toBe(200);
    const rotated = rot.json();
    expect(rotated.refresh_token).not.toBe(refresh_token);
    expect(rotated.family_id).toBe(family_id);

    const replay = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh_token, family_id },
    });
    expect(replay.statusCode).toBe(401);
    expect(replay.json().error).toBe("refresh_reuse_detected");
  });

  it("/api/auth/me returns the authed user", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "CorrectHorseBatteryStaple1!" },
    });
    const access = login.json().access_token;
    const me = await app.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: { authorization: `Bearer ${access}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().username).toBe("alice");
  });

  it("logout revokes the family", async () => {
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "CorrectHorseBatteryStaple1!" },
    });
    const { access_token, refresh_token, family_id } = login.json();
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: { authorization: `Bearer ${access_token}` },
      payload: { family_id },
    });
    expect(out.statusCode).toBe(204);
    const ref = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh_token, family_id },
    });
    expect(ref.statusCode).toBe(401);
  });

  it("logout-all revokes every family for the user", async () => {
    const a = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "CorrectHorseBatteryStaple1!" },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "alice", password: "CorrectHorseBatteryStaple1!" },
    });
    const out = await app.inject({
      method: "POST",
      url: "/api/auth/logout-all",
      headers: { authorization: `Bearer ${a.json().access_token}` },
    });
    expect(out.statusCode).toBe(204);
    const r1 = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh_token: a.json().refresh_token, family_id: a.json().family_id },
    });
    const r2 = await app.inject({
      method: "POST",
      url: "/api/auth/refresh",
      payload: { refresh_token: b.json().refresh_token, family_id: b.json().family_id },
    });
    expect(r1.statusCode).toBe(401);
    expect(r2.statusCode).toBe(401);
  });
});
