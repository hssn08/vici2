// D04 — POST /api/admin/campaigns/:cid/statuses
// Creates a per-campaign custom status. Rejects if code exists in __SYS__.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { StatusService } from "../service.js";
import { StatusCreateSchema } from "../validators.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleCreateStatus(req: FastifyRequest, reply: FastifyReply, prisma: PrismaClient, auth: AuthContext, redis: any): Promise<void> {
  const { cid } = req.params as { cid: string };

  // Block __SYS__ writes
  if (cid === "__SYS__") {
    return reply.code(403).send({ error: "system_status_immutable" });
  }

  const parsed = StatusCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
  }

  const { status: code, ...def } = parsed.data;
  const tenantId = BigInt(auth.tenantId);

  // Reserve __ prefix for admin:system callers
  if (code.startsWith("__") && !auth.perms.has("tenant:edit")) {
    return reply.code(403).send({ error: "reserved_code_prefix" });
  }

  const svc = new StatusService(prisma);

  try {
    const created = await svc.create(redis, tenantId, cid, code, {
      description: def.description,
      selectable: def.selectable,
      humanAnswered: def.humanAnswered,
      sale: def.sale,
      dnc: def.dnc,
      callback: def.callback,
      notInterested: def.notInterested,
      hotkey: def.hotkey,
      recycleDelaySeconds: def.recycleDelaySeconds,
      category: def.category,
    });
    return reply.code(201).send(created);
  } catch (err: unknown) {
    const e = err as { message?: string; statusCode?: number };
    if (e.message === "code_exists_in_system") return reply.code(409).send({ error: "code_exists_in_system" });
    if (e.message === "hotkey_conflict") return reply.code(409).send({ error: "hotkey_conflict" });
    throw err;
  }
}
