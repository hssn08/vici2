// I05 — Admin routes for VM drop audio asset management.
//
// Route map (all require admin+ auth):
//   GET    /api/admin/vm-drops                 list assets for tenant (paginated)
//   POST   /api/admin/vm-drops                 upload new asset (multipart WAV/MP3)
//   GET    /api/admin/vm-drops/:id             get asset detail
//   PATCH  /api/admin/vm-drops/:id             rename / deactivate
//   DELETE /api/admin/vm-drops/:id             soft-delete (active=false)
//   GET    /api/admin/vm-drops/:id/play        get play URL (local or pre-signed)
//
// RBAC: GET routes require vmdrop:read; mutating routes require vmdrop:edit.
// Upload: multipart/form-data with fields `name` (string) + `file` (audio).
// Server-side: ffprobe validates duration (≤120s), ffmpeg transcodes to WAV 8kHz.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

const prisma = getPrisma();
const execFileAsync = promisify(execFile);

// ─── Config ───────────────────────────────────────────────────────────────────

const VMDROP_DIR = process.env.VMDROP_DIR ?? "/var/lib/vici2/vmdrop";
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_DURATION_SEC = 120;
const ALLOWED_CONTENT_TYPES = new Set(["audio/wav", "audio/mpeg", "audio/mp3", "audio/x-wav"]);

// ─── Auth helpers ─────────────────────────────────────────────────────────────

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function requireVmdropRead(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const auth = (req as AuthReq).auth;
  if (!auth) {
    void reply.code(401).send({ error: "not_authenticated" });
    return;
  }
  // vmdrop:read = admin+ or supervisor; vmdrop:edit = admin+
  if (auth.role !== "admin" && auth.role !== "super_admin" && auth.role !== "supervisor") {
    void reply.code(403).send({ error: "forbidden", required: "vmdrop:read" });
    return;
  }
  done();
}

function requireVmdropEdit(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const auth = (req as AuthReq).auth;
  if (!auth) {
    void reply.code(401).send({ error: "not_authenticated" });
    return;
  }
  if (auth.role !== "admin" && auth.role !== "super_admin") {
    void reply.code(403).send({ error: "forbidden", required: "vmdrop:edit" });
    return;
  }
  done();
}

// ─── Serialization ────────────────────────────────────────────────────────────

function serializeBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function toDto(row: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(row, serializeBigInt));
}

// ─── ffprobe helper ───────────────────────────────────────────────────────────

interface ProbeResult {
  durationSec: number;
  sizeBytes: number;
}

async function probeAudio(filePath: string): Promise<ProbeResult> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "quiet",
    "-print_format", "json",
    "-show_format",
    filePath,
  ]);

  const parsed = JSON.parse(stdout) as { format?: { duration?: string; size?: string } };
  const durationSec = parseFloat(parsed.format?.duration ?? "0");
  const sizeBytes = parseInt(parsed.format?.size ?? "0", 10);
  return { durationSec, sizeBytes };
}

// ─── ffmpeg transcode helper ──────────────────────────────────────────────────

async function transcodeToWav8k(inputPath: string, outputPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-i", inputPath,
    "-ar", "8000",
    "-ac", "1",
    "-f", "wav",
    "-y", // overwrite if exists
    outputPath,
  ]);
}

// ─── Schemas ─────────────────────────────────────────────────────────────────

const PatchSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  active: z.boolean().optional(),
});

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.bigint().optional(),
  activeOnly: z.coerce.boolean().default(true),
});

// ─── Handlers ─────────────────────────────────────────────────────────────────

async function handleList(
  req: FastifyRequest<{ Querystring: Record<string, string> }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    void reply.code(400).send({ error: "validation_error", details: parsed.error.issues });
    return;
  }
  const { limit, cursor, activeOnly } = parsed.data;

  const assets = await prisma.voicemailDropAsset.findMany({
    where: {
      tenantId: BigInt(tenantId),
      ...(activeOnly && { active: true }),
      ...(cursor && { id: { lt: cursor } }),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
  });

  const hasMore = assets.length > limit;
  const items = hasMore ? assets.slice(0, limit) : assets;
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? String(lastItem.id) : null;

  void reply.send({ items: items.map((a: unknown) => toDto(a as Record<string, unknown>)), nextCursor });
}

async function handleGet(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const asset = await prisma.voicemailDropAsset.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!asset) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }
  void reply.send(toDto(asset as unknown as Record<string, unknown>));
}

