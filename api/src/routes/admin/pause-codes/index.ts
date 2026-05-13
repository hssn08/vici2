// M07 — Admin pause code route registration.
//
// Route map:
//   GET    /api/admin/pause-codes          admin+  list pause codes
//   POST   /api/admin/pause-codes          admin+  create pause code
//   GET    /api/admin/pause-codes/:id      admin+  get one
//   PATCH  /api/admin/pause-codes/:id      admin+  update
//   DELETE /api/admin/pause-codes/:id      admin+  delete

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  PauseCodeListQuerySchema,
  PauseCodeCreateSchema,
  PauseCodeUpdateSchema,
} from "./schema.js";
import {
  listPauseCodes,
  getPauseCode,
  createPauseCode,
  updatePauseCode,
  deletePauseCode,
} from "./service.js";
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
export async function registerAdminPauseCodeRoutes(app: any): Promise<void> {
  // GET /api/admin/pause-codes
  app.get(
    "/api/admin/pause-codes",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = PauseCodeListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await listPauseCodes(auth.tenantId, parsed.data);
      return reply.send(result);
    },
  );

  // POST /api/admin/pause-codes
  app.post(
    "/api/admin/pause-codes",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = PauseCodeCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const created = await createPauseCode(auth.tenantId, auth.uid, parsed.data);
        return reply.code(201).send(created);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "A pause code with this code already exists in this scope" });
        }
        throw err;
      }
    },
  );

  // GET /api/admin/pause-codes/:id
  app.get(
    "/api/admin/pause-codes/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let pcId: bigint;
      try { pcId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pause code ID" });
      }
      const pc = await getPauseCode(auth.tenantId, pcId);
      if (!pc) return reply.code(404).send({ code: "not_found", message: "Pause code not found" });
      return reply.send(pc);
    },
  );

  // PATCH /api/admin/pause-codes/:id
  app.patch(
    "/api/admin/pause-codes/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let pcId: bigint;
      try { pcId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pause code ID" });
      }
      const parsed = PauseCodeUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const updated = await updatePauseCode(auth.tenantId, auth.uid, pcId, parsed.data);
        if (!updated) return reply.code(404).send({ code: "not_found", message: "Pause code not found" });
        return reply.send(updated);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "A pause code with this code already exists in this scope" });
        }
        throw err;
      }
    },
  );

  // DELETE /api/admin/pause-codes/:id
  app.delete(
    "/api/admin/pause-codes/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let pcId: bigint;
      try { pcId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid pause code ID" });
      }
      const deleted = await deletePauseCode(auth.tenantId, auth.uid, pcId);
      if (!deleted) return reply.code(404).send({ code: "not_found", message: "Pause code not found" });
      return reply.code(204).send();
    },
  );
}
