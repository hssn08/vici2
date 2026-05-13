import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getActiveKid,
  publicJwks,
  registerKeyPairForTests,
  resetJwtForTests,
  signAccessToken,
  verifyAccessToken,
} from "../../src/auth/jwt.js";

describe("jwt", () => {
  beforeEach(async () => {
    resetJwtForTests();
    await registerKeyPairForTests("ed25519-test-1");
  });
  afterEach(() => {
    resetJwtForTests();
  });

  it("signs and verifies an access token", async () => {
    const signed = await signAccessToken({
      uid: 42,
      tenantId: 1,
      role: "agent",
      perms: ["call:dial"],
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    const claims = await verifyAccessToken(signed.token, { expectedAud: "api" });
    expect(claims.uid).toBe(42);
    expect(claims.tenant_id).toBe(1);
    expect(claims.role).toBe("agent");
    expect(claims.aud).toBe("api");
    expect(claims.totp_verified).toBe(true);
  });

  it("rejects token with wrong audience", async () => {
    const signed = await signAccessToken({
      uid: 1,
      tenantId: 1,
      role: "agent",
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    await expect(
      verifyAccessToken(signed.token, { expectedAud: "ws" }),
    ).rejects.toThrow();
  });

  it("rejects tampered token", async () => {
    const signed = await signAccessToken({
      uid: 1,
      tenantId: 1,
      role: "agent",
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    const tampered = signed.token.slice(0, -4) + "AAAA";
    await expect(
      verifyAccessToken(tampered, { expectedAud: "api" }),
    ).rejects.toThrow();
  });

  it("rejects unknown kid", async () => {
    const signed = await signAccessToken({
      uid: 1,
      tenantId: 1,
      role: "agent",
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    resetJwtForTests();
    await registerKeyPairForTests("ed25519-different");
    await expect(
      verifyAccessToken(signed.token, { expectedAud: "api" }),
    ).rejects.toThrow();
  });

  it("rejects expired token", async () => {
    const signed = await signAccessToken({
      uid: 1,
      tenantId: 1,
      role: "agent",
      totpVerified: true,
      aud: "api",
      ttlSec: -1,
    });
    await expect(
      verifyAccessToken(signed.token, { expectedAud: "api", clockToleranceSec: 0 }),
    ).rejects.toThrow();
  });

  it("publishes only public keys via jwks", () => {
    const jwks = publicJwks();
    expect(jwks.keys.length).toBe(1);
    const k = jwks.keys[0] as Record<string, unknown>;
    expect(k.kid).toBe("ed25519-test-1");
    // Public Ed25519 JWK has only x (no d / private). 'd' is the private scalar.
    expect(k.d).toBeUndefined();
  });

  it("reports active kid", () => {
    expect(getActiveKid()).toBe("ed25519-test-1");
  });

  it("verifies token signed by old kid after key rotation", async () => {
    const old = await signAccessToken({
      uid: 9,
      tenantId: 1,
      role: "admin",
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    await registerKeyPairForTests("ed25519-test-2");
    const fresh = await signAccessToken({
      uid: 9,
      tenantId: 1,
      role: "admin",
      totpVerified: true,
      aud: "api",
      ttlSec: 60,
    });
    expect(getActiveKid()).toBe("ed25519-test-2");
    const claimsOld = await verifyAccessToken(old.token, { expectedAud: "api" });
    const claimsNew = await verifyAccessToken(fresh.token, { expectedAud: "api" });
    expect(claimsOld.uid).toBe(9);
    expect(claimsNew.uid).toBe(9);
  });
});
