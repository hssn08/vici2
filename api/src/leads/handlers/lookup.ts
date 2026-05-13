// D01 — GET /api/leads/lookup (PLAN §1.1)
// Lookup by phone_e164. Agent hot path.

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma.js";
import { serializeLead } from "./get.js";

const LookupQuerySchema = z.object({
  phone_e164: z.string().min(2).max(20),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export function registerLookupLeadRoute(app: FastifyInstance): void {
  app.get(
    "/api/leads/lookup",
    {
      preValidation: [
        app.requireAuth,
        app.requirePermission("lead:read"),
      ],
    },
    async (req, reply) => {
      const parsed = LookupQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_QUERY", issues: parsed.error.issues });
      }

      const { phone_e164, limit } = parsed.data;
      const tenantId = BigInt(req.auth!.tenantId);
      const prisma = getPrisma();

      const leads = await prisma.lead.findMany({
        where: {
          tenantId,
          phoneE164: phone_e164,
          deletedAt: null,
        },
        select: {
          id: true,
          tenantId: true,
          listId: true,
          status: true,
          phoneE164: true,
          phoneAlt: true,
          phoneAlt2: true,
          firstName: true,
          lastName: true,
          email: true,
          state: true,
          countryCode: true,
          knownTimezone: true,
          tzBlocked: true,
          version: true,
          rank: true,
          calledCount: true,
          ownerUserId: true,
          deletedAt: true,
          entryAt: true,
          modifyAt: true,
          createdAt: true,
          updatedAt: true,
          lastCalledAt: true,
          customData: true,
          vendorLeadCode: true,
          sourceId: true,
          title: true,
          middleInitial: true,
          address1: true,
          address2: true,
          city: true,
          postalCode: true,
          dateOfBirth: true,
          gender: true,
          comments: true,
          tzOffsetMin: true,
        },
        orderBy: [{ modifyAt: "desc" }],
        take: limit,
      });

      return reply.code(200).send({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data: (leads as any[]).map((l: any) => serializeLead(l as Record<string, unknown>)),
        count: leads.length,
      });
    },
  );
}
