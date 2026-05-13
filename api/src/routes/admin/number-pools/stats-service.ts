// X04 — Pool-level aggregate stats service.

import { getPrisma } from "../../../lib/prisma.js";
import type { PoolStatsResponse } from "./schema.js";

// ---------------------------------------------------------------------------
// Pool aggregate stats
// ---------------------------------------------------------------------------

export async function getPoolStats(
  tenantId: number,
  poolId: bigint,
): Promise<PoolStatsResponse | null> {
  const db = getPrisma();

  // Verify pool exists
  const pool = await db.numberPool.findFirst({
    where: { id: poolId, tenantId: BigInt(tenantId) },
  });
  if (!pool) return null;

  const memberships = await db.numberPoolDid.findMany({
    where: { poolId, tenantId: BigInt(tenantId) },
    select: {
      quarantined: true,
      healthScore: true,
      callCount7d: true,
      answerCount7d: true,
    },
  });

  const totalDids = memberships.length;
  const activeDids = memberships.filter((m) => !m.quarantined).length;
  const quarantinedDids = totalDids - activeDids;

  const avgHealthScore =
    totalDids > 0
      ? memberships.reduce((sum, m) => sum + (m.healthScore ?? 0), 0) / totalDids
      : 0;

  const activeWithCalls = memberships.filter((m) => !m.quarantined && m.callCount7d > 0);
  const avgAnswerRate7d =
    activeWithCalls.length > 0
      ? activeWithCalls.reduce(
          (sum, m) => sum + m.answerCount7d / m.callCount7d,
          0,
        ) / activeWithCalls.length
      : 0;

  // Valkey live counters — Phase 3.5 stub (dialer sets these)
  const totalCallsToday = 0;
  const activeCallsNow = 0;

  return {
    poolId: String(poolId),
    totalDids,
    activeDids,
    quarantinedDids,
    avgHealthScore: Math.round(avgHealthScore),
    avgAnswerRate7d,
    totalCallsToday,
    activeCallsNow,
    belowMinActiveSize: activeDids < pool.minActiveSize,
  };
}
