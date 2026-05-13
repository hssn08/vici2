/**
 * A07 — Agent today-stats endpoint.
 * GET /api/agent/stats/today
 *
 * Returns aggregate call metrics for the authenticated agent for the current UTC day.
 * Uses call_log + dispositions tables via Prisma.
 *
 * Response: AgentTodayStats
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../auth/middleware.js";
import { getPrisma } from "../lib/prisma.js";

export interface AgentTodayStats {
  callsHandled: number;
  contacts: number;
  sales: number;
  talkTimeSec: number;
  dropPct: number;
  asOf: string;
}

type AuthReq = FastifyRequest & { auth?: AuthContext };

function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const auth = (req as AuthReq).auth;
  if (!auth) {
    void reply.code(401).send({ error: "not_authenticated" });
    return;
  }
  done();
}

async function handleAgentStatsTodayRoute(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = (req as AuthReq).auth!;
  const prisma = getPrisma();

  // Start of today in UTC
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  try {
    // Fetch all call_log rows for this agent today
    const calls = await prisma.callLog.findMany({
      where: {
        tenantId: BigInt(auth.tenantId),
        userId: BigInt(auth.uid),
        callStarted: { gte: today },
      },
      select: {
        id: true,
        talkSeconds: true,
        isDrop: true,
        callAnswered: true,
      },
    });

    const callsHandled = calls.length;
    const contacts = calls.filter((c) => c.callAnswered !== null).length;
    const drops = calls.filter((c) => c.isDrop).length;
    const talkTimeSec = calls.reduce((sum, c) => sum + (c.talkSeconds ?? 0), 0);
    const dropPct = callsHandled > 0 ? (drops / callsHandled) * 100 : 0;

    // Sales = distinct leads with a sale-type disposition today
    const callIds = calls.map((c) => c.id);
    let sales = 0;
    if (callIds.length > 0) {
      // A sale is any disposition where the status_code starts with 'SALE'
      // (or tenant-specific codes: configurable; here we use a simple SALE% match)
      const saleDisps = await prisma.disposition.findMany({
        where: {
          tenantId: BigInt(auth.tenantId),
          userId: BigInt(auth.uid),
          disposedAt: { gte: today },
          callLogId: { in: callIds },
          statusCode: { startsWith: "SALE" },
        },
        select: { id: true },
      });
      sales = saleDisps.length;
    }

    const stats: AgentTodayStats = {
      callsHandled,
      contacts,
      sales,
      talkTimeSec,
      dropPct: Math.round(dropPct * 10) / 10,
      asOf: new Date().toISOString(),
    };

    void reply.code(200).send(stats);
  } catch (err) {
    req.log.error({ err }, "agent stats query failed");
    // Return zeroes on error so the widget degrades gracefully
    const fallback: AgentTodayStats = {
      callsHandled: 0,
      contacts: 0,
      sales: 0,
      talkTimeSec: 0,
      dropPct: 0,
      asOf: new Date().toISOString(),
    };
    void reply.code(200).send(fallback);
  }
}

export async function registerAgentStatsRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.get(
    "/api/agent/stats/today",
    { preHandler: [requireAuth] },
    handleAgentStatsTodayRoute,
  );
}
