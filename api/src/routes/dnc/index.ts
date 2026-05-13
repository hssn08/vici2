// D05 — DNC route registration.
//
// Routes:
//   GET    /api/dnc                       dnc:read  — lookup single phone
//   POST   /api/dnc                       dnc:edit  — add internal entry
//   POST   /api/dnc/bulk                  dnc:edit  — bulk CSV add
//   DELETE /api/dnc/:id                   dnc:edit  — soft-remove
//   POST   /api/dnc/bypass               dnc:bypass — mint single-use bypass token
//   POST   /api/dnc/bypass/redeem        dnc:bypass — redeem token (T04 internal)
//   GET    /api/dnc/audit                audit:view — bypass audit events
//   POST   /api/dnc/sync/federal         dnc:edit  — manual trigger
//   GET    /api/dnc/sync-status          dnc:read  — last run timestamps

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { getPrisma } from "../../lib/prisma.js";
import Redis from "ioredis";
import { env } from "../../lib/env.js";
import { hasPermission } from "../../auth/rbac.js";
import type { AuthContext } from "../../auth/middleware.js";
import type { Permission } from "@vici2/types";
import {
  dncCheck,
  bloomAdd,
  mintBypassToken,
  redeemBypassToken,
  bulkImportDnc,
  runFederalDeltaSync,
} from "../../dnc/index.js";
import { DncSource } from "../../dnc/types.js";

