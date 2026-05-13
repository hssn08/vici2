// M07 — Admin script route registration.
//
// Route map:
//   GET    /api/admin/scripts                         script:read   list scripts
//   POST   /api/admin/scripts                         script:edit   create script
//   GET    /api/admin/scripts/:id                     script:read   get one
//   PATCH  /api/admin/scripts/:id                     script:edit   update (bumps version)
//   DELETE /api/admin/scripts/:id                     script:edit   soft-delete
//   GET    /api/admin/scripts/:id/versions            script:read   list version history
//   POST   /api/admin/scripts/:id/restore/:version    script:edit   restore version
//   POST   /api/admin/scripts/:id/render              script:read   render with sample data

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  ScriptListQuerySchema,
  ScriptCreateSchema,
  ScriptUpdateSchema,
  ScriptRenderSchema,
} from "./schema.js";
import {
  listScripts,
  getScript,
  createScript,
  updateScript,
  deleteScript,
  listScriptVersions,
  restoreScriptVersion,
  renderScript,
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
export async function registerAdminScriptRoutes(app: any): Promise<void> {
  // NOTE: specific sub-paths must be registered before /:id to avoid conflicts

  // GET /api/admin/scripts
  app.get(
    "/api/admin/scripts",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = ScriptListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await listScripts(auth.tenantId, parsed.data);
      return reply.send(result);
    },
  );

  // POST /api/admin/scripts
  app.post(
    "/api/admin/scripts",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = ScriptCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const created = await createScript(auth.tenantId, auth.uid, parsed.data);
      return reply.code(201).send(created);
    },
  );

  // GET /api/admin/scripts/:id/versions (before /:id)
  app.get(
    "/api/admin/scripts/:id/versions",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let scriptId: bigint;
      try { scriptId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid script ID" });
      }
      const versions = await listScriptVersions(auth.tenantId, scriptId);
      if (versions === null) {
        return reply.code(404).send({ code: "not_found", message: "Script not found" });
      }
      return reply.send({ data: versions });
    },
  );

  // POST /api/admin/scripts/:id/restore/:version (before /:id)
  app.post(
    "/api/admin/scripts/:id/restore/:version",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; version: string };
      let scriptId: bigint;
      try { scriptId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid script ID" });
      }
      const versionNumber = parseInt(params.version, 10);
      if (isNaN(versionNumber) || versionNumber < 1) {
        return reply.code(400).send({ code: "invalid_version", message: "Invalid version number" });
      }
      const result = await restoreScriptVersion(auth.tenantId, auth.uid, scriptId, versionNumber);
      if (!result) return reply.code(404).send({ code: "not_found", message: "Script or version not found" });
      return reply.send(result);
    },
  );

  // POST /api/admin/scripts/:id/render (before /:id)
  app.post(
    "/api/admin/scripts/:id/render",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let scriptId: bigint;
      try { scriptId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid script ID" });
      }
      const parsed = ScriptRenderSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await renderScript(auth.tenantId, scriptId, parsed.data);
      if (!result) return reply.code(404).send({ code: "not_found", message: "Script not found" });
      return reply.send(result);
    },
  );

  // GET /api/admin/scripts/:id
  app.get(
    "/api/admin/scripts/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let scriptId: bigint;
      try { scriptId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid script ID" });
      }
      const script = await getScript(auth.tenantId, scriptId);
      if (!script) return reply.code(404).send({ code: "not_found", message: "Script not found" });
      return reply.send(script);
    },
  );

  // PATCH /api/admin/scripts/:id
  app.patch(
    "/api/admin/scripts/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let scriptId: bigint;
      try { scriptId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid script ID" });
      }
      const parsed = ScriptUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const updated = await updateScript(auth.tenantId, auth.uid, scriptId, parsed.data);
      if (!updated) return reply.code(404).send({ code: "not_found", message: "Script not found" });
      return reply.send(updated);
    },
  );

  // DELETE /api/admin/scripts/:id
  app.delete(
    "/api/admin/scripts/:id",
    { preHandler: [app.requireAuth, app.requireRole("admin")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let scriptId: bigint;
      try { scriptId = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid script ID" });
      }
      const deleted = await deleteScript(auth.tenantId, auth.uid, scriptId);
      if (!deleted) return reply.code(404).send({ code: "not_found", message: "Script not found" });
      return reply.code(204).send();
    },
  );
}
