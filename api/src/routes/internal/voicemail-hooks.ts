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

// I05: extended schema — accepts optional partial flag; file_path is now optional
// (api_hangup_hook fires even if caller drops before record starts, in which
// case file_path may be empty and duration_sec=0).
const RecordedSchema = z.object({
  box_id: z.coerce.bigint(),
  call_uuid: z.string().min(1).max(40),
  tenant_id: z.coerce.bigint().default(BigInt(1)),
  caller_number: z.string().max(20).optional().nullable(),
  duration_sec: z.coerce.number().int().min(0).default(0),
  file_path: z.string().max(512).optional().default(""),
  // I05: explicit partial flag; also auto-set when duration_sec < 3 or file_path=""
  partial: z.coerce.boolean().default(false),
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

      const { box_id, call_uuid, tenant_id, caller_number, duration_sec, file_path, partial: partialFlag } = parsed.data;

      // I05: auto-detect partial recording (caller hung up before 3s or no file)
      const isPartial = partialFlag || duration_sec < 3 || !file_path;

      // Verify mailbox exists
      const box = await prisma.voicemailBox.findFirst({
        where: { id: box_id, tenantId: tenant_id, active: true },
        include: { boxUsers: { select: { userId: true } } },
      });
      if (!box) {
        void reply.code(404).send({ error: "mailbox_not_found" });
        return;
      }

      // Create voicemail row (I05: include partial flag)
      const vm = await prisma.voicemail.create({
        data: {
          tenantId: tenant_id,
          mailboxId: box.id,
          callUuid: call_uuid,
          recordingUri: file_path || "",
          durationSec: duration_sec,
          callerNumber: caller_number ?? null,
          partial: isPartial,
          status: "NEW",
          transcribed: false,
        },
      });

      req.log.info(
        { vmId: String(vm.id), boxId: String(box_id), callUuid: call_uuid, partial: isPartial },
        "i05: voicemail created",
      );

      // Notify all assigned users
      const { getRedis } = await import("../../lib/redis.js");
      const redis = getRedis();

      // I05: emit audit event for voicemail capture
      const auditAction = isPartial ? "voicemail_partial" : "voicemail_captured";
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (redis as any).xadd(
          "events:vici2.audit.voicemail",
          "*",
          "data",
          JSON.stringify({
            action: auditAction,
            entity_type: "voicemail_box",
            entity_id: String(box_id),
            tenant_id: String(tenant_id),
            call_uuid,
            voicemail_id: String(vm.id),
            duration_sec: String(duration_sec),
            partial: String(isPartial),
          }),
        );
      } catch (err) {
        req.log.error({ err }, "i05: failed to emit voicemail audit event");
      }

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
              body: `New voicemail in mailbox "${box.name}" from ${caller_number ?? "unknown"} (${duration_sec}s)${isPartial ? " [partial]" : ""}`,
              link: `/voicemail`,
              severity: "info",
            },
          );
        } catch (err) {
          req.log.error({ err, userId: String(userId) }, "i05: notify failed for user");
        }
      }

      // I05: send email notification to box.notifyEmail if configured
      const boxWithEmail = box as typeof box & { notifyEmail?: string | null };
      if (boxWithEmail.notifyEmail) {
        try {
          const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3001";
          const playbackLink = `${appBaseUrl}/voicemail?id=${String(vm.id)}`;
          // Enqueue email via Valkey stream (N01/N02 consumer picks up)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (redis as any).xadd(
            "events:vici2.email.requested",
            "*",
            "data",
            JSON.stringify({
              to: boxWithEmail.notifyEmail,
              template_slug: "new-voicemail",
              tenant_id: String(tenant_id),
              variables: {
                mailbox_name: box.name,
                caller_number: caller_number ?? "unknown",
                duration_sec: String(duration_sec),
                playback_link: playbackLink,
                partial: String(isPartial),
              },
            }),
          );
          req.log.info({ notifyEmail: boxWithEmail.notifyEmail, vmId: String(vm.id) }, "i05: enqueued VM email notification");
        } catch (err) {
          req.log.error({ err, notifyEmail: boxWithEmail.notifyEmail }, "i05: failed to enqueue VM email notification");
        }
      }

      // Emit transcription event if box has transcribe=true (only non-partial VMs)
      if (box.transcribe && !isPartial && file_path) {
        await emitTranscriptionRequested({
          voicemailId: vm.id,
          fileUri: file_path,
          tenantId: tenant_id,
        });
      }

      void reply.code(201).send({ id: String(vm.id), status: "created", partial: isPartial });
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
