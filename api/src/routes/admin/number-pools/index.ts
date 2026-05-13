// X04 — Number Pool + Rotation: route registration.
//
// Route map (all under /api/admin/number-pools):
//   GET    /                          number_pool:read   list pools
//   POST   /                          number_pool:edit   create pool
//   GET    /:id                       number_pool:read   get pool
//   PATCH  /:id                       number_pool:edit   update pool
//   DELETE /:id                       number_pool:edit   delete pool
//   GET    /:id/dids                  number_pool:read   list members
//   POST   /:id/dids                  number_pool:edit   add DID
//   DELETE /:id/dids/:didId           number_pool:edit   remove DID
//   GET    /:id/dids/:didId/stats     number_pool:read   per-number stats
//   POST   /:id/dids/:didId/quarantine    number_pool:edit   quarantine
//   POST   /:id/dids/:didId/unquarantine  number_pool:edit   unquarantine
//   GET    /:id/stats                 number_pool:read   pool stats

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  PoolCreateSchema,
  PoolUpdateSchema,
  PoolListQuerySchema,
  DidMemberListQuerySchema,
  AddDidSchema,
  QuarantineDidSchema,
} from "./schema.js";
import {
  listPools,
  getPool,
  createPool,
  updatePool,
  deletePool,
} from "./service.js";
import {
  listPoolDids,
  addDidToPool,
  removeDidFromPool,
  getDidStats,
  quarantineDid,
  unquarantineDid,
} from "./did-service.js";
import { getPoolStats } from "./stats-service.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function parseId(raw: unknown, name = "id"): bigint {
  const n = BigInt(String(raw));
  if (n <= 0n) throw new Error(`Invalid ${name}`);
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminNumberPoolRoutes(app: any): Promise<void> {
  const BASE = "/api/admin/number-pools";

  // GET /api/admin/number-pools
  app.get(
    BASE,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = PoolListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      return reply.send(await listPools(auth.tenantId, parsed.data));
    },
  );

  // POST /api/admin/number-pools
  app.post(
    BASE,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = PoolCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const pool = await createPool(auth.tenantId, auth.uid, parsed.data);
        return reply.code(201).send(pool);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "A pool with this name already exists" });
        }
        throw err;
      }
    },
  );

  // GET /api/admin/number-pools/:id
  app.get(
    `${BASE}/:id`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pool ID" });
      }
      const pool = await getPool(auth.tenantId, id);
      if (!pool) return reply.code(404).send({ code: "not_found", message: "Pool not found" });
      return reply.send(pool);
    },
  );

  // PATCH /api/admin/number-pools/:id
  app.patch(
    `${BASE}/:id`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pool ID" });
      }
      const parsed = PoolUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const updated = await updatePool(auth.tenantId, auth.uid, id, parsed.data);
        if (!updated) return reply.code(404).send({ code: "not_found", message: "Pool not found" });
        return reply.send(updated);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "A pool with this name already exists" });
        }
        throw err;
      }
    },
  );

  // DELETE /api/admin/number-pools/:id
  app.delete(
    `${BASE}/:id`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pool ID" });
      }
      const result = await deletePool(auth.tenantId, auth.uid, id);
      if (result.conflict) {
        return reply.code(409).send({ code: "conflict", message: "Pool is referenced by one or more campaigns" });
      }
      if (!result.deleted) {
        return reply.code(404).send({ code: "not_found", message: "Pool not found" });
      }
      return reply.code(204).send();
    },
  );

  // GET /api/admin/number-pools/:id/stats
  app.get(
    `${BASE}/:id/stats`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pool ID" });
      }
      const stats = await getPoolStats(auth.tenantId, id);
      if (!stats) return reply.code(404).send({ code: "not_found", message: "Pool not found" });
      return reply.send(stats);
    },
  );

  // GET /api/admin/number-pools/:id/dids
  app.get(
    `${BASE}/:id/dids`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pool ID" });
      }
      const parsed = DidMemberListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      return reply.send(await listPoolDids(auth.tenantId, id, parsed.data));
    },
  );

  // POST /api/admin/number-pools/:id/dids
  app.post(
    `${BASE}/:id/dids`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pool ID" });
      }
      const parsed = AddDidSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await addDidToPool(auth.tenantId, auth.uid, id, parsed.data);
      if ("error" in result) {
        return reply.code(result.status).send({ code: result.status === 409 ? "conflict" : "not_found", message: result.error });
      }
      return reply.code(201).send(result);
    },
  );

  // DELETE /api/admin/number-pools/:id/dids/:didId
  app.delete(
    `${BASE}/:id/dids/:didId`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; didId: string };
      let id: bigint;
      let didId: bigint;
      try {
        id = parseId(params.id);
        didId = parseId(params.didId, "didId");
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid ID" });
      }
      const result = await removeDidFromPool(auth.tenantId, auth.uid, id, didId);
      if (!result.removed) return reply.code(404).send({ code: "not_found", message: "DID membership not found" });
      return reply.code(204).send();
    },
  );

  // GET /api/admin/number-pools/:id/dids/:didId/stats
  app.get(
    `${BASE}/:id/dids/:didId/stats`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; didId: string };
      let id: bigint;
      let didId: bigint;
      try {
        id = parseId(params.id);
        didId = parseId(params.didId, "didId");
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid ID" });
      }
      const stats = await getDidStats(auth.tenantId, id, didId);
      if (!stats) return reply.code(404).send({ code: "not_found", message: "DID membership not found" });
      return reply.send(stats);
    },
  );

  // POST /api/admin/number-pools/:id/dids/:didId/quarantine
  app.post(
    `${BASE}/:id/dids/:didId/quarantine`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; didId: string };
      let id: bigint;
      let didId: bigint;
      try {
        id = parseId(params.id);
        didId = parseId(params.didId, "didId");
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid ID" });
      }
      const parsed = QuarantineDidSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await quarantineDid(auth.tenantId, auth.uid, id, didId, parsed.data);
      if (!result.ok) return reply.code(404).send({ code: "not_found", message: "DID membership not found" });
      return reply.code(204).send();
    },
  );

  // POST /api/admin/number-pools/:id/dids/:didId/unquarantine
  app.post(
    `${BASE}/:id/dids/:didId/unquarantine`,
    { preHandler: [app.requireAuth, app.requirePermission("number_pool:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; didId: string };
      let id: bigint;
      let didId: bigint;
      try {
        id = parseId(params.id);
        didId = parseId(params.didId, "didId");
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid ID" });
      }
      const result = await unquarantineDid(auth.tenantId, auth.uid, id, didId);
      if (!result.ok) return reply.code(404).send({ code: "not_found", message: "DID membership not found" });
      return reply.code(204).send();
    },
  );
}
