/**
 * api/src/routes/recordings/legal-hold.ts
 *
 * POST   /api/recordings/:id/legal-hold  — apply legal hold
 * DELETE /api/recordings/:id/legal-hold  — release legal hold
 *
 * Restricted to superadmin + compliance roles.
 * R02 PLAN §14.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { makeBackend } from '../../../../workers/recording-uploader/src/backends/factory.js';
import { RecordingService, NoopAuditWriter } from '../../../../workers/recording-uploader/src/services/recording.service.js';
import { parseEnv } from '../../../../workers/recording-uploader/src/config.js';
import { getPrisma } from '../../lib/prisma.js';

interface RecordingParams {
  id: string;
}

let _service: RecordingService | null = null;
function getService(): RecordingService {
  if (!_service) {
    const env = parseEnv();
    const backend = makeBackend(env);
    _service = new RecordingService(getPrisma(), backend, env.R02_DEFAULT_BUCKET, new NoopAuditWriter());
  }
  return _service;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerLegalHoldRoutes(app: FastifyInstance | any): Promise<void> {
  // POST /api/recordings/:id/legal-hold
  app.post(
    '/api/recordings/:id/legal-hold',
    {
      preHandler: [app.requireAuth, app.requireRole('superadmin')],
    },
    async (req: FastifyRequest<{ Params: RecordingParams }>, reply: FastifyReply) => {
      const auth = (req as FastifyRequest & { auth?: { tenantId: number; role: string; uid: number } }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      const recordingLogId = BigInt(req.params.id);
      const tenantId = BigInt(auth.tenantId);

      await getService().setLegalHold(
        tenantId,
        [recordingLogId],
        true,
        { userId: BigInt(auth.uid), role: auth.role },
      );

      return reply.code(204).send();
    },
  );

  // DELETE /api/recordings/:id/legal-hold
  app.delete(
    '/api/recordings/:id/legal-hold',
    {
      preHandler: [app.requireAuth, app.requireRole('superadmin')],
    },
    async (req: FastifyRequest<{ Params: RecordingParams }>, reply: FastifyReply) => {
      const auth = (req as FastifyRequest & { auth?: { tenantId: number; role: string; uid: number } }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      const recordingLogId = BigInt(req.params.id);
      const tenantId = BigInt(auth.tenantId);

      await getService().setLegalHold(
        tenantId,
        [recordingLogId],
        false,
        { userId: BigInt(auth.uid), role: auth.role },
      );

      return reply.code(204).send();
    },
  );
}
