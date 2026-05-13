// D07 — List stats computation with Valkey 5-minute cache.
//
// Performance target: ≤200ms p99 for lists ≤1M leads (cache hit ≤5ms).

import type { PrismaClient } from "@prisma/client";
import { getRedis } from "../lib/redis.js";

const CACHE_TTL_SECONDS = 300;
const COUNT_CAP = 1_000_000;

export interface ListStats {
  list_id: number;
  tenant_id: number;
  total: number;
  capped: boolean; // true when total was cut at COUNT_CAP
  by_status: Record<string, number>;
  recyclable: number;
  callable_now: number;
  cached_at: string;
  cache_ttl_seconds: number;
}

function cacheKey(tenantId: number, listId: number): string {
  return `list:stats:${tenantId}:${listId}`;
}

export function invalidateStatsCache(tenantId: number, listId: number): Promise<number> {
  const redis = getRedis();
  return redis.del(cacheKey(tenantId, listId));
}

export async function getListStats(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
  callableStatusCodes: string[],
  recycleDelaySeconds: number,
  maxAttempts: number,
): Promise<ListStats> {
  const redis = getRedis();
  const key = cacheKey(tenantId, listId);

  // Try cache first
  const cached = await redis.get(key);
  if (cached) {
    return JSON.parse(cached) as ListStats;
  }

  // Compute stats fresh (all raw SQL for performance)
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);

  // Per-status breakdown
  const byStatusRows = await prisma.$queryRaw<Array<{ status: string; cnt: bigint }>>`
    SELECT status, COUNT(*) AS cnt
    FROM leads
    WHERE tenant_id = ${tid}
      AND list_id = ${lid}
      AND deleted_at IS NULL
    GROUP BY status
    LIMIT 200
  `;

  const by_status: Record<string, number> = {};
  for (const row of byStatusRows) {
    by_status[row.status] = Number(row.cnt);
  }

  // Capped total (detect overflow past 1M)
  const countRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM leads
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
      LIMIT ${COUNT_CAP + 1}
    ) sub
  `;
  const rawTotal = Number(countRows[0]?.n ?? 0);
  const capped = rawTotal > COUNT_CAP;
  const finalTotal = capped ? COUNT_CAP : rawTotal;

  // Recyclable leads
  const recycleAt = new Date(Date.now() - recycleDelaySeconds * 1000);
  const recyclableRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM leads
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
        AND called_count < ${maxAttempts}
        AND (last_called_at IS NULL OR last_called_at < ${recycleAt})
      LIMIT ${COUNT_CAP + 1}
    ) sub
  `;
  const recyclable = Math.min(Number(recyclableRows[0]?.n ?? 0), COUNT_CAP);

  // Callable-now (status in callable set + recyclable condition)
  let callable_now = 0;
  if (callableStatusCodes.length > 0) {
    const callableRows = await prisma.$queryRaw<Array<{ n: bigint }>>`
      SELECT COUNT(*) AS n FROM (
        SELECT 1 FROM leads
        WHERE tenant_id = ${tid}
          AND list_id = ${lid}
          AND deleted_at IS NULL
          AND status IN (${callableStatusCodes.join(",")})
          AND called_count < ${maxAttempts}
          AND (last_called_at IS NULL OR last_called_at < ${recycleAt})
        LIMIT ${COUNT_CAP + 1}
      ) sub
    `;
    callable_now = Math.min(Number(callableRows[0]?.n ?? 0), COUNT_CAP);
  }

  const stats: ListStats = {
    list_id: listId,
    tenant_id: tenantId,
    total: finalTotal,
    capped,
    by_status,
    recyclable,
    callable_now,
    cached_at: new Date().toISOString(),
    cache_ttl_seconds: CACHE_TTL_SECONDS,
  };

  // Store in Valkey
  await redis.set(key, JSON.stringify(stats), "EX", CACHE_TTL_SECONDS);

  return stats;
}
