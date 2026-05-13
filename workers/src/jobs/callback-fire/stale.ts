// D06 worker — stale-detection tick (every 5 min).
// Emits Prometheus metric + Valkey event for callbacks that have aged past the threshold.
// Phase 1: no auto-cancel. Phase 2: adds campaigns.callback_auto_dead_seconds.

import type { PrismaClient } from "@prisma/client";
import { callbackStaleTotal, getAgeBucket } from "./metrics.js";
import pino from "pino";

const logger = pino({ level: "info" });

const INSTANCE_ID = `d06-stale-${process.pid}`;
const DEFAULT_STALE_THRESHOLD_SECONDS = 14400; // 4 hours

export async function callbackStaleTick(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  tenantId: bigint,
): Promise<void> {
  const lockKey = `t:${tenantId}:cron:lock:callback_stale`;
  const locked = await redis.set(lockKey, INSTANCE_ID, "EX", 310, "NX");
  if (!locked) return;

  try {
    // Get per-campaign threshold (default 4h = 14400s)
    const campaign = await prisma.campaign.findFirst({
      where: { tenantId, active: true },
      select: { callbackStaleThresholdSeconds: true },
    });
    const thresholdSeconds = campaign?.callbackStaleThresholdSeconds ?? DEFAULT_STALE_THRESHOLD_SECONDS;
    const staleThreshold = new Date(Date.now() - thresholdSeconds * 1000);

    const stale = await prisma.callback.findMany({
      where: {
        tenantId,
        status: { in: ["LIVE", "PENDING"] },
        callbackAt: { lt: staleThreshold },
      },
      select: { id: true, userId: true, callbackAt: true },
    });

    for (const cb of stale) {
      const dedupKey = `t:${tenantId}:d06:stale_seen:${cb.id}`;
      const isNew = await redis.set(dedupKey, "1", "EX", 3600, "NX");
      if (!isNew) continue;

      const ageSeconds = Math.floor((Date.now() - cb.callbackAt.getTime()) / 1000);
      const ageBucket = getAgeBucket(ageSeconds);
      const scope = cb.userId != null ? "AGENT" : "GLOBAL";

      callbackStaleTotal.inc({ scope, age_bucket: ageBucket });

      try {
        await redis.xadd(
          "events:vici2.callback.callback_stale",
          "*",
          "payload",
          JSON.stringify({
            type: "callback_stale",
            tenantId: String(tenantId),
            callbackId: String(cb.id),
            age_seconds: ageSeconds,
            age_bucket: ageBucket,
            scope,
            ts: new Date().toISOString(),
          }),
        );
      } catch (err) {
        logger.error({ err, callbackId: String(cb.id) }, "d06:stale: event publish failed");
      }

      logger.warn({ callbackId: String(cb.id), ageSeconds, ageBucket, scope }, "d06:stale: callback is stale");
    }
  } finally {
    await redis.del(lockKey);
  }
}
