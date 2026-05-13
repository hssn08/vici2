// M03 — Fastify plugin: route registration for ops admin report endpoints.
//
// Routes registered:
//   GET  /api/admin/reports/campaign-daily              report:view
//   GET  /api/admin/reports/campaign-daily/export.csv   report:export
//   GET  /api/admin/reports/agent-productivity          report:view
//   GET  /api/admin/reports/agent-productivity/export.csv  report:export
//   GET  /api/admin/reports/list-health                 report:view
//   GET  /api/admin/reports/list-health/export.csv      report:export

import type { FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "../lib/prisma.js";
import { hasPermission } from "../auth/rbac.js";
import type { AuthContext } from "../auth/middleware.js";
import type { Permission } from "@vici2/types";

import { handleCampaignDaily } from "./handlers/campaign-daily.js";
import { handleAgentProductivity } from "./handlers/agent-productivity.js";
import { handleListHealth } from "./handlers/list-health.js";

// ── Auth helpers (mirrors reporting/index.ts pattern) ─────────────────────────

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext | undefined {
  return (req as AuthReq).auth;
}

function checkPerm(
  auth: AuthContext | undefined,
  perm: Permission,
  reply: FastifyReply,
): boolean {
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
export async function registerOpsReportRoutes(app: any): Promise<void> {

  // ── GET /api/admin/reports/campaign-daily ────────────────────────────────
  app.get(
    "/api/admin/reports/campaign-daily",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:view", reply)) return;
      return handleCampaignDaily(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/campaign-daily/export.csv ─────────────────────
  app.get(
    "/api/admin/reports/campaign-daily/export.csv",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:export", reply)) return;
      // Force CSV mode via query param
      (req.query as Record<string, string>).format = "csv";
      return handleCampaignDaily(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/agent-productivity ────────────────────────────
  app.get(
    "/api/admin/reports/agent-productivity",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:view", reply)) return;
      return handleAgentProductivity(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/agent-productivity/export.csv ─────────────────
  app.get(
    "/api/admin/reports/agent-productivity/export.csv",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:export", reply)) return;
      (req.query as Record<string, string>).format = "csv";
      return handleAgentProductivity(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/list-health ───────────────────────────────────
  app.get(
    "/api/admin/reports/list-health",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:view", reply)) return;
      return handleListHealth(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/list-health/export.csv ────────────────────────
  app.get(
    "/api/admin/reports/list-health/export.csv",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:export", reply)) return;
      (req.query as Record<string, string>).format = "csv";
      return handleListHealth(req, reply, getPrisma(), auth!);
    },
  );
}
