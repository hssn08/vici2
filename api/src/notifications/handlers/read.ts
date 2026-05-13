// N01 — PATCH /api/notifications/:id/read
// Marks a single notification as read (sets read_at = NOW()).

import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../../auth/middleware.js";
import { getPrisma } from "../../lib/prisma.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export async function handleMarkRead(req: FastifyRequest, reply: FastifyReply): Promise<void> {
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

  const existing = await prisma.notification.findFirst({
    where: {
      id: notifId,
      tenantId: BigInt(auth.tenantId),
      userId: BigInt(auth.uid),
    },
    select: { id: true, readAt: true },
  });

  if (!existing) {
    await reply.code(404).send({ error: "not_found" });
    return;
  }

  if (!existing.readAt) {
    await prisma.notification.update({
      where: { id: notifId },
      data: { readAt: new Date() },
    });
  }

  await reply.send({ ok: true });
}
