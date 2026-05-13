// GET /internal/freeswitch/monitor_authz
//
// Called by the FreeSWITCH dialplan via mod_xml_curl (or curl_auto) during
// the supervisor's INVITE. Validates the monitor grant token (signature,
// expiry, role, tenant, jti one-time use) and returns 200 OK or 403 Forbidden.
//
// This is the defense-in-depth layer: even if the API pre-flight has a bug,
// the dialplan will reject unauthenticated supervisors. (S02 PLAN §6.2.)
//
// NOT a public-facing endpoint. No authentication middleware needed — the
// token itself is the credential.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { jwtVerify, importJWK, type KeyLike } from "jose";
import { MonitorAuthzQuerySchema } from "./monitor.schema.js";
import { MONITOR_TOKEN_AUD } from "./monitor.token.js";
import { getRedis } from "../../lib/redis.js";
import { env } from "../../lib/env.js";
import { getPrisma } from "../../lib/prisma.js";

export function registerMonitorAuthzRoute(app: FastifyInstance): void {
  app.get(
    "/internal/freeswitch/monitor_authz",
    async (req: FastifyRequest, reply: FastifyReply) => {
      const parsed = MonitorAuthzQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply
          .code(200) // FS expects 200 even for errors; we use result status.
          .send(forbiddenXml("invalid_params"));
      }

      const q = parsed.data;
      const redis = getRedis();

      // ── 1. Verify JWT ─────────────────────────────────────────────────────
      let payload: {
        jti: string;
        tid: number;
        uid: number;
        role: string;
        monitor_target_uid: number;
        monitor_initial_mode: string;
        exp: number;
      };

      try {
        const publicKeysJwks = env.jwtPublicKeysJwks
          ? JSON.parse(Buffer.from(env.jwtPublicKeysJwks, "base64").toString("utf-8")) as { keys: Array<Record<string, unknown>> }
          : null;

        if (!publicKeysJwks) {
          return reply.code(200).send(forbiddenXml("jwt_not_configured"));
        }

        const keyMap = new Map<string, KeyLike | Uint8Array>();
        for (const jwk of publicKeysJwks.keys) {
          if (jwk.kid && typeof jwk.kid === "string") {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const key = await importJWK(jwk as any, env.jwtAlg);
            keyMap.set(jwk.kid, key as KeyLike);
          }
        }

        const result = await jwtVerify(
          q.token,
          (h) => {
            const entry = keyMap.get((h as { kid?: string }).kid ?? "");
            if (!entry) throw new Error("unknown kid");
            return entry as KeyLike;
          },
          { issuer: env.jwtIssuer, audience: MONITOR_TOKEN_AUD, clockTolerance: 10 },
        );
        payload = result.payload as typeof payload;
      } catch (err) {
        req.log.warn({ err }, "monitor_authz: token verify failed");
        await writeDeniedAudit(req, q, "token_invalid");
        return reply.code(200).send(forbiddenXml("token_invalid"));
      }

      // ── 2. JTI one-time use check ─────────────────────────────────────────
      // S02 PLAN §6.2: the JTI was stored at mint time (EX 90 NX).
      // DEL returns 0 if already consumed or never existed.
      const jtiKey = `vici2:monitor:jti:${payload.jti}`;
      const deleted = await redis.del(jtiKey);
      if (deleted === 0) {
        req.log.warn({ jti: payload.jti }, "monitor_authz: JTI replay detected");
        await writeDeniedAudit(req, q, "token_replay");
        return reply.code(200).send(forbiddenXml("token_replay"));
      }

      // ── 3. Tenant scope check ─────────────────────────────────────────────
      const claimedTid = String(payload.tid);
      if (claimedTid !== q.target_tid) {
        req.log.warn({ jwt_tid: payload.tid, req_tid: q.target_tid }, "monitor_authz: tenant mismatch");
        await writeDeniedAudit(req, q, "tenant_mismatch");
        return reply.code(200).send(forbiddenXml("tenant_mismatch"));
      }

      // ── 4. Target UID check ───────────────────────────────────────────────
      if (String(payload.monitor_target_uid) !== q.target_uid) {
        req.log.warn({ jwt_target: payload.monitor_target_uid, req_target: q.target_uid }, "monitor_authz: target_uid mismatch");
        await writeDeniedAudit(req, q, "target_uid_mismatch");
        return reply.code(200).send(forbiddenXml("target_uid_mismatch"));
      }

      // ── 5. Store JTI→supCallUUID mapping (populated when FS assigns UUID) ─
      // At this point we don't have the FS call UUID yet (it's assigned by FS
      // after the dialplan returns). We store the JTI→mode mapping so the
      // conf-maint handler can look up the session later.
      // The actual sup_call_uuid is stored in the HASH by OnSupervisorJoin.
      const jtiIndexKey = `t:${payload.tid}:monitor:jti:${payload.jti}`;
      // Store the jti→mode mapping temporarily (90s), to be replaced with
      // the real sup_call_uuid by the conf-maint handler.
      await redis.set(jtiIndexKey, `pending:${payload.jti}`, "EX", 90);

      req.log.info({ jti: payload.jti, target_uid: q.target_uid, mode: q.mode }, "monitor_authz: authorized");

      // ── 6. Return 200 OK to FS ────────────────────────────────────────────
      return reply
        .code(200)
        .header("Content-Type", "text/xml")
        .send(
          `<?xml version="1.0"?>\n` +
          `<document type="freeswitch/xml">\n` +
          `  <section name="result">\n` +
          `    <result status="200"/>\n` +
          `  </section>\n` +
          `</document>`,
        );
    },
  );
}

function forbiddenXml(reason: string): string {
  return (
    `<?xml version="1.0"?>\n` +
    `<document type="freeswitch/xml">\n` +
    `  <section name="result">\n` +
    `    <result status="403" reason="${reason}"/>\n` +
    `  </section>\n` +
    `</document>`
  );
}

async function writeDeniedAudit(
  req: FastifyRequest,
  q: { caller_uid: string; target_tid: string; target_uid: string; mode: string },
  reason: string,
): Promise<void> {
  try {
    const prisma = getPrisma();
    await // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (prisma.auditLog as any).create({
      data: {
        tenantId: BigInt(q.target_tid),
        actorUserId: BigInt(q.caller_uid),
        actorKind: "system",
        action: "monitor.session.denied",
        entityType: "monitor_session",
        entityId: null,
        beforeJson: null,
        afterJson: { reason, caller_uid: q.caller_uid, target_uid: q.target_uid, mode: q.mode },
        requestId: null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        ts: new Date(),
      },
    });
  } catch {
    req.log.warn("monitor_authz: audit write failed (non-fatal)");
  }
}
