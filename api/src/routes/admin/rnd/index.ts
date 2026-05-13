/**
 * api/src/routes/admin/rnd/index.ts
 *
 * N06 — Route registration for RND scrub admin endpoints.
 *
 * Endpoints:
 *   POST   /api/admin/rnd/scrub                rnd:scrub     — trigger a campaign scrub
 *   GET    /api/admin/rnd/status/:campaign_id  rnd:scrub     — poll scrub progress
 *   GET    /api/admin/rnd/config               rnd:configure — get tenant config
 *   PUT    /api/admin/rnd/config               rnd:configure — update tenant config
 *   GET    /api/admin/rnd/usage                rnd:scrub     — monthly usage/cost
 *   DELETE /api/admin/rnd/override/:phone      rnd:override  — remove reassigned DNC entry
 */

import { handleTriggerScrub } from './scrub.js';
import { handleGetStatus } from './status.js';
import { handleGetConfig, handleUpdateConfig } from './config.js';
import { handleGetUsage } from './usage.js';
import { handleOverride } from './override.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminRndRoutes(app: any): Promise<void> {
  // POST /api/admin/rnd/scrub — trigger a campaign scrub
  app.post(
    '/api/admin/rnd/scrub',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:scrub')] },
    handleTriggerScrub,
  );

  // GET /api/admin/rnd/status/:campaign_id — poll scrub progress
  app.get(
    '/api/admin/rnd/status/:campaign_id',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:scrub')] },
    handleGetStatus,
  );

  // GET /api/admin/rnd/config — get tenant RND config
  app.get(
    '/api/admin/rnd/config',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:configure')] },
    handleGetConfig,
  );

  // PUT /api/admin/rnd/config — update tenant RND config
  app.put(
    '/api/admin/rnd/config',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:configure')] },
    handleUpdateConfig,
  );

  // GET /api/admin/rnd/usage — monthly cost breakdown
  app.get(
    '/api/admin/rnd/usage',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:scrub')] },
    handleGetUsage,
  );

  // DELETE /api/admin/rnd/override/:phone — remove reassigned DNC
  app.delete(
    '/api/admin/rnd/override/:phone',
    { preHandler: [app.requireAuth, app.requirePermission('rnd:override')] },
    handleOverride,
  );
}
