/**
 * api/src/routes/recordings/transcript.ts
 *
 * GET  /api/recordings/:id/transcript
 * POST /api/recordings/:id/transcript/retry
 *
 * N07 PLAN §7 / AC-8, AC-9, AC-14.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Queue } from 'bullmq';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getPrisma } from '../../lib/prisma.js';
import { makeBackend } from '../../../../workers/recording-uploader/src/backends/factory.js';
import { parseEnv as parseR02Env } from '../../../../workers/recording-uploader/src/config.js';

// ---------------------------------------------------------------------------
// RBAC helpers
// ---------------------------------------------------------------------------

const RAW_ALLOWED_ROLES = new Set(['superadmin', 'compliance_auditor']);
const OWN_CALL_ONLY_ROLES = new Set(['agent']);

// Rate-limit: 1 manual retry per recording per hour (in-memory per process)
const retryRateLimit = new Map<string, number>();

function checkRetryRateLimit(recordingLogId: string): boolean {
  const last = retryRateLimit.get(recordingLogId);
  if (last && Date.now() - last < 3600_000) return false;
  retryRateLimit.set(recordingLogId, Date.now());
  return true;
}

// ---------------------------------------------------------------------------
// Presigned URL generation via recording-uploader backend
// ---------------------------------------------------------------------------

function getStorageBackend() {
  const env = parseR02Env();
  return makeBackend(env);
}

const INLINE_WORD_COUNT_LIMIT = Number(process.env['N07_INLINE_WORD_COUNT_LIMIT'] ?? 5000);
const PRESIGNED_URL_EXPIRES_SEC = 300;

// Parse S3 URI: s3://bucket/key → { bucket, key }
function parseS3Uri(uri: string): { bucket: string; key: string } {
  const u = new URL(uri);
  return { bucket: u.hostname, key: u.pathname.replace(/^\//, '') };
}

// ---------------------------------------------------------------------------
// BullMQ connection helper
// ---------------------------------------------------------------------------

function getTranscriptionQueueConnection() {
  const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const parsed = new URL(redisUrl);
  return { host: parsed.hostname, port: Number(parsed.port || 6379) };
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerTranscriptRoutes(app: FastifyInstance | any): Promise<void> {
  // GET /api/recordings/:id/transcript
  app.get(
    '/api/recordings/:id/transcript',
    { preHandler: [app.requireAuth] },
    async (
      req: FastifyRequest<{
        Params: { id: string };
        Querystring: { format?: string; raw?: string };
      }>,
      reply: FastifyReply,
    ) => {
      const auth = (req as FastifyRequest & { auth?: { tenantId: number; role: string; userId?: number } }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      const recordingLogId = BigInt(req.params.id);
      const tenantId = BigInt(auth.tenantId);
      const wantRaw = req.query.raw === 'true';
      const wantUrl = req.query.format === 'url';

      // Raw transcript requires elevated role (AC-9)
      if (wantRaw && !RAW_ALLOWED_ROLES.has(auth.role)) {
        return reply.code(403).send({ error: 'raw_transcript_forbidden' });
      }

      const prisma = getPrisma();

      // Fetch recording_log row
      const rows = await prisma.$queryRaw<
        Array<{
          id: bigint;
          uuid: string;
          user_id: bigint | null;
          transcript_status: string;
          transcript_uri: string | null;
          transcript_lang: string | null;
          transcript_word_count: number | null;
          consent_status: string;
          start_time: Date;
          tenant_id: bigint;
        }>
      >`
        SELECT id, uuid, user_id, transcript_status, transcript_uri,
               transcript_lang, transcript_word_count, consent_status, start_time, tenant_id
        FROM recording_log
        WHERE id = ${recordingLogId} AND tenant_id = ${tenantId}
        LIMIT 1
      `;

      const rec = rows[0];
      if (!rec) return reply.code(404).send({ error: 'not_found' });

      // Agent RBAC: can only access own calls
      if (OWN_CALL_ONLY_ROLES.has(auth.role)) {
        if (!rec.user_id || rec.user_id.toString() !== String(auth.userId)) {
          return reply.code(403).send({ error: 'access_denied' });
        }
      }

      const status = rec.transcript_status;

      // Consent blocked
      if (status === 'consent_blocked') {
        return reply.code(403).send({ error: 'transcript_consent_blocked' });
      }

      // In-progress
      if (['pending', 'queued', 'processing'].includes(status)) {
        return reply.code(202).send({ status });
      }

      // Failed
      if (status === 'failed') {
        return reply.code(200).send({ status: 'failed', retry_available: true });
      }

      // Skipped
      if (status === 'skipped') {
        return reply.code(200).send({ status: 'skipped' });
      }

      // Completed — fetch from S3
      if (status !== 'completed' || !rec.transcript_uri) {
        return reply.code(404).send({ error: 'transcript_not_available' });
      }

      const { bucket, key: baseKey } = parseS3Uri(rec.transcript_uri);
      const key = wantRaw
        ? baseKey.replace('.transcript.json', '.transcript.raw.json')
        : baseKey;

      const backend = getStorageBackend();

      // URL mode or large transcript → return presigned URL
      if (wantUrl || (rec.transcript_word_count ?? 0) >= INLINE_WORD_COUNT_LIMIT) {
        const presignedUrl = await backend.getSignedUrl(bucket, key, PRESIGNED_URL_EXPIRES_SEC);
        return reply.send({
          transcript_status: 'completed',
          transcript_url: presignedUrl,
          expires_in_seconds: PRESIGNED_URL_EXPIRES_SEC,
        });
      }

      // Inline mode — fetch JSON from S3 and return
      const s3Resp = await backend.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      if (!s3Resp.Body) return reply.code(500).send({ error: 'transcript_body_missing' });

      const chunks: Buffer[] = [];
      for await (const chunk of s3Resp.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const transcriptJson = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
      return reply.send(transcriptJson);
    },
  );

  // POST /api/recordings/:id/transcript/retry (admin+ only) — AC-14
  app.post(
    '/api/recordings/:id/transcript/retry',
    { preHandler: [app.requireAuth] },
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const auth = (req as FastifyRequest & { auth?: { tenantId: number; role: string } }).auth;
      if (!auth) return reply.code(401).send({ error: 'unauthorized' });

      // Require admin+ role
      if (!['admin', 'superadmin'].includes(auth.role)) {
        return reply.code(403).send({ error: 'admin_required' });
      }

      const recordingLogId = req.params.id;
      const tenantId = BigInt(auth.tenantId);
      const prisma = getPrisma();

      // Rate limit: 1 retry per recording per hour
      if (!checkRetryRateLimit(recordingLogId)) {
        return reply.code(429).send({ error: 'retry_rate_limited', retry_after_seconds: 3600 });
      }

      // Load recording
      const rows = await prisma.$queryRaw<
        Array<{
          id: bigint;
          uuid: string;
          storage_url: string | null;
          consent_status: string;
          duration_sec: number | null;
          tenant_id: bigint;
          transcript_status: string;
        }>
      >`
        SELECT id, uuid, storage_url, consent_status, duration_sec, tenant_id, transcript_status
        FROM recording_log
        WHERE id = ${BigInt(recordingLogId)} AND tenant_id = ${tenantId}
        LIMIT 1
      `;

      const rec = rows[0];
      if (!rec) return reply.code(404).send({ error: 'not_found' });
      if (!rec.storage_url) return reply.code(422).send({ error: 'recording_not_uploaded' });
      if (['prompted_declined', 'skipped'].includes(rec.consent_status)) {
        return reply.code(403).send({ error: 'transcript_consent_blocked' });
      }

      // Reset status to queued
      await prisma.$executeRaw`
        UPDATE recording_log
        SET transcript_status = 'queued',
            transcript_uri    = NULL,
            updated_at        = NOW()
        WHERE id = ${BigInt(recordingLogId)} AND tenant_id = ${tenantId}
      `;

      // Enqueue fresh job
      const connection = getTranscriptionQueueConnection();
      const transcriptionQueue = new Queue('transcription', { connection });
      try {
        const job = await transcriptionQueue.add(
          'transcription',
          {
            recordingLogId,
            callUuid: rec.uuid,
            tenantId: rec.tenant_id.toString(),
            storageUrl: rec.storage_url,
            consentStatus: rec.consent_status,
            durationSec: rec.duration_sec ?? 0,
          },
          {
            attempts: 6,
            backoff: { type: 'exponential', delay: 60_000 },
            removeOnComplete: 50,
            removeOnFail: 500,
          },
        );
        return reply.code(202).send({ jobId: job.id ?? recordingLogId, status: 'queued' });
      } finally {
        await transcriptionQueue.close();
      }
    },
  );
}
