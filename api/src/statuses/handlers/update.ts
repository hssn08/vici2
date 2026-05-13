// D04 — PATCH /api/admin/campaigns/:cid/statuses/:code
// Updates per-campaign status. Rejects if cid === '__SYS__'.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { StatusService } from "../service.js";
import { StatusUpdateSchema } from "../validators.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleUpdateStatus(req: FastifyRequest, reply: FastifyReply, prisma: PrismaClient, auth: AuthContext, redis: any): Promise<void> {
  const { cid, code } = req.params as { cid: string; code: string };

  // Block __SYS__ writes per PLAN §3.3
  if (cid === "__SYS__") {
    return reply.code(403).send({ error: "system_status_immutable" });
  }

  const parsed = StatusUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
  }

  const tenantId = BigInt(auth.tenantId);
  const svc = new StatusService(prisma);

  try {
    const updated = await svc.upsert(redis, tenantId, cid, code, parsed.data);
    return reply.code(200).send(updated);
  } catch (err: unknown) {
    const e = err as { message?: string };
    if (e.message === "status_not_found") return reply.code(404).send({ error: "not_found" });
    if (e.message === "hotkey_conflict") return reply.code(409).send({ error: "hotkey_conflict" });
    throw err;
  }
}
