// JWKS + ws-token + TOTP enroll/verify integration.

import Fastify, { type FastifyInstance } from "fastify";
import RedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerKeyPairForTests,
  resetJwtForTests,
  signAccessToken,
  verifyAccessToken,
} from "../../src/auth/jwt.js";
import { registerAuthDecorators } from "../../src/auth/middleware.js";
import { generateOtpForTests } from "../../src/auth/totp.js";
import { registerJwksRoute } from "../../src/routes/auth/jwks.js";
import { registerWsTokenRoute } from "../../src/routes/auth/ws-token.js";
import { registerTotpRoutes } from "../../src/routes/auth/totp.js";
import { setPrismaForTests } from "../../src/lib/prisma.js";
import { setRedisForTests } from "../../src/lib/redis.js";

describe("auth routes — misc", () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetJwtForTests();
    await registerKeyPairForTests("ed25519-misc");
    setRedisForTests(new RedisMock({ data: {} }) as never);
    setPrismaForTests({
      user: {
        findUnique: vi.fn(async () => ({
          id: 1n,
          tenantId: 1n,
          username: "alice",
          email: null,
          fullName: null,
          passwordHash: "",
          role: "agent",
          active: true,
          totpRequired: false,
          lastLoginAt: null,
        })),
      },
      auditLog: { create: vi.fn(async () => undefined) },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    app = Fastify();
    await registerAuthDecorators(app);
    registerJwksRoute(app);
    registerWsTokenRoute(app);
    registerTotpRoutes(app);
  });
  afterEach(async () => {
    await app.close();
    setRedisForTests(null);
    setPrismaForTests(null);
    resetJwtForTests();
  });

  it("GET /auth/.well-known/jwks.json publishes only public keys", async () => {
    const res = await app.inject({ method: "GET", url: "/auth/.well-known/jwks.json" });
    expect(res.statusCode).toBe(200);
    const jwks = res.json();
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBe(1);
    expect(jwks.keys[0].d).toBeUndefined();
    expect(res.headers["cache-control"]).toContain("max-age=300");
  });

  it("POST /auth/ws-token mints an aud=ws JWT from a valid api token", async () => {
    const apiTok = await signAccessToken({
      uid: 5,
      tenantId: 1,
      role: "agent",
      perms: ["call:dial"],
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    const res = await app.inject({
      method: "POST",
      url: "/auth/ws-token",
      headers: { authorization: `Bearer ${apiTok.token}` },
    });
    expect(res.statusCode).toBe(200);
    const wsTok = res.json().ws_token;
    const claims = await verifyAccessToken(wsTok, { expectedAud: "ws" });
    expect(claims.aud).toBe("ws");
    expect(claims.uid).toBe(5);
  });

  it("rejects ws-token mint when called without auth", async () => {
    const res = await app.inject({ method: "POST", url: "/auth/ws-token" });
    expect(res.statusCode).toBe(401);
  });

  it("POST /api/auth/totp/enroll returns a secret + uri", async () => {
    const apiTok = await signAccessToken({
      uid: 1,
      tenantId: 1,
      role: "agent",
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/totp/enroll",
      headers: { authorization: `Bearer ${apiTok.token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().secret).toBeTruthy();
    expect(res.json().otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
    expect(Array.isArray(res.json().backup_codes)).toBe(true);
  });

  it("POST /api/auth/totp/verify accepts a valid code", async () => {
    const apiTok = await signAccessToken({
      uid: 1,
      tenantId: 1,
      role: "agent",
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    const enrollRes = await app.inject({
      method: "POST",
      url: "/api/auth/totp/enroll",
      headers: { authorization: `Bearer ${apiTok.token}` },
      payload: {},
    });
    const secret = enrollRes.json().secret;
    const code = generateOtpForTests(secret);
    const verify = await app.inject({
      method: "POST",
      url: "/api/auth/totp/verify",
      headers: { authorization: `Bearer ${apiTok.token}` },
      payload: { secret, code },
    });
    expect(verify.statusCode).toBe(200);
    expect(verify.json().verified).toBe(true);
  });

  it("POST /api/auth/totp/verify rejects wrong code", async () => {
    const apiTok = await signAccessToken({
      uid: 1,
      tenantId: 1,
      role: "agent",
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/totp/verify",
      headers: { authorization: `Bearer ${apiTok.token}` },
      payload: { secret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", code: "000000" },
    });
    expect(res.statusCode).toBe(401);
  });
});
