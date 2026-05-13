// I03 — Admin routes for voicemail box management.
//
// Route map (all require admin+ auth):
//   GET    /api/admin/voicemail-boxes                       list mailboxes
//   POST   /api/admin/voicemail-boxes                       create mailbox + render XML
//   GET    /api/admin/voicemail-boxes/:id                   get mailbox detail
//   PATCH  /api/admin/voicemail-boxes/:id                   update mailbox + re-render
//   DELETE /api/admin/voicemail-boxes/:id                   soft-delete (active=false)
//   POST   /api/admin/voicemail-boxes/:id/greeting          upload greeting WAV/MP3 (multipart)
//   DELETE /api/admin/voicemail-boxes/:id/greeting          remove custom greeting
//   POST   /api/admin/voicemail-boxes/:id/users             assign user to mailbox
//   DELETE /api/admin/voicemail-boxes/:id/users/:userId     remove user from mailbox

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { getPrisma } from "../../lib/prisma.js";
import { getVoicemailRenderer } from "../../services/voicemail/VoicemailRenderer.js";
import type { AuthContext } from "../../auth/middleware.js";

const prisma = getPrisma();

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function requireAdminRole(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const auth = (req as AuthReq).auth;
  if (!auth) {
    void reply.code(401).send({ error: "not_authenticated" });
    return;
  }
  if (auth.role !== "admin" && auth.role !== "super_admin") {
    void reply.code(403).send({ error: "forbidden", required: "admin" });
    return;
  }
  done();
}

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const BoxCreateSchema = z.object({
  name: z.string().min(1).max(128),
  ingroupId: z.string().max(32).optional().nullable(),
  userId: z.coerce.bigint().optional().nullable(),
  didId: z.coerce.bigint().optional().nullable(),
  maxDurationSec: z.number().int().min(10).max(600).default(120),
  // I05: optional team email for new-VM notifications
  notifyEmail: z.string().email().max(255).optional().nullable(),
  transcribe: z.boolean().default(false),
  active: z.boolean().default(true),
});

const BoxUpdateSchema = BoxCreateSchema.partial();

const UserAssignSchema = z.object({
  userId: z.coerce.bigint(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function bigintSerializer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function serializeBox(box: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(box, bigintSerializer));
}

// ─── Route handlers ──────────────────────────────────────────────────────────

async function handleList(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const { tenantId } = getAuth(req);
  const boxes = await prisma.voicemailBox.findMany({
    where: { tenantId: BigInt(tenantId) },
    include: {
      boxUsers: { select: { userId: true } },
    },
    orderBy: { name: "asc" },
  });
  void reply.send(boxes.map(serializeBox));
}

async function handleGet(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const box = await prisma.voicemailBox.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
    include: {
      boxUsers: { select: { userId: true, createdAt: true } },
    },
  });
  if (!box) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }
  void reply.send(serializeBox(box as unknown as Record<string, unknown>));
}

