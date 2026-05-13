// X04 — Number pool quarantine reaper + health score updater.
//
// Runs every hour (0 * * * * UTC) via BullMQ repeatable job.
// For each non-quarantined pool DID membership it:
//   1. Checks answer-rate (7d) against pool.ar_floor.
//   2. Checks short-call rate (30d) as a complaint proxy against pool.cr_ceil.
//   3. Computes a [0,100] health score.
//   4. Quarantines or updates the health score in DB.
// Also checks each pool for below-min-active-size and emits Prometheus gauge.

import { reaperQuarantined, reaperBelowMin } from './metrics.js';

type QuarantineReason = 'low_answer_rate' | 'high_complaint_rate' | 'manual' | 'label_detected';

// ---------------------------------------------------------------------------
// Health score computation
// ---------------------------------------------------------------------------

export function computeHealthScore(
  ar: number | null,
  cr: number | null,
  attest: string,
): number {
  const arScore = ar !== null ? Math.min(ar / 0.25, 1.0) : 0.5;
  const crScore = cr !== null ? Math.max(1.0 - cr / 0.05, 0) : 0.8;
  const attestBonus: Record<string, number> = { A: 1.0, B: 0.7, C: 0.3, unknown: 0.5 };
  const ab = attestBonus[attest] ?? 0.5;
  const composite = 0.40 * arScore + 0.25 * crScore + 0.35 * ab;
  return Math.round(composite * 100);
}

// ---------------------------------------------------------------------------
// Quarantine a membership row
// ---------------------------------------------------------------------------

async function quarantineMembership(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  membershipId: bigint,
  reason: QuarantineReason,
  meta: Record<string, unknown>,
  now: Date,
): Promise<void> {
  await db.numberPoolDid.update({
    where: { id: membershipId },
    data: {
      quarantined: true,
      quarantinedAt: now,
      quarantineReason: reason,
      quarantineMeta: meta,
      updatedAt: now,
    },
  });
}

// ---------------------------------------------------------------------------
// Check pool sizes and emit gauge
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function checkPoolSizes(db: any, _now: Date): Promise<void> {
  const pools = await db.numberPool.findMany({
    where: { active: true },
    select: { id: true, minActiveSize: true, tenantId: true },
  });

  let belowMin = 0;
  for (const pool of pools) {
    const activeCount = await db.numberPoolDid.count({
      where: { poolId: pool.id, quarantined: false },
    });
    if (activeCount < pool.minActiveSize) {
      belowMin++;
    }
  }

  reaperBelowMin.set(belowMin);
}

// ---------------------------------------------------------------------------
// Prune stale 7d counters for memberships unused in 8+ days
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function pruneStaleCounters(db: any, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - 8 * 24 * 3600 * 1000);
  await db.numberPoolDid.updateMany({
    where: {
      lastUsedAt: { lt: cutoff },
      callCount7d: { gt: 0 },
    },
    data: {
      callCount7d: 0,
      answerCount7d: 0,
    },
  });
}

// ---------------------------------------------------------------------------
// Main reaper entry point
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function runReaper(db: any, now: Date): Promise<void> {
  // 1. Load all active pool memberships that are not yet quarantined
  const memberships = await db.numberPoolDid.findMany({
    where: { quarantined: false },
    include: {
      pool: {
        select: {
          arMinSample: true,
          arFloor: true,
          crMinSample: true,
          crCeil: true,
        },
      },
    },
  });

  for (const m of memberships) {
    const pool = m.pool;

    const arSample: number = m.callCount7d ?? 0;
    const ar: number | null = arSample > 0 ? (m.answerCount7d ?? 0) / arSample : null;

    const crSample: number = m.callCount30d ?? 0;
    const cr: number | null = crSample > 0 ? (m.shortCallCount30d ?? 0) / crSample : null;

    let shouldQuarantine = false;
    let reason: QuarantineReason = 'manual';
    let meta: Record<string, unknown> = {};

    // AR check
    const arFloor = typeof pool.arFloor === 'object' ? parseFloat(pool.arFloor.toString()) : Number(pool.arFloor);
    const crCeil = typeof pool.crCeil === 'object' ? parseFloat(pool.crCeil.toString()) : Number(pool.crCeil);

    if (ar !== null && arSample >= pool.arMinSample && ar < arFloor) {
      shouldQuarantine = true;
      reason = 'low_answer_rate';
      meta = { ar, sample: arSample, floor: arFloor };
    }

    // CR check (only if not already quarantining for AR)
    if (!shouldQuarantine && cr !== null && crSample >= pool.crMinSample && cr > crCeil) {
      shouldQuarantine = true;
      reason = 'high_complaint_rate';
      meta = { cr, sample: crSample, ceil: crCeil };
    }

    // Compute health score
    const healthScore = computeHealthScore(ar, cr, m.attestLevel ?? 'unknown');

    if (shouldQuarantine) {
      await quarantineMembership(db, m.id, reason, meta, now);
      reaperQuarantined.inc();
    } else {
      // Update health score only
      await db.numberPoolDid.update({
        where: { id: m.id },
        data: { healthScore, updatedAt: now },
      });
    }
  }

  // 2. Check pool sizes and update gauge
  await checkPoolSizes(db, now);

  // 3. Prune stale 7d counters
  await pruneStaleCounters(db, now);
}
