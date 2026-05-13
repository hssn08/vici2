// D05 — Bypass token unit tests

import { describe, it, expect } from "vitest";
import RedisMock from "ioredis-mock";
import { mintBypassToken, redeemBypassToken } from "../../src/dnc/bypass.js";

function makeRedis() {
  return new RedisMock() as unknown as import("ioredis").Redis;
}

describe("mintBypassToken", () => {
  it("returns a token and expiresAt", async () => {
    const redis = makeRedis();
    const result = await mintBypassToken(redis, {
      tenantId: 1,
      phone: "+14155551212",
      source: "federal",
      userId: 99,
      justification: "returning inbound call for DNC listed number",
      ttlSeconds: 60,
    });
    expect(result.token).toBeTruthy();
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("caps TTL at 300 seconds", async () => {
    const redis = makeRedis();
    const before = Date.now();
    const result = await mintBypassToken(redis, {
      tenantId: 1,
      phone: "+14155551212",
      source: "internal",
      userId: 1,
      justification: "test justification long enough for the test",
      ttlSeconds: 9999, // over max
    });
    const ttl = result.expiresAt.getTime() - before;
    expect(ttl).toBeLessThanOrEqual(300_000 + 100); // 300s + 100ms tolerance
  });
});

describe("redeemBypassToken", () => {
  it("returns expired for nonexistent token", async () => {
    const redis = makeRedis();
    const result = await redeemBypassToken(redis, {
      tenantId: 1,
      token: "nonexistent-token-xyz",
      phone: "+14155551212",
      source: "federal",
      userId: 1,
      justification: "test",
    });
    expect(result).toBe("expired");
  });

  it("single-use: second redeem returns expired", async () => {
    const redis = makeRedis();
    const { token } = await mintBypassToken(redis, {
      tenantId: 1,
      phone: "+14155551212",
      source: "federal",
      userId: 5,
      justification: "returning inbound call from DNC number",
      ttlSeconds: 300,
    });

    const opts = {
      tenantId: 1,
      token,
      phone: "+14155551212",
      source: "federal" as const,
      userId: 5,
      justification: "returning inbound call from DNC number",
    };

    const first = await redeemBypassToken(redis, opts);
    expect(first).toBe("ok");

    const second = await redeemBypassToken(redis, opts);
    expect(second).toBe("expired");
  });

  it("returns mismatch for wrong justification", async () => {
    const redis = makeRedis();
    const { token } = await mintBypassToken(redis, {
      tenantId: 1,
      phone: "+14155551212",
      source: "federal",
      userId: 5,
      justification: "original justification for minting token",
      ttlSeconds: 300,
    });

    const result = await redeemBypassToken(redis, {
      tenantId: 1,
      token,
      phone: "+14155551212",
      source: "federal",
      userId: 5,
      justification: "tampered justification is different",
    });
    expect(result).toBe("mismatch");
  });
});
