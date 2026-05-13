// POST /api/auth/refresh

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { audit } from "../../auth/audit.js";
import { signAccessToken } from "../../auth/jwt.js";
import {
  consumeRefreshToken,
  issueRefreshToken,
  sha256Hex,
} from "../../auth/refresh.js";
import { permissionsFor } from "../../auth/rbac.js";
import { env } from "../../lib/env.js";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";

const BodySchema = z.object({
  refresh_token: z.string().min(10),
  family_id: z.string().min(1),
  tenant_id: z.number().int().positive().optional(),
});

function refreshTtlForRole(role: string): number {
  if (role === "agent") return env.refreshTtlAgentSec;
  if (role === "integrator") return env.refreshTtlIntegratorSec;
  return env.refreshTtlAdminSec;
}

export function registerRefreshRoute(app: FastifyInstance): void {
  app.post("/api/auth/refresh", async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const { refresh_token, family_id, tenant_id } = parsed.data;
    const tenantId = tenant_id ?? 1;
    const redis = getRedis();
    const prisma = getPrisma();

    const consumed = await consumeRefreshToken(redis, tenantId, family_id, refresh_token);

    if (consumed.outcome === "not_found") {
      await audit({
        tx: prisma,
        actorUserId: null,
        actorKind: "user",
        action: "auth.refresh.expired",
        tenantId,
        entityType: "session",
        entityId: family_id,
        ip: req.ip,
      });
      return reply.code(401).send({ error: "refresh_not_found" });
    }
    if (consumed.outcome === "reuse") {
      await audit({
        tx: prisma,
        actorUserId: null,
        actorKind: "system",
        action: "auth.refresh.reuse_detected",
        tenantId,
        entityType: "session",
        entityId: family_id,
        afterJson: { keys_revoked: consumed.keysRevoked },
        ip: req.ip,
      });
      return reply.code(401).send({ error: "refresh_reuse_detected" });
    }

    if (!consumed.userId || !consumed.role) {
      return reply.code(500).send({ error: "refresh_record_corrupt" });
    }

    const user = await prisma.user.findUnique({ where: { id: BigInt(consumed.userId) } });
    if (!user || !user.active) {
      return reply.code(401).send({ error: "user_inactive" });
    }

    const role = user.role as unknown as string;
    const access = await signAccessToken({
      uid: Number(user.id),
      tenantId: Number(user.tenantId),
      role: role as never,
      perms: [...permissionsFor(role as never)],
      totpVerified: !user.totpRequired,
      aud: "api",
      ttlSec: env.accessTokenTtlSec,
    });
    const refresh = await issueRefreshToken({
      redis,
      tenantId: Number(user.tenantId),
      userId: Number(user.id),
      role: role as never,
      ttlSec: refreshTtlForRole(role),
      familyId: family_id,
      parentTokenHash: sha256Hex(refresh_token),
      ip: req.ip,
      ua: req.headers["user-agent"] as string | undefined,
    });

    await audit({
      tx: prisma,
      actorUserId: user.id,
      actorKind: "user",
      action: "auth.refresh.success",
      tenantId,
      entityType: "session",
      entityId: family_id,
      ip: req.ip,
    });

    return reply.code(200).send({
      access_token: access.token,
      refresh_token: refresh.token,
      family_id: refresh.familyId,
      access_expires_at: access.claims.exp,
      refresh_expires_at: refresh.expiresAt,
    });
  });
}
