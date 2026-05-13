// I03 — Internal voicemail hooks (called by FreeSWITCH after recording completes).
//
// Route map:
//   POST /api/internal/voicemail/recorded   — FS webhook: create voicemail row, notify users
//   GET  /api/internal/voicemail/file       — serve local voicemail file (dev only)
//
// Authentication: X-Internal-Secret header (same pattern as ivr-hooks.ts).

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { getPrisma } from "../../lib/prisma.js";
import { notify } from "../../notifications/service.js";

const prisma = getPrisma();

// ─── Auth ─────────────────────────────────────────────────────────────────────

function requireInternalSecret(req: FastifyRequest, reply: FastifyReply): boolean {
  const secret = req.headers["x-internal-secret"];
  const expected = process.env.INTERNAL_SECRET;
  if (!expected || secret !== expected) {
    void reply.code(403).send({ error: "forbidden" });
    return false;
  }
  return true;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const RecordedSchema = z.object({
  box_id: z.coerce.bigint(),
  call_uuid: z.string().min(1).max(40),
  tenant_id: z.coerce.bigint().default(BigInt(1)),
  caller_number: z.string().max(20).optional().nullable(),
  duration_sec: z.coerce.number().int().min(0).default(0),
  file_path: z.string().min(1).max(512),
});

// ─── Transcription event ──────────────────────────────────────────────────────

async function emitTranscriptionRequested(params: {
  voicemailId: bigint;
  fileUri: string;
  tenantId: bigint;
}): Promise<void> {
  // Publish to Valkey stream events:vici2.transcription.requested.
  // N07 worker consumes and writes transcript_uri back.
  // Phase 1: log and emit; N07 wire-up done in N07 module.
  const message = JSON.stringify({
    voicemail_id: String(params.voicemailId),
    file_uri: params.fileUri,
    tenant_id: String(params.tenantId),
    source: "voicemail",
  });

  try {
    const { getRedis } = await import("../../lib/redis.js");
    const redis = getRedis();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (redis as any).xadd(
      "events:vici2.transcription.requested",
      "*",
      "data",
      message,
    );
  } catch (err) {
    // Non-fatal — transcription is optional
    console.error("[i03] failed to emit transcription.requested", err);
  }
}

// ─── Registration ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerInternalVoicemailRoutes(app: any): Promise<void> {

  // POST /api/internal/voicemail/recorded
  // Called by FreeSWITCH after the record application completes.
  app.post(
    "/api/internal/voicemail/recorded",
    async (req: FastifyRequest, reply: FastifyReply) => {
      if (!requireInternalSecret(req, reply)) return;

      const parsed = RecordedSchema.safeParse(req.body);
      if (!parsed.success) {
        void reply.code(400).send({ error: "validation_error", details: parsed.error.issues });
        return;
      }

      const { box_id, call_uuid, tenant_id, caller_number, duration_sec, file_path } = parsed.data;

      // Verify mailbox exists
      const box = await prisma.voicemailBox.findFirst({
        where: { id: box_id, tenantId: tenant_id, active: true },
        include: { boxUsers: { select: { userId: true } } },
      });
      if (!box) {
        void reply.code(404).send({ error: "mailbox_not_found" });
        return;
      }

      // Create voicemail row
      const vm = await prisma.voicemail.create({
        data: {
          tenantId: tenant_id,
          mailboxId: box.id,
          callUuid: call_uuid,
          recordingUri: file_path,
          durationSec: duration_sec,
          callerNumber: caller_number ?? null,
          status: "NEW",
          transcribed: false,
        },
      });

      req.log.info(
        { vmId: String(vm.id), boxId: String(box_id), callUuid: call_uuid },
        "i03: voicemail created",
      );

      // Notify all assigned users
      const { getRedis } = await import("../../lib/redis.js");
      const redis = getRedis();

      for (const { userId } of box.boxUsers) {
        try {
          await notify(
            prisma,
            redis,
            null, // email queue Phase 1: null (uses N01 BullMQ when wired)
            {
              tenantId: tenant_id,
              userId,
              category: "voicemail_new",
              subject: "New voicemail",
              body: `New voicemail in mailbox "${box.name}" from ${caller_number ?? "unknown"} (${duration_sec}s)`,
              link: `/voicemail`,
              severity: "info",
            },
          );
        } catch (err) {
          req.log.error({ err, userId: String(userId) }, "i03: notify failed for user");
        }
      }

      // Emit transcription event if box has transcribe=true
      if (box.transcribe) {
        await emitTranscriptionRequested({
          voicemailId: vm.id,
          fileUri: file_path,
          tenantId: tenant_id,
        });
      }

      void reply.code(201).send({ id: String(vm.id), status: "created" });
    },
  );

  // GET /api/internal/voicemail/file?path=...
  // Dev-only: serve local voicemail WAV file.
  app.get(
    "/api/internal/voicemail/file",
    async (req: FastifyRequest<{ Querystring: { path?: string } }>, reply: FastifyReply) => {
      if (process.env.NODE_ENV === "production") {
        void reply.code(404).send({ error: "not_found" });
        return;
      }
      const filePath = req.query.path;
      if (!filePath) {
        void reply.code(400).send({ error: "path_required" });
        return;
      }
      // Basic path traversal check
      const resolved = path.resolve(filePath);
      if (!resolved.includes("/voicemail/") && !resolved.includes("\\voicemail\\")) {
        void reply.code(403).send({ error: "forbidden_path" });
        return;
      }
      try {
        const stream = fs.createReadStream(resolved);
        void reply.header("content-type", "audio/wav").send(stream);
      } catch {
        void reply.code(404).send({ error: "file_not_found" });
      }
    },
  );
}
