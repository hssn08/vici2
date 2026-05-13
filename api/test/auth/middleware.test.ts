import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  registerKeyPairForTests,
  resetJwtForTests,
  signAccessToken,
} from "../../src/auth/jwt.js";
import { registerAuthDecorators } from "../../src/auth/middleware.js";

describe("middleware", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    resetJwtForTests();
    await registerKeyPairForTests("ed25519-mw-test");
    app = Fastify();
    await registerAuthDecorators(app);
  });

  afterEach(async () => {
    await app.close();
    resetJwtForTests();
  });

  async function makeToken(opts: {
    uid?: number;
    tenantId?: number;
    role?: "agent" | "supervisor" | "admin" | "super_admin" | "integrator";
    aud?: "api" | "ws";
    perms?: string[];
    totpVerified?: boolean;
    ttl?: number;
  }): Promise<string> {
    const r = await signAccessToken({
      uid: opts.uid ?? 1,
      tenantId: opts.tenantId ?? 1,
      role: (opts.role ?? "agent") as never,
      perms: (opts.perms ?? []) as never,
      totpVerified: opts.totpVerified ?? true,
      aud: opts.aud ?? "api",
      ttlSec: opts.ttl ?? 60,
    });
    return r.token;
  }

  it("requireAuth attaches req.auth", async () => {
    app.get("/p", { preHandler: app.requireAuth }, async (req, reply) => {
      return reply.send({ uid: req.auth!.uid, tenant: req.auth!.tenantId });
    });
    const tok = await makeToken({ uid: 42 });
    const res = await app.inject({
      method: "GET",
      url: "/p",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ uid: 42, tenant: 1 });
  });

  it("requireAuth rejects without Authorization header", async () => {
    app.get("/p", { preHandler: app.requireAuth }, async () => ({ ok: true }));
    const res = await app.inject({ method: "GET", url: "/p" });
    expect(res.statusCode).toBe(401);
  });

  it("requireRole enforces hierarchy (admin admits super_admin)", async () => {
    app.get(
      "/admin",
      { preHandler: [app.requireAuth, app.requireRole("admin")] },
      async () => ({ ok: true }),
    );
    const agentTok = await makeToken({ role: "agent" });
    const superTok = await makeToken({ role: "super_admin" });
    expect(
      (await app.inject({
        method: "GET",
        url: "/admin",
        headers: { authorization: `Bearer ${agentTok}` },
      })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({
        method: "GET",
        url: "/admin",
        headers: { authorization: `Bearer ${superTok}` },
      })).statusCode,
    ).toBe(200);
  });

  it("requirePermission accepts permission from role default set", async () => {
    app.get(
      "/dial",
      { preHandler: [app.requireAuth, app.requirePermission("call:dial")] },
      async () => ({ ok: true }),
    );
    const tok = await makeToken({ role: "agent" });
    const res = await app.inject({
      method: "GET",
      url: "/dial",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("requirePermission rejects when role lacks the verb", async () => {
    app.get(
      "/bypass",
      { preHandler: [app.requireAuth, app.requirePermission("dnc:bypass")] },
      async () => ({ ok: true }),
    );
    const tok = await makeToken({ role: "admin", perms: [] });
    const res = await app.inject({
      method: "GET",
      url: "/bypass",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("requireTenant rejects cross-tenant access", async () => {
    app.post(
      "/t/:tenant_id/op",
      { preHandler: [app.requireAuth, app.requireTenant()] },
      async () => ({ ok: true }),
    );
    const tok = await makeToken({ tenantId: 1 });
    const ok = await app.inject({
      method: "POST",
      url: "/t/1/op",
      headers: { authorization: `Bearer ${tok}` },
      payload: {},
    });
    expect(ok.statusCode).toBe(200);
    const cross = await app.inject({
      method: "POST",
      url: "/t/2/op",
      headers: { authorization: `Bearer ${tok}` },
      payload: {},
    });
    expect(cross.statusCode).toBe(403);
  });

  it("requireOwn blocks non-owner agent but admin bypasses", async () => {
    app.get(
      "/u/:userId",
      {
        preHandler: [
          app.requireAuth,
          app.requireOwn((req) => (req.params as Record<string, string>).userId),
        ],
      },
      async () => ({ ok: true }),
    );
    const agentTok = await makeToken({ uid: 5, role: "agent" });
    const adminTok = await makeToken({ uid: 99, role: "admin" });
    expect(
      (await app.inject({
        method: "GET",
        url: "/u/5",
        headers: { authorization: `Bearer ${agentTok}` },
      })).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({
        method: "GET",
        url: "/u/6",
        headers: { authorization: `Bearer ${agentTok}` },
      })).statusCode,
    ).toBe(403);
    expect(
      (await app.inject({
        method: "GET",
        url: "/u/5",
        headers: { authorization: `Bearer ${adminTok}` },
      })).statusCode,
    ).toBe(200);
  });

  it("requireWsToken rejects an api-audience token", async () => {
    app.get("/ws", { preHandler: app.requireWsToken }, async () => ({ ok: true }));
    const apiTok = await makeToken({ aud: "api" });
    const res = await app.inject({
      method: "GET",
      url: "/ws",
      headers: { authorization: `Bearer ${apiTok}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("requireWsToken accepts ws-audience token", async () => {
    app.get("/ws", { preHandler: app.requireWsToken }, async () => ({ ok: true }));
    const wsTok = await makeToken({ aud: "ws" });
    const res = await app.inject({
      method: "GET",
      url: "/ws",
      headers: { authorization: `Bearer ${wsTok}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it("requireTotp rejects when totp_verified is false", async () => {
    app.get(
      "/secret",
      { preHandler: [app.requireAuth, app.requireTotp] },
      async () => ({ ok: true }),
    );
    const tok = await makeToken({ totpVerified: false });
    const res = await app.inject({
      method: "GET",
      url: "/secret",
      headers: { authorization: `Bearer ${tok}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
