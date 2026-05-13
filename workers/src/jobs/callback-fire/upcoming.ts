// D06 worker — pre-due heads-up tick (every 60 s).
// Notifies AGENT-scoped agents 4-5 minutes before callback_at.

import type { PrismaClient } from "@prisma/client";
import pino from "pino";

const logger = pino({ level: "info" });

const INSTANCE_ID = `d06-upcoming-${process.pid}`;

export async function callbackUpcomingTick(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  tenantId: bigint,
): Promise<void> {
  const lockKey = `t:${tenantId}:cron:lock:callback_upcoming`;
  const locked = await redis.set(lockKey, INSTANCE_ID, "EX", 65, "NX");
  if (!locked) return;

  try {
    const now = new Date();
    const fourMin = new Date(now.getTime() + 4 * 60 * 1000);
    const fiveMin = new Date(now.getTime() + 5 * 60 * 1000);

    const upcoming = await prisma.callback.findMany({
      where: {
        tenantId,
        status: "PENDING",
        userId: { not: null },
        callbackAt: { gte: fourMin, lte: fiveMin },
      },
      select: { id: true, userId: true, leadId: true, campaignId: true, callbackAt: true, comments: true },
    });

    for (const cb of upcoming) {
      if (!cb.userId) continue;

      // Dedup: skip if already notified in this 5-min window
      const dedupKey = `t:${tenantId}:d06:upcoming_seen:${cb.id}`;
      const alreadySeen = await redis.set(dedupKey, "1", "EX", 5 * 60, "NX");
      if (!alreadySeen) continue;

      // Check if agent is online
      const agentStatus = await redis.get(`t:${tenantId}:agent:status:${cb.userId}`);
      if (!["READY", "PAUSED", "INCALL", "WRAPUP"].includes(agentStatus ?? "")) continue;

      try {
        await redis.publish(
          `t:${tenantId}:ws:user:${cb.userId}`,
          JSON.stringify({
            type: "callback_upcoming",
            callback_id: String(cb.id),
            lead_id: String(cb.leadId),
            campaign_id: cb.campaignId,
            callback_at: cb.callbackAt.toISOString(),
            comments: cb.comments,
            minutes_until: 5,
          }),
        );
      } catch (err) {
        logger.error({ err, callbackId: String(cb.id) }, "d06:upcoming: WS notify failed");
      }
    }
  } finally {
    await redis.del(lockKey);
  }
}
