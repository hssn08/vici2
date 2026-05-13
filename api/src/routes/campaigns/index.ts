// E01 — Campaign routes registration.
//
// Route map:
//   GET    /api/campaigns                               campaign:read
//   POST   /api/campaigns                               campaign:create
//   GET    /api/campaigns/:campaignId                   campaign:read
//   PATCH  /api/campaigns/:campaignId                   campaign:edit
//   DELETE /api/campaigns/:campaignId                   campaign:delete
//   POST   /api/campaigns/:campaignId/clone             campaign:create
//   POST   /api/campaigns/:campaignId/action            campaign:edit
//   GET    /api/campaigns/:campaignId/lists             campaign:read
//   POST   /api/campaigns/:campaignId/lists             campaign:edit
//   DELETE /api/campaigns/:campaignId/lists/:listId     campaign:edit
//   GET    /api/campaigns/:campaignId/status-overrides          campaign:read
//   PUT    /api/campaigns/:campaignId/status-overrides/:code    campaign:edit
//   DELETE /api/campaigns/:campaignId/status-overrides/:code    campaign:edit
//
// Auth decorators (requireAuth etc.) are registered by the caller
// (registerAuthRoutes). This function only registers routes.

import type { FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "../../lib/prisma.js";
import {
  CampaignCreateSchema,
  CampaignUpdateSchema,
  CampaignListQuerySchema,
  CampaignListLinkSchema,
  StatusOverrideUpsertSchema,
  CampaignActionSchema,
} from "./schema.js";
import {
  listCampaigns,
  getCampaign,
  createCampaign,
  updateCampaign,
  deleteCampaign,
  cloneCampaign,
  applyCampaignAction,
  linkList,
  unlinkList,
  listStatusOverrides,
  upsertStatusOverride,
  deleteStatusOverride,
} from "./service.js";
import { hasPermission } from "../../auth/rbac.js";
import type { Permission } from "@vici2/types";
import type { AuthContext } from "../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext | undefined {
  return (req as AuthReq).auth;
}

