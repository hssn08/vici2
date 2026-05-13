// POST /auth/ws-token — mint a short-lived ws-scoped JWT from a live API token

import type { FastifyInstance } from "fastify";

import { signAccessToken } from "../../auth/jwt.js";
import { permissionsFor } from "../../auth/rbac.js";
import { env } from "../../lib/env.js";

export function registerWsTokenRoute(app: FastifyInstance): void {
  app.post(
    "/auth/ws-token",
    { preHandler: app.requireAuth },
    async (req, reply) => {
      if (!req.auth) return reply.code(401).send({ error: "not_authenticated" });
      const tok = await signAccessToken({
        uid: req.auth.uid,
        tenantId: req.auth.tenantId,
        role: req.auth.role,
        perms: [...permissionsFor(req.auth.role)],
        totpVerified: req.auth.totpVerified,
        aud: "ws",
        ttlSec: env.accessTokenTtlSec,
      });
      return reply.code(200).send({
        ws_token: tok.token,
        expires_at: tok.claims.exp,
      });
    },
  );
}
