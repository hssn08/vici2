// fs-nodes.ts — X03 Multi-FS: FS node admin REST endpoints.
//
// Route map (base: /api/admin/infrastructure/fs-nodes):
//   GET    /                              infra:fs_node:read   list nodes (with stats)
//   POST   /                              infra:fs_node:edit   create node
//   GET    /:id                           infra:fs_node:read   get single node
//   PATCH  /:id                           infra:fs_node:edit   update node
//   DELETE /:id                           infra:fs_node:edit   soft-delete (set OFFLINE)
//   POST   /:id/drain                     infra:fs_node:edit   set DRAINING
//   POST   /:id/activate                  infra:fs_node:edit   set ACTIVE
//   GET    /:id/campaigns                 infra:fs_node:read   campaigns pinned to node
//   POST   /campaigns/:campaign_id/pin    infra:fs_node:edit   pin/re-pin campaign
//   DELETE /campaigns/:campaign_id/pin    infra:fs_node:edit   clear pin (auto-assign)
//
// X03 PLAN §4.2.

import { z } from "zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import { AffinityService } from "../../../services/affinity/affinity-service.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const a = (req as AuthReq).auth;
  if (!a) throw new Error("Unauthenticated");
  return a;
}

function parseId(raw: unknown, name = "id"): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ${name}`);
  return n;
}

// ── Zod schemas ──────────────────────────────────────────────────────────────

const CreateNodeSchema = z.object({
  name: z.string().min(1).max(64),
  host: z.string().min(1).max(128),
  eslHost: z.string().min(1).max(128),
  eslPort: z.number().int().positive().default(8021),
  eslPassword: z.string().min(1).max(255),
  weight: z.number().int().min(0).max(32767).default(100),
  metadata: z.record(z.unknown()).optional(),
});

const UpdateNodeSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  host: z.string().min(1).max(128).optional(),
  eslHost: z.string().min(1).max(128).optional(),
  eslPort: z.number().int().positive().optional(),
  eslPassword: z.string().min(1).max(255).optional(),
  weight: z.number().int().min(0).max(32767).optional(),
  metadata: z.record(z.unknown()).optional(),
});

const PinCampaignSchema = z.object({
  fsNodeId: z.number().int().positive(),
  force: z.boolean().optional().default(false),
});

// ── Factory ──────────────────────────────────────────────────────────────────

function makeService(): AffinityService {
  // In production the Redis client is injected via app context.
  // For now, we construct from the global prisma + a stub Redis.
  // The service is created per-request to avoid circular imports with app startup.
  const db = getPrisma();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const redis = (globalThis as any).__vici2_redis ?? null;
  const logger = {
    info: (...args: unknown[]) => console.info(...args),
    warn: (...args: unknown[]) => console.warn(...args),
    error: (...args: unknown[]) => console.error(...args),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return new AffinityService(db, redis, logger);
}

// ── Route registration ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminFsNodeRoutes(app: any): Promise<void> {
  const BASE = "/api/admin/infrastructure/fs-nodes";

  // GET /api/admin/infrastructure/fs-nodes
  app.get(
    BASE,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const svc = makeService();
      const nodes = await svc.listNodes();
      return reply.send({ nodes });
    },
  );

  // POST /api/admin/infrastructure/fs-nodes
  app.post(
    BASE,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = CreateNodeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const svc = makeService();
      try {
        const node = await svc.createNode({
          ...parsed.data,
          tenantId: Number(auth.tenantId),
        });
        return reply.code(201).send(node);
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "A node with this name already exists" });
        }
        throw err;
      }
    },
  );

  // GET /api/admin/infrastructure/fs-nodes/:id
  app.get(
    `${BASE}/:id`,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { id: string };
      let id: number;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid node ID" });
      }
      const db = getPrisma();
      const node = await db.fsNode.findUnique({ where: { id } });
      if (!node) return reply.code(404).send({ code: "not_found", message: "FS node not found" });
      // Strip ESL password from response.
      const { eslPassword: _pwd, ...safe } = node;
      void _pwd;
      return reply.send(safe);
    },
  );

  // PATCH /api/admin/infrastructure/fs-nodes/:id
  app.patch(
    `${BASE}/:id`,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { id: string };
      let id: number;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid node ID" });
      }
      const parsed = UpdateNodeSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const svc = makeService();
      const updated = await svc.updateNode(id, parsed.data, Number(auth.tenantId));
      if (!updated) return reply.code(404).send({ code: "not_found", message: "FS node not found" });
      const { eslPassword: _pwd, ...safe } = updated;
      void _pwd;
      return reply.send(safe);
    },
  );

  // DELETE /api/admin/infrastructure/fs-nodes/:id (soft-delete → OFFLINE)
  app.delete(
    `${BASE}/:id`,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { id: string };
      let id: number;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid node ID" });
      }
      const db = getPrisma();
      const node = await db.fsNode.findUnique({ where: { id } });
      if (!node) return reply.code(404).send({ code: "not_found", message: "FS node not found" });

      // Check for pinned campaigns.
      const pinnedCount = await db.campaign.count({ where: { fsNodeId: id } });
      if (pinnedCount > 0) {
        return reply.code(409).send({
          code: "has_campaigns",
          message: `Node has ${pinnedCount} pinned campaign(s). Re-pin before deleting.`,
        });
      }

      const svc = makeService();
      await svc.setNodeStatus(id, "OFFLINE");
      return reply.code(204).send();
    },
  );

  // POST /api/admin/infrastructure/fs-nodes/:id/drain
  app.post(
    `${BASE}/:id/drain`,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { id: string };
      let id: number;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid node ID" });
      }
      const svc = makeService();
      try {
        await svc.setNodeStatus(id, "DRAINING");
        return reply.code(204).send();
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "P2025") return reply.code(404).send({ code: "not_found", message: "FS node not found" });
        throw err;
      }
    },
  );

  // POST /api/admin/infrastructure/fs-nodes/:id/activate
  app.post(
    `${BASE}/:id/activate`,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { id: string };
      let id: number;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid node ID" });
      }
      const svc = makeService();
      try {
        await svc.setNodeStatus(id, "ACTIVE");
        return reply.code(204).send();
      } catch (err) {
        const e = err as { code?: string; message?: string };
        if (e.code === "P2025") return reply.code(404).send({ code: "not_found", message: "FS node not found" });
        throw err;
      }
    },
  );

  // GET /api/admin/infrastructure/fs-nodes/:id/campaigns
  app.get(
    `${BASE}/:id/campaigns`,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { id: string };
      let id: number;
      try { id = parseId(params.id); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid node ID" });
      }
      const svc = makeService();
      const campaigns = await svc.listCampaignsForNode(id);
      return reply.send({ campaigns });
    },
  );

  // POST /api/admin/infrastructure/fs-nodes/campaigns/:campaign_id/pin
  app.post(
    `${BASE}/campaigns/:campaign_id/pin`,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { campaign_id: string };
      let campaignId: number;
      try { campaignId = parseId(params.campaign_id, "campaign_id"); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid campaign ID" });
      }
      const parsed = PinCampaignSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const svc = makeService();
      try {
        await svc.pinCampaign(campaignId, parsed.data.fsNodeId, parsed.data.force, auth.uid);
        return reply.code(204).send();
      } catch (err) {
        const e = err as { code?: string; message?: string; activeCalls?: number };
        if (e.code === "CAMPAIGN_HAS_ACTIVE_CALLS") {
          return reply.code(409).send({
            error: {
              code: "CAMPAIGN_HAS_ACTIVE_CALLS",
              message: e.message,
              activeCalls: e.activeCalls,
            },
          });
        }
        throw err;
      }
    },
  );

  // DELETE /api/admin/infrastructure/fs-nodes/campaigns/:campaign_id/pin
  app.delete(
    `${BASE}/campaigns/:campaign_id/pin`,
    { preHandler: [app.requireAuth, app.requirePermission("infra:fs_node:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { campaign_id: string };
      let campaignId: number;
      try { campaignId = parseId(params.campaign_id, "campaign_id"); } catch {
        return reply.code(400).send({ code: "invalid_id", message: "Invalid campaign ID" });
      }
      const svc = makeService();
      await svc.clearPin(campaignId);
      return reply.code(204).send();
    },
  );
}
