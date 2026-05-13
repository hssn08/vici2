// D04 — GET /api/admin/system-statuses
// Returns all 35 __SYS__ status rows (cached 5 min).

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleListSystemStatuses(req: FastifyRequest, reply: FastifyReply, prisma: PrismaClient, auth: AuthContext, _redis: any): Promise<void> {
  // Tenant isolation — use requester's tenantId
  const tenantId = BigInt(auth.tenantId);

  const rows = await prisma.status.findMany({
    where: { tenantId, campaignId: "__SYS__" },
    orderBy: [{ hotkey: "asc" }, { status: "asc" }],
  });

  return reply.code(200).send({
    items: rows.map((r: { status: string; description: string; selectable: boolean; humanAnswered: boolean; sale: boolean; dnc: boolean; callback: boolean; notInterested: boolean; hotkey: string | null; recycleDelaySeconds: number | null; category: string | null; systemOwner: string | null }) => ({
      code: r.status,
      description: r.description,
      selectable: r.selectable,
      humanAnswered: r.humanAnswered,
      sale: r.sale,
      dnc: r.dnc,
      callback: r.callback,
      notInterested: r.notInterested,
      hotkey: r.hotkey ?? null,
      recycleDelaySeconds: r.recycleDelaySeconds ?? null,
      category: r.category ?? null,
      systemOwner: r.systemOwner ?? null,
      source: "system" as const,
      maxCalls: null,
    })),
  });
}
