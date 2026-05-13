// Supervisor route aggregator.
// S02 monitor routes:
//   POST /api/sup/monitor/start
//   PATCH /api/sup/sessions/:id/mode
//   DELETE /api/sup/sessions/:id
//   GET /internal/freeswitch/monitor_authz
//   GET|POST /internal/freeswitch/monitor_end
// S01 dashboard routes:
//   GET /api/sup/agents
//   GET /api/sup/campaigns/metrics
//   GET /api/sup/health
// S04 wallboard routes:
//   GET  /api/sup/wallboard/layouts
//   POST /api/sup/wallboard/layouts

import type { FastifyInstance } from "fastify";
import { registerMonitorStartRoute } from "./monitor.start.js";
import { registerMonitorModeRoute } from "./monitor.mode.js";
import { registerMonitorEndRoute } from "./monitor.end.js";
import { registerMonitorAuthzRoute } from "./monitor.authz.internal.js";
import { registerMonitorHangupHookRoute } from "./monitor.hangup-hook.internal.js";
import { registerDashboardAgentsRoute } from "./dashboard.agents.js";
import { registerDashboardCampaignsRoute } from "./dashboard.campaigns.js";
import { registerDashboardHealthRoute } from "./dashboard.health.js";
import { registerWallboardLayoutsRoute } from "./wallboard.layouts.js";
// S05 coaching
import { registerSupCoachingRoutes } from "../sup/coaching/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerSupervisorRoutes(app: any): Promise<void> {
  // S02 monitor
  registerMonitorStartRoute(app as FastifyInstance);
  registerMonitorModeRoute(app as FastifyInstance);
  registerMonitorEndRoute(app as FastifyInstance);
  registerMonitorAuthzRoute(app as FastifyInstance);
  registerMonitorHangupHookRoute(app as FastifyInstance);
  // S01 dashboard
  registerDashboardAgentsRoute(app as FastifyInstance);
  registerDashboardCampaignsRoute(app as FastifyInstance);
  registerDashboardHealthRoute(app as FastifyInstance);
  // S04 wallboard
  registerWallboardLayoutsRoute(app as FastifyInstance);
  // S05 coaching
  await registerSupCoachingRoutes(app as FastifyInstance);
}
