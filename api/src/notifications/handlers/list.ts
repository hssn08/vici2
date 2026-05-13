// N01 — GET /api/notifications
// Cursor-paginated list of notifications for the authenticated user.
// Query params: status=unread|read|all (default=all), cursor=<last_id>, limit=1..50 (default=20)

import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../../auth/middleware.js";
import { getPrisma } from "../../lib/prisma.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

interface QueryParams {
  status?: string;
  cursor?: string;
  limit?: string;
}

export async function handleListNotifications(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

  const query = req.query as QueryParams;
  const status = query.status ?? "all";
  const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? "20", 10)));
  const cursor = query.cursor ? BigInt(query.cursor) : undefined;

  const prisma = getPrisma();

  // Build where clause
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {
    tenantId: BigInt(auth.tenantId),
    userId: BigInt(auth.uid),
    channel: "in_app",
  };

  if (status === "unread") {
    where.readAt = null;
  } else if (status === "read") {
    where.readAt = { not: null };
  }

  if (cursor) {
    where.id = { lt: cursor };
  }

  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { id: "desc" },
      take: limit + 1, // fetch one extra to determine if there is a next page
      select: {
        id: true,
        channel: true,
        category: true,
        subject: true,
        body: true,
        severity: true,
        link: true,
        readAt: true,
        createdAt: true,
      },
    }),
    prisma.notification.count({
      where: {
        tenantId: BigInt(auth.tenantId),
        userId: BigInt(auth.uid),
        channel: "in_app",
        readAt: null,
      },
    }),
  ]);

  const hasMore = items.length > limit;
  const page = hasMore ? items.slice(0, limit) : items;
  const lastItem = page[page.length - 1];
  const nextCursor = hasMore && lastItem ? String(lastItem.id) : null;

  await reply.send({
    items: page.map((n) => ({
      id: String(n.id),
      channel: n.channel,
      category: n.category,
      subject: n.subject,
      body: n.body,
      severity: n.severity,
      link: n.link,
      readAt: n.readAt?.toISOString() ?? null,
      createdAt: n.createdAt.toISOString(),
    })),
    nextCursor,
    unreadCount,
  });
}
