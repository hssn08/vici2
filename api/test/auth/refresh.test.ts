import RedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  consumeRefreshToken,
  issueRefreshToken,
  revokeAllForUser,
  revokeFamily,
  sha256Hex,
} from "../../src/auth/refresh.js";

type AnyRedis = InstanceType<typeof RedisMock>;

function makeRedis(): AnyRedis {
  return new RedisMock();
}

describe("refresh token store", () => {
  let redis: AnyRedis;
  beforeEach(() => {
    redis = makeRedis();
  });
  afterEach(async () => {
    await redis.flushall();
  });

  it("issues a refresh token persisted in valkey", async () => {
    const issued = await issueRefreshToken({
      redis: redis as never,
      tenantId: 1,
      userId: 7,
      role: "agent",
      ttlSec: 60,
    });
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(issued.familyId).toMatch(/^[0-9a-f-]{36}$/);
    expect(issued.tokenHash).toHaveLength(64);
    const stored = await redis.hgetall(
      `t:1:auth:refresh:${issued.familyId}:${issued.tokenHash}`,
    );
    expect(stored.user_id).toBe("7");
    expect(stored.role).toBe("agent");
  });

  it("consumes a valid token and reports OK", async () => {
    const issued = await issueRefreshToken({
      redis: redis as never,
      tenantId: 1,
      userId: 7,
      role: "agent",
      ttlSec: 60,
    });
    const res = await consumeRefreshToken(redis as never, 1, issued.familyId, issued.token, 7);
    expect(res.outcome).toBe("ok");
    expect(res.userId).toBe(7);
    expect(res.role).toBe("agent");
  });

  it("returns NOT_FOUND for missing token in unknown family", async () => {
    const res = await consumeRefreshToken(redis as never, 1, "00000000-0000-7000-8000-000000000000", "garbage", 7);
    expect(res.outcome).toBe("not_found");
  });

  it("detects reuse and revokes the family", async () => {
    const issued = await issueRefreshToken({
      redis: redis as never,
      tenantId: 1,
      userId: 7,
      role: "agent",
      ttlSec: 60,
    });
    const rotated = await issueRefreshToken({
      redis: redis as never,
      tenantId: 1,
      userId: 7,
      role: "agent",
      ttlSec: 60,
      familyId: issued.familyId,
      parentTokenHash: issued.tokenHash,
    });
    // Consume the FIRST (rotated-from) token a second time.
    const first = await consumeRefreshToken(
      redis as never,
      1,
      issued.familyId,
      issued.token,
      7,
    );
    expect(first.outcome).toBe("ok");
    const replay = await consumeRefreshToken(
      redis as never,
      1,
      issued.familyId,
      issued.token,
      7,
    );
    // Token was deleted by first consume; family still has the rotated child
    // member. Replay must trigger REUSE_DETECTED and nuke the family.
    expect(replay.outcome).toBe("reuse");
    expect(replay.familyId).toBe(issued.familyId);

    // After family revoke, attempts to use the rotated token also fail.
    const after = await consumeRefreshToken(
      redis as never,
      1,
      rotated.familyId,
      rotated.token,
      7,
    );
    expect(after.outcome).toBe("not_found");
  });

  it("revokeAllForUser clears every family", async () => {
    const a = await issueRefreshToken({
      redis: redis as never,
      tenantId: 1,
      userId: 9,
      role: "admin",
      ttlSec: 60,
    });
    const b = await issueRefreshToken({
      redis: redis as never,
      tenantId: 1,
      userId: 9,
      role: "admin",
      ttlSec: 60,
    });
    const revoked = await revokeAllForUser(redis as never, 1, 9);
    expect(revoked).toBeGreaterThanOrEqual(2);
    expect(
      (await consumeRefreshToken(redis as never, 1, a.familyId, a.token, 9)).outcome,
    ).toBe("not_found");
    expect(
      (await consumeRefreshToken(redis as never, 1, b.familyId, b.token, 9)).outcome,
    ).toBe("not_found");
  });

  it("revokeFamily targets a single family", async () => {
    const t = await issueRefreshToken({
      redis: redis as never,
      tenantId: 1,
      userId: 3,
      role: "agent",
      ttlSec: 60,
    });
    await revokeFamily(redis as never, 1, t.familyId, 3);
    const res = await consumeRefreshToken(redis as never, 1, t.familyId, t.token, 3);
    expect(res.outcome).toBe("not_found");
  });

  it("token_hash is sha256 of the cleartext token", async () => {
    const t = await issueRefreshToken({
      redis: redis as never,
      tenantId: 1,
      userId: 11,
      role: "agent",
      ttlSec: 60,
    });
    expect(t.tokenHash).toBe(sha256Hex(t.token));
  });
});
