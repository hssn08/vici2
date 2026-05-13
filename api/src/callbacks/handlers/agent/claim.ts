// D06 — POST /api/agent/callbacks/:id/claim — claim GLOBAL callback (CAS).

import type { FastifyRequest, FastifyReply } from "fastify";
import { claimCallback } from "../../service.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleClaimCallback(redis: any) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = (req as AuthReq).auth;
    if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

    const { id } = req.params as { id: string };

    try {
      const result = await claimCallback(getPrisma(), redis, auth, BigInt(id));
      await reply.send(result);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; code?: string };
      await reply.code(e.statusCode ?? 500).send({ error: e.code ?? "internal_error" });
    }
  };
}
