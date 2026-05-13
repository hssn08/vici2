// GET /api/sup/health
//
// Returns the system health snapshot: FreeSWITCH, MySQL, Valkey, dialer pods,
// and scrape staleness. Phase 1: returns stub data.
//
// S01 PLAN §2, §3.3.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export interface SystemHealth {
  freeswitchUp: boolean;
  mysqlUp: boolean;
  valkeyUp: boolean;
  /** Number of dialer pods currently reporting healthy. */
  dialerPodsUp: number;
  /** Total number of dialer pods expected. */
  dialerPodsTotal: number;
  /** Milliseconds since the last successful metrics scrape. */
  scrapeStalenessMs: number;
  scrapeAt: string;
}

export function registerDashboardHealthRoute(app: FastifyInstance): void {
  app.get(
    "/api/sup/health",
    {
      preHandler: [app.requireAuth, app.requireRole("supervisor")],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      // Phase 1 stub.
      // TODO(Phase-2): check FS ESL ping, MySQL query, Valkey PING, dialer /health.
      const now = new Date();
      const health: SystemHealth = {
        freeswitchUp: true,
        mysqlUp: true,
        valkeyUp: true,
        dialerPodsUp: 2,
        dialerPodsTotal: 2,
        scrapeStalenessMs: 800,
        scrapeAt: now.toISOString(),
      };

      return reply.send(health);
    },
  );
}
