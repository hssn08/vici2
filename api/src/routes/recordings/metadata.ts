/**
 * api/src/routes/recordings/metadata.ts
 *
 * GET /api/recordings/:id
 *
 * Returns recording metadata: size, duration, consent_status, lifecycle_state,
 * sha256 (hex), retention info. Tenant-scoped.
 * R02 PLAN §14.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '../../lib/prisma.js';

interface RecordingParams {
  id: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerRecordingMetadataRoute(app: FastifyInstance | any): Promise<void> {
  app.get(
    '/api/recordings/:id',
    {
      preHandler: [app.requireAuth],
    },
    async (req: FastifyRequest<{ Params: RecordingParams }>, reply: FastifyReply) => {
      const auth = (req as FastifyRequest & { auth?: { tenantId: number; role: string } }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      const recordingLogId = BigInt(req.params.id);
      const tenantId = BigInt(auth.tenantId);
      const prisma = getPrisma();

      const rows = await prisma.$queryRaw<
        Array<{
          id: bigint;
          uuid: string;
          filename: string;
          storage_url: string | null;
          sha256: Buffer | null;
          lifecycle_state: string;
          failure_reason: string | null;
          start_time: Date;
          duration_sec: number | null;
          size_bytes: bigint | null;
          consent_status: string;
          encoded_at: Date | null;
        }>
      >`
        SELECT id, uuid, filename, storage_url, sha256, lifecycle_state, failure_reason,
               start_time, duration_sec, size_bytes, consent_status, encoded_at
        FROM recording_log
        WHERE id = ${recordingLogId} AND tenant_id = ${tenantId}
        LIMIT 1
      `;

      const row = rows[0];
      if (!row) return reply.code(404).send({ error: 'not_found' });

      return reply.send({
        id: row.id.toString(),
        uuid: row.uuid,
        storage_url: row.storage_url,
        sha256: row.sha256 ? row.sha256.toString('hex') : null,
        lifecycle_state: row.lifecycle_state,
        failure_reason: row.failure_reason,
        start_time: row.start_time.toISOString(),
        duration_sec: row.duration_sec,
        size_bytes: row.size_bytes?.toString() ?? null,
        consent_status: row.consent_status,
        encoded_at: row.encoded_at?.toISOString() ?? null,
      });
    },
  );
}
