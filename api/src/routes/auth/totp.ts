// POST /api/auth/totp/enroll, POST /api/auth/totp/verify
//
// PLAN §10 carves the full TOTP flow to F06; F05 ships the primitives and
// pass-through endpoints. With no `user_totp_secrets` table in the schema
// yet, F05 returns the enrollment material to the client and trusts the
// caller to surface it back on verify. F06 will land the persistence layer.

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { audit } from "../../auth/audit.js";
import { enrollTotp, generateBackupCodes, verifyTotpCode } from "../../auth/totp.js";
import { getPrisma } from "../../lib/prisma.js";

const EnrollBody = z.object({});
const VerifyBody = z.object({
  secret: z.string().min(16),
  code: z.string().regex(/^\d{6}$/),
});

export function registerTotpRoutes(app: FastifyInstance): void {
  app.post(
    "/api/auth/totp/enroll",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: "not_authenticated" });
      const _parsed = EnrollBody.safeParse(req.body ?? {});
      const prisma = getPrisma();
      const user = await prisma.user.findUnique({ where: { id: BigInt(req.auth.uid) } });
      if (!user) return reply.code(404).send({ error: "user_not_found" });

      const { secret, otpauthUri } = enrollTotp({
        user: user.username,
        issuer: "vici2",
      });
      const backup = generateBackupCodes();

      // F06 persists; F05 audit-logs the enrollment hook.
      await audit({
        tx: prisma,
        actorUserId: user.id,
        actorKind: "user",
        action: "auth.totp.enrolled",
        tenantId: Number(user.tenantId),
        entityType: "user",
        entityId: String(user.id),
        ip: req.ip,
      });

      void _parsed;
      return reply.code(200).send({
        secret,
        otpauth_uri: otpauthUri,
        backup_codes: backup.plain,
      });
    },
  );

  app.post(
    "/api/auth/totp/verify",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: "not_authenticated" });
      const parsed = VerifyBody.safeParse(req.body);
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });

      const ok = verifyTotpCode(parsed.data.secret, parsed.data.code);
      const prisma = getPrisma();
      await audit({
        tx: prisma,
        actorUserId: req.auth.uid,
        actorKind: "user",
        action: ok ? "auth.totp.verified" : "auth.totp.failed",
        tenantId: req.auth.tenantId,
        entityType: "user",
        entityId: String(req.auth.uid),
        ip: req.ip,
      });
      if (!ok) return reply.code(401).send({ error: "totp_invalid" });
      return reply.code(200).send({ verified: true });
    },
  );
}
