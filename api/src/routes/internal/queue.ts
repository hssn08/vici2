// I01 — Internal queue endpoints (called by FreeSWITCH dialplan + Go dispatcher).
// I01 PLAN §17.2.
//
// All routes protected by X-Internal-Secret header.
//
// Route map:
//   POST /internal/queue/enroll       — enroll call in queue
//   POST /internal/queue/timeout      — park failure / dispatcher timeout
//   POST /internal/queue/exit_callback — callback offer accepted
//   POST /internal/queue/hangup       — caller hung up mid-queue

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma.js";
import { getRedis } from "../../lib/redis.js";
import { env } from "../../lib/env.js";

const prisma = getPrisma();

// ─── Auth ─────────────────────────────────────────────────────────────────────

function requireInternalSecret(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = req.headers["x-internal-secret"];
  const expected = (env as Record<string, unknown>)["internalSecret"] as string | undefined
    ?? process.env.INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    reply.code(403).send({ code: "forbidden" });
    return false;
  }
  return true;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const EnrollSchema = z.object({
  call_uuid: z.string().min(1),
  ingroup: z.string().min(1).max(32),
  tenant: z.coerce.number().int().default(1),
});

const TimeoutSchema = z.object({
  call_uuid: z.string().min(1),
});

const ExitCallbackSchema = z.object({
  call_uuid: z.string().min(1),
  number: z.string().min(1).max(20),
  tenant: z.coerce.number().int().default(1),
});

const HangupSchema = z.object({
  call_uuid: z.string().min(1),
  tenant: z.coerce.number().int().default(1),
});

// ─── Priority computation ─────────────────────────────────────────────────────

function computePriorityBoost(
  didBoostSec: number,
  crmRank: number,
  crmEnabled: boolean,
): number {
  // I01 PLAN §10.2 (FROZEN).
  let boost = 0;
  if (didBoostSec > 0) {
    boost += Math.min(600, didBoostSec);
  }
  if (crmEnabled && crmRank > 0) {
    boost += Math.min(300, crmRank * 30);
  }
  return Math.min(900, boost);
}

