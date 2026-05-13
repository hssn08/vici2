// M08 — Fastify plugin: route registration for compliance reporting endpoints.
//
// Routes registered:
//   GET  /api/admin/reports/fcc-drop-rate              report:view
//   GET  /api/admin/reports/fcc-drop-rate/timeline     report:view
//   GET  /api/admin/reports/fcc-drop-rate/export.csv   report:export
//   GET  /api/admin/reports/evidence-pack              report:view
//   GET  /api/admin/reports/dnc-sync-history           report:view
//   GET  /api/admin/reports/attestations               report:view

import type { FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "../lib/prisma.js";
import { hasPermission } from "../auth/rbac.js";
import type { AuthContext } from "../auth/middleware.js";
import type { Permission } from "@vici2/types";

import { handleFccDropRate, handleFccTimeline } from "./handlers/fcc-drop-rate.js";
import { handleEvidencePack } from "./handlers/evidence-pack.js";
import { handleDncSyncHistory } from "./handlers/dnc-sync-history.js";
import { handleAttestations } from "./handlers/attestations.js";
import { handleFccExport } from "./handlers/fcc-export.js";

// ── Auth helpers (mirrors statuses/index.ts pattern) ─────────────────────────

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
export async function registerReportingRoutes(app: any): Promise<void> {

  // ── GET /api/admin/reports/fcc-drop-rate ─────────────────────────────────
  app.get(
    "/api/admin/reports/fcc-drop-rate",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:view", reply)) return;
      return handleFccDropRate(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/fcc-drop-rate/timeline ────────────────────────
  app.get(
    "/api/admin/reports/fcc-drop-rate/timeline",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:view", reply)) return;
      return handleFccTimeline(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/fcc-drop-rate/export.csv ──────────────────────
  app.get(
    "/api/admin/reports/fcc-drop-rate/export.csv",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:export", reply)) return;
      return handleFccExport(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/evidence-pack ─────────────────────────────────
  app.get(
    "/api/admin/reports/evidence-pack",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:view", reply)) return;
      return handleEvidencePack(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/dnc-sync-history ───────────────────────────────
  app.get(
    "/api/admin/reports/dnc-sync-history",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:view", reply)) return;
      return handleDncSyncHistory(req, reply, getPrisma(), auth!);
    },
  );

  // ── GET /api/admin/reports/attestations ──────────────────────────────────
  app.get(
    "/api/admin/reports/attestations",
    { preHandler: app.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "report:view", reply)) return;
      return handleAttestations(req, reply, getPrisma(), auth!);
    },
  );
}
