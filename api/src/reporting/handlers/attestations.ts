// M08 — GET /api/admin/reports/attestations

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { ReportingService } from "../service.js";
import { reportRequestsTotal } from "../metrics.js";

interface AttestationsQuery {
  table?: string;
  from?: string;
  to?: string;
  limit?: string;
}

const VALID_TABLES = new Set([
  "audit_log",
  "call_window_audit",
  "originate_audit",
  "consent_log",
  "dnc_sync_log",
]);

export async function handleAttestations(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  auth: AuthContext,
): Promise<void> {
  reportRequestsTotal.inc({ endpoint: "attestations" });

  const query = req.query as AttestationsQuery;
  const tableName = query.table;

  if (tableName && !VALID_TABLES.has(tableName)) {
    void reply.code(400).send({
      error: "invalid_table",
      valid: [...VALID_TABLES],
    });
    return;
  }

  const fromDate = query.from ? new Date(query.from) : undefined;
  const toDate = query.to ? new Date(query.to) : undefined;
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);
  const tenantId = BigInt(auth.tenantId);

  const svc = new ReportingService(prisma);
  const rows = await svc.getAttestations(tenantId, tableName, fromDate, toDate, limit);

  const items = rows.map((r) => ({
    id: String(r.id),
    tenantId: String(r.tenantId),
    tableName: r.tableName,
    windowDate: r.windowDate,
    rowCount: String(r.rowCount),
    merkleRoot: r.merkleRoot,
    keyId: r.keyId,
    signatureB64: r.signatureB64,
    s3Key: r.s3Key,
    computedAt: r.computedAt,
  }));

  void reply.code(200).send({
    items,
    total: items.length,
    meta: {
      note: "Verify offline: scripts/verify-audit-chain.ts --window 7d",
    },
  });
}
