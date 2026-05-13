// D02 — Import routes plugin (PLAN §5.1)
// Registers all /api/admin/imports routes.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyApp = any;

import { registerCreateImportRoute } from "./handlers/create.js";
import { registerGetImportRoute } from "./handlers/get.js";
import { registerListImportsRoute } from "./handlers/list.js";
import { registerImportEventsRoute } from "./handlers/events.js";
import { registerErrorsCsvRoute } from "./handlers/errors-csv.js";
import { registerPreviewRoute } from "./handlers/preview.js";
import { registerCancelImportRoute } from "./handlers/cancel.js";

export async function registerImportRoutes(app: AnyApp): Promise<void> {
  // Register @fastify/multipart for file upload support
  if (!app.hasContentTypeParser("multipart/form-data")) {
    await app.register(import("@fastify/multipart").then((m) => m.default), {
      limits: {
        fileSize: 600 * 1024 * 1024,  // 600 MB absolute cap
        files: 1,
        fields: 10,
      },
    });
  }

  registerCreateImportRoute(app);
  registerGetImportRoute(app);
  registerListImportsRoute(app);
  registerImportEventsRoute(app);
  registerErrorsCsvRoute(app);
  registerPreviewRoute(app);
  registerCancelImportRoute(app);
}
