// GET /api/sup/campaigns/metrics
//
// Returns per-campaign KPI metrics for all campaigns visible to the supervisor.
// Phase 1: returns stub data. Real data wiring is blocked on E05 (drop gauges)
// and the dialer stats pipeline shipping.
//
// S01 PLAN §2, §3.2.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export interface CampaignMetrics {
  campaignId: number;
  campaignName: string;
  /** Adaptive Predictive dial level (e.g. 1.8 means 1.8 calls per agent). */
  dialLevel: number;
  /** Calls currently in-flight (ringing or answered). */
  inFlight: number;
  /** Agents currently in READY state on this campaign. */
  agentsReady: number;
  /** Agents logged in but not yet on a call. */
  agentsWaiting: number;
  /** Number of calls queued (inbound queue depth). */
  queueDepth: number;
  /** Number of leads in the hopper that can be called right now. */
  leadsCallable: number;
  /** 30-day rolling drop rate as a percentage (0–100). */
  dropPct30d: number;
  /** True if dialer has been throttled due to drop rate crossing 3%. */
  dropGated: boolean;
}

export function registerDashboardCampaignsRoute(app: FastifyInstance): void {
  app.get(
    "/api/sup/campaigns/metrics",
    {
      preHandler: [app.requireAuth, app.requireRole("supervisor")],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      // Phase 1 stub: representative mock data with all gauge thresholds exercised.
      // TODO(Phase-2): replace with E05 drop-gate metrics + dialer Valkey stats.
      const campaigns: CampaignMetrics[] = [
        {
          campaignId: 1,
          campaignName: "Outbound Sales Q2",
          dialLevel: 1.8,
          inFlight: 12,
          agentsReady: 3,
          agentsWaiting: 1,
          queueDepth: 0,
          leadsCallable: 2480,
          dropPct30d: 1.2,
          dropGated: false,
        },
        {
          campaignId: 2,
          campaignName: "Re-Engagement",
          dialLevel: 2.1,
          inFlight: 5,
          agentsReady: 1,
          agentsWaiting: 2,
          queueDepth: 0,
          leadsCallable: 940,
          dropPct30d: 2.7,
          dropGated: false,
        },
        {
          campaignId: 3,
          campaignName: "Win-Back Q1 (paused)",
          dialLevel: 0,
          inFlight: 0,
          agentsReady: 0,
          agentsWaiting: 0,
          queueDepth: 0,
          leadsCallable: 340,
          dropPct30d: 3.4,
          dropGated: true,
        },
      ];

      return reply.send({ campaigns, scrapeAt: new Date().toISOString() });
    },
  );
}
