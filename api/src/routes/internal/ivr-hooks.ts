// I02 — Internal IVR hooks (called by eslbridge / FreeSWITCH).
//
// Route map:
//   POST /internal/ivr/traversal_log       — write traversal log rows
//   POST /internal/ivr/callback_accept/:uuid — D06 callback scheduling

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma.js";
import { env } from "../../lib/env.js";
// IvrTraversalLogEntry shape is documented in @vici2/types — kept for reference
// import type { IvrTraversalLogEntry } from "@vici2/types";

const prisma = getPrisma();

// ─── Auth ─────────────────────────────────────────────────────────────────────

function requireInternalSecret(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = req.headers["x-internal-secret"];
  const expected =
    (env as Record<string, unknown>)["internalSecret"] as string | undefined
    ?? process.env.INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    reply.code(403).send({ code: "forbidden" });
    return false;
  }
  return true;
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const TraversalLogSchema = z.object({
  session_uuid: z.string().min(1).max(40),
  ivr_id: z.coerce.bigint(),
  tenant_id: z.coerce.bigint().default(BigInt(1)),
  lang: z.string().max(5).default("en"),
  path: z.array(z.string()),
  digits: z.array(z.string()),
  final_outcome: z.string().max(16),
  total_duration_ms: z.coerce.number().int().min(0),
});

// ─── Registration ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerInternalIvrRoutes(app: any): Promise<void> {

  // POST /internal/ivr/traversal_log
  app.post("/internal/ivr/traversal_log",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireInternalSecret(req, reply)) return;

      const parsed = TraversalLogSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }

      const d = parsed.data;
      const path = d.path;
      const digits = d.digits;
      const now = new Date();

      // Build one log row per visited node
      const rows = path.map((nodeIdStr, idx) => ({
        tenantId: d.tenant_id,
        ivrId: d.ivr_id,
        sessionUuid: d.session_uuid,
        nodeId: BigInt(nodeIdStr),
        lang: d.lang,
        digit: digits[idx] ?? null,
        outcome: idx === path.length - 1
          ? (["terminal", "hangup", "timeout"].includes(d.final_outcome)
              ? d.final_outcome as "terminal" | "hangup" | "timeout"
              : "digit")
          : "digit",
        durationMs: idx === path.length - 1 ? d.total_duration_ms : 0,
        enteredAt: now,
      }));

      if (rows.length > 0) {
        // Batch insert — ivr_traversal_log is partitioned so skip Prisma model
        await prisma.$executeRawUnsafe(
          `INSERT INTO ivr_traversal_log
            (tenant_id, ivr_id, session_uuid, node_id, lang, digit, outcome, duration_ms, entered_at)
           VALUES ${rows.map(() => "(?,?,?,?,?,?,?,?,?)").join(",")}`,
          ...rows.flatMap((r) => [
            r.tenantId,
            r.ivrId,
            r.sessionUuid,
            r.nodeId,
            r.lang,
            r.digit,
            r.outcome,
            r.durationMs,
            r.enteredAt,
          ]),
        );
      }

      return reply.send({ ok: true, rows: rows.length });
    },
  );

  // POST /internal/ivr/callback_accept/:uuid
  app.post("/internal/ivr/callback_accept/:uuid",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireInternalSecret(req, reply)) return;

      const { uuid } = req.params as { uuid: string };
      const body = req.body as Record<string, unknown>;
      const ingroupId = String(body.vici2_callback_ingroup ?? "");
      const phoneE164 = String(body.vici2_did_e164 ?? "");
      const tenantId = BigInt(Number(body.tenant_id ?? 1));

      if (!ingroupId || !phoneE164) {
        return reply.code(400).send({ code: "missing_params", message: "vici2_callback_ingroup and vici2_did_e164 required" });
      }

      // D06 callback scheduling — stub for Phase 1
      // Full D06 integration wired when D06 IMPLEMENT ships.
      await prisma.$executeRawUnsafe(
        `INSERT INTO callbacks (tenant_id, phone_e164, ingroup_id, status, source, source_uuid, scheduled_at, created_at, updated_at)
         VALUES (?, ?, ?, 'PENDING', 'ivr_callback', ?, NOW(6), NOW(6), NOW(6))
         ON DUPLICATE KEY UPDATE updated_at=NOW(6)`,
        tenantId,
        phoneE164,
        ingroupId,
        uuid,
      );

      return reply.send({ ok: true, uuid });
    },
  );
}
