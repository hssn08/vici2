/**
 * api/src/routes/recordings/integrity.ts
 *
 * GET /api/recordings/:id/integrity-check
 *
 * Runs verifyIntegrity(): HEAD + SHA-256 comparison + Object Lock state.
 * Restricted to superadmin + auditor roles.
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
export async function registerIntegrityRoute(app: FastifyInstance | any): Promise<void> {
  app.get(
    '/api/recordings/:id/integrity-check',
    {
      preHandler: [app.requireAuth, app.requireRole('superadmin')],
    },
    async (req: FastifyRequest<{ Params: RecordingParams }>, reply: FastifyReply) => {
      const auth = (req as FastifyRequest & { auth?: { tenantId: number; role: string } }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      const recordingLogId = BigInt(req.params.id);

      const result = await getService().verifyIntegrity(recordingLogId);

      return reply.send({
        ok: result.ok,
        local_sha256: result.localSha,
        remote_sha256: result.remoteSha,
        retain_until_date: result.retainUntilDate?.toISOString() ?? null,
        legal_hold: result.legalHold,
      });
    },
  );
}
