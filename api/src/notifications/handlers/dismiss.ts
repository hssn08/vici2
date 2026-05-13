// N01 — DELETE /api/notifications/:id
// Hard-deletes a notification. Users can only delete their own;
// admin/supervisor can delete any within their tenant.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../../auth/middleware.js";
import { getPrisma } from "../../lib/prisma.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export async function handleDismiss(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const { id } = req.params as { id: string };
  let notifId: bigint;
  try {
    notifId = BigInt(id);
  } catch {
    await reply.code(400).send({ error: "invalid_id" });
    return;
  }

  const prisma = getPrisma();

  // Admins and supervisors can dismiss any notification within their tenant.
  // Agents can only dismiss their own.
  const isElevated = auth.role === "admin" || auth.role === "super_admin" || auth.role === "supervisor";

  const existing = await prisma.notification.findFirst({
    where: {
      id: notifId,
      tenantId: BigInt(auth.tenantId),
      ...(isElevated ? {} : { userId: BigInt(auth.uid) }),
    },
    select: { id: true },
  });

  if (!existing) {
    await reply.code(404).send({ error: "not_found" });
    return;
  }

  await prisma.notification.delete({ where: { id: notifId } });

  await reply.code(204).send();
}
