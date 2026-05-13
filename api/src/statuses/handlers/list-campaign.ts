// D04 — GET /api/admin/campaigns/:cid/statuses
// Returns 3-layer merged effective statuses for a campaign.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { StatusService } from "../service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleListCampaignStatuses(req: FastifyRequest, reply: FastifyReply, prisma: PrismaClient, auth: AuthContext, _redis: any): Promise<void> {
  const { cid } = req.params as { cid: string };
  const tenantId = BigInt(auth.tenantId);

  const svc = new StatusService(prisma);
  const statuses = await svc.list(tenantId, cid);

  return reply.code(200).send({
    campaignId: cid,
    items: statuses,
  });
}