function checkPerm(auth: AuthContext | undefined, perm: Permission, reply: FastifyReply): boolean {
  if (!auth) {
    void reply.code(401).send({ error: "not_authenticated" });
    return false;
  }
  if (!auth.perms.has(perm) && !hasPermission(auth.role, perm)) {
    void reply.code(403).send({ error: "permission_denied" });
    return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerCampaignRoutes(app: any): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/campaigns
  // -------------------------------------------------------------------------
  app.get(
    "/api/campaigns",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:read", reply)) return;

      const parsed = CampaignListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
      }
      const q = parsed.data;
      const prisma = getPrisma();
      const result = await listCampaigns(prisma, {
        tenantId: auth!.tenantId,
        active: q.active,
        dialMethod: q.dial_method,
        limit: q.limit,
        offset: q.offset,
      });
      return reply.code(200).send(result);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/campaigns
  // -------------------------------------------------------------------------
  app.post(
    "/api/campaigns",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:create", reply)) return;

      const parsed = CampaignCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const prisma = getPrisma();
      try {
        const campaign = await createCampaign(
          prisma,
          auth!.tenantId,
          parsed.data,
          auth!.uid,
          (req as FastifyRequest & { id?: string }).id,
          req.ip,
          req.headers["user-agent"] as string | undefined,
        );
        return reply.code(201).send(campaign);
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e?.code === "P2002") {
          return reply.code(409).send({ error: "campaign_id_conflict" });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId
  // -------------------------------------------------------------------------
  app.get(
    "/api/campaigns/:campaignId",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:read", reply)) return;

      const { campaignId } = req.params as { campaignId: string };
      const prisma = getPrisma();
      const campaign = await getCampaign(prisma, auth!.tenantId, campaignId);
      if (!campaign) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send(campaign);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/campaigns/:campaignId
  // -------------------------------------------------------------------------
  app.patch(
    "/api/campaigns/:campaignId",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;

      const { campaignId } = req.params as { campaignId: string };
      const parsed = CampaignUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const prisma = getPrisma();
      const updated = await updateCampaign(
        prisma,
        auth!.tenantId,
        campaignId,
        parsed.data,
        auth!.uid,
        (req as FastifyRequest & { id?: string }).id,
        req.ip,
        req.headers["user-agent"] as string | undefined,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send(updated);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/campaigns/:campaignId
  // -------------------------------------------------------------------------
  app.delete(
    "/api/campaigns/:campaignId",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:delete", reply)) return;

      const { campaignId } = req.params as { campaignId: string };
      const prisma = getPrisma();
      const deleted = await deleteCampaign(
        prisma,
        auth!.tenantId,
        campaignId,
        auth!.uid,
        (req as FastifyRequest & { id?: string }).id,
        req.ip,
        req.headers["user-agent"] as string | undefined,
      );
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:campaignId/clone
  // -------------------------------------------------------------------------
  app.post(
    "/api/campaigns/:campaignId/clone",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:create", reply)) return;

      const { campaignId } = req.params as { campaignId: string };
      const body = req.body as { new_id?: string; new_name?: string } | null;
      if (!body?.new_id || !body?.new_name) {
        return reply.code(400).send({ error: "missing_fields", message: "new_id and new_name are required" });
      }
      const idRe = /^[a-zA-Z0-9_-]+$/;
      if (!idRe.test(body.new_id) || body.new_id.length > 32) {
        return reply.code(400).send({ error: "invalid_new_id" });
      }
      const prisma = getPrisma();
      try {
        const cloned = await cloneCampaign(
          prisma,
          auth!.tenantId,
          campaignId,
          body.new_id,
          body.new_name,
          auth!.uid,
          (req as FastifyRequest & { id?: string }).id,
          req.ip,
          req.headers["user-agent"] as string | undefined,
        );
        if (!cloned) return reply.code(404).send({ error: "not_found" });
        return reply.code(201).send(cloned);
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e?.code === "P2002") {
          return reply.code(409).send({ error: "campaign_id_conflict" });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:campaignId/action  (start / pause / stop)
  // -------------------------------------------------------------------------
  app.post(
    "/api/campaigns/:campaignId/action",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;

      const { campaignId } = req.params as { campaignId: string };
      const parsed = CampaignActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const prisma = getPrisma();
      const updated = await applyCampaignAction(
        prisma,
        auth!.tenantId,
        campaignId,
        parsed.data.action,
        auth!.uid,
        (req as FastifyRequest & { id?: string }).id,
        req.ip,
        req.headers["user-agent"] as string | undefined,
      );
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.code(200).send(updated);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/lists
  // -------------------------------------------------------------------------
  app.get(
    "/api/campaigns/:campaignId/lists",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:read", reply)) return;

      const { campaignId } = req.params as { campaignId: string };
      const prisma = getPrisma();
      const rows = await prisma.campaignList.findMany({
        where: { tenantId: BigInt(auth!.tenantId), campaignId },
        orderBy: { priority: "desc" },
      });
      return reply.code(200).send({
        items: rows.map((r: { listId: bigint; priority: number }) => ({ list_id: Number(r.listId), priority: r.priority })),
      });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/campaigns/:campaignId/lists
  // -------------------------------------------------------------------------
  app.post(
    "/api/campaigns/:campaignId/lists",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;

      const { campaignId } = req.params as { campaignId: string };
      const parsed = CampaignListLinkSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }
      const prisma = getPrisma();

      // Verify campaign exists
      const campaign = await getCampaign(prisma, auth!.tenantId, campaignId);
      if (!campaign) return reply.code(404).send({ error: "not_found" });

      try {
        await linkList(
          prisma,
          auth!.tenantId,
          campaignId,
          parsed.data,
          auth!.uid,
          (req as FastifyRequest & { id?: string }).id,
          req.ip,
          req.headers["user-agent"] as string | undefined,
        );
        return reply.code(204).send();
      } catch (err: unknown) {
        const e = err as { code?: string };
        if (e?.code === "P2003") {
          return reply.code(400).send({ error: "list_not_found" });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/campaigns/:campaignId/lists/:listId
  // -------------------------------------------------------------------------
  app.delete(
    "/api/campaigns/:campaignId/lists/:listId",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;

      const { campaignId, listId } = req.params as { campaignId: string; listId: string };
      const listIdNum = Number(listId);
      if (!Number.isInteger(listIdNum) || listIdNum <= 0) {
        return reply.code(400).send({ error: "invalid_list_id" });
      }
      const prisma = getPrisma();
      const deleted = await unlinkList(
        prisma,
        auth!.tenantId,
        campaignId,
        listIdNum,
        auth!.uid,
        (req as FastifyRequest & { id?: string }).id,
        req.ip,
        req.headers["user-agent"] as string | undefined,
      );
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/campaigns/:campaignId/status-overrides
  // -------------------------------------------------------------------------
  app.get(
    "/api/campaigns/:campaignId/status-overrides",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:read", reply)) return;

      const { campaignId } = req.params as { campaignId: string };
      const prisma = getPrisma();
      const overrides = await listStatusOverrides(prisma, auth!.tenantId, campaignId);
      return reply.code(200).send({ items: overrides });
    },
  );

  // -------------------------------------------------------------------------
  // PUT /api/campaigns/:campaignId/status-overrides/:statusCode
  // -------------------------------------------------------------------------
  app.put(
    "/api/campaigns/:campaignId/status-overrides/:statusCode",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;

      const { campaignId, statusCode } = req.params as { campaignId: string; statusCode: string };

      // Verify campaign exists first
      const prisma = getPrisma();
      const campaign = await getCampaign(prisma, auth!.tenantId, campaignId);
      if (!campaign) return reply.code(404).send({ error: "not_found" });

      const parsed = StatusOverrideUpsertSchema.safeParse({
        status_code: statusCode,
        ...(req.body as object),
      });
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }

      const override = await upsertStatusOverride(
        prisma,
        auth!.tenantId,
        campaignId,
        parsed.data,
        auth!.uid,
        (req as FastifyRequest & { id?: string }).id,
        req.ip,
        req.headers["user-agent"] as string | undefined,
      );
      return reply.code(200).send(override);
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/campaigns/:campaignId/status-overrides/:statusCode
  // -------------------------------------------------------------------------
  app.delete(
    "/api/campaigns/:campaignId/status-overrides/:statusCode",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;

      const { campaignId, statusCode } = req.params as { campaignId: string; statusCode: string };
      const prisma = getPrisma();
      const deleted = await deleteStatusOverride(
        prisma,
        auth!.tenantId,
        campaignId,
        statusCode,
        auth!.uid,
        (req as FastifyRequest & { id?: string }).id,
        req.ip,
        req.headers["user-agent"] as string | undefined,
      );
      if (!deleted) return reply.code(404).send({ error: "not_found" });
      return reply.code(204).send();
    },
  );
}
