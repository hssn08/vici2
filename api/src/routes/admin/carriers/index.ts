// M06 — Admin carrier + gateway route registration.
//
// Route map:
//   GET    /api/admin/carriers                           admin+  carriers:read
//   POST   /api/admin/carriers                           super_admin  carriers:write
//   GET    /api/admin/carriers/:id                       admin+
//   PATCH  /api/admin/carriers/:id                       super_admin
//   DELETE /api/admin/carriers/:id                       super_admin
//   POST   /api/admin/carriers/:id/test-connect          admin+
//   GET    /api/admin/carriers/:id/gateways              admin+
//   POST   /api/admin/carriers/:id/gateways              super_admin
//   GET    /api/admin/carriers/:id/gateways/:gwId        admin+
//   PATCH  /api/admin/carriers/:id/gateways/:gwId        super_admin
//   DELETE /api/admin/carriers/:id/gateways/:gwId        super_admin
//   POST   /api/admin/carriers/:id/gateways/:gwId/reload super_admin
//   GET    /api/admin/carriers/:id/health                admin+

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  CarrierCreateSchema,
  CarrierUpdateSchema,
  CarrierListQuerySchema,
  GatewayCreateSchema,
  GatewayUpdateSchema,
} from "./schema.js";
import {
  listCarriers,
  getCarrier,
  createCarrier,
  updateCarrier,
  deleteCarrier,
  listGateways,
  getGateway,
  createGateway,
  updateGateway,
  deleteGateway,
  getCarrierHealth,
} from "./service.js";
import { testConnect, reloadGateway } from "./actions.js";
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

