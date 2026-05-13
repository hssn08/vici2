// D04 — DELETE /api/admin/campaigns/:cid/statuses/:code
// Soft-deletes a shadow row. Never deletes __SYS__ rows.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { StatusService } from "../service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleDeleteStatus(req: FastifyRequest, reply: FastifyReply, prisma: PrismaClient, auth: AuthContext, redis: any): Promise<void> {
  const { cid, code } = req.params as { cid: string; code: string };

  // Block __SYS__ deletes
  if (cid === "__SYS__") {
    return reply.code(403).send({ error: "system_status_immutable" });
  }

  const tenantId = BigInt(auth.tenantId);
  const svc = new StatusService(prisma);

  const deleted = await svc.delete(redis, tenantId, cid, code);
  if (!deleted) return reply.code(404).send({ error: "not_found" });
  return reply.code(204).send();
}
