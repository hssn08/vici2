// POST /api/auth/logout, POST /api/auth/logout-all

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { audit } from "../../auth/audit.js";
import { revokeAllForUser, revokeFamily } from "../../auth/refresh.js";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";

const LogoutBody = z.object({
  family_id: z.string().min(1).optional(),
});

export function registerLogoutRoutes(app: FastifyInstance): void {
  app.post(
    "/api/auth/logout",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: "not_authenticated" });
      const parsed = LogoutBody.safeParse(req.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      const redis = getRedis();
      const prisma = getPrisma();
      let revoked = 0;
      if (parsed.data.family_id) {
        revoked = await revokeFamily(redis, req.auth.tenantId, parsed.data.family_id, req.auth.uid);
      }
      await audit({
        tx: prisma,
        actorUserId: req.auth.uid,
        actorKind: "user",
        action: "auth.logout",
        tenantId: req.auth.tenantId,
        entityType: "session",
        entityId: parsed.data.family_id ?? null,
        afterJson: { revoked },
        ip: req.ip,
      });
      return reply.code(204).send();
    },
  );

  app.post(
    "/api/auth/logout-all",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: "not_authenticated" });
      const redis = getRedis();
      const prisma = getPrisma();
      const revoked = await revokeAllForUser(redis, req.auth.tenantId, req.auth.uid);
      await audit({
        tx: prisma,
        actorUserId: req.auth.uid,
        actorKind: "user",
        action: "auth.logout.all",
        tenantId: req.auth.tenantId,
        entityType: "user",
        entityId: String(req.auth.uid),
        afterJson: { revoked },
        ip: req.ip,
      });
      return reply.code(204).send();
    },
  );
}
