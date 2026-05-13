// I02 — Admin routes for IVR engine.
//
// Route map (all require admin+ auth):
//   GET    /api/admin/ivrs                                     list IVRs
//   POST   /api/admin/ivrs                                     create IVR
//   GET    /api/admin/ivrs/:ivrId                              get detail
//   PUT    /api/admin/ivrs/:ivrId                              update IVR metadata
//   DELETE /api/admin/ivrs/:ivrId                              soft-delete IVR
//
//   POST   /api/admin/ivrs/:ivrId/nodes                        create node
//   PUT    /api/admin/ivrs/:ivrId/nodes/:nodeId                update node
//   DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId                delete node
//
//   POST   /api/admin/ivrs/:ivrId/nodes/:nodeId/edges          create edge
//   PUT    /api/admin/ivrs/:ivrId/nodes/:nodeId/edges/:edgeId  update edge
//   DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId/edges/:edgeId  delete edge
//
//   POST   /api/admin/ivrs/:ivrId/nodes/:nodeId/prompts        upload prompt
//   DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId/prompts/:pId   delete prompt
//
//   GET    /api/admin/ivrs/:ivrId/analytics                    analytics
//
//   PUT    /api/admin/did-numbers/:didId/ivr                   assign IVR to DID

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma.js";
import { getIvrRenderer } from "../../services/ivr/IvrRenderer.js";
import { uploadPrompt, PromptUploadError } from "../../services/ivr/PromptUploader.js";
import { IvrValidationError } from "../../services/ivr/IvrValidator.js";
import type { AuthContext } from "../../auth/middleware.js";

const prisma = getPrisma();

type AuthReq = FastifyRequest & { auth?: AuthContext };
function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const IvrCreateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(2000).optional().nullable(),
});

const IvrUpdateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().max(2000).optional().nullable(),
  active: z.boolean().optional(),
});

const NodeTypeEnum = z.enum([
  "collect",
  "lang_select",
  "terminal_ingroup",
  "terminal_hangup",
  "terminal_voicemail",
  "terminal_transfer",
  "terminal_callback",
]);

const NodeCreateSchema = z.object({
  name: z.string().min(1).max(128),
  nodeType: NodeTypeEnum,
  collectMin: z.number().int().min(1).max(9).default(1),
  collectMax: z.number().int().min(1).max(9).default(1),
  collectTerminators: z.string().max(8).default("none"),
  timeoutMs: z.number().int().min(500).max(30000).default(5000),
  interDigitMs: z.number().int().min(100).max(10000).default(3000),
  invalidMax: z.number().int().min(1).max(9).default(3),
  actionTarget: z.string().max(128).optional().nullable(),
  positionX: z.number().int().default(0),
  positionY: z.number().int().default(0),
  isEntryNode: z.boolean().default(false),
});

const NodeUpdateSchema = NodeCreateSchema.partial();

const EdgeCreateSchema = z.object({
  onInput: z.string().min(1).max(16),
  toNodeId: z.coerce.bigint().optional().nullable(),
  label: z.string().max(64).optional().nullable(),
  sortOrder: z.number().int().min(0).max(255).default(0),
});

const EdgeUpdateSchema = EdgeCreateSchema.partial();

// ─── Serializers ─────────────────────────────────────────────────────────────

function serializeIvr(ivr: Record<string, unknown>): Record<string, unknown> {
  return {
    ...ivr,
    id: String(ivr.id),
    tenantId: String(ivr.tenantId),
    entryNodeId: ivr.entryNodeId ? String(ivr.entryNodeId) : null,
  };
}

function serializeNode(n: Record<string, unknown>): Record<string, unknown> {
  return {
    ...n,
    id: String(n.id),
    tenantId: String(n.tenantId),
    ivrId: String(n.ivrId),
    edges: Array.isArray(n.edges) ? (n.edges as Record<string, unknown>[]).map(serializeEdge) : [],
    prompts: Array.isArray(n.prompts) ? (n.prompts as Record<string, unknown>[]).map(serializePrompt) : [],
  };
}

