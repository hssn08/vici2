// I03 — Agent / supervisor voicemail routes.
//
// Route map:
//   GET    /api/voicemails                 list voicemails for accessible mailboxes
//   GET    /api/voicemails/:id/play        get play URL (redirect to local file or pre-signed URL)
//   PATCH  /api/voicemails/:id             status transitions: READ, ARCHIVED, DELETED
//   DELETE /api/voicemails/:id             soft-delete (sets status=DELETED)

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { getPrisma } from "../lib/prisma.js";
import type { AuthContext } from "../auth/middleware.js";

const prisma = getPrisma();

type AuthReq = FastifyRequest & { auth?: AuthContext };

function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const auth = (req as AuthReq).auth;
  if (!auth) {
    void reply.code(401).send({ error: "not_authenticated" });
    return;
  }
  done();
}

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function serializeBigInt(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

function toDto(row: Record<string, unknown>): unknown {
  return JSON.parse(JSON.stringify(row, serializeBigInt));
}

// ─── Accessible mailbox IDs for the current user ──────────────────────────────

async function getAccessibleBoxIds(
  tenantId: bigint,
  userId: bigint,
  role: string,
): Promise<bigint[]> {
  if (role === "super_admin" || role === "superadmin" || role === "admin") {
    // Admin sees all boxes for the tenant
    const boxes = await prisma.voicemailBox.findMany({
      where: { tenantId, active: true },
      select: { id: true },
    });
    return boxes.map((b) => b.id);
  }

  if (role === "supervisor") {
    // Supervisors see boxes they are assigned to + boxes owned by their ingroup(s)
    const assigned = await prisma.voicemailBoxUser.findMany({
      where: { tenantId, userId },
      select: { voicemailBoxId: true },
    });
    return assigned.map((r) => r.voicemailBoxId);
  }

  // Agents: only boxes they are explicitly assigned to
  const assigned = await prisma.voicemailBoxUser.findMany({
    where: { tenantId, userId },
    select: { voicemailBoxId: true },
  });
  return assigned.map((r) => r.voicemailBoxId);
}

// ─── Handlers ─────────────────────────────────────────────────────────────────

const StatusTransitionSchema = z.object({
  status: z.enum(["READ", "ARCHIVED", "DELETED"]),
});

const ListQuerySchema = z.object({
  mailboxId: z.coerce.bigint().optional(),
  status: z.enum(["NEW", "READ", "ARCHIVED", "DELETED"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.coerce.bigint().optional(),
});

async function handleList(
  req: FastifyRequest<{ Querystring: Record<string, string> }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId, uid: userId, role } = getAuth(req);
  const parsed = ListQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    void reply.code(400).send({ error: "validation_error", details: parsed.error.issues });
    return;
  }
  const { mailboxId, status, limit, cursor } = parsed.data;

  const accessibleIds = await getAccessibleBoxIds(
    BigInt(tenantId),
    BigInt(userId),
    role,
  );
  if (accessibleIds.length === 0) {
    void reply.send({ items: [], nextCursor: null });
    return;
  }

  const boxIds = mailboxId
    ? accessibleIds.filter((id) => id === mailboxId)
    : accessibleIds;

  if (boxIds.length === 0) {
    void reply.send({ items: [], nextCursor: null });
    return;
  }

  const vms = await prisma.voicemail.findMany({
    where: {
      tenantId: BigInt(tenantId),
      mailboxId: { in: boxIds },
      ...(status && { status }),
      ...(cursor && { id: { lt: cursor } }),
    },
    orderBy: { createdAt: "desc" },
    take: limit + 1,
    include: { mailbox: { select: { name: true } } },
  });

  const hasMore = vms.length > limit;
  const items = hasMore ? vms.slice(0, limit) : vms;
  const lastItem = items[items.length - 1];
  const nextCursor = hasMore && lastItem ? String(lastItem.id) : null;

  void reply.send({ items: items.map(toDto), nextCursor });
}

async function handlePlay(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId, uid: userId, role } = getAuth(req);
  const accessibleIds = await getAccessibleBoxIds(
    BigInt(tenantId),
    BigInt(userId),
    role,
  );

  const vm = await prisma.voicemail.findFirst({
    where: {
      id: BigInt(req.params.id),
      tenantId: BigInt(tenantId),
      mailboxId: { in: accessibleIds },
    },
  });

  if (!vm) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }

  // Phase 1: redirect to a local file path via the API's static file serving.
  // Phase 2: generate pre-signed S3 URL via R02 mechanism.
  // For now, return the file URI directly (dev) or a signed URL placeholder.
  const fileUri = vm.recordingUri;
  if (fileUri.startsWith("s3://")) {
    // TODO(R02): generate pre-signed URL
    void reply.send({ playUrl: fileUri, type: "s3" });
    return;
  }

  // Local file: serve as a redirect to /api/internal/voicemail/file?path=...
  void reply.send({ playUrl: `/api/internal/voicemail/file?path=${encodeURIComponent(fileUri)}`, type: "local" });
}

async function handlePatch(
  req: FastifyRequest<{ Params: { id: string }; Body: unknown }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId, uid: userId, role } = getAuth(req);
  const parsed = StatusTransitionSchema.safeParse(req.body);
  if (!parsed.success) {
    void reply.code(400).send({ error: "validation_error", details: parsed.error.issues });
    return;
  }
  const accessibleIds = await getAccessibleBoxIds(
    BigInt(tenantId),
    BigInt(userId),
    role,
  );
  const vm = await prisma.voicemail.findFirst({
    where: {
      id: BigInt(req.params.id),
      tenantId: BigInt(tenantId),
      mailboxId: { in: accessibleIds },
    },
  });
  if (!vm) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }
  const updated = await prisma.voicemail.update({
    where: { id: vm.id },
    data: { status: parsed.data.status },
  });
  void reply.send(toDto(updated as unknown as Record<string, unknown>));
}

async function handleDelete(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const { tenantId, uid: userId, role } = getAuth(req);
  const accessibleIds = await getAccessibleBoxIds(
    BigInt(tenantId),
    BigInt(userId),
    role,
  );
  const vm = await prisma.voicemail.findFirst({
    where: {
      id: BigInt(req.params.id),
      tenantId: BigInt(tenantId),
      mailboxId: { in: accessibleIds },
    },
  });
  if (!vm) {
    void reply.code(404).send({ error: "not_found" });
    return;
  }
  await prisma.voicemail.update({
    where: { id: vm.id },
    data: { status: "DELETED" },
  });
  void reply.code(204).send();
}

// ─── Plugin registration ──────────────────────────────────────────────────────

export async function registerVoicemailRoutes(app: FastifyInstance): Promise<void> {
  const preHandler = [requireAuth];

  app.get<{ Querystring: Record<string, string> }>(
    "/api/voicemails",
    { preHandler },
    handleList,
  );
  app.get<{ Params: { id: string } }>(
    "/api/voicemails/:id/play",
    { preHandler },
    handlePlay,
  );
  app.patch<{ Params: { id: string }; Body: unknown }>(
    "/api/voicemails/:id",
    { preHandler },
    handlePatch,
  );
  app.delete<{ Params: { id: string } }>(
    "/api/voicemails/:id",
    { preHandler },
    handleDelete,
  );
}
