// D01 — Lead CRUD plugin (PLAN §11.1)
// Registers all lead routes as a Fastify plugin.

import type { FastifyInstance } from "fastify";
import { registerListLeadsRoute } from "./handlers/list.js";
import { registerLookupLeadRoute } from "./handlers/lookup.js";
import { registerGetLeadRoute } from "./handlers/get.js";
import { registerCreateLeadRoute } from "./handlers/create.js";
import { registerBulkLeadRoute } from "./handlers/bulk.js";
import { registerUpdateLeadRoute } from "./handlers/update.js";
import { registerDeleteLeadRoute } from "./handlers/delete.js";
import { registerLeadCallsRoute } from "./handlers/calls.js";
import { registerExportLeadsRoute } from "./handlers/export.js";
import { registerPromoteFieldRoute } from "./handlers/promote-field.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerLeadRoutes(app: FastifyInstance | any): Promise<void> {
  // Order matters: specific routes before parameterized ones
  // to avoid /api/leads/lookup matching :id param
  registerExportLeadsRoute(app);
  registerLookupLeadRoute(app);
  registerListLeadsRoute(app);
  registerGetLeadRoute(app);
  registerCreateLeadRoute(app);
  registerBulkLeadRoute(app);
  registerUpdateLeadRoute(app);
  registerDeleteLeadRoute(app);
  registerLeadCallsRoute(app);
  registerPromoteFieldRoute(app);
}
