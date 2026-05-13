// M08 — GET /api/admin/reports/fcc-drop-rate/export.csv
//
// CSV download for FCC quarterly safe-harbor evidence.
// Streams csv-stringify output. Requires report:export permission.

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { ReportingService } from "../service.js";
import { exportBytesTotal, reportRequestsTotal } from "../metrics.js";
import { stringify } from "csv-stringify";

interface FccExportQuery {
  campaign?: string;
  from?: string;
  to?: string;
}

export async function handleFccExport(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  auth: AuthContext,
): Promise<void> {
  reportRequestsTotal.inc({ endpoint: "fcc-export" });

  const query = req.query as FccExportQuery;
  const campaignId = query.campaign ?? "__ALL__";
  const toDate = query.to ? new Date(query.to) : new Date();
  const fromDate = query.from
    ? new Date(query.from)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

  const tenantId = BigInt(auth.tenantId);
  const svc = new ReportingService(prisma);

  // Fetch both summary and timeline for the CSV
  const [summary, timeline] = await Promise.all([
    svc.getFccDropRate(tenantId, campaignId, fromDate, toDate),
    svc.getFccTimeline(tenantId, campaignId, 90),
  ]);

  const fromStr = fromDate.toISOString().slice(0, 10);
  const toStr = toDate.toISOString().slice(0, 10);
  const filename = `fcc_drop_rate_${campaignId}_${fromStr}_${toStr}.csv`;

  void reply.header("Content-Type", "text/csv; charset=utf-8");
  void reply.header("Content-Disposition", `attachment; filename="${filename}"`);

  // Build CSV rows: summary section + timeline section
  const rows: string[][] = [
    // Section 1: Summary
    ["SECTION", "FCC DROP RATE SUMMARY"],
    [
      "campaign_id",
      "from_date",
      "to_date",
      "total_calls",
      "human_answered",
      "drops",
      "sales",
      "drop_rate_pct",
      "fcc_threshold_pct",
      "above_threshold",
    ],
    [
      summary.campaignId,
      summary.fromDate,
      summary.toDate,
      String(summary.totalCalls),
      String(summary.humanAnswered),
      String(summary.drops),
      String(summary.sales),
      summary.dropRatePct !== null ? String(summary.dropRatePct) : "",
      "3.0",
      summary.dropRatePct !== null && summary.dropRatePct > 3.0 ? "YES" : "NO",
    ],
    [],
    // Section 2: Daily timeline
    ["SECTION", "FCC DROP RATE DAILY TIMELINE (last 90 days)"],
    ["date", "total_calls", "human_answered", "drops", "drop_rate_pct"],
    ...timeline.map((b) => [
      b.date,
      String(b.totalCalls),
      String(b.humanAnswered),
      String(b.drops),
      b.dropRatePct !== null ? String(b.dropRatePct) : "",
    ]),
    [],
    // Footer note
    [
      "NOTE",
      "Denominator is SUM(human_answered) per D04 PLAN §8.2 / FCC TCPA 47 CFR §64.1200(a)(7). Safe-harbor threshold 3%.",
    ],
  ];

  // Stringify and collect bytes
  const csvContent = await new Promise<string>((resolve, reject) => {
    const chunks: string[] = [];
    const stringifier = stringify({
      cast: {
        boolean: (value: boolean) => (value ? "true" : "false"),
      },
    });
    stringifier.on("readable", () => {
      let chunk: string;
      while ((chunk = stringifier.read()) !== null) {
        chunks.push(chunk);
      }
    });
    stringifier.on("error", reject);
    stringifier.on("finish", () => resolve(chunks.join("")));

    for (const row of rows) {
      stringifier.write(row);
    }
    stringifier.end();
  });

  exportBytesTotal.inc(Buffer.byteLength(csvContent, "utf8"));

  void reply.send(csvContent);
}
