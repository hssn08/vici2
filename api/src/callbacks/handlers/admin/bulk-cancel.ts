// D06 — POST /api/admin/callbacks/bulk-cancel — cancel up to 500 by ids.

import type { FastifyRequest, FastifyReply } from "fastify";
import { BulkCancelBody } from "../../schemas.js";
import { bulkCancelCallbacks } from "../../service.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export async function handleBulkCancel(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const parsed = BulkCancelBody.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: "validation_error", details: parsed.error.flatten() });
    return;
  }

  try {
    const result = await bulkCancelCallbacks(getPrisma(), auth, parsed.data.ids);
    await reply.send(result);
  } catch (err: unknown) {
    const e = err as { statusCode?: number; code?: string };
    await reply.code(e.statusCode ?? 500).send({ error: e.code ?? "internal_error" });
  }
}
