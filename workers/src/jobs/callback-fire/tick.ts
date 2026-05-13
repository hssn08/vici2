// D06 worker — main tick algorithm (every 30 s).
//
// Per tenant:
//   1. Valkey SET NX EX 60 advisory lock.
//   2. Query PENDING callbacks due within [now, now + grace_window].
//   3. For each: TCPA gate → promote or defer.
//   4. Release lock.

import type { PrismaClient } from "@prisma/client";
import { promoteCallback } from "./promote.js";
import { deferCallback } from "./defer.js";
import {
  callbackFiredTotal,
  callbackDeferredTotal,
  workerTickDuration,
  workerTickPromoted,
  workerTickSkippedTotal,
} from "./metrics.js";
import pino from "pino";

const logger = pino({ level: "info" });

const INSTANCE_ID = `d06-worker-${process.pid}-${Date.now()}`;

export interface TickResult {
  skipped?: boolean;
  reason?: string;
  fired?: number;
  deferred?: number;
  errors?: number;
}

// Phase-1 TCPA stub — C01 will replace with real gate
interface TcpaResult {
  outcome: "ALLOW" | "SKIP_UNTIL" | "BLOCK_INVALID";
  nextOpen?: Date;
  reason?: string;
}

async function checkTcpaAtFireTime(_leadTzIana: string | null, _when: Date): Promise<TcpaResult> {
  // Phase 1: always ALLOW. C01 IMPLEMENT wires `callback_fire` enforcement point.
  return { outcome: "ALLOW" };
}

export async function callbackFireTick(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  tenantId: bigint,
): Promise<TickResult> {
  const lockKey = `t:${tenantId}:cron:lock:callback_fire`;
  const end = workerTickDuration.startTimer();

  // Advisory lock: SET NX EX 60
  const locked = await redis.set(lockKey, INSTANCE_ID, "EX", 60, "NX");
  if (!locked) {
    workerTickSkippedTotal.inc({ reason: "lock_contention" });
    return { skipped: true, reason: "lock_contention" };
  }

  try {
    // Get campaign grace window (default 30s) — use minimum across campaigns for safety
    // Phase 1: read from first campaign or use default
    const campaignSettings = await prisma.campaign.findFirst({
      where: { tenantId, active: true },
      select: { callbackGraceWindowSeconds: true },
    });
    const graceWindowSeconds = campaignSettings?.callbackGraceWindowSeconds ?? 30;

    const dueBy = new Date(Date.now() + graceWindowSeconds * 1000);

    const due = await prisma.callback.findMany({
      where: {
        tenantId,
        status: "PENDING",
        callbackAt: { lte: dueBy },
      },
      orderBy: { callbackAt: "asc" },
      take: 500,
      include: {
        lead: { select: { id: true, knownTimezone: true } },
      },
    });

    if (due.length === 0) {
      workerTickSkippedTotal.inc({ reason: "empty" });
      return { skipped: true, reason: "empty" };
    }

    let fired = 0, deferred = 0, errors = 0;

    for (const cb of due) {
      const tcpa = await checkTcpaAtFireTime(cb.lead?.knownTimezone ?? null, new Date());

      if (tcpa.outcome === "ALLOW" || tcpa.outcome === "BLOCK_INVALID") {
        const warning = tcpa.outcome === "BLOCK_INVALID" ? tcpa.reason : undefined;
        const result = await promoteCallback(prisma, redis, {
          id: cb.id,
          tenantId: cb.tenantId,
          leadId: cb.leadId,
          campaignId: cb.campaignId,
          userId: cb.userId,
          callbackAt: cb.callbackAt,
          status: cb.status,
          comments: cb.comments,
        }, warning);

        if (result.promoted) {
          fired++;
          const scope = cb.userId != null ? "AGENT" : "GLOBAL";
          callbackFiredTotal.inc({ scope, tcpa_outcome: tcpa.outcome });
          workerTickPromoted.inc({ outcome: "fired" });
        } else if (result.reason === "transaction_error") {
          errors++;
          workerTickPromoted.inc({ outcome: "error" });
        }
        // already_live = skipped silently (idempotent)
      } else if (tcpa.outcome === "SKIP_UNTIL" && tcpa.nextOpen) {
        await deferCallback(prisma, redis, cb.id, cb.tenantId, cb.leadId, cb.userId, tcpa.nextOpen);
        deferred++;
        callbackDeferredTotal.inc({ reason: "tcpa_skip_until" });
        workerTickPromoted.inc({ outcome: "deferred" });
      }
    }

    logger.info({ tenantId: String(tenantId), fired, deferred, errors }, "d06:tick: completed");
    return { fired, deferred, errors };
  } catch (err) {
    logger.error({ err, tenantId: String(tenantId) }, "d06:tick: fatal error");
    return { fired: 0, deferred: 0, errors: 1 };
  } finally {
    await redis.del(lockKey);
    end();
  }
}
