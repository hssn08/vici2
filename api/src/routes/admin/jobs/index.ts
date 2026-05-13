/**
 * W02 — Jobs Queue Admin: route registration.
 *
 * All routes are prefixed under /api/admin and require:
 *   - requireAuth  (JWT verification)
 *   - requirePermission(verb) per endpoint
 *
 * Endpoint permission matrix (FROZEN per PLAN §3.2):
 *   GET  /jobs/queues                        jobs:view
 *   GET  /jobs/queues/:queue/jobs            jobs:view
 *   GET  /jobs/queues/:queue/jobs/:id        jobs:view
 *   POST /jobs/queues/:queue/jobs/:id/retry  jobs:retry
 *   DEL  /jobs/queues/:queue/jobs/:id        jobs:retry
 *   POST /jobs/queues/:queue/pause           jobs:retry
 *   POST /jobs/queues/:queue/resume          jobs:retry
 *   POST /jobs/queues/:queue/drain           jobs:drain
 *   GET  /jobs/dlq/:queue                   jobs:view
 *   POST /jobs/dlq/:queue/:eid/retry         jobs:retry
 *   DEL  /jobs/dlq/:queue                   jobs:drain
 */

import { handleGetQueues } from './queues.js';
import { handleGetJobs, handleGetJobDetail } from './queue-jobs.js';
import {
  handleJobRetry,
  handleJobRemove,
  handleQueuePause,
  handleQueueResume,
  handleQueueDrain,
} from './queue-actions.js';
import { handleGetDlq, handleDlqRetry, handleDlqDrain } from './dlq.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminJobRoutes(app: any): Promise<void> {
  // ── Queue list ──────────────────────────────────────────────────────────
  app.get(
    '/api/admin/jobs/queues',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:view')] },
    handleGetQueues,
  );

  // ── Job list ────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/jobs/queues/:queue/jobs',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:view')] },
    handleGetJobs,
  );

  // ── Job detail ──────────────────────────────────────────────────────────
  app.get(
    '/api/admin/jobs/queues/:queue/jobs/:id',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:view')] },
    handleGetJobDetail,
  );

  // ── Job retry ───────────────────────────────────────────────────────────
  app.post(
    '/api/admin/jobs/queues/:queue/jobs/:id/retry',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:retry')] },
    handleJobRetry,
  );

  // ── Job remove ──────────────────────────────────────────────────────────
  app.delete(
    '/api/admin/jobs/queues/:queue/jobs/:id',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:retry')] },
    handleJobRemove,
  );

  // ── Queue pause ─────────────────────────────────────────────────────────
  app.post(
    '/api/admin/jobs/queues/:queue/pause',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:retry')] },
    handleQueuePause,
  );

  // ── Queue resume ────────────────────────────────────────────────────────
  app.post(
    '/api/admin/jobs/queues/:queue/resume',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:retry')] },
    handleQueueResume,
  );

  // ── Queue drain ─────────────────────────────────────────────────────────
  app.post(
    '/api/admin/jobs/queues/:queue/drain',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:drain')] },
    handleQueueDrain,
  );

  // ── DLQ list ────────────────────────────────────────────────────────────
  app.get(
    '/api/admin/jobs/dlq/:queue',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:view')] },
    handleGetDlq,
  );

  // ── DLQ retry ───────────────────────────────────────────────────────────
  app.post(
    '/api/admin/jobs/dlq/:queue/:eid/retry',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:retry')] },
    handleDlqRetry,
  );

  // ── DLQ drain ───────────────────────────────────────────────────────────
  app.delete(
    '/api/admin/jobs/dlq/:queue',
    { preHandler: [app.requireAuth, app.requirePermission('jobs:drain')] },
    handleDlqDrain,
  );
}
