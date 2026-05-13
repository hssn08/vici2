// D06 worker — promoteCallback: atomic PENDING → LIVE transition.
// Uses $transaction for CAS. Skips (P2025/no-op) if row already LIVE.

import type { PrismaClient } from "@prisma/client";
import pino from "pino";

const logger = pino({ level: "info" });

export interface PromoteResult {
  promoted: boolean;
  reason?: string;
}

export interface CallbackRow {
  id: bigint;
  tenantId: bigint;
  leadId: bigint;
  campaignId: string;
  userId: bigint | null;
  callbackAt: Date;
  status: string;
  comments: string | null;
}

 
export async function promoteCallback(
  prisma: PrismaClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  redis: any,
  cb: CallbackRow,
  tcpaWarning?: string,
): Promise<PromoteResult> {
  try {
    const result = await prisma.$transaction(async (tx) => {
      // CAS: only promote if still PENDING
      const updateResult = await tx.callback.updateMany({
        where: { id: cb.id, status: "PENDING" },
        data: { status: "LIVE" },
      });

      if (updateResult.count === 0) {
        // Already promoted or terminal — idempotent skip
        return { promoted: false };
      }

      // Update lead to CALLBK; if AGENT-scoped, set owner_user_id
      await tx.lead.update({
        where: { id: cb.leadId },
        data: {
          status: "CALLBK",
          modifyAt: new Date(),
          ...(cb.userId != null ? { ownerUserId: cb.userId } : {}),
        },
      });

      // Audit
      await tx.auditLog.create({
        data: {
          tenantId: cb.tenantId,
          actorKind: "worker",
          action: "callback.fired",
          entityType: "callback",
          entityId: String(cb.id),
          afterJson: {
            scope: cb.userId != null ? "AGENT" : "GLOBAL",
            ...(tcpaWarning ? { tcpa_warning: tcpaWarning } : {}),
          },
          ts: new Date(),
        },
      });

      return { promoted: true };
    });

    if (!result.promoted) return { promoted: false, reason: "already_live" };

    // After-commit: publish events and WS notifications
    const scope = cb.userId != null ? "AGENT" : "GLOBAL";
    const eventType = scope === "AGENT" ? "callback_fired_agent" : "callback_fired_global";

    try {
      const payload = JSON.stringify({
        type: eventType,
        tenantId: String(cb.tenantId),
        callbackId: String(cb.id),
        leadId: String(cb.leadId),
        userId: cb.userId != null ? String(cb.userId) : null,
        campaignId: cb.campaignId,
        ts: new Date().toISOString(),
      });
      await redis.xadd(`events:vici2.callback.${eventType}`, "*", "payload", payload);

      // WS notification for AGENT-scoped only
      if (cb.userId != null) {
        const online = await redis.get(`t:${cb.tenantId}:agent:status:${cb.userId}`);
        if (["READY", "PAUSED", "INCALL", "WRAPUP"].includes(online ?? "")) {
          await redis.publish(
            `t:${cb.tenantId}:ws:user:${cb.userId}`,
            JSON.stringify({
              type: "callback_due",
              callback_id: String(cb.id),
              lead_id: String(cb.leadId),
              campaign_id: cb.campaignId,
              callback_at: cb.callbackAt.toISOString(),
              comments: cb.comments,
            }),
          );
        }
      }

      if (tcpaWarning) {
        const warnPayload = JSON.stringify({
          type: "callback_fired_with_warning",
          tenantId: String(cb.tenantId),
          callbackId: String(cb.id),
          reason: tcpaWarning,
          ts: new Date().toISOString(),
        });
        await redis.xadd("events:vici2.callback.callback_fired_with_warning", "*", "payload", warnPayload);
      }
    } catch (err) {
      logger.error({ err, callbackId: String(cb.id) }, "d06:promote: after-commit event failed (non-fatal)");
    }

    return { promoted: true };
  } catch (err) {
    logger.error({ err, callbackId: String(cb.id) }, "d06:promote: transaction failed");
    return { promoted: false, reason: "transaction_error" };
  }
}
