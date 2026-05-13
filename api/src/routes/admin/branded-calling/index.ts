// N05 — Branded Calling admin routes.
// Mounts all sub-routes under /api/admin/branded-calling.

import type { FastifyInstance } from 'fastify';
import {
  handleListProviders,
  handleGetProvider,
  handleConfigureProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleTestConnection,
} from './provider.js';
import {
  handleListDids,
  handleRegisterDid,
  handleDeregisterDid,
  handleBulkRegister,
} from './dids.js';
import {
  handleGetReputation,
  handleSubmitDispute,
} from './reputation.js';

export async function registerAdminBrandedCallingRoutes(app: FastifyInstance): Promise<void> {
  const configPerm = app.requirePermission('branded_calling:configure');
  const registerPerm = app.requirePermission('branded_calling:register_did');

  // Provider config
  app.get(
    '/api/admin/branded-calling',
    { preHandler: [app.requireAuth, configPerm] },
    handleListProviders,
  );
  app.post(
    '/api/admin/branded-calling/:provider',
    { preHandler: [app.requireAuth, configPerm] },
    handleConfigureProvider,
  );
  app.get(
    '/api/admin/branded-calling/:provider',
    { preHandler: [app.requireAuth, configPerm] },
    handleGetProvider,
  );
  app.patch(
    '/api/admin/branded-calling/:provider',
    { preHandler: [app.requireAuth, configPerm] },
    handleUpdateProvider,
  );
  app.delete(
    '/api/admin/branded-calling/:provider',
    { preHandler: [app.requireAuth, configPerm] },
    handleDeleteProvider,
  );
  app.post(
    '/api/admin/branded-calling/:provider/test-connection',
    { preHandler: [app.requireAuth, configPerm] },
    handleTestConnection,
  );

  // DID registration — bulk-register must be registered before :didId routes
  app.get(
    '/api/admin/branded-calling/:provider/dids',
    { preHandler: [app.requireAuth, registerPerm] },
    handleListDids,
  );
  app.post(
    '/api/admin/branded-calling/:provider/dids',
    { preHandler: [app.requireAuth, registerPerm] },
    handleRegisterDid,
  );
  app.post(
    '/api/admin/branded-calling/:provider/dids/bulk-register',
    { preHandler: [app.requireAuth, registerPerm] },
    handleBulkRegister,
  );
  app.delete(
    '/api/admin/branded-calling/:provider/dids/:didId',
    { preHandler: [app.requireAuth, registerPerm] },
    handleDeregisterDid,
  );

  // Reputation + dispute
  app.get(
    '/api/admin/branded-calling/:provider/dids/:didId/reputation',
    { preHandler: [app.requireAuth, registerPerm] },
    handleGetReputation,
  );
  app.post(
    '/api/admin/branded-calling/:provider/dids/:didId/dispute',
    { preHandler: [app.requireAuth, registerPerm] },
    handleSubmitDispute,
  );
}