function serializeEdge(e: Record<string, unknown>): Record<string, unknown> {
  return {
    ...e,
    id: String(e.id),
    tenantId: String(e.tenantId),
    ivrId: String(e.ivrId),
    fromNodeId: String(e.fromNodeId),
    toNodeId: e.toNodeId ? String(e.toNodeId) : null,
  };
}

function serializePrompt(p: Record<string, unknown>): Record<string, unknown> {
  return {
    ...p,
    id: String(p.id),
    tenantId: String(p.tenantId),
    nodeId: String(p.nodeId),
  };
}

// ─── Render trigger + audit ───────────────────────────────────────────────────

async function triggerRender(ivrId: bigint): Promise<void> {
  try {
    await getIvrRenderer().render(ivrId);
  } catch (err) {
    // Log but don't re-throw — let the API response succeed, dialplan may lag
    if (err instanceof IvrValidationError) throw err;
    console.error("[IvrRenderer] render error:", err);
  }
}

async function triggerRemove(ivrId: bigint, tenantId: bigint): Promise<void> {
  try {
    await getIvrRenderer().remove(ivrId, tenantId);
  } catch {
    // Non-fatal
  }
}

// ─── Route registration ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminIvrRoutes(app: any): Promise<void> {

  // ── IVR CRUD ──────────────────────────────────────────────────────────────

  // GET /api/admin/ivrs
  app.get("/api/admin/ivrs",
    { preHandler: [app.requireAuth, app.requirePermission("user:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const ivrs = await (prisma as unknown as { ivr: { findMany: (q: unknown) => Promise<unknown[]> } }).ivr.findMany({
        where: { tenantId: BigInt(tenantId) },
        include: { _count: { select: { nodes: true } } },
        orderBy: { createdAt: "asc" },
      });
      return reply.send((ivrs as Record<string, unknown>[]).map(serializeIvr));
    },
  );

  // POST /api/admin/ivrs
  app.post("/api/admin/ivrs",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const parsed = IvrCreateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const ivr = await (prisma as unknown as { ivr: { create: (q: unknown) => Promise<unknown> } }).ivr.create({
        data: {
          tenantId: BigInt(tenantId),
          name: parsed.data.name,
          description: parsed.data.description ?? null,
        },
      });

      return reply.code(201).send(serializeIvr(ivr as Record<string, unknown>));
    },
  );

  // GET /api/admin/ivrs/:ivrId
  app.get("/api/admin/ivrs/:ivrId",
    { preHandler: [app.requireAuth, app.requirePermission("user:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId } = req.params as { ivrId: string };

      const ivr = await (prisma as unknown as { ivr: { findFirst: (q: unknown) => Promise<unknown> } }).ivr.findFirst({
        where: { id: BigInt(ivrId), tenantId: BigInt(tenantId) },
        include: {
          nodes: {
            include: {
              edgesFrom: true,
              prompts: true,
            },
          },
        },
      });
      if (!ivr) return reply.code(404).send({ code: "not_found" });

      const ivrRaw = ivr as Record<string, unknown>;
      const nodes = (ivrRaw.nodes as Record<string, unknown>[]).map((n) =>
        serializeNode({
          ...n,
          edges: n.edgesFrom,
        }),
      );
      return reply.send(serializeIvr({ ...ivrRaw, nodes }));
    },
  );

  // PUT /api/admin/ivrs/:ivrId
  app.put("/api/admin/ivrs/:ivrId",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId } = req.params as { ivrId: string };
      const parsed = IvrUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const ivr = await (prisma as unknown as { ivr: { updateMany: (q: unknown) => Promise<{ count: number }>, findFirst: (q: unknown) => Promise<unknown> } }).ivr.updateMany({
        where: { id: BigInt(ivrId), tenantId: BigInt(tenantId) },
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          ...(parsed.data.active !== undefined ? { active: parsed.data.active } : {}),
        },
      });
      if (!ivr || ivr.count === 0) return reply.code(404).send({ code: "not_found" });

      // Re-render after metadata change (active toggle removes XML)
      const updated = await (prisma as unknown as { ivr: { findFirst: (q: unknown) => Promise<unknown> } }).ivr.findFirst({
        where: { id: BigInt(ivrId), tenantId: BigInt(tenantId) },
      });

      const updatedRaw = updated as Record<string, unknown>;
      if (updatedRaw.active) {
        await triggerRender(BigInt(ivrId)).catch(() => undefined);
      } else {
        await triggerRemove(BigInt(ivrId), BigInt(tenantId));
      }

      return reply.send(serializeIvr(updatedRaw));
    },
  );

  // DELETE /api/admin/ivrs/:ivrId
  app.delete("/api/admin/ivrs/:ivrId",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId } = req.params as { ivrId: string };

      // Soft-delete: set active=false, remove XML
      const result = await (prisma as unknown as { ivr: { updateMany: (q: unknown) => Promise<{ count: number }> } }).ivr.updateMany({
        where: { id: BigInt(ivrId), tenantId: BigInt(tenantId) },
        data: { active: false },
      });
      if (!result || result.count === 0) return reply.code(404).send({ code: "not_found" });

      await triggerRemove(BigInt(ivrId), BigInt(tenantId));
      return reply.code(204).send();
    },
  );

  // ── Node CRUD ──────────────────────────────────────────────────────────────

  // POST /api/admin/ivrs/:ivrId/nodes
  app.post("/api/admin/ivrs/:ivrId/nodes",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId } = req.params as { ivrId: string };
      const parsed = NodeCreateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      // Verify IVR belongs to tenant
      const ivr = await (prisma as unknown as { ivr: { findFirst: (q: unknown) => Promise<unknown> } }).ivr.findFirst({
        where: { id: BigInt(ivrId), tenantId: BigInt(tenantId) },
      });
      if (!ivr) return reply.code(404).send({ code: "not_found" });

      const d = parsed.data;
      const node = await (prisma as unknown as { ivrNode: { create: (q: unknown) => Promise<unknown> } }).ivrNode.create({
        data: {
          tenantId: BigInt(tenantId),
          ivrId: BigInt(ivrId),
          name: d.name,
          nodeType: d.nodeType,
          collectMin: d.collectMin,
          collectMax: d.collectMax,
          collectTerminators: d.collectTerminators,
          timeoutMs: d.timeoutMs,
          interDigitMs: d.interDigitMs,
          invalidMax: d.invalidMax,
          actionTarget: d.actionTarget ?? null,
          positionX: d.positionX,
          positionY: d.positionY,
        },
      });

      const nodeRaw = node as Record<string, unknown>;

      // If first node or explicitly set as entry, update ivr.entry_node_id
      const ivrRaw = ivr as Record<string, unknown>;
      if (d.isEntryNode || !ivrRaw.entryNodeId) {
        await (prisma as unknown as { ivr: { update: (q: unknown) => Promise<unknown> } }).ivr.update({
          where: { id: BigInt(ivrId) },
          data: { entryNodeId: nodeRaw.id as bigint },
        });
      }

      // Re-render (may fail if tree is incomplete — tolerate)
      await triggerRender(BigInt(ivrId)).catch(() => undefined);

      return reply.code(201).send(serializeNode({ ...nodeRaw, edges: [], prompts: [] }));
    },
  );

  // PUT /api/admin/ivrs/:ivrId/nodes/:nodeId
  app.put("/api/admin/ivrs/:ivrId/nodes/:nodeId",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId, nodeId } = req.params as { ivrId: string; nodeId: string };
      const parsed = NodeUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const result = await (prisma as unknown as { ivrNode: { updateMany: (q: unknown) => Promise<{ count: number }> } }).ivrNode.updateMany({
        where: { id: BigInt(nodeId), tenantId: BigInt(tenantId), ivrId: BigInt(ivrId) },
        data: {
          ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
          ...(parsed.data.nodeType !== undefined ? { nodeType: parsed.data.nodeType } : {}),
          ...(parsed.data.collectMin !== undefined ? { collectMin: parsed.data.collectMin } : {}),
          ...(parsed.data.collectMax !== undefined ? { collectMax: parsed.data.collectMax } : {}),
          ...(parsed.data.collectTerminators !== undefined ? { collectTerminators: parsed.data.collectTerminators } : {}),
          ...(parsed.data.timeoutMs !== undefined ? { timeoutMs: parsed.data.timeoutMs } : {}),
          ...(parsed.data.invalidMax !== undefined ? { invalidMax: parsed.data.invalidMax } : {}),
          ...(parsed.data.actionTarget !== undefined ? { actionTarget: parsed.data.actionTarget } : {}),
          ...(parsed.data.positionX !== undefined ? { positionX: parsed.data.positionX } : {}),
          ...(parsed.data.positionY !== undefined ? { positionY: parsed.data.positionY } : {}),
        },
      });
      if (!result || result.count === 0) return reply.code(404).send({ code: "not_found" });

      const updated = await (prisma as unknown as { ivrNode: { findFirst: (q: unknown) => Promise<unknown> } }).ivrNode.findFirst({
        where: { id: BigInt(nodeId), tenantId: BigInt(tenantId) },
        include: { edgesFrom: true, prompts: true },
      });

      await triggerRender(BigInt(ivrId)).catch(() => undefined);
      const updatedRaw = updated as Record<string, unknown>;
      return reply.send(serializeNode({ ...updatedRaw, edges: updatedRaw.edgesFrom }));
    },
  );

  // DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId
  app.delete("/api/admin/ivrs/:ivrId/nodes/:nodeId",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId, nodeId } = req.params as { ivrId: string; nodeId: string };

      const result = await (prisma as unknown as { ivrNode: { deleteMany: (q: unknown) => Promise<{ count: number }> } }).ivrNode.deleteMany({
        where: { id: BigInt(nodeId), tenantId: BigInt(tenantId), ivrId: BigInt(ivrId) },
      });
      if (!result || result.count === 0) return reply.code(404).send({ code: "not_found" });

      // If this was the entry node, clear it
      const ivr = await (prisma as unknown as { ivr: { findFirst: (q: unknown) => Promise<unknown> } }).ivr.findFirst({
        where: { id: BigInt(ivrId), entryNodeId: BigInt(nodeId) },
      });
      if (ivr) {
        await (prisma as unknown as { ivr: { update: (q: unknown) => Promise<unknown> } }).ivr.update({
          where: { id: BigInt(ivrId) },
          data: { entryNodeId: null },
        });
      }

      await triggerRender(BigInt(ivrId)).catch(() => undefined);
      return reply.code(204).send();
    },
  );

  // ── Edge CRUD ──────────────────────────────────────────────────────────────

  // POST /api/admin/ivrs/:ivrId/nodes/:nodeId/edges
  app.post("/api/admin/ivrs/:ivrId/nodes/:nodeId/edges",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId, nodeId } = req.params as { ivrId: string; nodeId: string };
      const parsed = EdgeCreateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const d = parsed.data;
      const edge = await (prisma as unknown as { ivrEdge: { create: (q: unknown) => Promise<unknown> } }).ivrEdge.create({
        data: {
          tenantId: BigInt(tenantId),
          ivrId: BigInt(ivrId),
          fromNodeId: BigInt(nodeId),
          onInput: d.onInput,
          toNodeId: d.toNodeId ?? null,
          label: d.label ?? null,
          sortOrder: d.sortOrder,
        },
      });

      await triggerRender(BigInt(ivrId)).catch(() => undefined);
      return reply.code(201).send(serializeEdge(edge as Record<string, unknown>));
    },
  );

  // PUT /api/admin/ivrs/:ivrId/nodes/:nodeId/edges/:edgeId
  app.put("/api/admin/ivrs/:ivrId/nodes/:nodeId/edges/:edgeId",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId, edgeId } = req.params as { ivrId: string; nodeId: string; edgeId: string };
      const parsed = EdgeUpdateSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const result = await (prisma as unknown as { ivrEdge: { updateMany: (q: unknown) => Promise<{ count: number }> } }).ivrEdge.updateMany({
        where: { id: BigInt(edgeId), tenantId: BigInt(tenantId) },
        data: {
          ...(parsed.data.onInput !== undefined ? { onInput: parsed.data.onInput } : {}),
          ...(parsed.data.toNodeId !== undefined ? { toNodeId: parsed.data.toNodeId } : {}),
          ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
          ...(parsed.data.sortOrder !== undefined ? { sortOrder: parsed.data.sortOrder } : {}),
        },
      });
      if (!result || result.count === 0) return reply.code(404).send({ code: "not_found" });

      const updated = await (prisma as unknown as { ivrEdge: { findFirst: (q: unknown) => Promise<unknown> } }).ivrEdge.findFirst({
        where: { id: BigInt(edgeId) },
      });
      await triggerRender(BigInt(ivrId)).catch(() => undefined);
      return reply.send(serializeEdge(updated as Record<string, unknown>));
    },
  );

  // DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId/edges/:edgeId
  app.delete("/api/admin/ivrs/:ivrId/nodes/:nodeId/edges/:edgeId",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId, edgeId } = req.params as { ivrId: string; nodeId: string; edgeId: string };

      const result = await (prisma as unknown as { ivrEdge: { deleteMany: (q: unknown) => Promise<{ count: number }> } }).ivrEdge.deleteMany({
        where: { id: BigInt(edgeId), tenantId: BigInt(tenantId) },
      });
      if (!result || result.count === 0) return reply.code(404).send({ code: "not_found" });

      await triggerRender(BigInt(ivrId)).catch(() => undefined);
      return reply.code(204).send();
    },
  );

  // ── Prompt upload ──────────────────────────────────────────────────────────

  // POST /api/admin/ivrs/:ivrId/nodes/:nodeId/prompts
  app.post("/api/admin/ivrs/:ivrId/nodes/:nodeId/prompts",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId, nodeId } = req.params as { ivrId: string; nodeId: string };

      // Parse multipart — body should have file + lang
      const body = req.body as Record<string, unknown>;
      const lang = String(body.lang ?? "en");
      const file = body.file as { filename?: string; mimetype?: string; data?: Buffer } | undefined;

      if (!file || !file.data) {
        return reply.code(400).send({ code: "missing_file", message: "field 'file' is required" });
      }

      try {
        const result = await uploadPrompt({
          tenantId: BigInt(tenantId),
          ivrId: BigInt(ivrId),
          nodeId: BigInt(nodeId),
          lang,
          fileName: file.filename ?? "prompt.wav",
          mimeType: file.mimetype ?? "audio/wav",
          fileBuffer: file.data,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof PromptUploadError) {
          const statusMap: Record<string, number> = {
            too_large: 413,
            invalid_type: 415,
            too_long: 422,
            conversion_failed: 422,
            upload_failed: 502,
          };
          return reply.code(statusMap[err.code] ?? 422).send({ code: err.code, message: err.message });
        }
        throw err;
      }
    },
  );

  // DELETE /api/admin/ivrs/:ivrId/nodes/:nodeId/prompts/:promptId
  app.delete("/api/admin/ivrs/:ivrId/nodes/:nodeId/prompts/:promptId",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { promptId } = req.params as { promptId: string };

      const result = await (prisma as unknown as { ivrPrompt: { deleteMany: (q: unknown) => Promise<{ count: number }> } }).ivrPrompt.deleteMany({
        where: { id: BigInt(promptId), tenantId: BigInt(tenantId) },
      });
      if (!result || result.count === 0) return reply.code(404).send({ code: "not_found" });
      return reply.code(204).send();
    },
  );

  // ── Analytics ──────────────────────────────────────────────────────────────

  // GET /api/admin/ivrs/:ivrId/analytics
  app.get("/api/admin/ivrs/:ivrId/analytics",
    { preHandler: [app.requireAuth, app.requirePermission("user:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ivrId } = req.params as { ivrId: string };
      const query = req.query as { from?: string; to?: string };

      const from = query.from ? new Date(query.from) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
      const to = query.to ? new Date(query.to) : new Date();

      // Aggregate from ivr_traversal_log (raw SQL for partitioned table)
      const rows = await prisma.$queryRaw<
        Array<{
          node_id: bigint;
          outcome: string;
          digit: string | null;
          duration_ms: number;
          session_uuid: string;
        }>
      >`
        SELECT node_id, outcome, digit, duration_ms, session_uuid
        FROM ivr_traversal_log
        WHERE tenant_id = ${BigInt(tenantId)}
          AND ivr_id = ${BigInt(ivrId)}
          AND entered_at >= ${from}
          AND entered_at < ${to}
      `;

      // Get node names
      const nodes = await (prisma as unknown as { ivrNode: { findMany: (q: unknown) => Promise<Array<{ id: bigint; name: string }>> } }).ivrNode.findMany({
        where: { ivrId: BigInt(ivrId), tenantId: BigInt(tenantId) },
        select: { id: true, name: true },
      });
      const nodeNameMap = new Map(nodes.map((n) => [String(n.id), n.name]));

      // Compute per-node stats
      const sessionSet = new Set(rows.map((r: { session_uuid: string }) => r.session_uuid));
      const nodeStats = new Map<
        string,
        { entryCount: number; dropOffCount: number; digitDist: Record<string, number>; timeoutCount: number; totalMs: number }
      >();

      for (const row of rows) {
        const nid = String(row.node_id);
        if (!nodeStats.has(nid)) {
          nodeStats.set(nid, { entryCount: 0, dropOffCount: 0, digitDist: {}, timeoutCount: 0, totalMs: 0 });
        }
        const stat = nodeStats.get(nid)!;
        stat.entryCount++;
        stat.totalMs += row.duration_ms ?? 0;
        if (row.outcome === "hangup") stat.dropOffCount++;
        if (row.outcome === "timeout") stat.timeoutCount++;
        if (row.digit && row.outcome === "digit") {
          stat.digitDist[row.digit] = (stat.digitDist[row.digit] ?? 0) + 1;
        }
      }

      const terminalCount = rows.filter((r: { outcome: string }) => r.outcome === "terminal").length;
      const sessionCount = sessionSet.size;
      const completionRate = sessionCount > 0 ? terminalCount / sessionCount : 0;

      return reply.send({
        sessionCount,
        completionRate,
        nodes: [...nodeStats.entries()].map(([nodeId, stat]) => ({
          nodeId,
          name: nodeNameMap.get(nodeId) ?? nodeId,
          entryCount: stat.entryCount,
          dropOffCount: stat.dropOffCount,
          dropOffRate: stat.entryCount > 0 ? stat.dropOffCount / stat.entryCount : 0,
          digitDistribution: stat.digitDist,
          timeoutCount: stat.timeoutCount,
          avgDurationMs: stat.entryCount > 0 ? Math.round(stat.totalMs / stat.entryCount) : 0,
        })),
      });
    },
  );

  // ── DID assignment ─────────────────────────────────────────────────────────

  // PUT /api/admin/did-numbers/:didId/ivr
  app.put("/api/admin/did-numbers/:didId/ivr",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { didId } = req.params as { didId: string };
      const { ivrId } = req.body as { ivrId: string | null };

      const data = ivrId
        ? { routeKind: "ivr" as const, routeTarget: String(ivrId) }
        : { routeKind: "ingroup" as const, routeTarget: "" };

      const result = await (prisma as unknown as { didNumber: { updateMany: (q: unknown) => Promise<{ count: number }> } }).didNumber.updateMany({
        where: { id: BigInt(didId), tenantId: BigInt(tenantId) },
        data,
      });
      if (!result || result.count === 0) return reply.code(404).send({ code: "not_found" });

      // Re-render IVR to pick up new DID association
      if (ivrId) {
        await triggerRender(BigInt(ivrId)).catch(() => undefined);
      }

      return reply.send({ ok: true });
    },
  );
}
