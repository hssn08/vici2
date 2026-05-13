// POST /api/auth/password/change

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { hashPassword, verifyPassword } from "../../auth/argon2.js";
import { audit } from "../../auth/audit.js";
import { checkPassword } from "../../auth/password-policy.js";
import { revokeAllForUser } from "../../auth/refresh.js";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";

const Body = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(12).max(256),
});

export function registerPasswordChangeRoute(app: FastifyInstance): void {
  app.post(
    "/api/auth/password/change",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: "not_authenticated" });
      const parsed = Body.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });

      const prisma = getPrisma();
      const redis = getRedis();
      const user = await prisma.user.findUnique({ where: { id: BigInt(req.auth.uid) } });
      if (!user) return reply.code(404).send({ error: "user_not_found" });

      const ok = await verifyPassword(parsed.data.current_password, user.passwordHash);
      if (!ok) return reply.code(401).send({ error: "invalid_current_password" });

      const policy = await checkPassword(parsed.data.new_password, { redis });
      if (!policy.ok) return reply.code(400).send({ error: "password_policy", reason: policy.reason });

      const newHash = await hashPassword(parsed.data.new_password);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: newHash },
      });

      await revokeAllForUser(redis, Number(user.tenantId), Number(user.id));

      await audit({
        tx: prisma,
        actorUserId: user.id,
        actorKind: "user",
        action: "auth.password.changed",
        tenantId: Number(user.tenantId),
        entityType: "user",
        entityId: String(user.id),
        ip: req.ip,
      });

      return reply.code(204).send();
    },
  );
}
