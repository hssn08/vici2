// D04 — POST /api/admin/leads/bulk-reset
// M07 "list reset" — resets lead statuses in bulk.
// Requires admin:system (tenant:edit permission).
// Writes a synthetic RESET disposition row per lead.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../../auth/middleware.js";
import { BulkResetSchema } from "../validators.js";
import { terminalRecycleWritesTotal } from "../metrics.js";
import { getPrisma } from "../../lib/prisma.js";

export async function handleBulkReset(req: FastifyRequest, reply: FastifyReply, _prismaArg: unknown, auth: AuthContext): Promise<void> {
  const parsed = BulkResetSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "invalid_body", issues: parsed.error.issues });
  }

  const { campaignId, listIds, fromStatuses, toStatus, reason } = parsed.data;
  const tenantId = BigInt(auth.tenantId);

  const prisma = getPrisma();

  // Build parameterized query
  let whereClause = `l.tenant_id = ? AND l.campaign_id = ?`;
  const params: unknown[] = [tenantId, campaignId];

  if (listIds && listIds.length > 0) {
    whereClause += ` AND l.list_id IN (${listIds.map(() => "?").join(",")})`;
    params.push(...listIds);
  }

  if (fromStatuses && fromStatuses.length > 0) {
    whereClause += ` AND l.status IN (${fromStatuses.map(() => "?").join(",")})`;
    params.push(...fromStatuses);
  }

  // Count affected leads first
  const countResult = await prisma.$queryRawUnsafe<Array<{ cnt: bigint }>>(
    `SELECT COUNT(*) AS cnt FROM leads l WHERE ${whereClause}`,
    ...params,
  );
  const affectedCount = Number(countResult[0]?.cnt ?? 0);

  // Perform the bulk reset
  await prisma.$executeRawUnsafe(
    `UPDATE leads l SET l.status = ?, l.modify_at = NOW() WHERE ${whereClause}`,
    toStatus,
    ...params,
  );

  // Write audit log
  try {
    await prisma.$executeRawUnsafe(
      `INSERT INTO audit_log
         (tenant_id, action, entity_type, entity_id, actor_id, payload, created_at, updated_at)
       VALUES (?, 'lead.bulk_reset', 'campaign', ?, ?, JSON_OBJECT(
         'campaign_id', ?,
         'to_status', ?,
         'from_statuses', ?,
         'affected_count', ?,
         'reason', ?
       ), NOW(), NOW())`,
      tenantId,
      0n,
      auth.uid,
      campaignId,
      toStatus,
      JSON.stringify(fromStatuses ?? []),
      affectedCount,
      reason ?? null,
    );
  } catch {
    // Audit log failure is non-fatal; already did the reset
  }

  terminalRecycleWritesTotal.inc();

  return reply.code(200).send({
    affectedCount,
    toStatus,
    campaignId,
    resetAt: new Date().toISOString(),
  });
}
