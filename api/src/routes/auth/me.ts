// GET /api/auth/me

import type { FastifyInstance } from "fastify";

import { getPrisma } from "../../lib/prisma.js";

export function registerMeRoute(app: FastifyInstance): void {
  app.get(
    "/api/auth/me",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: "not_authenticated" });
      const prisma = getPrisma();
      const user = await prisma.user.findUnique({ where: { id: BigInt(req.auth.uid) } });
      if (!user) return reply.code(404).send({ error: "user_not_found" });
      return reply.code(200).send({
        id: Number(user.id),
        username: user.username,
        email: user.email,
        full_name: user.fullName,
        role: user.role,
        tenant_id: Number(user.tenantId),
        active: user.active,
        totp_required: user.totpRequired,
        totp_verified: req.auth.totpVerified,
        last_login_at: user.lastLoginAt,
        perms: [...req.auth.perms],
      });
    },
  );
}