async function handleUpload(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId, uid: userId } = getAuth(req);

  // Parse multipart
  let nameField: string | undefined;
  let fileBuffer: Buffer | undefined;
  let fileContentType: string | undefined;
  let fileExt = "wav";

  try {
    const parts = req.parts();
    for await (const part of parts) {
      if (part.type === "field" && part.fieldname === "name") {
        nameField = part.value as string;
      } else if (part.type === "file" && part.fieldname === "file") {
        fileContentType = part.mimetype;
        const ext = path.extname(part.filename ?? "").toLowerCase();
        if (ext === ".mp3") fileExt = "mp3";
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of part.file) {
          totalBytes += (chunk as Buffer).length;
          if (totalBytes > MAX_UPLOAD_BYTES) {
            void reply.code(413).send({ error: "file_too_large", maxBytes: MAX_UPLOAD_BYTES });
            return;
          }
          chunks.push(chunk as Buffer);
        }
        fileBuffer = Buffer.concat(chunks);
      }
    }
  } catch (err) {
    req.log.error({ err }, "i05: multipart parse error");
    void reply.code(400).send({ error: "multipart_parse_error" });
    return;
  }

  if (!nameField || !nameField.trim()) {
    void reply.code(400).send({ error: "validation_error", details: [{ path: ["name"], message: "name is required" }] });
    return;
  }

  if (!fileBuffer || fileBuffer.length === 0) {
    void reply.code(400).send({ error: "file_required" });
    return;
  }

  if (fileContentType && !ALLOWED_CONTENT_TYPES.has(fileContentType)) {
    void reply.code(400).send({ error: "invalid_audio_format", allowed: ["audio/wav", "audio/mpeg"] });
    return;
  }

  const tempFile = `/tmp/vmdrop_upload_${randomUUID()}.${fileExt}`;
  let assetId: bigint | undefined;

  try {
    // Write temp file
    await fs.writeFile(tempFile, fileBuffer);

    // Probe duration
    let probeResult: ProbeResult;
    try {
      probeResult = await probeAudio(tempFile);
    } catch (err) {
      req.log.error({ err }, "i05: ffprobe failed");
      void reply.code(422).send({ error: "probe_failed", message: "Could not read audio metadata" });
      return;
    }

    if (probeResult.durationSec > MAX_DURATION_SEC) {
      void reply.code(422).send({
        error: "duration_too_long",
        maxDurationSec: MAX_DURATION_SEC,
        actualDurationSec: probeResult.durationSec,
      });
      return;
    }

    // Create DB record first to get the ID for the file path
    const asset = await prisma.voicemailDropAsset.create({
      data: {
        tenantId: BigInt(tenantId),
        name: nameField.trim(),
        localPath: "", // will update after transcode
        durationSec: Math.ceil(probeResult.durationSec),
        sizeBytes: fileBuffer.length,
        originalFormat: fileExt,
        active: true,
        createdBy: BigInt(userId),
      },
    });
    assetId = asset.id;

    // Transcode to WAV 8kHz
    const outputPath = path.join(VMDROP_DIR, String(tenantId), `${String(assetId)}.wav`);
    try {
      await transcodeToWav8k(tempFile, outputPath);
    } catch (err) {
      req.log.error({ err }, "i05: ffmpeg transcode failed");
      // Clean up the DB row
      await prisma.voicemailDropAsset.delete({ where: { id: assetId } }).catch(() => undefined);
      void reply.code(422).send({ error: "transcode_failed", message: "Audio transcoding failed" });
      return;
    }

    // Update localPath in DB
    const updated = await prisma.voicemailDropAsset.update({
      where: { id: assetId },
      data: { localPath: outputPath },
    });

    req.log.info(
      { assetId: String(assetId), tenantId, localPath: outputPath },
      "i05: vm-drop asset uploaded",
    );

    void reply.code(201).send(toDto(updated as unknown as Record<string, unknown>));
  } finally {
    await fs.unlink(tempFile).catch(() => undefined);
  }
}

async function handlePatch(
  req: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const parsed = PatchSchema.safeParse(req.body);
  if (!parsed.success) {
    void reply.code(400).send({ error: "validation_error", details: parsed.error.issues });
    return;
  }

  const existing = await prisma.voicemailDropAsset.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!existing) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  const updated = await prisma.voicemailDropAsset.update({
    where: { id: existing.id },
    data: {
      ...(parsed.data.name !== undefined && { name: parsed.data.name }),
      ...(parsed.data.active !== undefined && { active: parsed.data.active }),
    },
  });

  void reply.send(toDto(updated as unknown as Record<string, unknown>));
}

async function handleDelete(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const existing = await prisma.voicemailDropAsset.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!existing) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  // Soft-delete: set active=false
  await prisma.voicemailDropAsset.update({
    where: { id: existing.id },
    data: { active: false },
  });

  void reply.code(204).send();
}

async function handlePlay(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const asset = await prisma.voicemailDropAsset.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId), active: true },
  });
  if (!asset) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  if (asset.s3Uri) {
    // Phase 2: generate pre-signed S3 URL via R02
    void reply.send({ playUrl: asset.s3Uri, type: "s3" });
    return;
  }

  // Phase 1: local file path served via internal endpoint
  void reply.send({
    playUrl: `/api/internal/voicemail/file?path=${encodeURIComponent(asset.localPath)}`,
    type: "local",
  });
}

// ─── Plugin registration ──────────────────────────────────────────────────────

export async function registerAdminVmDropRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Record<string, string> }>(
    "/api/admin/vm-drops",
    { preHandler: [requireVmdropRead] },
    handleList,
  );
  app.post(
    "/api/admin/vm-drops",
    { preHandler: [requireVmdropEdit] },
    handleUpload,
  );
  app.get<{ Params: { id: string } }>(
    "/api/admin/vm-drops/:id",
    { preHandler: [requireVmdropRead] },
    handleGet,
  );
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/admin/vm-drops/:id",
    { preHandler: [requireVmdropEdit] },
    handlePatch,
  );
  app.delete<{ Params: { id: string } }>(
    "/api/admin/vm-drops/:id",
    { preHandler: [requireVmdropEdit] },
    handleDelete,
  );
  app.get<{ Params: { id: string } }>(
    "/api/admin/vm-drops/:id/play",
    { preHandler: [requireVmdropRead] },
    handlePlay,
  );
}
