// D06 — GET /api/admin/callbacks/aggregate — counts by scope/status/hour.

import type { FastifyRequest, FastifyReply } from "fastify";
import { AggregateQuery } from "../../schemas.js";
import { getCallbackAggregate } from "../../service.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export async function handleAdminAggregate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const parsed = AggregateQuery.safeParse(req.query);
  if (!parsed.success) {
    await reply.code(400).send({ error: "validation_error", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await getCallbackAggregate(getPrisma(), auth, parsed.data.campaign_id, parsed.data.horizon_hours);
    await reply.send(result);
  } catch (err: unknown) {
    const e = err as { statusCode?: number; code?: string };
    await reply.code(e.statusCode ?? 500).send({ error: e.code ?? "internal_error" });
  }
}
