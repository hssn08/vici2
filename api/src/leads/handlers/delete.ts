// D01 — DELETE /api/leads/:id (PLAN §1.1)
// Soft-delete (sets deleted_at = NOW()). Idempotent.

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import { IdParamSchema } from "../schemas.js";
import { auditLead } from "../audit.js";
import { publishLeadEvent } from "../events.js";

export function registerDeleteLeadRoute(app: FastifyInstance): void {
  app.delete(
    "/api/leads/:id",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:delete"),
      ],
    },
    async (req, reply) => {
      const parsed = IdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_ID", issues: parsed.error.issues });
      }

      const { id } = parsed.data;
      const tenantId = BigInt(req.auth!.tenantId);
      const actorUserId = BigInt(req.auth!.uid);
      const prisma = getPrisma();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await prisma.$transaction(async (tx: any) => {
        const existing = await tx.lead.findFirst({
          where: { id, tenantId },
          select: { id: true, deletedAt: true },
        });

        // Idempotent: already deleted → still 204
        if (!existing || existing.deletedAt !== null) {
          return;
        }

        const deletedAt = new Date();
        await tx.lead.update({
          where: { id, tenantId },
          data: {
            deletedAt,
            modifyAt: deletedAt,
          },
        });

        await auditLead({
          tx: tx as Parameters<typeof auditLead>[0]["tx"],
          action: "lead.deleted",
          tenantId,
          actorUserId,
          entityId: String(id),
          after: { soft: true, deleted_at: deletedAt.toISOString() },
          ip: req.ip,
          userAgent: req.headers["user-agent"],
          requestId: req.id,
        });
      });

      // After-commit event publish
      void publishLeadEvent("lead.deleted", {
        tenant_id: String(tenantId),
        lead_id: String(id),
        actor_user_id: String(actorUserId),
        ts: new Date().toISOString(),
        action: "lead.deleted",
      });

      return reply.code(204).send();
    },
  );
}
