// D06 — GET /api/agent/callbacks/mine — list own callbacks.

import type { FastifyRequest, FastifyReply } from "fastify";
import { listMineCallbacks } from "../../service.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export async function handleMineCallbacks(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const query = req.query as Record<string, string>;
  const cursor = query.cursor ? BigInt(query.cursor) : undefined;
  const limit = query.limit ? parseInt(query.limit, 10) : 50;

  try {
    const result = await listMineCallbacks(getPrisma(), auth, { cursor, limit });
    await reply.send(result);
  } catch (err: unknown) {
    const e = err as { statusCode?: number; code?: string };
    await reply.code(e.statusCode ?? 500).send({ error: e.code ?? "internal_error" });
  }
}
