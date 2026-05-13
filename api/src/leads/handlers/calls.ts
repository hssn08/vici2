// D01 — GET /api/leads/:id/calls (PLAN §1.1)
// Returns call history for a lead (stub — call_log table owned by T04/D04).
// D01 ships the RBAC gate and pagination projection; full join is T04 territory.

import type { FastifyInstance } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import { IdParamSchema } from "../schemas.js";

export function registerLeadCallsRoute(app: FastifyInstance): void {
  app.get(
    "/api/leads/:id/calls",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:read"),
      ],
    },
    async (req, reply) => {
      const parsed = IdParamSchema.safeParse(req.params);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_ID", issues: parsed.error.issues });
      }

      const { id } = parsed.data;
      const tenantId = BigInt(req.auth!.tenantId);
      const prisma = getPrisma();

      // Verify lead exists and belongs to tenant
      const lead = await prisma.lead.findFirst({
        where: { id, tenantId, deletedAt: null },
        select: { id: true },
      });

      if (!lead) {
        return reply.code(404).send({ error: "NOT_FOUND" });
      }

      // call_log table not yet modeled in schema (T04 territory)
      // Return empty response with correct shape for now
      return reply.code(200).send({
        data: [],
        page: {
          limit: 50,
          has_more: false,
          next_cursor: null,
        },
        _note: "call_log integration pending T04 implementation",
      });
    },
  );
}
