// DELETE /api/sup/sessions/:id
//
// End a monitor session by kicking the supervisor's conference member.
// The supervisor's SIP leg receives BYE; api_hangup_hook fires to write the
// monitor.session.ended audit row.
//
// Authorization: the supervisor who owns the session, OR any admin/super_admin.
// S02 PLAN §11.3.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { getRedis } from "../../lib/redis.js";

export function registerMonitorEndRoute(app: FastifyInstance): void {
  app.delete(
    "/api/sup/sessions/:id",
    {
      preHandler: [app.requireAuth, app.requireRole("supervisor")],
    },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { id: sessionId } = req.params as { id: string };
      const auth = req.auth!;
      const redis = getRedis();

      // ── 1. Resolve session ────────────────────────────────────────────────
      const jtiIndexKey = `t:${auth.tenantId}:monitor:jti:${sessionId}`;
      const supCallUUID = await redis.get(jtiIndexKey);
      if (!supCallUUID) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      const sessionKey = `t:${auth.tenantId}:monitor:${supCallUUID}`;
      const session = await redis.hgetall(sessionKey);
      if (!session || !session.mode) {
        return reply.code(404).send({ error: "session_not_found" });
      }

      // ── 2. Authorization ──────────────────────────────────────────────────
      if (session.sup_uid && Number(session.sup_uid) !== auth.uid) {
        if (!["admin", "super_admin"].includes(auth.role)) {
          return reply.code(403).send({ error: "not_session_owner" });
        }
      }

      const supMID = session.conf_member_id;
      const targetUID = session.target_uid;
      const confName = `agent_t${auth.tenantId}_u${targetUID}`;

      // ── 3. Kick the supervisor from the conference ─────────────────────────
      // S02 PLAN §11.3: conference kick <supMID>. The BYE flows back to the
      // supervisor's SIP.js. The api_hangup_hook fires asynchronously.
      try {
        const dialerUrl = process.env.DIALER_INTERNAL_URL ?? "http://dialer:8081";
        const resp = await fetch(`${dialerUrl}/internal/conference/command`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conf_name: confName, command: "kick", args: supMID }),
        });
        if (!resp.ok) {
          req.log.warn({ status: resp.status }, "monitor: kick command returned non-2xx");
          // Non-fatal: fall through; Valkey cleanup will happen via hangup hook.
        }
      } catch (err) {
        req.log.error({ err }, "monitor: kick conference command failed");
        // Fall through: clean up Valkey state anyway.
      }

      // ── 4. Clean up Valkey state eagerly ─────────────────────────────────
      // The conf-maint del-member handler will also clean up when the kick
      // fires the del-member event, so this is idempotent.
      const confMembersKey = `t:${auth.tenantId}:agent:${targetUID}:conf_members`;
      await redis.hdel(confMembersKey, supCallUUID);

      const monitorZKey = `t:${auth.tenantId}:agent:${targetUID}:monitors`;
      await redis.zrem(monitorZKey, supCallUUID);

      await redis.del(sessionKey);
      await redis.del(jtiIndexKey);

      // Audit row is written by the api_hangup_hook (monitor.end.internal.ts)
      // when the supervisor leg actually hangs up. We do not double-write here.

      return reply.code(204).send();
    },
  );
}
