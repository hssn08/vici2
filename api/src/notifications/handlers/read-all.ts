// N01 — POST /api/notifications/read-all
// Marks all unread in-app notifications for the calling user as read.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../../auth/middleware.js";
import { getPrisma } from "../../lib/prisma.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export async function handleReadAll(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const prisma = getPrisma();

  const result = await prisma.notification.updateMany({
    where: {
      tenantId: BigInt(auth.tenantId),
      userId: BigInt(auth.uid),
      channel: "in_app",
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  await reply.send({ marked: result.count });
}
