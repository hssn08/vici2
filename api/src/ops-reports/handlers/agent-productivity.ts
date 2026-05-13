// M03 — GET /api/admin/reports/agent-productivity
//        GET /api/admin/reports/agent-productivity/export.csv

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { OpsReportService } from "../service.js";
import { buildCacheKey, cacheGet, cacheSet } from "../cache.js";
import { opsReportRequestsTotal, opsReportCacheHits, opsReportCacheMisses, opsExportBytesTotal } from "../metrics.js";
import { toCsv } from "../../lib/csv.js";
import type { AgentProductivityRow } from "../service.js";

interface Query {
  from?: string;
  to?: string;
  agent?: string;  // user_id
  format?: string;
}

function parseDateRange(from?: string, to?: string): { fromDate: Date; toDate: Date } {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);
  return { fromDate, toDate };
}

const CSV_HEADERS: (keyof AgentProductivityRow)[] = [
  "reportDate",
  "userId",
  "username",
  "callsHandled",
  "timeReadySec",
  "timePausedSec",
  "timeTalkingSec",
  "timeAcwSec",
  "sales",
  "salesPerHour",
];

export async function handleAgentProductivity(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  auth: AuthContext,
): Promise<void> {
  opsReportRequestsTotal.inc({ endpoint: "agent-productivity" });

  const query = req.query as Query;
  const { fromDate, toDate } = parseDateRange(query.from, query.to);
  const tenantId = BigInt(auth.tenantId);
  const isCsv = query.format === "csv" || req.headers["accept"] === "text/csv";

  const cacheKey = buildCacheKey("agent-productivity", tenantId, {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    agent: query.agent,
  });

  let rows = await cacheGet<AgentProductivityRow[]>(cacheKey);
  if (rows) {
    opsReportCacheHits.inc({ report: "agent-productivity" });
  } else {
    opsReportCacheMisses.inc({ report: "agent-productivity" });
    const svc = new OpsReportService(prisma);
    rows = await svc.getAgentProductivity(tenantId, fromDate, toDate, query.agent);
    await cacheSet(cacheKey, rows);
  }

  if (isCsv) {
    const csv = toCsv(CSV_HEADERS as string[], rows as unknown as Record<string, unknown>[]);
    opsExportBytesTotal.inc(Buffer.byteLength(csv, "utf8"));
    const filename = `agent-productivity-${fromDate.toISOString().slice(0, 10)}-${toDate.toISOString().slice(0, 10)}.csv`;
    void reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .code(200)
      .send(csv);
    return;
  }

  void reply.code(200).send({
    data: rows,
    meta: {
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      agent: query.agent ?? null,
      count: rows.length,
    },
  });
}
