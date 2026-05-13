// D06 worker — deferCallback: TCPA SKIP_UNTIL re-snooze.
// Updates callback_at to nextOpen and publishes event.

import type { PrismaClient } from "@prisma/client";
import pino from "pino";

const logger = pino({ level: "info" });

 
export async function deferCallback(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  callbackId: bigint,
  tenantId: bigint,
  leadId: bigint,
  userId: bigint | null,
  nextOpen: Date,
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.callback.update({
        where: { id: callbackId },
        data: { callbackAt: nextOpen },
      });

      await tx.auditLog.create({
        data: {
          tenantId,
          actorKind: "worker",
          action: "callback.snoozed",
          entityType: "callback",
          entityId: String(callbackId),
          afterJson: {
            reason: "tcpa_skip_until",
            next_open: nextOpen.toISOString(),
          },
          ts: new Date(),
        },
      });
    });

    await redis.xadd(
      "events:vici2.callback.callback_tcpa_deferred",
      "*",
      "payload",
      JSON.stringify({
        type: "callback_tcpa_deferred",
        tenantId: String(tenantId),
        callbackId: String(callbackId),
        leadId: String(leadId),
        userId: userId != null ? String(userId) : null,
        next_open: nextOpen.toISOString(),
        ts: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.error({ err, callbackId: String(callbackId) }, "d06:defer: failed to defer callback");
  }
}
