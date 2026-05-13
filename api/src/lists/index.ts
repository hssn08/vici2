// D07 — List management Fastify plugin.
//
// Route map:
//   GET    /api/lists                                   list:read
//   POST   /api/lists                                   list:write
//   GET    /api/lists/:id                               list:read
//   PATCH  /api/lists/:id                               list:write
//   DELETE /api/lists/:id                               list:delete
//   GET    /api/lists/:id/stats                         list:read
//   GET    /api/lists/:id/campaigns                     list:read
//   POST   /api/lists/:id/campaigns                     list:write
//   PATCH  /api/lists/:id/campaigns/:campaignId         list:write
//   DELETE /api/lists/:id/campaigns/:campaignId         list:write
//   POST   /api/lists/:id/reset                         list:reset
//   POST   /api/lists/:id/purge                         list:purge
//   POST   /api/lists/:id/clone                         list:write
//   GET    /api/lists/:id/reset/:jobId/progress         list:read
//   GET    /api/lists/:id/purge/:jobId/progress         list:read

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "../lib/prisma.js";
import {
  ListCreateSchema,
  ListUpdateSchema,
  ListQuerySchema,
  CampaignLinkSchema,
  CampaignLinkUpdateSchema,
  CloneSchema,
  ResetPurgeSchema,
  DEFAULT_LIST_SETTINGS,
} from "./schema.js";
import {
  listLists,
  getList,
  createList,
  updateList,
  deleteList,
  listCampaignAssignments,
  linkCampaign,
  updateCampaignLink,
  unlinkCampaign,
  resetListSync,
  purgeListSync,
  cloneList,
  countActiveLeads,
  SYNC_LEAD_THRESHOLD,
} from "./service.js";
import { getListStats } from "./stats.js";
import { enqueueListReset, enqueueListPurge } from "./jobs.js";
import { streamJobProgress } from "./sse.js";
import { checkListPerm, getAuth } from "./permissions.js";
import { auditList } from "./audit.js";
import type { ListSettings } from "./schema.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerListRoutes(app: FastifyInstance | any): Promise<void> {

  // ---------------------------------------------------------------------------
  // GET /api/lists
  // ---------------------------------------------------------------------------
  app.get(
    "/api/lists",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:read", reply)) return;

      const qs = req.query as Record<string, string>;
      const parsed = ListQuerySchema.safeParse(qs);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_QUERY", issues: parsed.error.issues });
      }

      const prisma = getPrisma();
      const result = await listLists(prisma, Number(auth!.tenantId), parsed.data);
      return reply.send(result);
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/lists
  // ---------------------------------------------------------------------------
  app.post(
    "/api/lists",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:write", reply)) return;

      const body = req.body as unknown;
      const parsed = ListCreateSchema.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: parsed.error.issues });
      }

      const prisma = getPrisma();
      const list = await createList(
        prisma,
        Number(auth!.tenantId),
        parsed.data,
        Number(auth!.uid),
        req.id,
        req.ip,
        req.headers["user-agent"],
      );

      return reply.code(201).send(list);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/lists/:id
  // ---------------------------------------------------------------------------
  app.get(
    "/api/lists/:id",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:read", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const prisma = getPrisma();
      const list = await getList(prisma, Number(auth!.tenantId), listId);
      if (!list) return reply.code(404).send({ error: "LIST_NOT_FOUND" });

      return reply.send(list);
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/lists/:id
  // ---------------------------------------------------------------------------
  app.patch(
    "/api/lists/:id",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:write", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const parsed = ListUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: parsed.error.issues });
      }

      const prisma = getPrisma();
      const list = await updateList(
        prisma,
        Number(auth!.tenantId),
        listId,
        parsed.data,
        Number(auth!.uid),
        req.id,
        req.ip,
        req.headers["user-agent"],
      );
      if (!list) return reply.code(404).send({ error: "LIST_NOT_FOUND" });

      return reply.send(list);
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/lists/:id
  // ---------------------------------------------------------------------------
  app.delete(
    "/api/lists/:id",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:delete", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const prisma = getPrisma();
      const deleted = await deleteList(
        prisma,
        Number(auth!.tenantId),
        listId,
        Number(auth!.uid),
        req.id,
        req.ip,
        req.headers["user-agent"],
      );
      if (!deleted) return reply.code(404).send({ error: "LIST_NOT_FOUND" });

      return reply.code(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/lists/:id/stats
  // ---------------------------------------------------------------------------
  app.get(
    "/api/lists/:id/stats",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:read", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const prisma = getPrisma();
      const tenantId = Number(auth!.tenantId);

      // Get list settings for stats computation
      const listRow = await getList(prisma, tenantId, listId);
      if (!listRow) return reply.code(404).send({ error: "LIST_NOT_FOUND" });

      const settings = (listRow.settings as ListSettings) ?? DEFAULT_LIST_SETTINGS;

      const stats = await getListStats(
        prisma,
        tenantId,
        listId,
        settings.callable_status_codes,
        settings.recycle_delay_default,
        settings.max_attempts,
      );

      return reply.send(stats);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/lists/:id/campaigns
  // ---------------------------------------------------------------------------
  app.get(
    "/api/lists/:id/campaigns",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:read", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const prisma = getPrisma();
      const links = await listCampaignAssignments(prisma, Number(auth!.tenantId), listId);
      return reply.send({ data: links });
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/lists/:id/campaigns
  // ---------------------------------------------------------------------------
  app.post(
    "/api/lists/:id/campaigns",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:write", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const parsed = CampaignLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: parsed.error.issues });
      }

      const prisma = getPrisma();
      try {
        const link = await linkCampaign(
          prisma,
          Number(auth!.tenantId),
          listId,
          parsed.data,
          Number(auth!.uid),
          req.id,
          req.ip,
          req.headers["user-agent"],
        );
        return reply.code(201).send(link);
      } catch (err) {
        if ((err as Error).message === "LIST_NOT_FOUND") {
          return reply.code(404).send({ error: "LIST_NOT_FOUND" });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // PATCH /api/lists/:id/campaigns/:campaignId
  // ---------------------------------------------------------------------------
  app.patch(
    "/api/lists/:id/campaigns/:campaignId",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:write", reply)) return;

      const { id, campaignId } = req.params as { id: string; campaignId: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const parsed = CampaignLinkUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: parsed.error.issues });
      }

      const prisma = getPrisma();
      const link = await updateCampaignLink(
        prisma,
        Number(auth!.tenantId),
        listId,
        campaignId,
        parsed.data,
        Number(auth!.uid),
        req.id,
        req.ip,
        req.headers["user-agent"],
      );
      if (!link) return reply.code(404).send({ error: "LINK_NOT_FOUND" });

      return reply.send(link);
    },
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/lists/:id/campaigns/:campaignId
  // ---------------------------------------------------------------------------
  app.delete(
    "/api/lists/:id/campaigns/:campaignId",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:write", reply)) return;

      const { id, campaignId } = req.params as { id: string; campaignId: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const prisma = getPrisma();
      const unlinked = await unlinkCampaign(
        prisma,
        Number(auth!.tenantId),
        listId,
        campaignId,
        Number(auth!.uid),
        req.id,
        req.ip,
        req.headers["user-agent"],
      );
      if (!unlinked) return reply.code(404).send({ error: "LINK_NOT_FOUND" });

      return reply.code(204).send();
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/lists/:id/reset
  // ---------------------------------------------------------------------------
  app.post(
    "/api/lists/:id/reset",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:reset", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const parsed = ResetPurgeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: parsed.error.issues });
      }

      const prisma = getPrisma();
      const tenantId = Number(auth!.tenantId);

      // Verify list exists
      const list = await getList(prisma, tenantId, listId);
      if (!list) return reply.code(404).send({ error: "LIST_NOT_FOUND" });

      const count = await countActiveLeads(prisma, tenantId, listId);

      if (count <= SYNC_LEAD_THRESHOLD) {
        // Synchronous reset
        const result = await resetListSync(
          prisma,
          tenantId,
          listId,
          Number(auth!.uid),
          req.id,
          req.ip,
          req.headers["user-agent"],
        );
        return reply.send({ mode: "sync", ...result });
      } else {
        // Audit queue event first
        await auditList({
          tx: prisma,
          actorUserId: Number(auth!.uid),
          actorKind: "user",
          action: "list.reset.queued",
          tenantId,
          entityId: String(listId),
          afterJson: { estimated_count: count },
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        });

        const jobId = await enqueueListReset({
          tenantId,
          listId,
          actorUserId: Number(auth!.uid),
          requestId: req.id ?? "",
          batchSize: 1000,
        });
        return reply.code(202).send({ mode: "async", job_id: jobId, status: "queued" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/lists/:id/purge
  // ---------------------------------------------------------------------------
  app.post(
    "/api/lists/:id/purge",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:purge", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const parsed = ResetPurgeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: parsed.error.issues });
      }

      const prisma = getPrisma();
      const tenantId = Number(auth!.tenantId);

      const list = await getList(prisma, tenantId, listId);
      if (!list) return reply.code(404).send({ error: "LIST_NOT_FOUND" });

      const count = await countActiveLeads(prisma, tenantId, listId);

      if (count <= SYNC_LEAD_THRESHOLD) {
        const result = await purgeListSync(
          prisma,
          tenantId,
          listId,
          Number(auth!.uid),
          req.id,
          req.ip,
          req.headers["user-agent"],
        );
        return reply.send({ mode: "sync", ...result });
      } else {
        await auditList({
          tx: prisma,
          actorUserId: Number(auth!.uid),
          actorKind: "user",
          action: "list.purge.queued",
          tenantId,
          entityId: String(listId),
          afterJson: { estimated_count: count },
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers["user-agent"],
        });

        const jobId = await enqueueListPurge({
          tenantId,
          listId,
          actorUserId: Number(auth!.uid),
          requestId: req.id ?? "",
          batchSize: 1000,
        });
        return reply.code(202).send({ mode: "async", job_id: jobId, status: "queued" });
      }
    },
  );

  // ---------------------------------------------------------------------------
  // POST /api/lists/:id/clone
  // ---------------------------------------------------------------------------
  app.post(
    "/api/lists/:id/clone",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:write", reply)) return;

      const { id } = req.params as { id: string };
      const listId = Number(id);
      if (!Number.isInteger(listId) || listId <= 0) {
        return reply.code(400).send({ error: "INVALID_ID" });
      }

      const parsed = CloneSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "INVALID_BODY", issues: parsed.error.issues });
      }

      const prisma = getPrisma();
      try {
        const result = await cloneList(
          prisma,
          Number(auth!.tenantId),
          listId,
          parsed.data,
          Number(auth!.uid),
          req.id,
          req.ip,
          req.headers["user-agent"],
        );
        return reply.code(201).send(result);
      } catch (err) {
        if ((err as Error).message === "LIST_NOT_FOUND") {
          return reply.code(404).send({ error: "LIST_NOT_FOUND" });
        }
        throw err;
      }
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/lists/:id/reset/:jobId/progress  (SSE)
  // ---------------------------------------------------------------------------
  app.get(
    "/api/lists/:id/reset/:jobId/progress",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:read", reply)) return;

      const { jobId } = req.params as { id: string; jobId: string };
      await streamJobProgress(req, reply, jobId);
    },
  );

  // ---------------------------------------------------------------------------
  // GET /api/lists/:id/purge/:jobId/progress  (SSE)
  // ---------------------------------------------------------------------------
  app.get(
    "/api/lists/:id/purge/:jobId/progress",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkListPerm(auth, "list:read", reply)) return;

      const { jobId } = req.params as { id: string; jobId: string };
      await streamJobProgress(req, reply, jobId);
    },
  );
}