// ── Redis singleton ────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _redis: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getRedis(): any {
  if (!_redis) {
    _redis = new Redis(env.redisUrl);
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

function normalizePhone(raw: string): string | null {
  const p = parsePhoneNumberFromString(raw, "US");
  if (!p || !p.isValid()) return null;
  return p.format("E.164");
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const CheckQuerySchema = z.object({
  phone: z.string(),
  campaignId: z.string().optional(),
  leadState: z.string().length(2).optional(),
  sources: z.string().optional(), // comma-separated
});

const AddDncSchema = z.object({
  phone: z.string(),
  source: z.literal("internal"),
  state: z.string().length(2).optional().default("__"),
  campaignId: z.string().optional().default("__GLOBAL__"),
  notes: z.string().max(255).optional(),
});

const BypassMintSchema = z.object({
  phone: z.string(),
  source: DncSource,
  justification: z.string().min(10).max(500),
  ttlSeconds: z.number().int().min(1).max(300).optional(),
});

const BypassRedeemSchema = z.object({
  token: z.string(),
  phone: z.string(),
  source: DncSource,
  justification: z.string(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerDncRoutes(app: any): Promise<void> {
  const fastify = app as FastifyInstance;

  // ── GET /api/dnc?phone= ─────────────────────────────────────────────────────
  fastify.get(
    "/api/dnc",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "dnc:read", reply)) return;

      const parsed = CheckQuerySchema.safeParse(req.query);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_query", issues: parsed.error.issues });
      const q = parsed.data;

      const phone = normalizePhone(q.phone);
      if (!phone) return reply.code(400).send({ error: "invalid_phone" });

      const validSrcs = new Set(["federal", "state", "internal", "litigator"]);
      const sources = q.sources
        ? (q.sources.split(",").filter((s) => validSrcs.has(s)) as Array<"federal" | "state" | "internal" | "litigator">)
        : (["federal", "state", "internal"] as Array<"federal" | "state" | "internal">);

      const result = await dncCheck(getRedis(), getPrisma(), {
        phoneE164: phone,
        tenantId: auth!.tenantId,
        campaignId: q.campaignId,
        leadState: q.leadState,
        sources,
      });

      return reply.code(200).send({
        isDnc: result.isDnc,
        sources: result.sources,
        latencyMicros: result.latencyMicros,
        bloomFalsePositive: result.bloomFalsePositive,
      });
    },
  );

  // ── POST /api/dnc ───────────────────────────────────────────────────────────
  fastify.post(
    "/api/dnc",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "dnc:edit", reply)) return;

      const parsed = AddDncSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      const body = parsed.data;

      const phone = normalizePhone(body.phone);
      if (!phone) return reply.code(400).send({ error: "invalid_phone" });

      const prisma = getPrisma();
      try {
        await prisma.$executeRawUnsafe(
          `INSERT IGNORE INTO dnc
             (tenant_id, phone_e164, source, state, campaign_id, added_at, added_by, notes, created_at, updated_at)
           VALUES (?, ?, 'internal', ?, ?, NOW(), ?, ?, NOW(), NOW())`,
          auth!.tenantId,
          phone,
          body.state,
          body.campaignId,
          auth!.uid,
          body.notes ?? null,
        );

        await bloomAdd(getRedis(), "internal", auth!.tenantId, phone);

        return reply.code(201).send({ addedAt: new Date().toISOString() });
      } catch (err) {
        const e = err as { code?: string };
        if (e?.code === "P2002") return reply.code(409).send({ error: "already_exists" });
        throw err;
      }
    },
  );

  // ── POST /api/dnc/bulk ──────────────────────────────────────────────────────
  fastify.post(
    "/api/dnc/bulk",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "dnc:edit", reply)) return;

      const body = req.body as Record<string, unknown>;
      const source = (body?.source as string) ?? "internal";
      if (!["internal", "state", "litigator"].includes(source)) {
        return reply.code(400).send({ error: "invalid_source" });
      }
      const csvText = body?.csv as string;
      if (!csvText || typeof csvText !== "string") {
        return reply.code(400).send({ error: "missing_csv" });
      }

      const result = await bulkImportDnc(getRedis(), getPrisma(), {
        tenantId: auth!.tenantId,
        source: source as "internal" | "state" | "litigator",
        csvText,
        addedByUserId: auth!.uid,
        campaignId: body?.campaignId as string | undefined,
        state: body?.state as string | undefined,
      });

      return reply.code(200).send(result);
    },
  );

  // ── DELETE /api/dnc/:id ─────────────────────────────────────────────────────
  fastify.delete(
    "/api/dnc/:phone",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "dnc:edit", reply)) return;

      const { phone: rawPhone } = req.params as { phone: string };
      const phone = normalizePhone(decodeURIComponent(rawPhone));
      if (!phone) return reply.code(400).send({ error: "invalid_phone" });

      const query = req.query as { source?: string };
      const source = query.source ?? "internal";

      // Federal/litigator require dnc:bypass
      if ((source === "federal" || source === "litigator") &&
          !checkPerm(auth, "dnc:bypass", reply)) return;

      await getPrisma().$executeRawUnsafe(
        `UPDATE dnc SET expires_at = NOW(), updated_at = NOW()
         WHERE phone_e164 = ? AND tenant_id = ? AND source = ?`,
        phone,
        source === "federal" || source === "litigator" ? 0 : auth!.tenantId,
        source,
      );

      return reply.code(204).send();
    },
  );

  // ── POST /api/dnc/bypass ────────────────────────────────────────────────────
  fastify.post(
    "/api/dnc/bypass",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "dnc:bypass", reply)) return;

      const parsed = BypassMintSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      const body = parsed.data;

      const phone = normalizePhone(body.phone);
      if (!phone) return reply.code(400).send({ error: "invalid_phone" });

      const result = await mintBypassToken(getRedis(), {
        tenantId: auth!.tenantId,
        phone,
        source: body.source,
        userId: auth!.uid,
        justification: body.justification,
        ttlSeconds: body.ttlSeconds,
      });

      return reply.code(201).send({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );

  // ── POST /api/dnc/bypass/redeem ─────────────────────────────────────────────
  fastify.post(
    "/api/dnc/bypass/redeem",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "dnc:bypass", reply)) return;

      const parsed = BypassRedeemSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      const body = parsed.data;

      const phone = normalizePhone(body.phone);
      if (!phone) return reply.code(400).send({ error: "invalid_phone" });

      const outcome = await redeemBypassToken(getRedis(), {
        tenantId: auth!.tenantId,
        token: body.token,
        phone,
        source: body.source,
        userId: auth!.uid,
        justification: body.justification,
      });

      if (outcome === "ok") return reply.code(200).send({ outcome: "ok" });
      if (outcome === "mismatch") return reply.code(403).send({ error: "mismatch" });
      return reply.code(410).send({ error: "expired" });
    },
  );

  // ── GET /api/dnc/audit ──────────────────────────────────────────────────────
  fastify.get(
    "/api/dnc/audit",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "audit:view", reply)) return;

      const q = req.query as { page?: string };
      const page = Math.max(1, parseInt(q.page ?? "1", 10));
      const limit = 50;
      const offset = (page - 1) * limit;

      const rows = await getPrisma().$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT * FROM audit_log
         WHERE tenant_id = ?
           AND action LIKE 'dnc.bypass.%'
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        auth!.tenantId,
        limit,
        offset,
      );

      return reply.code(200).send({ page, items: rows });
    },
  );

  // ── POST /api/dnc/sync/federal ──────────────────────────────────────────────
  fastify.post(
    "/api/dnc/sync/federal",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "dnc:edit", reply)) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const dryRun = body?.dryRun === true || process.env.DNC_FEDERAL_DRY_RUN === "true";

      // For dry-run / dev triggers, run synchronously; production should use worker queue
      const result = await runFederalDeltaSync(
        getRedis(),
        getPrisma(),
        { san: "", password: "", coId: "" }, // real creds come from dnc_sync_config.config_json
        { dryRun, seedFile: body?.seedFile as string | undefined },
      );

      if (result === null) {
        return reply.code(409).send({ error: "sync_already_running" });
      }
      return reply.code(200).send(result);
    },
  );

  // ── GET /api/dnc/sync-status ────────────────────────────────────────────────
  fastify.get(
    "/api/dnc/sync-status",
    { preHandler: fastify.requireAuth },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      if (!checkPerm(auth, "dnc:read", reply)) return;
      void auth;

      const rows = await getPrisma().$queryRawUnsafe<Array<Record<string, unknown>>>(
        `SELECT source, enabled, cadence, last_run_at, next_run_at
         FROM dnc_sync_config
         ORDER BY source`,
      );

      return reply.code(200).send({ sources: rows });
    },
  );
}
