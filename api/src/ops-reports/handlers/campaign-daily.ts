// M03 — GET /api/admin/reports/campaign-daily
//        GET /api/admin/reports/campaign-daily/export.csv

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { OpsReportService } from "../service.js";
import { buildCacheKey, cacheGet, cacheSet } from "../cache.js";
import { opsReportRequestsTotal, opsReportCacheHits, opsReportCacheMisses, opsExportBytesTotal } from "../metrics.js";
import { toCsv } from "../../lib/csv.js";
import type { CampaignDailyRow } from "../service.js";

interface Query {
  from?: string;
  to?: string;
  campaign?: string;
  format?: string;
}

function parseDateRange(from?: string, to?: string): { fromDate: Date; toDate: Date } {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { fromDate, toDate };
}

const CSV_HEADERS: (keyof CampaignDailyRow)[] = [
  "reportDate",
  "campaignId",
  "callsAttempted",
  "callsConnected",
  "contacts",
  "sales",
  "drops",
  "dropRatePct",
  "avgCallDurationSec",
  "abandonRatePct",
];

export async function handleCampaignDaily(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  auth: AuthContext,
): Promise<void> {
  opsReportRequestsTotal.inc({ endpoint: "campaign-daily" });

  const query = req.query as Query;
  const { fromDate, toDate } = parseDateRange(query.from, query.to);
  const tenantId = BigInt(auth.tenantId);
  const isCsv = query.format === "csv" || req.headers["accept"] === "text/csv";

  const cacheKey = buildCacheKey("campaign-daily", tenantId, {
    from: fromDate.toISOString().slice(0, 10),
    to: toDate.toISOString().slice(0, 10),
    campaign: query.campaign,
  });

  let rows = await cacheGet<CampaignDailyRow[]>(cacheKey);
  if (rows) {
    opsReportCacheHits.inc({ report: "campaign-daily" });
  } else {
    opsReportCacheMisses.inc({ report: "campaign-daily" });
    const svc = new OpsReportService(prisma);
    rows = await svc.getCampaignDaily(tenantId, fromDate, toDate, query.campaign);
    await cacheSet(cacheKey, rows);
  }

  if (isCsv) {
    const csv = toCsv(CSV_HEADERS as string[], rows as unknown as Record<string, unknown>[]);
    opsExportBytesTotal.inc(Buffer.byteLength(csv, "utf8"));
    const filename = `campaign-daily-${fromDate.toISOString().slice(0, 10)}-${toDate.toISOString().slice(0, 10)}.csv`;
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
      campaign: query.campaign ?? null,
      count: rows.length,
      denominatorNote: "contacts = SUM(s.human_answered) per D04 PLAN §8.2",
    },
  });
}