async function handleCreate(
  req: FastifyRequest<{ Body: unknown }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const parsed = BoxCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    void reply.code(400).send({ error: "validation_error", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const box = await prisma.voicemailBox.create({
    data: {
      tenantId: BigInt(tenantId),
      name: data.name,
      ingroupId: data.ingroupId ?? null,
      userId: data.userId ?? null,
      didId: data.didId ?? null,
      maxDurationSec: data.maxDurationSec,
      notifyEmail: data.notifyEmail ?? null,
      transcribe: data.transcribe,
      active: data.active,
    },
  });

  const renderer = getVoicemailRenderer(prisma);
  try {
    await renderer.render(box.id);
  } catch (err) {
    req.log.error({ err, boxId: String(box.id) }, "vm: render failed after create");
  }

  // I05: write DID→box Valkey cache entry for I01 overflow routing
  if (data.didId) {
    try {
      const { getRedis } = await import("../../lib/redis.js");
      const redis = getRedis();
      const cacheKey = `t:${tenantId}:did:${String(data.didId)}:vm_box_id`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (redis as any).set(cacheKey, String(box.id));
    } catch (err) {
      req.log.error({ err }, "i05: failed to write DID→box Valkey cache");
    }
  }

  void reply.code(201).send(serializeBox(box as unknown as Record<string, unknown>));
}

async function handleUpdate(
  req: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const parsed = BoxUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    void reply.code(400).send({ error: "validation_error", details: parsed.error.issues });
    return;
  }
  const data = parsed.data;
  const existing = await prisma.voicemailBox.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!existing) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  const updated = await prisma.voicemailBox.update({
    where: { id: existing.id },
    data: {
      ...(data.name !== undefined && { name: data.name }),
      ...(data.ingroupId !== undefined && { ingroupId: data.ingroupId }),
      ...(data.userId !== undefined && { userId: data.userId }),
      ...(data.didId !== undefined && { didId: data.didId }),
      ...(data.maxDurationSec !== undefined && { maxDurationSec: data.maxDurationSec }),
      ...(data.notifyEmail !== undefined && { notifyEmail: data.notifyEmail }),
      ...(data.transcribe !== undefined && { transcribe: data.transcribe }),
      ...(data.active !== undefined && { active: data.active }),
    },
  });

  const renderer = getVoicemailRenderer(prisma);
  try {
    await renderer.render(updated.id);
  } catch (err) {
    req.log.error({ err, boxId: String(updated.id) }, "vm: render failed after update");
  }

  // I05: update DID→box Valkey cache if didId changed
  if (data.didId !== undefined) {
    try {
      const { getRedis } = await import("../../lib/redis.js");
      const redis = getRedis();
      // Remove old cache entry if didId changed
      if (existing.didId && existing.didId !== data.didId) {
        const oldKey = `t:${updated.tenantId}:did:${String(existing.didId)}:vm_box_id`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (redis as any).del(oldKey);
      }
      if (data.didId) {
        const newKey = `t:${updated.tenantId}:did:${String(data.didId)}:vm_box_id`;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (redis as any).set(newKey, String(updated.id));
      }
    } catch (err) {
      req.log.error({ err }, "i05: failed to update DID→box Valkey cache");
    }
  }

  void reply.send(serializeBox(updated as unknown as Record<string, unknown>));
}

async function handleDelete(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const existing = await prisma.voicemailBox.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!existing) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  // Soft-delete: set active=false, regenerate XML (removes extension)
  await prisma.voicemailBox.update({
    where: { id: existing.id },
    data: { active: false },
  });

  const renderer = getVoicemailRenderer(prisma);
  try {
    await renderer.render(existing.id);
  } catch (err) {
    req.log.error({ err, boxId: String(existing.id) }, "vm: render failed after delete");
  }

  // I05: invalidate DID→box Valkey cache entry
  if (existing.didId) {
    try {
      const { getRedis } = await import("../../lib/redis.js");
      const redis = getRedis();
      const cacheKey = `t:${existing.tenantId}:did:${String(existing.didId)}:vm_box_id`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (redis as any).del(cacheKey);
    } catch (err) {
      req.log.error({ err }, "i05: failed to delete DID→box Valkey cache");
    }
  }

  void reply.code(204).send();
}

async function handleGreetingUpload(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const existing = await prisma.voicemailBox.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!existing) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  // Phase 1: expect the file as a raw body with content-type audio/wav or audio/mpeg.
  // The greeting is stored at a local path accessible to FreeSWITCH.
  const greetingDir =
    process.env.FS_VOICEMAIL_GREETINGS_DIR ??
    `/var/lib/freeswitch/sounds/voicemail/${String(tenantId)}`;

  await fs.mkdir(greetingDir, { recursive: true });

  const greetingPath = path.join(greetingDir, `${String(existing.id)}_greeting.wav`);

  // For multipart or raw body, write incoming buffer directly.
  // (Real prod: convert MP3 → WAV 8kHz via ffmpeg before writing.)
  const body = req.body as Buffer | null;
  if (!body || !Buffer.isBuffer(body)) {
    void reply.code(400).send({ error: "file_required", message: "Send WAV body as raw bytes" });
    return;
  }

  if (body.length > 10 * 1024 * 1024) {
    void reply.code(413).send({ error: "file_too_large", maxBytes: 10 * 1024 * 1024 });
    return;
  }

  await fs.writeFile(greetingPath, body);

  await prisma.voicemailBox.update({
    where: { id: existing.id },
    data: { greetingUri: greetingPath },
  });

  const renderer = getVoicemailRenderer(prisma);
  try {
    await renderer.render(existing.id);
  } catch (err) {
    req.log.error({ err, boxId: String(existing.id) }, "vm: render failed after greeting upload");
  }

  void reply.send({ greetingUri: greetingPath });
}

