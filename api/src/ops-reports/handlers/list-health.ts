// M03 — GET /api/admin/reports/list-health
//        GET /api/admin/reports/list-health/export.csv

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { OpsReportService } from "../service.js";
import { buildCacheKey, cacheGet, cacheSet } from "../cache.js";
import { opsReportRequestsTotal, opsReportCacheHits, opsReportCacheMisses, opsExportBytesTotal } from "../metrics.js";
import { toCsv } from "../../lib/csv.js";
import type { ListHealthRow } from "../service.js";

interface Query {
  campaign?: string;
  format?: string;
}

const CSV_HEADERS: (keyof ListHealthRow)[] = [
  "listId",
  "listName",
  "campaignId",
  "leadsTotal",
  "leadsCallable",
  "leadsDnc",
  "leadsTzBlocked",
  "leadsNoAttempts",
  "leadsExhausted",
  "lastDialAt",
];

export async function handleListHealth(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  auth: AuthContext,
): Promise<void> {
  opsReportRequestsTotal.inc({ endpoint: "list-health" });

  const query = req.query as Query;
  const tenantId = BigInt(auth.tenantId);
  const isCsv = query.format === "csv" || req.headers["accept"] === "text/csv";

  const cacheKey = buildCacheKey("list-health", tenantId, {
    campaign: query.campaign,
  });

  let rows = await cacheGet<ListHealthRow[]>(cacheKey);
  if (rows) {
    opsReportCacheHits.inc({ report: "list-health" });
  } else {
    opsReportCacheMisses.inc({ report: "list-health" });
    const svc = new OpsReportService(prisma);
    rows = await svc.getListHealth(tenantId, query.campaign);
    await cacheSet(cacheKey, rows);
  }

  if (isCsv) {
    const csv = toCsv(CSV_HEADERS as string[], rows as unknown as Record<string, unknown>[]);
    opsExportBytesTotal.inc(Buffer.byteLength(csv, "utf8"));
    const date = new Date().toISOString().slice(0, 10);
    void reply
      .header("Content-Type", "text/csv; charset=utf-8")
      .header("Content-Disposition", `attachment; filename="list-health-${date}.csv"`)
      .code(200)
      .send(csv);
    return;
  }

  void reply.code(200).send({
    data: rows,
    meta: {
      campaign: query.campaign ?? null,
      count: rows.length,
    },
  });
}
