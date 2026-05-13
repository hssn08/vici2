// N01 — GET|PATCH /api/notifications/prefs
// Per-user delivery preference management.

import type { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import type { AuthContext } from "../../auth/middleware.js";
import { getPrisma } from "../../lib/prisma.js";
import { ALL_CATEGORIES, type NotifCategory } from "../categories.js";
import { getUserPrefs, upsertUserPref } from "../service.js";
import type { NotifChannel } from "../categories.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

const UpdatePrefBody = z.object({
  category: z.enum(ALL_CATEGORIES as [NotifCategory, ...NotifCategory[]]),
  channels: z.array(z.enum(["in_app", "email"] as ["in_app", "email"])).min(0),
});

export async function handleGetPrefs(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const prisma = getPrisma();
  const prefs = await getUserPrefs(prisma, BigInt(auth.uid), BigInt(auth.tenantId));

  await reply.send({ prefs });
}

export async function handleUpdatePref(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const parsed = UpdatePrefBody.safeParse(req.body);
  if (!parsed.success) {
    await reply.code(400).send({ error: "validation_error", details: parsed.error.flatten() });
    return;
  }

  const { category, channels } = parsed.data;
  const prisma = getPrisma();

  await upsertUserPref(prisma, BigInt(auth.uid), BigInt(auth.tenantId), category, channels as NotifChannel[]);

  await reply.send({ ok: true });
}
