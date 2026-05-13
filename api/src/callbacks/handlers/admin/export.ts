// D06 — GET /api/admin/callbacks/export — CSV export (admin only).

import type { FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";
import { roleAtLeast } from "../../../auth/rbac.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export async function handleExportCallbacks(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = (req as AuthReq).auth;
  if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }
  if (!roleAtLeast(auth.role, "admin")) { await reply.code(403).send({ error: "permission_denied" }); return; }

  const tenantId = BigInt(auth.tenantId);

  const rows = await getPrisma().callback.findMany({
    where: { tenantId, status: { in: ["PENDING", "LIVE"] } },
    include: { lead: { select: { firstName: true, lastName: true, phoneE164: true, knownTimezone: true } } },
    orderBy: { callbackAt: "asc" },
    take: 10000,
  });

  const header = "id,lead_id,campaign_id,user_id,scope,callback_at,status,comments,lead_name,lead_phone,lead_tz\n";
  const csvRows = rows.map((r) => {
    const name = [r.lead?.firstName, r.lead?.lastName].filter(Boolean).join(" ");
    const scope = r.userId != null ? "AGENT" : "GLOBAL";
    const fields = [
      String(r.id),
      String(r.leadId),
      r.campaignId,
      r.userId != null ? String(r.userId) : "",
      scope,
      r.callbackAt.toISOString(),
      r.status,
      `"${(r.comments ?? "").replace(/"/g, '""')}"`,
      `"${name.replace(/"/g, '""')}"`,
      r.lead?.phoneE164 ?? "",
      r.lead?.knownTimezone ?? "",
    ];
    return fields.join(",");
  });

  const csv = header + csvRows.join("\n");
  await reply
    .header("Content-Type", "text/csv")
    .header("Content-Disposition", "attachment; filename=callbacks.csv")
    .send(csv);
}
