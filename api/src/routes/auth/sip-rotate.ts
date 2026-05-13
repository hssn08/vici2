// POST /api/auth/sip/rotate — generate a new SIP password for self/admin.

import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { audit } from "../../auth/audit.js";
import { roleAtLeast } from "../../auth/rbac.js";
import {
  encryptSipPassword,
  generateSipPassword,
  generateSipUsername,
} from "../../auth/sip-creds.js";
import { getPrisma } from "../../lib/prisma.js";

const Body = z.object({
  user_id: z.number().int().positive().optional(),
});

export function registerSipRotateRoute(app: FastifyInstance): void {
  app.post(
    "/api/auth/sip/rotate",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: "not_authenticated" });
      const parsed = Body.safeParse(req.body ?? {});
      if (!parsed.success)
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });

      const targetUid = parsed.data.user_id ?? req.auth.uid;
      if (targetUid !== req.auth.uid && !roleAtLeast(req.auth.role, "admin")) {
        return reply.code(403).send({ error: "not_owner" });
      }

      const prisma = getPrisma();
      const user = await prisma.user.findUnique({ where: { id: BigInt(targetUid) } });
      if (!user) return reply.code(404).send({ error: "user_not_found" });
      if (Number(user.tenantId) !== req.auth.tenantId)
        return reply.code(403).send({ error: "tenant_mismatch" });

      const password = generateSipPassword(32);
      const sipUsername = generateSipUsername(Number(user.id));

      const existing = await prisma.sipCredential.findFirst({
        where: { tenantId: user.tenantId, userId: user.id },
      });
      let cred;
      if (existing) {
        const enc = encryptSipPassword(password, {
          rowId: existing.id,
          tenantId: user.tenantId,
        });
        cred = await prisma.sipCredential.update({
          where: { id: existing.id },
          data: {
            sipPasswordCt: Buffer.from(enc.ciphertextBlob),
            kekVersion: enc.kekVersion,
            lastRotatedAt: new Date(),
          },
        });
      } else {
        cred = await prisma.sipCredential.create({
          data: {
            tenantId: user.tenantId,
            userId: user.id,
            sipUsername,
            sipPasswordCt: Buffer.from(""),
            kekVersion: 1,
          },
        });
        const enc = encryptSipPassword(password, { rowId: cred.id, tenantId: user.tenantId });
        cred = await prisma.sipCredential.update({
          where: { id: cred.id },
          data: {
            sipPasswordCt: Buffer.from(enc.ciphertextBlob),
            kekVersion: enc.kekVersion,
            lastRotatedAt: new Date(),
          },
        });
      }

      await audit({
        tx: prisma,
        actorUserId: req.auth.uid,
        actorKind: "user",
        action: "auth.sip.rotated",
        tenantId: req.auth.tenantId,
        entityType: "sip_credential",
        entityId: String(cred.id),
        afterJson: { user_id: Number(user.id), kek_version: cred.kekVersion },
        ip: req.ip,
      });

      return reply.code(200).send({
        sip_username: cred.sipUsername,
        sip_password: password,
        kek_version: cred.kekVersion,
      });
    },
  );
}
