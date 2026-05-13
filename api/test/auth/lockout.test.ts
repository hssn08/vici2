import RedisMock from "ioredis-mock";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearLockout,
  getLockoutState,
  ladderForTests,
  recordFailure,
} from "../../src/auth/lockout.js";

type AnyRedis = InstanceType<typeof RedisMock>;

describe("lockout", () => {
  let redis: AnyRedis;
  beforeEach(() => {
    redis = new RedisMock();
  });
  afterEach(async () => {
    await redis.flushall();
  });

  it("locks after 5 consecutive failures", async () => {
    let st;
    for (let i = 0; i < 5; i++) {
      st = await recordFailure(redis as never, 1, "alice");
    }
    expect(st!.isLocked).toBe(true);
    expect(st!.lockedUntil).toBeGreaterThan(0);
  });

  it("backs off exponentially across multiple lock cycles", async () => {
    const ladder = ladderForTests();
    // First lock: 15m. Second lock (after expiry): 30m. Capped at 4h.
    let first;
    for (let i = 0; i < 5; i++) first = await recordFailure(redis as never, 1, "bob");
    expect(first!.level).toBe(1);

    // Manually expire lockout by clearing locked_until
    await redis.hset(`t:1:auth:lockout:bob`, "locked_until", "0");

    let second;
    for (let i = 0; i < 5; i++) second = await recordFailure(redis as never, 1, "bob");
    expect(second!.level).toBe(2);
    // 30 minutes for second lock
    expect(second!.lockedUntil).toBeGreaterThan(0);
    // ladder progression respected
    expect(ladder[0]).toBe(15 * 60);
    expect(ladder[1]).toBe(30 * 60);
  });

  it("lowercases username for keying", async () => {
    await recordFailure(redis as never, 1, "Alice");
    const st = await getLockoutState(redis as never, 1, "ALICE");
    expect(st.failCount).toBe(1);
  });

  it("clearLockout removes the key", async () => {
    await recordFailure(redis as never, 1, "charlie");
    await clearLockout(redis as never, 1, "charlie");
    const st = await getLockoutState(redis as never, 1, "charlie");
    expect(st.failCount).toBe(0);
    expect(st.isLocked).toBe(false);
  });

  it("resets fail_count after 15-minute window", async () => {
    await recordFailure(redis as never, 1, "dora");
    // Manually pretend the last failure was 1 hour ago
    await redis.hset(`t:1:auth:lockout:dora`, "last_fail_at", String(Math.floor(Date.now() / 1000) - 3600));
    const next = await recordFailure(redis as never, 1, "dora");
    expect(next.failCount).toBe(1);
  });
});
