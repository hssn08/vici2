// I01 — Supervisor endpoints for inbound queue management.
// I01 PLAN §17.3 + §16.3 + §16.4.
//
// Route map:
//   GET  /api/sup/ingroups/:id/queue         live queue detail (per-call)
//   POST /api/sup/ingroups/:id/queue/:uuid/dispatch   force-dispatch to agent
//   POST /api/sup/ingroups/:id/queue/:uuid/kick       kick caller to overflow

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";
import type { AuthContext } from "../../auth/middleware.js";

const prisma = getPrisma();

type AuthReq = FastifyRequest & { auth?: AuthContext };
function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

const ForceDispatchSchema = z.object({
  agent_user_id: z.coerce.bigint(),
});

const KickSchema = z.object({
  reason: z.string().max(128).optional(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerSupIngroupRoutes(app: any): Promise<void> {

  // GET /api/sup/ingroups/:id/queue — live queue with per-call detail.
  // I01 PLAN §17.3.
  app.get("/api/sup/ingroups/:id/queue",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { id } = req.params as { id: string };
      const rdb = getRedis();

      // zrange returns alternating [member, score, member, score, ...]
      const callUUIDs = await (rdb as unknown as { zrange(key: string, start: number, stop: number, withScores: string): Promise<string[]> })
        .zrange(`t:${tenantId}:ingroup:${id}:queue`, 0, -1, "WITHSCORES");
      const calls: Array<{ callUuid: string; baseScore: number; position: number }> = [];
      for (let i = 0; i < callUUIDs.length; i += 2) {
        calls.push({
          callUuid: callUUIDs[i] as string,
          baseScore: Number(callUUIDs[i + 1]),
          position: Math.floor(i / 2) + 1,
        });
      }

      const detailedCalls = await Promise.all(calls.map(async (c) => {
        const hash = await rdb.hgetall(`t:${tenantId}:queue_call:${c.callUuid}`);
        const enterTs = hash?.enter_ts ? Number(hash.enter_ts) : null;
        const waitSec = enterTs ? Math.floor((Date.now() - enterTs) / 1000) : null;
        return {
          ...c,
          callerIdE164: hash?.caller_id ?? null,
          enterTs,
          waitSec,
          ingroupId: hash?.ingroup_id ?? id,
          overflowHops: hash?.overflow_hops ? Number(hash.overflow_hops) : 0,
        };
      }));

      const meta = await rdb.hgetall(`t:${tenantId}:ingroup:${id}:queue_meta`);
      return reply.send({
        ingroupId: id,
        depth: calls.length,
        avgHandleSec: meta?.avg_handle_sec ? Number(meta.avg_handle_sec) : null,
        calls: detailedCalls,
      });
    }
  );

  // POST /api/sup/ingroups/:id/queue/:uuid/dispatch — force-dispatch.
  // I01 PLAN §16.3.
  app.post("/api/sup/ingroups/:id/queue/:uuid/dispatch",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId, uid: supervisorId } = getAuth(req);
      const { id: igid, uuid: callUuid } = req.params as { id: string; uuid: string };
      const parsed = ForceDispatchSchema.safeParse(req.body);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const agentUserId = parsed.data.agent_user_id;
      const rdb = getRedis();
      const now = Date.now();

      // Verify call still in queue.
      const score = await rdb.zscore(`t:${tenantId}:ingroup:${igid}:queue`, callUuid);
      if (!score) {
        return reply.code(404).send({ code: "call_not_in_queue" });
      }

      // Run the dispatch Lua script atomically.
      // (Re-use the same script as queuerd via Valkey EVALSHA)
      // For supervisor force-dispatch: execute Redis ops directly (supervisor override).
      await Promise.all([
        rdb.zrem(`t:${tenantId}:ingroup:${igid}:queue`, callUuid),
        rdb.zrem(`t:${tenantId}:ingroup:${igid}:ready_agents`, String(agentUserId)),
        rdb.zrem(`t:${tenantId}:agents:by_status:READY`, String(agentUserId)),
        rdb.zadd(`t:${tenantId}:agents:by_status:INCALL`, now, String(agentUserId)),
        rdb.hset(`t:${tenantId}:agent:${agentUserId}`,
          "status", "INCALL",
          "call_uuid", callUuid,
          "ingroup_id", igid,
          "incall_since", String(now),
        ),
        rdb.hset(`t:${tenantId}:queue_call:${callUuid}`,
          "dispatch_at", String(now),
          "dispatch_user_id", String(agentUserId),
        ),
      ]);

      // Write audit queue_log row.
      setImmediate(async () => {
        try {
          await prisma.$executeRaw`
            INSERT INTO queue_log (tenant_id, queue_call_id, event_at, event, metadata)
            SELECT ${tenantId}, id, FROM_UNIXTIME(${now} / 1000), 'dispatch',
              JSON_OBJECT('forced_by_supervisor', ${supervisorId}, 'agent_user_id', ${Number(agentUserId)})
            FROM queue_calls
            WHERE tenant_id = ${tenantId} AND call_uuid = ${callUuid}
            LIMIT 1
          `;
        } catch (_err) {
            // Non-fatal: audit best-effort.
          }
      });

      return reply.code(200).send({ ok: true, dispatchedTo: String(agentUserId) });
    }
  );

  // POST /api/sup/ingroups/:id/queue/:uuid/kick — kick caller to overflow.
  // I01 PLAN §16.4.
  app.post("/api/sup/ingroups/:id/queue/:uuid/kick",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId, uid: supervisorId } = getAuth(req);
      const { id: igid, uuid: callUuid } = req.params as { id: string; uuid: string };
      const parsed = KickSchema.safeParse(req.body ?? {});
      const reason = parsed.success ? (parsed.data.reason ?? "supervisor_kick") : "supervisor_kick";

      const rdb = getRedis();
      const now = Date.now();

      // Remove from queue.
      await rdb.zrem(`t:${tenantId}:ingroup:${igid}:queue`, callUuid);
      await rdb.hset(`t:${tenantId}:queue_call:${callUuid}`,
        "exit_at", String(now),
        "exit_reason", "overflow",
      );

      // Write audit queue_log row.
      setImmediate(async () => {
        try {
          await prisma.$executeRaw`
            INSERT INTO queue_log (tenant_id, queue_call_id, event_at, event, metadata)
            SELECT ${tenantId}, id, FROM_UNIXTIME(${now} / 1000), 'overflow',
              JSON_OBJECT('kicked_by', ${supervisorId}, 'reason', ${reason})
            FROM queue_calls
            WHERE tenant_id = ${tenantId} AND call_uuid = ${callUuid}
            LIMIT 1
          `;
        } catch (_err) {
            // Non-fatal: audit best-effort.
          }
      });

      return reply.code(200).send({ ok: true, reason });
    }
  );
}
