// POST /api/sup/monitor/start
//
// Pre-flight endpoint: validates RBAC, agent-in-call status, member budget,
// agent consent, mints a 60-second monitor grant JWT, writes audit rows.
//
// S02 PLAN §5.1, §11.1.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { SignJWT } from "jose";
import { randomUUID } from "node:crypto";

import { MonitorStartBodySchema } from "./monitor.schema.js";
import { MONITOR_TOKEN_AUD, MONITOR_TOKEN_TTL_SEC } from "./monitor.token.js";
import { roleAtLeast } from "../../auth/rbac.js";
import { initJwt, getActiveKid } from "../../auth/jwt.js";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";
import { env } from "../../lib/env.js";

// Maximum number of conference members before rejecting a new supervisor join.
// S02 PLAN §5.1 step 3: member budget < 18 (leaves 2 slots for 3-way transfers).
const MAX_CONF_MEMBERS_BUDGET = 18;

export function registerMonitorStartRoute(app: FastifyInstance): void {
  app.post(
    "/api/sup/monitor/start",
    {
      preHandler: [app.requireAuth, app.requireRole("supervisor")],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = MonitorStartBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
      }

      const body = parsed.data;
      const auth = req.auth!;
      const prisma = getPrisma();
      const redis = getRedis();

      // ── 1. Role check (middleware already enforces supervisor, but be explicit)
      if (!roleAtLeast(auth.role, "supervisor")) {
        return reply.code(403).send({ error: "role_insufficient" });
      }

      // ── 2. Fetch target agent — must exist and be active ─────────────────
      const targetAgent = await prisma.user.findFirst({
        where: { id: BigInt(body.target_uid), active: true },
        select: { id: true, tenantId: true },
      });

      if (!targetAgent) {
        await writeMonitorAudit(req, "monitor.session.denied", auth.uid, auth.tenantId, body.target_uid, null, {
          reason: "agent_not_found",
        });
        return reply.code(404).send({ error: "agent_not_found" });
      }

      // ── 3. Cross-tenant guard ─────────────────────────────────────────────
      if (Number(targetAgent.tenantId) !== auth.tenantId) {
        await writeMonitorAudit(req, "monitor.session.denied", auth.uid, auth.tenantId, body.target_uid, null, {
          reason: "tenant_mismatch",
        });
        return reply.code(403).send({ error: "tenant_mismatch" });
      }

      // ── 4. Agent-in-call check via Valkey ─────────────────────────────────
      // S02 PLAN §5.1 step 2.
      const agentKey = `t:${auth.tenantId}:agent:${body.target_uid}`;
      const agentStatus = await redis.hget(agentKey, "status");
      if (agentStatus !== "INCALL") {
        await writeMonitorAudit(req, "monitor.session.denied", auth.uid, auth.tenantId, body.target_uid, null, {
          reason: "agent_not_in_call",
          actual_status: agentStatus ?? "unknown",
        });
        return reply.code(409).send({ error: "agent_not_in_call" });
      }

      // ── 5. Member budget check ────────────────────────────────────────────
      // S02 PLAN §5.1 step 3.
      const confMembersKey = `t:${auth.tenantId}:agent:${body.target_uid}:conf_members`;
      const memberCount = await redis.hlen(confMembersKey);
      if (memberCount >= MAX_CONF_MEMBERS_BUDGET) {
        await writeMonitorAudit(req, "monitor.session.denied", auth.uid, auth.tenantId, body.target_uid, null, {
          reason: "member_budget_exceeded",
          current_count: memberCount,
        });
        return reply.code(503).send({ error: "member_budget_exceeded" });
      }

      // ── 6. Agent monitor-consent check ────────────────────────────────────
      // S02 PLAN §8.4: target agent must have a current monitor-consent audit row.
      // Written by the F05 login flow (S02 PLAN §14.4 amendment).
      const consentRow = await prisma.auditLog.findFirst({
        where: {
          tenantId: BigInt(auth.tenantId),
          actorUserId: BigInt(body.target_uid),
          action: "user.acknowledged_monitor_consent",
        },
        orderBy: { ts: "desc" },
      });

      // TODO(Phase-1.5): validate consent text version hash from afterJson.
      if (!consentRow) {
        await writeMonitorAudit(req, "monitor.session.denied", auth.uid, auth.tenantId, body.target_uid, null, {
          reason: "agent_consent_missing",
        });
        return reply.code(412).send({ error: "agent_consent_missing" });
      }

      // ── 7. Write monitor.session.requested audit row ──────────────────────
      const jti = randomUUID();
      await writeMonitorAudit(req, "monitor.session.requested", auth.uid, auth.tenantId, jti, null, {
        tid: auth.tenantId,
        sup_uid: auth.uid,
        target_uid: body.target_uid,
        mode: body.initial_mode,
      });

      // ── 8. Mint monitor grant token ───────────────────────────────────────
      // S02 PLAN §5.1 step 5. Uses the same private key as access tokens but
      // with aud=vici2-monitor-grant, TTL=60s, carries monitor-specific claims.
      await initJwt();
      const kid = getActiveKid();
      if (!kid) {
        return reply.code(500).send({ error: "jwt_not_configured" });
      }

      // We sign directly using SignJWT to avoid coupling to the access-token
      // key wrapper internals. The key is loaded via initJwt() above.
      // Phase 2 TODO: dedicated key injection via app.decorate.
      let token: string;
      let expiresAt: Date;
      try {
        const now = Math.floor(Date.now() / 1000);
        const exp = now + MONITOR_TOKEN_TTL_SEC;
        expiresAt = new Date(exp * 1000);

        // Store JTI in Valkey for one-time use.
        const jtiKey = `vici2:monitor:jti:${jti}`;
        await redis.set(jtiKey, "1", "EX", 90, "NX");

        // Build and sign the token using the existing signAccessToken-compatible
        // key infrastructure. We call signAccessToken with custom fields by
        // producing a raw SignJWT.
        // Phase 1: use the same EdDSA private key (different aud is sufficient
        // differentiation per PLAN §5.1).
        // Ensure initJwt has been called (makes jwt key material ready).
        await import("../../auth/jwt.js").then((m) => m.initJwt());
        //
        // Better approach used here: import the jose SignJWT and sign with the
        // key obtained from the environment directly (same env vars).
        // This mirrors what jwt.ts does internally.
        const { importJWK } = await import("jose");
        const envJwk = env.jwtPrivateKeyJwk
          ? JSON.parse(Buffer.from(env.jwtPrivateKeyJwk, "base64").toString("utf-8")) as Record<string, unknown>
          : null;

        if (!envJwk) {
          return reply.code(500).send({ error: "jwt_not_configured" });
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const privateKey = await importJWK(envJwk as any, env.jwtAlg);
        const signedKid = (envJwk.kid as string) ?? kid;

        const claims = {
          iss: env.jwtIssuer,
          aud: MONITOR_TOKEN_AUD,
          sub: `u_${auth.uid}`,
          uid: auth.uid,
          tid: auth.tenantId,
          role: auth.role,
          monitor_target_uid: body.target_uid,
          monitor_initial_mode: body.initial_mode,
          iat: now,
          exp,
          jti,
        };

        token = await new SignJWT(claims as Record<string, unknown>)
          .setProtectedHeader({ alg: env.jwtAlg, kid: signedKid, typ: "JWT" })
          .sign(privateKey);
      } catch (err) {
        req.log.error({ err }, "monitor: token mint failed");
        return reply.code(500).send({ error: "token_mint_failed" });
      }

      // ── 9. Write monitor.session.authorized audit row ─────────────────────
      await writeMonitorAudit(req, "monitor.session.authorized", auth.uid, auth.tenantId, jti, null, {
        token_exp: expiresAt.toISOString(),
        member_budget_remaining: MAX_CONF_MEMBERS_BUDGET - memberCount,
        jti,
      });

      // ── 10. Build response ────────────────────────────────────────────────
      // dial_extension = *8{tid}_{target_uid}_{mode}
      // S02 PLAN §5.1: "dial_extension": "*81_1042_listen"
      const confName = `agent_t${auth.tenantId}_u${body.target_uid}`;
      const dialExtension = `*8${auth.tenantId}_${body.target_uid}_${body.initial_mode}`;

      return reply.code(200).send({
        session_id: jti,
        token,
        expires_at: expiresAt.toISOString(),
        dial_extension: dialExtension,
        target_conf_name: confName,
      });
    },
  );
}

/** Write a monitor-domain audit row. Non-fatal on error. */
async function writeMonitorAudit(
  req: FastifyRequest,
  action: string,
  actorUserId: number,
  tenantId: number,
  entityId: string | number,
  beforeJson: unknown,
  afterJson: Record<string, unknown>,
): Promise<void> {
  try {
    const prisma = getPrisma();
    await // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma.auditLog as any).create({
      data: {
        tenantId: BigInt(tenantId),
        actorUserId: BigInt(actorUserId),
        actorKind: "user",
        action,
        entityType: "monitor_session",
        entityId: String(entityId),
        beforeJson: beforeJson ?? null,
        afterJson: afterJson as Record<string, unknown>,
        requestId: null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        ts: new Date(),
      },
    });
  } catch (err) {
    req.log.error({ err, action }, "monitor: audit write failed (non-fatal)");
  }
}