async function handleGreetingDelete(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const existing = await prisma.voicemailBox.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!existing) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  if (existing.greetingUri) {
    try {
      await fs.unlink(existing.greetingUri);
    } catch {
      // Ignore missing file
    }
  }

  await prisma.voicemailBox.update({
    where: { id: existing.id },
    data: { greetingUri: null },
  });

  const renderer = getVoicemailRenderer(prisma);
  try {
    await renderer.render(existing.id);
  } catch (err) {
    req.log.error({ err, boxId: String(existing.id) }, "vm: render failed after greeting delete");
  }

  void reply.code(204).send();
}

async function handleAssignUser(
  req: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const parsed = UserAssignSchema.safeParse(req.body);
  if (!parsed.success) {
    void reply.code(400).send({ error: "validation_error", details: parsed.error.issues });
    return;
  }
  const existing = await prisma.voicemailBox.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!existing) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  await prisma.voicemailBoxUser.upsert({
    where: {
      voicemailBoxId_userId: {
        voicemailBoxId: existing.id,
        userId: parsed.data.userId,
      },
    },
    create: {
      voicemailBoxId: existing.id,
      userId: parsed.data.userId,
      tenantId: BigInt(tenantId),
    },
    update: {},
  });

  void reply.code(201).send({ voicemailBoxId: String(existing.id), userId: String(parsed.data.userId) });
}

async function handleRemoveUser(
  req: FastifyRequest<{ Params: { id: string; userId: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId } = getAuth(req);
  const existing = await prisma.voicemailBox.findFirst({
    where: { id: BigInt(req.params.id), tenantId: BigInt(tenantId) },
  });
  if (!existing) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }
  await prisma.voicemailBoxUser.deleteMany({
    where: {
      voicemailBoxId: existing.id,
      userId: BigInt(req.params.userId),
    },
  });
  void reply.code(204).send();
}

// ─── Plugin registration ──────────────────────────────────────────────────────

export async function registerAdminVoicemailBoxRoutes(
  app: FastifyInstance,
): Promise<void> {
  const preHandler = [requireAdminRole];

  app.get("/api/admin/voicemail-boxes", { preHandler }, handleList);
  app.post<{ Body: unknown }>("/api/admin/voicemail-boxes", { preHandler }, handleCreate);
  app.get<{ Params: { id: string } }>(
    "/api/admin/voicemail-boxes/:id",
    { preHandler },
    handleGet,
  );
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/admin/voicemail-boxes/:id",
    { preHandler },
    handleUpdate,
  );
  app.delete<{ Params: { id: string } }>(
    "/api/admin/voicemail-boxes/:id",
    { preHandler },
    handleDelete,
  );
  app.post<{ Params: { id: string } }>(
    "/api/admin/voicemail-boxes/:id/greeting",
    { preHandler },
    handleGreetingUpload,
  );
  app.delete<{ Params: { id: string } }>(
    "/api/admin/voicemail-boxes/:id/greeting",
    { preHandler },
    handleGreetingDelete,
  );
  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/admin/voicemail-boxes/:id/users",
    { preHandler },
    handleAssignUser,
  );
  app.delete<{ Params: { id: string; userId: string } }>(
    "/api/admin/voicemail-boxes/:id/users/:userId",
    { preHandler },
    handleRemoveUser,
  );
}