function isSuperAdmin(auth: AuthContext): boolean {
  return auth.role === "super_admin";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminCarrierRoutes(app: any): Promise<void> {
  // ─── Carriers ─────────────────────────────────────────────────────────────

  // GET /api/admin/carriers
  app.get(
    "/api/admin/carriers",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = CarrierListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await listCarriers(auth.tenantId, parsed.data);
      return reply.send(result);
    },
  );

  // POST /api/admin/carriers
  app.post(
    "/api/admin/carriers",
    { preHandler: [app.requireAuth, app.requireRole("super_admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = CarrierCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const carrier = await createCarrier(auth.tenantId, auth.uid, parsed.data);
        return reply.code(201).send(carrier);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "A carrier with this name already exists" });
        }
        throw err;
      }
    },
  );

  // GET /api/admin/carriers/:id
  app.get(
    "/api/admin/carriers/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let carrierId: bigint;
      try { carrierId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid carrier ID" });
      }
      const carrier = await getCarrier(auth.tenantId, carrierId);
      if (!carrier) return reply.code(404).send({ code: "not_found", message: "Carrier not found" });
      return reply.send(carrier);
    },
  );

  // PATCH /api/admin/carriers/:id
  app.patch(
    "/api/admin/carriers/:id",
    { preHandler: [app.requireAuth, app.requireRole("super_admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let carrierId: bigint;
      try { carrierId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid carrier ID" });
      }
      const parsed = CarrierUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      // Credential fields require super_admin (already enforced by role check, but double-check)
      if ((parsed.data.username !== undefined || parsed.data.password !== undefined) && !isSuperAdmin(auth)) {
        return reply.code(403).send({ code: "forbidden", message: "Credential updates require super_admin" });
      }
      const updated = await updateCarrier(auth.tenantId, auth.uid, carrierId, parsed.data);
      if (!updated) return reply.code(404).send({ code: "not_found", message: "Carrier not found" });
      return reply.send(updated);
    },
  );

  // DELETE /api/admin/carriers/:id
  app.delete(
    "/api/admin/carriers/:id",
    { preHandler: [app.requireAuth, app.requireRole("super_admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let carrierId: bigint;
      try { carrierId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid carrier ID" });
      }
      const deleted = await deleteCarrier(auth.tenantId, auth.uid, carrierId);
      if (!deleted) return reply.code(404).send({ code: "not_found", message: "Carrier not found" });
      return reply.code(204).send();
    },
  );

  // POST /api/admin/carriers/:id/test-connect
  app.post(
    "/api/admin/carriers/:id/test-connect",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let carrierId: bigint;
      try { carrierId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid carrier ID" });
      }
      const result = await testConnect(auth.tenantId, auth.uid, carrierId);
      return reply.send(result);
    },
  );

  // GET /api/admin/carriers/:id/health
  app.get(
    "/api/admin/carriers/:id/health",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let carrierId: bigint;
      try { carrierId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid carrier ID" });
      }
      const health = await getCarrierHealth(auth.tenantId, carrierId);
      return reply.send(health);
    },
  );

  // ─── Gateways ─────────────────────────────────────────────────────────────

  // GET /api/admin/carriers/:id/gateways
  app.get(
    "/api/admin/carriers/:id/gateways",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let carrierId: bigint;
      try { carrierId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid carrier ID" });
      }
      const gateways = await listGateways(auth.tenantId, carrierId);
      return reply.send({ data: gateways });
    },
  );

  // POST /api/admin/carriers/:id/gateways
  app.post(
    "/api/admin/carriers/:id/gateways",
    { preHandler: [app.requireAuth, app.requireRole("super_admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let carrierId: bigint;
      try { carrierId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid carrier ID" });
      }
      const parsed = GatewayCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const gw = await createGateway(auth.tenantId, auth.uid, carrierId, parsed.data);
        return reply.code(201).send(gw);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "A gateway with this name already exists" });
        }
        throw err;
      }
    },
  );

  // GET /api/admin/carriers/:id/gateways/:gwId
  app.get(
    "/api/admin/carriers/:id/gateways/:gwId",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; gwId: string };
      let carrierId: bigint, gatewayId: bigint;
      try {
        carrierId = parseId(params.id);
        gatewayId = parseId(params.gwId, "gwId");
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid ID" });
      }
      const gw = await getGateway(auth.tenantId, carrierId, gatewayId);
      if (!gw) return reply.code(404).send({ code: "not_found", message: "Gateway not found" });
      return reply.send(gw);
    },
  );

  // PATCH /api/admin/carriers/:id/gateways/:gwId
  app.patch(
    "/api/admin/carriers/:id/gateways/:gwId",
    { preHandler: [app.requireAuth, app.requireRole("super_admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; gwId: string };
      let carrierId: bigint, gatewayId: bigint;
      try {
        carrierId = parseId(params.id);
        gatewayId = parseId(params.gwId, "gwId");
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid ID" });
      }
      const parsed = GatewayUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const updated = await updateGateway(auth.tenantId, auth.uid, carrierId, gatewayId, parsed.data);
      if (!updated) return reply.code(404).send({ code: "not_found", message: "Gateway not found" });
      return reply.send(updated);
    },
  );

  // DELETE /api/admin/carriers/:id/gateways/:gwId
  app.delete(
    "/api/admin/carriers/:id/gateways/:gwId",
    { preHandler: [app.requireAuth, app.requireRole("super_admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; gwId: string };
      let carrierId: bigint, gatewayId: bigint;
      try {
        carrierId = parseId(params.id);
        gatewayId = parseId(params.gwId, "gwId");
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid ID" });
      }
      const deleted = await deleteGateway(auth.tenantId, auth.uid, carrierId, gatewayId);
      if (!deleted) return reply.code(404).send({ code: "not_found", message: "Gateway not found" });
      return reply.code(204).send();
    },
  );

  // POST /api/admin/carriers/:id/gateways/:gwId/reload
  app.post(
    "/api/admin/carriers/:id/gateways/:gwId/reload",
    { preHandler: [app.requireAuth, app.requireRole("super_admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; gwId: string };
      let carrierId: bigint, gatewayId: bigint;
      try {
        carrierId = parseId(params.id);
        gatewayId = parseId(params.gwId, "gwId");
      } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid ID" });
      }
      const result = await reloadGateway(auth.tenantId, auth.uid, carrierId, gatewayId);
      if (!result) return reply.code(404).send({ code: "not_found", message: "Gateway not found" });
      return reply.send(result);
    },
  );
}
