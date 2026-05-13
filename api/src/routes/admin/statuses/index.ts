// M07 — Admin status route registration.
//
// Route map:
//   GET    /api/admin/statuses                       admin+  list statuses
//   POST   /api/admin/statuses                       admin+  create status
//   GET    /api/admin/statuses/:campaignId/:code     admin+  get one
//   PATCH  /api/admin/statuses/:campaignId/:code     admin+  update
//   DELETE /api/admin/statuses/:campaignId/:code     admin+  delete (system-owned blocked)

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  StatusListQuerySchema,
  StatusCreateSchema,
  StatusUpdateSchema,
} from "./schema.js";
import {
  listStatuses,
  getStatus,
  createStatus,
  updateStatus,
  deleteStatus,
} from "./service.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminStatusRoutes(app: any): Promise<void> {
  // GET /api/admin/statuses
  app.get(
    "/api/admin/statuses",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = StatusListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await listStatuses(auth.tenantId, parsed.data);
      return reply.send(result);
    },
  );

  // POST /api/admin/statuses
  app.post(
    "/api/admin/statuses",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = StatusCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const { result, hotkeyConflict } = await createStatus(auth.tenantId, auth.uid, parsed.data);
        if (hotkeyConflict) {
          return reply.code(409).send({
            code: "hotkey_conflict",
            message: `Hotkey already used by status ${hotkeyConflict} in this campaign`,
          });
        }
        return reply.code(201).send(result);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "status_exists", message: "A status with this code already exists in this campaign scope" });
        }
        throw err;
      }
    },
  );

  // GET /api/admin/statuses/:campaignId/:code
  app.get(
    "/api/admin/statuses/:campaignId/:code",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { campaignId: string; code: string };
      const status = await getStatus(auth.tenantId, params.campaignId, params.code);
      if (!status) return reply.code(404).send({ code: "not_found", message: "Status not found" });
      return reply.send(status);
    },
  );

  // PATCH /api/admin/statuses/:campaignId/:code
  app.patch(
    "/api/admin/statuses/:campaignId/:code",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { campaignId: string; code: string };
      const parsed = StatusUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const { result, hotkeyConflict } = await updateStatus(
          auth.tenantId,
          auth.uid,
          params.campaignId,
          params.code,
          parsed.data,
        );
        if (hotkeyConflict) {
          return reply.code(409).send({
            code: "hotkey_conflict",
            message: `Hotkey already used by status ${hotkeyConflict} in this campaign`,
          });
        }
        if (result === null) {
          return reply.code(404).send({ code: "not_found", message: "Status not found" });
        }
        return reply.send(result);
      } catch (err) {
        const e = err as { code?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "status_exists", message: "A status with this code already exists in this campaign scope" });
        }
        throw err;
      }
    },
  );

  // DELETE /api/admin/statuses/:campaignId/:code
  app.delete(
    "/api/admin/statuses/:campaignId/:code",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { campaignId: string; code: string };
      const result = await deleteStatus(auth.tenantId, auth.uid, params.campaignId, params.code);
      if ("notFound" in result) {
        return reply.code(404).send({ code: "not_found", message: "Status not found" });
      }
      if ("systemProtected" in result) {
        return reply.code(403).send({
          code: "system_protected",
          message: `Status ${params.code} is owned by system module '${result.systemProtected}' and cannot be deleted.`,
        });
      }
      return reply.code(204).send();
    },
  );
}
