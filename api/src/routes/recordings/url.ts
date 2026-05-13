/**
 * api/src/routes/recordings/url.ts
 *
 * GET /api/recordings/:id/url?ttl=300
 *
 * Returns a pre-signed S3 URL for playback.
 * TTL default 300 s; max 3600 s (HTTP 400 if exceeded).
 * R02 PLAN §12, §14.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { makeBackend } from '../../../../workers/recording-uploader/src/backends/factory.js';
import { RecordingService, NoopAuditWriter } from '../../../../workers/recording-uploader/src/services/recording.service.js';
import { parseEnv } from '../../../../workers/recording-uploader/src/config.js';
import { getPrisma } from '../../lib/prisma.js';

const QuerySchema = z.object({
  ttl: z.coerce.number().int().min(1).max(3600).optional(),
});

interface RecordingParams {
  id: string;
}

// Lazy singleton for the recording service (shares backend with worker in same process)
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
export async function registerRecordingUrlRoute(app: FastifyInstance | any): Promise<void> {
  app.get(
    '/api/recordings/:id/url',
    {
      preHandler: [app.requireAuth],
    },
    async (req: FastifyRequest<{ Params: RecordingParams; Querystring: { ttl?: string } }>, reply: FastifyReply) => {
      const auth = (req as FastifyRequest & { auth?: { tenantId: number; role: string; uid: number } }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      const parsed = QuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
      }

      const ttl = parsed.data.ttl ?? 300;
      if (ttl > 3600) {
        return reply.code(400).send({ error: 'ttl_exceeded', message: 'Maximum TTL is 3600 seconds' });
      }

      const recordingLogId = BigInt(req.params.id);
      const tenantId = BigInt(auth.tenantId);

      try {
        const url = await getService().getPlaybackUrl(
          tenantId,
          recordingLogId,
          { userId: BigInt(auth.uid), role: auth.role },
          ttl,
        );
        return reply.send({ url, expires_in: ttl });
      } catch (err: unknown) {
        const e = err as { status?: number; code?: string; message?: string };
        if (e.status === 404) return reply.code(404).send({ error: 'not_found' });
        if (e.code === 'TTL_EXCEEDED') return reply.code(400).send({ error: 'ttl_exceeded' });
        throw err;
      }
    },
  );
}
