// D06 — GET /api/admin/callbacks — list with filters.

import type { FastifyRequest, FastifyReply } from "fastify";
import { AdminListQuery } from "../../schemas.js";
import { listCallbacksAdmin } from "../../service.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export async function handleAdminListCallbacks(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const parsed = AdminListQuery.safeParse(req.query);
  if (!parsed.success) {
    await reply.code(400).send({ error: "validation_error", details: parsed.error.flatten() });
    return;
  }

  const q = parsed.data;
  const statuses = q.status
    ? (Array.isArray(q.status) ? q.status : [q.status])
    : undefined;

  try {
    const result = await listCallbacksAdmin(getPrisma(), auth, {
      statuses,
      scope: q.scope,
      userId: q.user_id,
      campaignId: q.campaign_id,
      dueFrom: q.due_from ? new Date(q.due_from) : undefined,
      dueTo: q.due_to ? new Date(q.due_to) : undefined,
      staleOnly: q.stale_only,
      cursor: q.cursor,
      limit: q.limit,
    });
    await reply.send(result);
  } catch (err: unknown) {
    const e = err as { statusCode?: number; code?: string };
    await reply.code(e.statusCode ?? 500).send({ error: e.code ?? "internal_error" });
  }
}
