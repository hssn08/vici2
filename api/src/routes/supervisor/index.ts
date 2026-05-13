// S02 supervisor monitor route aggregator.
// Mounts: POST /api/sup/monitor/start
//         PATCH /api/sup/sessions/:id/mode
//         DELETE /api/sup/sessions/:id
//         GET /internal/freeswitch/monitor_authz
//         GET|POST /internal/freeswitch/monitor_end

import type { FastifyInstance } from "fastify";
import { registerMonitorStartRoute } from "./monitor.start.js";
import { registerMonitorModeRoute } from "./monitor.mode.js";
import { registerMonitorEndRoute } from "./monitor.end.js";
import { registerMonitorAuthzRoute } from "./monitor.authz.internal.js";
import { registerMonitorHangupHookRoute } from "./monitor.hangup-hook.internal.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerSupervisorRoutes(app: any): Promise<void> {
  registerMonitorStartRoute(app as FastifyInstance);
  registerMonitorModeRoute(app as FastifyInstance);
  registerMonitorEndRoute(app as FastifyInstance);
  registerMonitorAuthzRoute(app as FastifyInstance);
  registerMonitorHangupHookRoute(app as FastifyInstance);
}
