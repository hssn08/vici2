// POST /internal/freeswitch/monitor_end
//
// Called by FreeSWITCH api_hangup_hook when the supervisor's SIP leg
// terminates (either from API DELETE or supervisor browser disconnect).
//
// Writes the monitor.session.ended audit row (idempotent via jti-keyed check
// to prevent double-write if both DELETE and hangup hook fire).
//
// S02 PLAN §11.5.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { MonitorEndQuerySchema } from "./monitor.schema.js";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";

export function registerMonitorHangupHookRoute(app: FastifyInstance): void {
  // FS api_hangup_hook fires as GET with UUID in query string,
  // but we accept both GET (FS default) and POST for flexibility.
  app.get(
    "/internal/freeswitch/monitor_end",
    async (req: FastifyRequest, reply: FastifyReply) => {
      return handleMonitorEnd(req, reply);
    },
  );

  app.post(
    "/internal/freeswitch/monitor_end",
    async (req: FastifyRequest, reply: FastifyReply) => {
      return handleMonitorEnd(req, reply);
    },
  );
}

async function handleMonitorEnd(req: FastifyRequest, reply: FastifyReply): Promise<unknown> {
  const parsed = MonitorEndQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_query" });
  }

  const { uuid: supCallUUID } = parsed.data;
  const redis = getRedis();
  const prisma = getPrisma();

  // ── 1. Find the session HASH from the supervisor's call UUID ──────────────
  // We need the tenantID to build the key. In Phase 1, single-tenant (tid=1).
  // Phase 2: FS passes vici2_mon_tid as a query param or we scan by UUID.
  // Workaround: FS can pass tid as &tid=1 in the hook URL.
  const tidStr = (req.query as Record<string, string>).tid ?? "1";
  const tenantID = parseInt(tidStr, 10);

  const sessionKey = `t:${tenantID}:monitor:${supCallUUID}`;
  const session = await redis.hgetall(sessionKey);

  if (!session || Object.keys(session).length === 0) {
    // Session already cleaned up (DELETE fired first); idempotent.
    req.log.info({ supCallUUID }, "monitor_end hook: session already cleaned up");
    return reply.code(204).send();
  }

  // ── 2. Idempotency guard ──────────────────────────────────────────────────
  // Use a short-lived Valkey lock to prevent double-audit when both DELETE
  // and hangup hook fire within the same second.
  const idempotencyKey = `vici2:monitor:ended:${supCallUUID}`;
  const alreadyWritten = await redis.set(idempotencyKey, "1", "EX", 30, "NX");
  if (alreadyWritten === null) {
    // Lock was already held by DELETE path; skip audit row.
    req.log.info({ supCallUUID }, "monitor_end hook: audit already written by DELETE path");
    return reply.code(204).send();
  }

  // ── 3. Compute session duration ───────────────────────────────────────────
  const startedAtMs = parseInt(session.started_at ?? "0", 10);
  const endedAt = new Date();
  const durationSec = startedAtMs > 0
    ? Math.round((endedAt.getTime() - startedAtMs) / 1000)
    : 0;

  // ── 4. Determine reason ───────────────────────────────────────────────────
  // FS doesn't tell us why the leg hung up. We infer:
  // - If the DELETE route cleaned up Valkey before the hook fired, the
  //   idempotency guard above would have caught it.
  // - If we reach here, the supervisor disconnected spontaneously.
  const reason = "supervisor_disconnect";

  // ── 5. Write audit row ────────────────────────────────────────────────────
  const supUID = session.sup_uid ? parseInt(session.sup_uid, 10) : null;
  try {
    await // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (prisma.auditLog as any).create({
      data: {
        tenantId: BigInt(tenantID),
        actorUserId: supUID !== null ? BigInt(supUID) : null,
        actorKind: "system",
        action: "monitor.session.ended",
        entityType: "monitor_session",
        entityId: supCallUUID,
        beforeJson: null,
        afterJson: {
          ended_at: endedAt.toISOString(),
          duration_sec: durationSec,
          reason,
          target_uid: session.target_uid,
          sup_uid: session.sup_uid,
          mode: session.mode,
        },
        requestId: null,
        ipAddress: req.ip,
        userAgent: req.headers["user-agent"] ?? null,
        ts: endedAt,
      },
    });
  } catch (err) {
    req.log.error({ err, supCallUUID }, "monitor_end hook: audit write failed");
  }

  // ── 6. Clean up Valkey state ───────────────────────────────────────────────
  const targetUID = session.target_uid;
  if (targetUID) {
    const confMembersKey = `t:${tenantID}:agent:${targetUID}:conf_members`;
    await redis.hdel(confMembersKey, supCallUUID);
    const monitorZKey = `t:${tenantID}:agent:${targetUID}:monitors`;
    await redis.zrem(monitorZKey, supCallUUID);
  }
  await redis.del(sessionKey);

  req.log.info({ supCallUUID, durationSec, reason }, "monitor session ended");
  return reply.code(204).send();
}
