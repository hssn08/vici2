// GET /auth/.well-known/jwks.json

import type { FastifyInstance } from "fastify";

import { initJwt, publicJwks } from "../../auth/jwt.js";

export function registerJwksRoute(app: FastifyInstance): void {
  app.get("/auth/.well-known/jwks.json", async (_req, reply) => {
    await initJwt();
    reply.header("cache-control", "public, max-age=300");
    return reply.code(200).send(publicJwks());
  });
}
