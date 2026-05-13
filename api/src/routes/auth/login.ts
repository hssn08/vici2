// POST /api/auth/login

import type { FastifyInstance } from "fastify";
import { Redis } from "ioredis";
import { z } from "zod";

import { verifyPassword, needsRehash, hashPassword } from "../../auth/argon2.js";
import { audit } from "../../auth/audit.js";
import { signAccessToken } from "../../auth/jwt.js";
import {
  clearLockout,
  getLockoutState,
  recordFailure,
} from "../../auth/lockout.js";
import { issueRefreshToken } from "../../auth/refresh.js";
import { roleAtLeast, permissionsFor } from "../../auth/rbac.js";
import { env } from "../../lib/env.js";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";

const BodySchema = z.object({
  tenant_id: z.number().int().positive().optional(),
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

function refreshTtlForRole(role: string): number {
  if (role === "agent") return env.refreshTtlAgentSec;
  if (role === "integrator") return env.refreshTtlIntegratorSec;
  return env.refreshTtlAdminSec;
}

export function registerLoginRoute(app: FastifyInstance): void {
  app.post("/api/auth/login", async (req, reply) => {
    const parsed = BodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
    }
    const body = parsed.data;
    const tenantId = body.tenant_id ?? 1;
    const prisma = getPrisma();
    const redis: Redis = getRedis();

    const lock = await getLockoutState(redis, tenantId, body.username);
    if (lock.isLocked) {
      await audit({
        tx: prisma,
        actorUserId: null,
        actorKind: "user",
        action: "auth.login.failure",
        tenantId,
        entityType: "user",
        entityId: body.username,
        afterJson: { reason: "locked", locked_until: lock.lockedUntil },
        ip: req.ip,
        userAgent: req.headers["user-agent"] as string | undefined,
      });
      return reply.code(429).send({ error: "locked", locked_until: lock.lockedUntil });
    }

    const user = await prisma.user.findUnique({
      where: { tenantId_username: { tenantId: BigInt(tenantId), username: body.username } },
    });

    const valid =
      user !== null &&
      user.active &&
      (await verifyPassword(body.password, user.passwordHash));

    if (!valid) {
      const next = await recordFailure(redis, tenantId, body.username);
      await audit({
        tx: prisma,
        actorUserId: user ? user.id : null,
        actorKind: "user",
        action: "auth.login.failure",
        tenantId,
        entityType: "user",
        entityId: body.username,
        afterJson: { fail_count: next.failCount, locked_until: next.lockedUntil },
        ip: req.ip,
        userAgent: req.headers["user-agent"] as string | undefined,
      });
      if (next.isLocked) {
        await audit({
          tx: prisma,
          actorUserId: user ? user.id : null,
          actorKind: "system",
          action: "auth.lockout.triggered",
          tenantId,
          entityType: "user",
          entityId: body.username,
          afterJson: { locked_until: next.lockedUntil, level: next.level },
          ip: req.ip,
        });
        return reply.code(429).send({ error: "locked", locked_until: next.lockedUntil });
      }
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    await clearLockout(redis, tenantId, body.username);

    if (needsRehash(user.passwordHash)) {
      const fresh = await hashPassword(body.password);
      await prisma.user.update({
        where: { id: user.id },
        data: { passwordHash: fresh },
      });
    }

    const requiresTotp = user.totpRequired;
    const totpVerified = !requiresTotp;
    const role = user.role as unknown as string;

    const access = await signAccessToken({
      uid: Number(user.id),
      tenantId: Number(user.tenantId),
      role: role as never,
      perms: [...permissionsFor(role as never)],
      totpVerified,
      aud: "api",
      ttlSec: env.accessTokenTtlSec,
    });

    const refresh = await issueRefreshToken({
      redis,
      tenantId: Number(user.tenantId),
      userId: Number(user.id),
      role: role as never,
      ttlSec: refreshTtlForRole(role),
      ip: req.ip,
      ua: req.headers["user-agent"] as string | undefined,
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    await audit({
      tx: prisma,
      actorUserId: user.id,
      actorKind: "user",
      action: "auth.login.success",
      tenantId,
      entityType: "user",
      entityId: String(user.id),
      afterJson: { jti: access.claims.jti, family_id: refresh.familyId },
      ip: req.ip,
      userAgent: req.headers["user-agent"] as string | undefined,
    });

    return reply.code(200).send({
      access_token: access.token,
      refresh_token: refresh.token,
      family_id: refresh.familyId,
      access_expires_at: access.claims.exp,
      refresh_expires_at: refresh.expiresAt,
      user: {
        id: Number(user.id),
        username: user.username,
        role: user.role,
        tenant_id: Number(user.tenantId),
        totp_required: user.totpRequired,
      },
      totp_required: requiresTotp,
    });
  });
}

// roleAtLeast referenced for symmetry of imports — silence eslint
void roleAtLeast;
