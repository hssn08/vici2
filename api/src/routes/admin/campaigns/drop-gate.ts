/**
 * drop-gate.ts — Admin REST endpoint for force-releasing the E05 drop gate.
 *
 * E05 PLAN §13.2:
 *   POST /api/admin/campaigns/:campaignId/drop-gate/release
 *   Authorization: campaigns:override_drop_gate (F05 RBAC)
 *
 * Responses:
 *   200  { released: true, drop_pct: number, engaged_for_seconds: number }
 *   403  { error: "insufficient_permissions" }
 *   404  { error: "campaign_not_found" }
 *   409  { error: "gate_not_engaged" }
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { VRedisClient } from "../../../lib/valkey/client.js";
import { getPrisma } from "../../../lib/prisma.js";
import { Keys } from "../../../lib/valkey/keys.js";
import type { AuthContext } from "../../../auth/middleware.js";

// Module-level singleton; lazily initialized at first request.
let _valkey: VRedisClient | null = null;
async function getValkey(): Promise<VRedisClient> {
  if (!_valkey) {
    _valkey = await VRedisClient.fromEnv();
  }
  return _valkey;
}

type AuthReq = FastifyRequest & { auth?: AuthContext };

const ReleaseBodySchema = z.object({
  reason: z.string().min(1).max(500),
});

export interface ReleaseResponse {
  released: boolean;
  drop_pct: number;
  engaged_for_seconds: number;
}

/**
 * registerDropGateReleaseRoute mounts the force-release endpoint.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerDropGateReleaseRoute(app: any): Promise<void> {
  app.post(
    "/api/admin/campaigns/:campaignId/drop-gate/release",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = (req as AuthReq).auth;
      if (!auth) {
        return reply.code(401).send({ error: "unauthenticated" });
      }

      // RBAC: campaigns:override_drop_gate
      // RBAC: campaigns:override_drop_gate (F05 permission)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!auth.perms?.has("campaigns:override_drop_gate" as any)) {
        return reply.code(403).send({ error: "insufficient_permissions" });
      }

      const { campaignId } = req.params as { campaignId: string };
      const cidInt = parseInt(campaignId, 10);
      if (!cidInt || cidInt <= 0) {
        return reply.code(400).send({ error: "invalid_campaign_id" });
      }

      const bodyParsed = ReleaseBodySchema.safeParse(req.body);
      if (!bodyParsed.success) {
        return reply.code(400).send({ error: "reason is required" });
      }
      const { reason } = bodyParsed.data;

      const prisma = getPrisma();
      const campaign = await prisma.campaign.findFirst({
        where: { id: campaignId, tenantId: auth.tenantId },
        select: { id: true },
      });
      if (!campaign) {
        return reply.code(404).send({ error: "campaign_not_found" });
      }

      const valkey = await getValkey();
      const rc = valkey.state; // ioredis instance
      const keys = new Keys(Number(auth.tenantId));

      // Check gate is engaged.
      const gateExists = await rc.exists(keys.campaignDropGated(cidInt));
      if (!gateExists) {
        return reply.code(409).send({ error: "gate_not_engaged" });
      }

      // Read engagement timestamp for engaged_for_seconds.
      let engagedForSeconds = 0;
      const engagedAtStr = await rc.get(
        keys.campaignDropGateEngagedAt(cidInt)
      );
      if (engagedAtStr) {
        const engagedAt = new Date(engagedAtStr);
        engagedForSeconds = Math.round(
          (Date.now() - engagedAt.getTime()) / 1000
        );
      }

      // Read current drop_pct.
      let dropPct = 0;
      const dropPctStr = await rc.get(keys.campaignDropPct30d(cidInt));
      if (dropPctStr) {
        dropPct = parseFloat(dropPctStr);
      }

      const now = new Date();

      // DEL drop_gated + engaged_at.
      await rc.del(
        keys.campaignDropGated(cidInt),
        keys.campaignDropGateEngagedAt(cidInt)
      );

      // XADD to drop_gate_transitions STREAM.
      await rc.xadd(
        keys.campaignDropGateTransitions(cidInt),
        "*",
        "action", "release",
        "drop_pct", dropPct.toFixed(4),
        "source", "operator",
        "operator_id", String(auth.uid),
        "reason", reason,
        "ts", now.toISOString()
      );

      // MySQL durable write: drop_gate_transition_log + C03 audit_log.
      await prisma.$transaction(async (tx) => {
        // Transition log (E05 §9.4).
        await tx.dropGateTransitionLog.create({
          data: {
            tenantId: auth.tenantId,
            campaignId,
            action: "release",
            dropPct,
            source: "operator",
            operatorId: BigInt(auth.uid),
            reason,
            occurredAt: now,
          },
        });

        // C03 audit log (AC-10): drop_gate_release with actor, reason, drop_pct.
        await tx.auditLog.create({
          data: {
            tenantId: auth.tenantId,
            actorUserId: BigInt(auth.uid),
            action: "drop_gate_release",
            entityType: "campaign",
            entityId: campaignId,
            afterJson: {
              reason,
              drop_pct_at_release: dropPct,
              engaged_duration_seconds: engagedForSeconds,
            },
            ts: now,
          },
        });
      });

      const response: ReleaseResponse = {
        released: true,
        drop_pct: dropPct,
        engaged_for_seconds: engagedForSeconds,
      };
      return reply.code(200).send(response);
    }
  );
}
