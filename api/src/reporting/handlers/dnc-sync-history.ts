// M08 — GET /api/admin/reports/dnc-sync-history

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { ReportingService } from "../service.js";
import { reportRequestsTotal } from "../metrics.js";

interface DncHistoryQuery {
  source?: string;
  limit?: string;
}

export async function handleDncSyncHistory(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  _auth: AuthContext,
): Promise<void> {
  reportRequestsTotal.inc({ endpoint: "dnc-sync-history" });

  const query = req.query as DncHistoryQuery;
  const source = query.source;
  const limit = Math.min(Math.max(Number(query.limit ?? 100), 1), 500);

  const svc = new ReportingService(prisma);
  const rows = await svc.getDncSyncHistory(source, limit);

  // Convert BigInt ids for JSON serialization
  const items = rows.map((r) => ({
    id: String(r.id),
    source: r.source,
    kind: r.kind,
    outcome: r.outcome,
    added: r.added,
    removed: r.removed,
    errorCount: r.errorCount,
    startedAt: r.startedAt,
    completedAt: r.completedAt,
    durationMs: r.durationMs,
    notes: r.notes,
    prevHash: r.prevHash,
    rowHash: r.rowHash,
  }));

  void reply.code(200).send({ items, total: items.length });
}
