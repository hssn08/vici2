// D06 — Fastify plugin: route registration for callback endpoints.
//
// Agent endpoints (any authenticated user):
//   POST   /api/agent/callbacks                            create
//   GET    /api/agent/callbacks/mine                       list own
//   POST   /api/agent/callbacks/:id/snooze                 snooze
//   POST   /api/agent/callbacks/:id/cancel                 cancel
//   POST   /api/agent/callbacks/:id/claim                  claim (GLOBAL → AGENT)
//
// Admin/supervisor endpoints (supervisor+ only):
//   GET    /api/admin/callbacks                            list with filters
//   GET    /api/admin/callbacks/aggregate                  counts by scope/status/hour
//   POST   /api/admin/callbacks/:id/reassign               single reassign
//   POST   /api/admin/callbacks/bulk-reassign              offboarding bulk
//   POST   /api/admin/callbacks/bulk-cancel                bulk cancel (up to 500)
//   GET    /api/admin/callbacks/export                     CSV (admin only)

import type { FastifyInstance } from "fastify";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Redis = require("ioredis");
import { env } from "../lib/env.js";
import { roleAtLeast } from "../auth/rbac.js";

import { handleScheduleCallback } from "./handlers/agent/schedule.js";
import { handleMineCallbacks } from "./handlers/agent/mine.js";
import { handleSnoozeCallback } from "./handlers/agent/snooze.js";
import { handleCancelCallback } from "./handlers/agent/cancel.js";
import { handleClaimCallback } from "./handlers/agent/claim.js";

import { handleAdminListCallbacks } from "./handlers/admin/list.js";
import { handleAdminAggregate } from "./handlers/admin/aggregate.js";
import { handleReassignCallback } from "./handlers/admin/reassign.js";
import { handleBulkReassign } from "./handlers/admin/bulk-reassign.js";
import { handleBulkCancel } from "./handlers/admin/bulk-cancel.js";
import { handleExportCallbacks } from "./handlers/admin/export.js";

import type { AuthContext } from "../auth/middleware.js";
import type { FastifyRequest, FastifyReply } from "fastify";

type AuthReq = FastifyRequest & { auth?: AuthContext };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _redis: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRedis(): any {
  if (!_redis) _redis = new Redis(env.redisUrl);
  return _redis;
}

function requireSupervisor(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const auth = (req as AuthReq).auth;
  if (!auth) { void reply.code(401).send({ error: "not_authenticated" }); return; }
  if (!roleAtLeast(auth.role, "supervisor")) { void reply.code(403).send({ error: "insufficient_role" }); return; }
  done();
}

export async function registerCallbackRoutes(app: FastifyInstance): Promise<void> {
  const redis = getRedis();

  // ── Agent routes ─────────────────────────────────────────────────────────────

  app.post(
    "/api/agent/callbacks",
    { preHandler: [app.requireAuth] },
    await handleScheduleCallback(redis),
  );

  app.get(
    "/api/agent/callbacks/mine",
    { preHandler: [app.requireAuth] },
    handleMineCallbacks,
  );

  app.post(
    "/api/agent/callbacks/:id/snooze",
    { preHandler: [app.requireAuth] },
    await handleSnoozeCallback(redis),
  );

  app.post(
    "/api/agent/callbacks/:id/cancel",
    { preHandler: [app.requireAuth] },
    await handleCancelCallback(redis),
  );

  app.post(
    "/api/agent/callbacks/:id/claim",
    { preHandler: [app.requireAuth] },
    await handleClaimCallback(redis),
  );

  // ── Admin/supervisor routes ───────────────────────────────────────────────────

  app.get(
    "/api/admin/callbacks",
    { preHandler: [app.requireAuth, requireSupervisor] },
    handleAdminListCallbacks,
  );

  app.get(
    "/api/admin/callbacks/aggregate",
    { preHandler: [app.requireAuth, requireSupervisor] },
    handleAdminAggregate,
  );

  app.get(
    "/api/admin/callbacks/export",
    { preHandler: [app.requireAuth, requireSupervisor] },
    handleExportCallbacks,
  );

  // NOTE: specific paths before :id param to avoid routing conflicts
  app.post(
    "/api/admin/callbacks/bulk-reassign",
    { preHandler: [app.requireAuth, requireSupervisor] },
    handleBulkReassign,
  );

  app.post(
    "/api/admin/callbacks/bulk-cancel",
    { preHandler: [app.requireAuth, requireSupervisor] },
    handleBulkCancel,
  );

  app.post(
    "/api/admin/callbacks/:id/reassign",
    { preHandler: [app.requireAuth, requireSupervisor] },
    await handleReassignCallback(redis),
  );
}
