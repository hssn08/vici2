// Failed-login lockout state. Valkey-backed; PLAN §3.5.
//
// Key: t:{tid}:auth:lockout:{username_lower}  HASH
//   fail_count, last_fail_at, locked_until, level
//
// Back-off ladder: 15m → 30m → 60m → 2h → 4h (cap).

import { Redis } from "ioredis";

const LADDER_SEC = [15 * 60, 30 * 60, 60 * 60, 2 * 3600, 4 * 3600];
const WINDOW_SEC = 15 * 60;
const FAIL_THRESHOLD = 5;

export interface LockoutState {
  failCount: number;
  lockedUntil: number;
  level: number;
  isLocked: boolean;
}

function key(tenantId: number, username: string): string {
  return `t:${tenantId}:auth:lockout:${username.toLowerCase()}`;
}

export async function getLockoutState(
  redis: Redis,
  tenantId: number,
  username: string,
): Promise<LockoutState> {
  const h = await redis.hgetall(key(tenantId, username));
  const failCount = Number(h.fail_count ?? 0);
  const lockedUntil = Number(h.locked_until ?? 0);
  const level = Number(h.level ?? 0);
  const now = Math.floor(Date.now() / 1000);
  return {
    failCount,
    lockedUntil,
    level,
    isLocked: lockedUntil > now,
  };
}

export async function recordFailure(
  redis: Redis,
  tenantId: number,
  username: string,
): Promise<LockoutState> {
  const k = key(tenantId, username);
  const now = Math.floor(Date.now() / 1000);
  const cur = await redis.hgetall(k);
  let failCount = Number(cur.fail_count ?? 0) + 1;
  let level = Number(cur.level ?? 0);
  const lastFail = Number(cur.last_fail_at ?? 0);
  if (lastFail && now - lastFail > WINDOW_SEC) {
    failCount = 1;
  }
  let lockedUntil = Number(cur.locked_until ?? 0);
  if (failCount >= FAIL_THRESHOLD) {
    const cooldown = LADDER_SEC[Math.min(level, LADDER_SEC.length - 1)] ?? LADDER_SEC[LADDER_SEC.length - 1]!;
    lockedUntil = now + cooldown;
    level = Math.min(level + 1, LADDER_SEC.length);
    failCount = 0;
  }
  await redis.hset(k, {
    fail_count: String(failCount),
    last_fail_at: String(now),
    locked_until: String(lockedUntil),
    level: String(level),
  });
  await redis.expire(k, 24 * 3600);
  return {
    failCount,
    lockedUntil,
    level,
    isLocked: lockedUntil > now,
  };
}

export async function clearLockout(
  redis: Redis,
  tenantId: number,
  username: string,
): Promise<void> {
  await redis.del(key(tenantId, username));
}

export function ladderForTests(): number[] {
  return [...LADDER_SEC];
}
