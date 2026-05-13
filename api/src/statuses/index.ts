// D04 — Fastify plugin: route registration for status & disposition endpoints.
//
// Routes registered:
//   GET    /api/admin/system-statuses                              campaign:read
//   GET    /api/admin/campaigns/:cid/statuses                     campaign:read
//   POST   /api/admin/campaigns/:cid/statuses                     campaign:edit
//   PATCH  /api/admin/campaigns/:cid/statuses/:code               campaign:edit
//   DELETE /api/admin/campaigns/:cid/statuses/:code               campaign:edit
//   GET    /api/admin/hangup-cause-map                            admin:read (audit:view)
//   POST   /api/admin/d04/reload                                  admin:system (tenant:edit)
//   POST   /api/admin/leads/bulk-reset                            admin:system (tenant:edit)

import type { FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "../lib/prisma.js";
import { hasPermission } from "../auth/rbac.js";
import type { AuthContext } from "../auth/middleware.js";
import type { Permission } from "@vici2/types";
import Redis from "ioredis";
import { env } from "../lib/env.js";
import { subscribeToInvalidation } from "./cache.js";

import { handleListSystemStatuses } from "./handlers/list-system.js";
import { handleListCampaignStatuses } from "./handlers/list-campaign.js";
import { handleCreateStatus } from "./handlers/create.js";
import { handleUpdateStatus } from "./handlers/update.js";
import { handleDeleteStatus } from "./handlers/delete.js";
import { handleGetHangupMap } from "./handlers/hangup-map.js";
import { handleD04Reload } from "./handlers/reload.js";
import { handleBulkReset } from "./handlers/bulk-reset.js";

// ── Redis singleton ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _redis: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRedis(): any {
  if (!_redis) {
    _redis = new Redis(env.redisUrl);
    subscribeToInvalidation(_redis);
  }
  return _redis;
}

// ── Auth helpers ──────────────────────────────────────────────────────────────

type AuthReq = FastifyRequest & { auth?: AuthContext };
function getAuth(req: FastifyRequest): AuthContext | undefined {
  return (req as AuthReq).auth;
}

function checkPerm(auth: AuthContext | undefined, perm: Permission, reply: FastifyReply): boolean {
  if (!auth) { void reply.code(401).send({ error: "not_authenticated" }); return false; }
  if (!auth.perms.has(perm) && !hasPermission(auth.role, perm)) {
    void reply.code(403).send({ error: "permission_denied" }); return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerStatusRoutes(app: any): Promise<void> {

  // ── GET /api/admin/system-statuses ─────────────────────────────────────────
  app.get(
    "/api/admin/system-statuses",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:read", reply)) return;
      return handleListSystemStatuses(req, reply, getPrisma(), auth!, getRedis());
    },
  );

  // ── GET /api/admin/campaigns/:cid/statuses ──────────────────────────────────
  app.get(
    "/api/admin/campaigns/:cid/statuses",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:read", reply)) return;
      return handleListCampaignStatuses(req, reply, getPrisma(), auth!, getRedis());
    },
  );

  // ── POST /api/admin/campaigns/:cid/statuses ─────────────────────────────────
  app.post(
    "/api/admin/campaigns/:cid/statuses",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;
      return handleCreateStatus(req, reply, getPrisma(), auth!, getRedis());
    },
  );

  // ── PATCH /api/admin/campaigns/:cid/statuses/:code ──────────────────────────
  app.patch(
    "/api/admin/campaigns/:cid/statuses/:code",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;
      return handleUpdateStatus(req, reply, getPrisma(), auth!, getRedis());
    },
  );

  // ── DELETE /api/admin/campaigns/:cid/statuses/:code ─────────────────────────
  app.delete(
    "/api/admin/campaigns/:cid/statuses/:code",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "campaign:edit", reply)) return;
      return handleDeleteStatus(req, reply, getPrisma(), auth!, getRedis());
    },
  );

  // ── GET /api/admin/hangup-cause-map ─────────────────────────────────────────
  app.get(
    "/api/admin/hangup-cause-map",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "audit:view", reply)) return;
      return handleGetHangupMap(req, reply);
    },
  );

  // ── POST /api/admin/d04/reload ───────────────────────────────────────────────
  app.post(
    "/api/admin/d04/reload",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "tenant:edit", reply)) return;
      return handleD04Reload(req, reply);
    },
  );

  // ── POST /api/admin/leads/bulk-reset ────────────────────────────────────────
  app.post(
    "/api/admin/leads/bulk-reset",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "tenant:edit", reply)) return;
      return handleBulkReset(req, reply, getPrisma(), auth!);
    },
  );
}
