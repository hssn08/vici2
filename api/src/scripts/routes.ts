// S03 — Admin script management route registration.
//
// Route map (all require admin+ auth unless noted):
//   GET    /api/admin/scripts                       script:read
//   POST   /api/admin/scripts                       script:edit
//   GET    /api/admin/scripts/:id                   script:read
//   PATCH  /api/admin/scripts/:id                   script:edit
//   DELETE /api/admin/scripts/:id                   script:edit
//   POST   /api/admin/scripts/:id/render            script:read
//   GET    /api/admin/scripts/:id/versions          script:read
//   GET    /api/admin/scripts/:id/versions/:v       script:read

import { z } from "zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../auth/middleware.js";
import {
  listScripts,
  getScript,
  createScript,
  updateScript,
  deleteScript,
  renderScript,
  listScriptVersions,
  getScriptVersion,
} from "./service.js";

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function parseId(raw: unknown): bigint {
  const n = BigInt(String(raw));
  if (n <= 0n) throw new Error("Invalid id");
  return n;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const ScriptCreateSchema = z.object({
  name: z.string().min(1).max(64),
  body: z.string().min(0).max(65535),
  campaignId: z.string().max(32).nullable().optional(),
  active: z.boolean().optional(),
});

const ScriptUpdateSchema = z
  .object({
    name: z.string().min(1).max(64).optional(),
    body: z.string().min(0).max(65535).optional(),
    campaignId: z.string().max(32).nullable().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const ScriptListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  campaignId: z.string().max(32).optional(),
  active: z
    .string()
    .transform((v) => (v === "true" ? true : v === "false" ? false : undefined))
    .optional(),
  search: z.string().max(64).optional(),
});

const RenderBodySchema = z.object({
  lead_id: z.string().optional(),
  call_uuid: z.string().uuid().optional(),
  call_started_at: z.string().datetime({ offset: true }).optional(),
  mode: z.enum(["render", "preview"]).optional(),
});

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerScriptRoutes(app: any): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/admin/scripts
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/scripts",
    { preHandler: [app.requireAuth, app.requirePermission("script:read")] },
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

  // -------------------------------------------------------------------------
  // POST /api/admin/scripts
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/scripts",
    { preHandler: [app.requireAuth, app.requirePermission("script:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = ScriptCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const script = await createScript(auth.tenantId, parsed.data);
      return reply.code(201).send(script);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/scripts/:id
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/scripts/:id",
    { preHandler: [app.requireAuth, app.requirePermission("script:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id" });
      }
      const script = await getScript(auth.tenantId, id);
      if (!script) return reply.code(404).send({ code: "not_found" });
      return reply.send(script);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/scripts/:id
  // -------------------------------------------------------------------------
  app.patch(
    "/api/admin/scripts/:id",
    { preHandler: [app.requireAuth, app.requirePermission("script:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id" });
      }
      const parsed = ScriptUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const script = await updateScript(auth.tenantId, id, parsed.data);
      if (!script) return reply.code(404).send({ code: "not_found" });
      return reply.send(script);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/admin/scripts/:id  (soft-delete: active = false)
  // -------------------------------------------------------------------------
  app.delete(
    "/api/admin/scripts/:id",
    { preHandler: [app.requireAuth, app.requirePermission("script:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id" });
      }
      const ok = await deleteScript(auth.tenantId, id);
      if (!ok) return reply.code(404).send({ code: "not_found" });
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/scripts/:id/render
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/scripts/:id/render",
    { preHandler: [app.requireAuth, app.requirePermission("script:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id" });
      }
      const parsed = RenderBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const { lead_id, call_uuid, call_started_at, mode } = parsed.data;
      const result = await renderScript(auth.tenantId, id, {
        leadId: lead_id ? BigInt(lead_id) : null,
        callUuid: call_uuid ?? null,
        callStartedAt: call_started_at ?? null,
        agentName: auth.rawClaims?.sub ?? "",
        mode: mode ?? "render",
      });
      if (!result) return reply.code(404).send({ code: "not_found" });
      return reply.send(result);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/scripts/:id/versions
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/scripts/:id/versions",
    { preHandler: [app.requireAuth, app.requirePermission("script:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id" });
      }
      const versions = await listScriptVersions(auth.tenantId, id);
      return reply.send({ data: versions });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/scripts/:id/versions/:v
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/scripts/:id/versions/:v",
    { preHandler: [app.requireAuth, app.requirePermission("script:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string; v: string };
      let id: bigint;
      let vNum: number;
      try {
        id = parseId(params.id);
        vNum = parseInt(params.v, 10);
        if (!Number.isFinite(vNum) || vNum < 1) throw new Error("bad v");
      } catch {
        return reply.code(400).send({ code: "invalid_params" });
      }
      const sv = await getScriptVersion(auth.tenantId, id, vNum);
      if (!sv) return reply.code(404).send({ code: "not_found" });
      return reply.send(sv);
    },
  );
}
