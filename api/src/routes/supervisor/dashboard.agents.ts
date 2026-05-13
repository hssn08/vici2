// GET /api/sup/agents
//
// Returns a snapshot of all active agents visible to the authenticated supervisor.
// Phase 1: returns stub data. Real data wiring is blocked on T03 (agent presence
// Valkey keys) shipping. The API shape is frozen for the UI.
//
// S01 PLAN §2, §3.1.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export interface AgentSnapshot {
  uid: number;
  displayName: string;
  state: "READY" | "IN_CALL" | "WRAPUP" | "PAUSED" | "LOGOUT";
  campaignId: number | null;
  campaignName: string | null;
  /** Seconds since the call was answered; null if not IN_CALL. */
  callDurationSec: number | null;
  /** Last 4 digits of the lead phone number; null if not IN_CALL. */
  leadPhone: string | null;
  /** Number of supervisors currently monitoring this agent. */
  monitorCount: number;
  teamId: number | null;
}

export function registerDashboardAgentsRoute(app: FastifyInstance): void {
  app.get(
    "/api/sup/agents",
    {
      preHandler: [app.requireAuth, app.requireRole("supervisor")],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      // Phase 1 stub: return representative mock data that exercises every state.
      // TODO(Phase-2): replace with Valkey SCAN on t:{tid}:agent:* presence keys.
      const agents: AgentSnapshot[] = [
        {
          uid: 101,
          displayName: "Alice Nguyen",
          state: "IN_CALL",
          campaignId: 1,
          campaignName: "Outbound Sales Q2",
          callDurationSec: 142,
          leadPhone: "4567",
          monitorCount: 0,
          teamId: null,
        },
        {
          uid: 102,
          displayName: "Bob Martinez",
          state: "READY",
          campaignId: 1,
          campaignName: "Outbound Sales Q2",
          callDurationSec: null,
          leadPhone: null,
          monitorCount: 0,
          teamId: null,
        },
        {
          uid: 103,
          displayName: "Carol Kim",
          state: "WRAPUP",
          campaignId: 2,
          campaignName: "Re-Engagement",
          callDurationSec: null,
          leadPhone: null,
          monitorCount: 0,
          teamId: null,
        },
        {
          uid: 104,
          displayName: "David Okafor",
          state: "IN_CALL",
          campaignId: 2,
          campaignName: "Re-Engagement",
          callDurationSec: 67,
          leadPhone: "9012",
          monitorCount: 1,
          teamId: null,
        },
        {
          uid: 105,
          displayName: "Eva Rossi",
          state: "PAUSED",
          campaignId: 1,
          campaignName: "Outbound Sales Q2",
          callDurationSec: null,
          leadPhone: null,
          monitorCount: 0,
          teamId: null,
        },
      ];

      return reply.send({ agents, scrapeAt: new Date().toISOString() });
    },
  );
}
