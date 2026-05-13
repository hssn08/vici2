// M03 — Valkey cache wrapper for ops reports.
//
// Cache key: rpt:m03:<report>:<tenantId>:<paramsHash>
// TTL: 300 seconds (5 minutes)
//
// Uses the existing getRedis() singleton from lib/redis.ts.
// Serializes results as JSON strings.

import { createHash } from "node:crypto";
import { getRedis } from "../lib/redis.js";

const TTL_SECONDS = 300; // 5 minutes
const KEY_PREFIX = "rpt:m03";

export function buildCacheKey(
  report: "campaign-daily" | "agent-productivity" | "list-health",
  tenantId: bigint,
  params: Record<string, string | undefined>,
): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k] ?? ""}`)
    .join("&");
  const hash = createHash("sha256").update(sorted).digest("hex").slice(0, 12);
  return `${KEY_PREFIX}:${report}:${tenantId}:${hash}`;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const redis = getRedis();
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch {
    // Cache failures are non-fatal — fall through to DB query.
    return null;
  }
}

export async function cacheSet(key: string, value: unknown): Promise<void> {
  try {
    const redis = getRedis();
    await redis.set(key, JSON.stringify(value), "EX", TTL_SECONDS);
  } catch {
    // Cache failures are non-fatal.
  }
}

export async function cacheDel(key: string): Promise<void> {
  try {
    const redis = getRedis();
    await redis.del(key);
  } catch {
    // no-op
  }
}
