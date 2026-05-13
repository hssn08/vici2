// M08 — GET /api/admin/reports/fcc-drop-rate
//        GET /api/admin/reports/fcc-drop-rate/timeline

import type { FastifyRequest, FastifyReply } from "fastify";
import type { PrismaClient } from "@prisma/client";
import type { AuthContext } from "../../auth/middleware.js";
import { ReportingService } from "../service.js";
import { reportRequestsTotal } from "../metrics.js";

interface FccQuery {
  campaign?: string;
  from?: string;
  to?: string;
  days?: string;
}

function parseDateRange(from?: string, to?: string): { fromDate: Date; toDate: Date } {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from
    ? new Date(from)
    : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { fromDate, toDate };
}

export async function handleFccDropRate(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  auth: AuthContext,
): Promise<void> {
  reportRequestsTotal.inc({ endpoint: "fcc-drop-rate" });

  const query = req.query as FccQuery;
  const campaignId = query.campaign ?? "__ALL__";
  const { fromDate, toDate } = parseDateRange(query.from, query.to);
  const tenantId = BigInt(auth.tenantId);

  const svc = new ReportingService(prisma);
  const result = await svc.getFccDropRate(tenantId, campaignId, fromDate, toDate);

  const fccThresholdPct = 3.0;
  const aboveThreshold = result.dropRatePct !== null && result.dropRatePct > fccThresholdPct;

  void reply.code(200).send({
    data: result,
    meta: {
      fccThresholdPct,
      aboveThreshold,
      note: "drop_rate = drops / NULLIF(SUM(human_answered), 0). Denominator is SUM(human_answered) per D04 PLAN §8.2.",
    },
  });
}

export async function handleFccTimeline(
  req: FastifyRequest,
  reply: FastifyReply,
  prisma: PrismaClient,
  auth: AuthContext,
): Promise<void> {
  reportRequestsTotal.inc({ endpoint: "fcc-timeline" });

  const query = req.query as FccQuery;
  const campaignId = query.campaign ?? "__ALL__";
  const days = Math.min(Math.max(Number(query.days ?? 90), 1), 365);
  const tenantId = BigInt(auth.tenantId);

  const svc = new ReportingService(prisma);
  const buckets = await svc.getFccTimeline(tenantId, campaignId, days);

  void reply.code(200).send({
    campaignId,
    days,
    buckets,
    meta: {
      denominatorNote: "humanAnswered = SUM(s.human_answered) per D04 PLAN §8.2",
    },
  });
}