// ─── Route registration ───────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerInternalQueueRoutes(app: any): Promise<void> {

  // POST /internal/queue/enroll
  // I01 PLAN §17.2 — main enroll endpoint called by FS dialplan.
  app.post("/internal/queue/enroll",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireInternalSecret(req, reply)) return;

      const query = req.query as Record<string, string>;
      const parsed = EnrollSchema.safeParse(query);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error", message: parsed.error.message });

      const { call_uuid: callUuid, ingroup: ingroupId, tenant: tenantId } = parsed.data;
      const rdb = getRedis();
      const now = Date.now();

      // Load in-group config for priority boost.
      const ingroup = await prisma.ingroup.findUnique({
        where: { tenantId_id: { tenantId: BigInt(tenantId), id: ingroupId } },
      });
      if (!ingroup) {
        return reply.code(404).send({ code: "ingroup_not_found", ingroup: ingroupId });
      }

      // CRM lookup (D01) — 200ms deadline, non-blocking on timeout.
      // I01 PLAN §10.4.
      let leadId: bigint | null = null;
      let crmRank = 0;
      const callerID = req.headers["x-caller-id"] as string | undefined ?? "";

      if (callerID) {
        try {
          const lead = await Promise.race([
            prisma.lead.findFirst({
              where: { tenantId: BigInt(tenantId), phone: callerID },
              select: { id: true, rank: true },
            }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 200)),
          ]);
          if (lead && "id" in lead && lead !== null) {
            leadId = (lead as { id: bigint; rank: number }).id;
            crmRank = (lead as { id: bigint; rank: number }).rank ?? 0;
          }
        } catch {
          // CRM lookup failed — continue without lead data.
        }
      }

      // DID-based priority boost.
      const didBoostSec = 0; // TODO: load from did_numbers.priority_boost_seconds via I02
      const boostSec = computePriorityBoost(didBoostSec, crmRank, true);
      const baseScore = now - boostSec * 1000;

      // Get current queue depth (for position_at_entry).
      const queueKey = `t:${tenantId}:ingroup:${ingroupId}:queue`;
      const depth = await rdb.zcard(queueKey);

      // ZADD to ingroup queue ZSET.
      await rdb.zadd(queueKey, baseScore, callUuid);

      // Set queue_call HASH.
      const callHashKey = `t:${tenantId}:queue_call:${callUuid}`;
      await rdb.hset(callHashKey,
        "ingroup_id", ingroupId,
        "caller_id", callerID,
        "enter_ts", String(now),
        "base_score", String(baseScore),
        "overflow_hops", "0",
        "lead_id", leadId ? String(leadId) : "",
      );

      // MySQL audit insert (async — don't block dialplan response).
      setImmediate(async () => {
        try {
          await prisma.$executeRaw`
            INSERT INTO queue_calls (
              tenant_id, call_uuid, ingroup_id, caller_id_e164, lead_id,
              enter_at, base_score, position_at_entry
            ) VALUES (
              ${tenantId}, ${callUuid}, ${ingroupId}, ${callerID},
              ${leadId}, FROM_UNIXTIME(${now} / 1000), ${baseScore}, ${depth + 1}
            )
          `;

          await prisma.$executeRaw`
            INSERT INTO queue_log (
              tenant_id, queue_call_id, event_at, event, metadata
            )
            SELECT ${tenantId}, id, FROM_UNIXTIME(${now} / 1000), 'enter',
              JSON_OBJECT('position', ${depth + 1})
            FROM queue_calls
            WHERE tenant_id = ${tenantId} AND call_uuid = ${callUuid}
            LIMIT 1
          `;
        } catch (err) {
          console.error("queue/enroll: DB insert failed", err);
        }
      });

      // Publish enrollment event to Valkey Stream (wakes dispatcher).
      // I01 PLAN §17.4.
      const enrollPayload = JSON.stringify({
        call_uuid: callUuid,
        ingroup_id: ingroupId,
        tenant_id: tenantId,
        caller_id_e164: callerID,
        base_score: baseScore,
        lead_id: leadId ? String(leadId) : null,
        matched_skills_json: "[]",
      });
      rdb.xadd("events:vici2.ingroup.enrollment", "*",
        "call_uuid", callUuid,
        "ingroup_id", ingroupId,
        "tenant_id", String(tenantId),
        "payload", enrollPayload,
      ).catch(() => {});

      return reply.code(200).send({
        enrolled: true,
        callUuid,
        ingroupId,
        position: depth + 1,
        baseScore,
      });
    }
  );

  // POST /internal/queue/timeout
  // Called by dialplan when park fails or dispatcher never picks up.
  app.post("/internal/queue/timeout",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireInternalSecret(req, reply)) return;

      const query = req.query as Record<string, string>;
      const parsed = TimeoutSchema.safeParse(query);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error" });

      const { call_uuid: callUuid } = parsed.data;
      const rdb = getRedis();

      // Cleanup: the hangup event handler will remove from ZSET.
      await rdb.hset(`t:1:queue_call:${callUuid}`, "exit_reason", "timeout");

      return reply.code(200).send({ ok: true });
    }
  );

  // POST /internal/queue/exit_callback
  // Callback offer accepted: schedule D06 callback + remove from queue.
  // I01 PLAN §11.3.
  app.post("/internal/queue/exit_callback",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireInternalSecret(req, reply)) return;

      const query = req.query as Record<string, string>;
      const parsed = ExitCallbackSchema.safeParse(query);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error" });

      const { call_uuid: callUuid, number: callbackNumber, tenant: tenantId } = parsed.data;
      const rdb = getRedis();
      const now = Date.now();

      // Get call state to find ingroup_id and position.
      const callHash = await rdb.hgetall(`t:${tenantId}:queue_call:${callUuid}`);
      const ingroupId = callHash?.ingroup_id ?? "UNKNOWN";

      // Remove from queue ZSET.
      await rdb.zrem(`t:${tenantId}:ingroup:${ingroupId}:queue`, callUuid);

      // Update call state.
      await rdb.hset(`t:${tenantId}:queue_call:${callUuid}`,
        "exit_at", String(now),
        "exit_reason", "callback",
      );

      // Schedule D06 callback (best-effort).
      setImmediate(async () => {
        try {
          const leadId = callHash?.lead_id ? BigInt(callHash.lead_id) : null;
          await prisma.$executeRaw`
            INSERT INTO callbacks (
              tenant_id, ingroup_id, phone_number, lead_id, status, expires_at, created_at
            ) VALUES (
              ${tenantId}, ${ingroupId}, ${callbackNumber}, ${leadId},
              'PENDING',
              DATE_ADD(NOW(), INTERVAL 96 HOUR),
              NOW(6)
            )
          `;

          await prisma.$executeRaw`
            UPDATE queue_calls
            SET exit_at = FROM_UNIXTIME(${now} / 1000),
                exit_reason = 'callback'
            WHERE tenant_id = ${tenantId} AND call_uuid = ${callUuid}
          `;
        } catch (err) {
          console.error("queue/exit_callback: DB insert failed", err);
        }
      });

      return reply.code(200).send({ ok: true, callbackNumber });
    }
  );

  // POST /internal/queue/hangup
  // Called via ESL event → T01 when caller hangs up mid-queue.
  // I01 PLAN §17.2 + AC-5.
  app.post("/internal/queue/hangup",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireInternalSecret(req, reply)) return;

      const query = req.query as Record<string, string>;
      const parsed = HangupSchema.safeParse(query);
      if (!parsed.success) return reply.code(400).send({ code: "validation_error" });

      const { call_uuid: callUuid, tenant: tenantId } = parsed.data;
      const rdb = getRedis();
      const now = Date.now();

      // Get call state.
      const callHash = await rdb.hgetall(`t:${tenantId}:queue_call:${callUuid}`);
      const ingroupId = callHash?.ingroup_id;

      if (ingroupId) {
        await rdb.zrem(`t:${tenantId}:ingroup:${ingroupId}:queue`, callUuid);
      }
      await rdb.hset(`t:${tenantId}:queue_call:${callUuid}`,
        "exit_at", String(now),
        "exit_reason", "caller_hangup",
      );

      // DB update (async).
      if (ingroupId) {
        setImmediate(async () => {
          try {
            await prisma.$executeRaw`
              UPDATE queue_calls
              SET exit_at = FROM_UNIXTIME(${now} / 1000),
                  exit_reason = 'caller_hangup'
              WHERE tenant_id = ${tenantId} AND call_uuid = ${callUuid}
            `;
          } catch (_err) {
            // Non-fatal: audit trail best-effort.
          }
        });
      }

      return reply.code(200).send({ ok: true });
    }
  );
}
