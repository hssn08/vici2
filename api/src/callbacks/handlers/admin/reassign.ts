// D06 — POST /api/admin/callbacks/:id/reassign — reassign to user or GLOBAL.

import type { FastifyRequest, FastifyReply } from "fastify";
import { ReassignBody } from "../../schemas.js";
import { reassignCallback } from "../../service.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleReassignCallback(redis: any) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = (req as AuthReq).auth;
    if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

    const { id } = req.params as { id: string };
    const parsed = ReassignBody.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: "validation_error", details: parsed.error.flatten() });
      return;
    }

    try {
      const result = await reassignCallback(getPrisma(), redis, auth, BigInt(id), parsed.data);
      await reply.send(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; code?: string };
      await reply.code(e.statusCode ?? 500).send({ error: e.code ?? "internal_error" });
    }
  };
}
