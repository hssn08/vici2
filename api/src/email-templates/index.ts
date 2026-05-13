// N02 — Email templates Fastify plugin.
// Registers all email-template routes + public unsubscribe endpoint.

import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import pino from 'pino';
import type { AuthContext } from '../auth/middleware.js';
import { audit } from '../auth/audit.js';
import { getPrisma } from '../lib/prisma.js';
import {
  listTemplates,
  getTemplate,
  createTemplate,
  patchTemplate,
  deleteTemplate,
  getTemplateVersions,
  previewRender,
} from './service.js';
import { verifyUnsubscribeToken } from './unsubscribe.js';
import { CATEGORY_VARS } from './variables.js';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'n02' },
});

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error('Unauthenticated');
  return auth;
}

function parseId(raw: unknown): bigint {
  const n = BigInt(String(raw));
  if (n <= 0n) throw new Error('Invalid id');
  return n;
}

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const CreateSchema = z.object({
  category: z.string().min(1).max(64),
  lang: z.string().max(10).optional(),
  subject: z.string().min(1).max(255),
  htmlBody: z.string().min(1),
  textBody: z.string().optional(),
});

const PatchSchema = z
  .object({
    subject: z.string().min(1).max(255).optional(),
    htmlBody: z.string().optional(),
    textBody: z.string().optional(),
    active: z.boolean().optional(),
  })
  .strict();

const PreviewSchema = z.object({
  sample_vars: z.record(z.unknown()).default({}),
});

const TestSendSchema = z.object({
  to: z.string().email(),
  sample_vars: z.record(z.unknown()).default({}),
});

// ---------------------------------------------------------------------------
// Rate limit helpers (Valkey counter)
// ---------------------------------------------------------------------------

const TEST_SEND_RATE_LIMIT = parseInt(
  process.env.VICI2_N02_TEST_SEND_RATE_LIMIT ?? '5',
  10,
);

async function checkTestSendRateLimit(
   
  redis: { incr: (k: string) => Promise<number>; expire: (k: string, s: number) => Promise<number> },
  tenantId: number,
  userId: number,
): Promise<boolean> {
  const key = `t:${tenantId}:n02:test_send_rate:${userId}`;
  const count = await redis.incr(key);
  if (count === 1) {
    await redis.expire(key, 3600);
  }
  return count <= TEST_SEND_RATE_LIMIT;
}

// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------

export async function registerEmailTemplateRoutes(
  app: FastifyInstance,
): Promise<void> {
  const prisma = getPrisma();

  // ---- GET /api/admin/email-templates ----
  app.get(
    '/api/admin/email-templates',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:read')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const query = req.query as { category?: string; lang?: string; active?: string };

      const activeQuery = query.active;
      let active: boolean | 'all';
      if (activeQuery === 'all') active = 'all';
      else if (activeQuery === 'false') active = false;
      else active = true;

      const result = await listTemplates(prisma, tenantId, {
        category: query.category,
        lang: query.lang,
        active,
      });
      return reply.send(result);
    },
  );

  // ---- POST /api/admin/email-templates ----
  app.post(
    '/api/admin/email-templates',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:edit')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const parsed = CreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      try {
        const dto = await createTemplate(prisma, { ...parsed.data, tenantId });
        await audit({
          tx: prisma,
          actorUserId: BigInt(auth.uid),
          actorKind: 'user',
          action: 'email_template.created',
          tenantId,
          entityType: 'email_template',
          entityId: dto.id,
          afterJson: { category: dto.category, lang: dto.lang, subject: dto.subject, version: dto.version },
          requestId: req.id,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
        });
        return reply.status(201).send(dto);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.message.includes('Unique constraint')
        ) {
          return reply
            .status(409)
            .send({ error: 'conflict', message: 'Template already exists for this category+lang' });
        }
        throw err;
      }
    },
  );

  // ---- GET /api/admin/email-templates/vars/:category — variable vocabulary ----
  // Must be registered BEFORE /:id to avoid param conflict
  app.get(
    '/api/admin/email-templates/vars/:category',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:read')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const params = req.params as { category: string };
      const vars = CATEGORY_VARS[params.category];
      if (!vars) return reply.status(404).send({ error: 'unknown_category' });
      return reply.send({ category: params.category, vars });
    },
  );

  // ---- GET /api/admin/email-templates/:id ----
  app.get(
    '/api/admin/email-templates/:id',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:read')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch { return reply.status(400).send({ error: 'invalid_id' }); }

      const dto = await getTemplate(prisma, tenantId, id);
      if (!dto) return reply.status(404).send({ error: 'not_found' });
      return reply.send(dto);
    },
  );

  // ---- PATCH /api/admin/email-templates/:id ----
  app.patch(
    '/api/admin/email-templates/:id',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:edit')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch { return reply.status(400).send({ error: 'invalid_id' }); }

      const parsed = PatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      const before = await getTemplate(prisma, tenantId, id);
      if (!before) return reply.status(404).send({ error: 'not_found' });

      const dto = await patchTemplate(prisma, tenantId, id, parsed.data);
      if (!dto) return reply.status(404).send({ error: 'not_found' });

      await audit({
        tx: prisma,
        actorUserId: BigInt(auth.uid),
        actorKind: 'user',
        action: 'email_template.updated',
        tenantId,
        entityType: 'email_template',
        entityId: dto.id,
        beforeJson: { subject: before.subject, version: before.version },
        afterJson: { subject: dto.subject, version: dto.version },
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return reply.send(dto);
    },
  );

  // ---- DELETE /api/admin/email-templates/:id ----
  app.delete(
    '/api/admin/email-templates/:id',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:edit')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch { return reply.status(400).send({ error: 'invalid_id' }); }

      const before = await getTemplate(prisma, tenantId, id);
      if (!before) return reply.status(404).send({ error: 'not_found' });

      const deleted = await deleteTemplate(prisma, tenantId, id);
      if (!deleted) return reply.status(404).send({ error: 'not_found' });

      await audit({
        tx: prisma,
        actorUserId: BigInt(auth.uid),
        actorKind: 'user',
        action: 'email_template.deleted',
        tenantId,
        entityType: 'email_template',
        entityId: String(id),
        beforeJson: { category: before.category, lang: before.lang, active: true },
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return reply.status(204).send();
    },
  );

  // ---- POST /api/admin/email-templates/:id/preview ----
  app.post(
    '/api/admin/email-templates/:id/preview',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:read')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch { return reply.status(400).send({ error: 'invalid_id' }); }

      const parsed = PreviewSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      const template = await getTemplate(prisma, tenantId, id);
      if (!template) return reply.status(404).send({ error: 'not_found' });

      const result = previewRender(
        template.subject,
        template.htmlBody,
        template.textBody,
        parsed.data.sample_vars,
      );

      return reply.send(result);
    },
  );

  // ---- POST /api/admin/email-templates/:id/test-send ----
  app.post(
    '/api/admin/email-templates/:id/test-send',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:edit')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch { return reply.status(400).send({ error: 'invalid_id' }); }

      const parsed = TestSendSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'validation_error', details: parsed.error.issues });
      }

      // Rate-limit check
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redis = (app as any).redis;
      if (redis) {
        const allowed = await checkTestSendRateLimit(redis, auth.tenantId, auth.uid);
        if (!allowed) {
          return reply.status(429).send({
            error: 'rate_limited',
            message: `Test send limited to ${TEST_SEND_RATE_LIMIT} per hour per user`,
          });
        }
      }

      const template = await getTemplate(prisma, tenantId, id);
      if (!template) return reply.status(404).send({ error: 'not_found' });

      const preview = previewRender(
        template.subject,
        template.htmlBody,
        template.textBody,
        parsed.data.sample_vars,
      );

      // Enqueue BullMQ job
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const emailQueue = (app as any).emailQueue;
      let jobId = 'no-queue';
      if (emailQueue) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const job = await (emailQueue as any).add(
          'email-delivery',
          {
            notificationId: `test-${Date.now()}`,
            tenantId: String(tenantId),
            userId: String(auth.uid),
            to: parsed.data.to,
            subject: preview.subject,
            body: preview.text,
            category: template.category,
            vars: parsed.data.sample_vars,
            userPreferredLang: 'en',
            isTestSend: true,
          },
          {
            attempts: 1,
            removeOnComplete: 10,
            removeOnFail: 50,
          },
        );
         
        jobId = (job as { id?: string }).id ?? 'unknown';
      }

      await audit({
        tx: prisma,
        actorUserId: BigInt(auth.uid),
        actorKind: 'user',
        action: 'email_template.test_sent',
        tenantId,
        entityType: 'email_template',
        entityId: String(id),
        afterJson: { to: parsed.data.to, category: template.category, lang: template.lang },
        requestId: req.id,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      return reply.status(202).send({ queued: true, jobId });
    },
  );

  // ---- GET /api/admin/email-templates/:id/versions ----
  app.get(
    '/api/admin/email-templates/:id/versions',
    { preHandler: [app.requireAuth, app.requirePermission('email_templates:read')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const params = req.params as { id: string };
      let id: bigint;
      try { id = parseId(params.id); } catch { return reply.status(400).send({ error: 'invalid_id' }); }

      const template = await getTemplate(prisma, tenantId, id);
      if (!template) return reply.status(404).send({ error: 'not_found' });

      const versions = await getTemplateVersions(prisma, tenantId, id);
      return reply.send({ versions });
    },
  );

  // ---- GET /api/notifications/unsubscribe?token=<token> (PUBLIC) ----
  app.get(
    '/api/notifications/unsubscribe',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as { token?: string };
      const token = query.token;
      if (!token) {
        return reply.status(400).send({ error: 'missing_token' });
      }

      const payload = verifyUnsubscribeToken(token);
      if (!payload) {
        return reply
          .status(400)
          .type('text/html')
          .send('<html><body><h1>Invalid or expired unsubscribe link.</h1><p>This link may have expired or is invalid. Please log in to manage your notification preferences.</p></body></html>');
      }

      try {
        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
          select: { tenantId: true },
        });

        if (!user) {
          return reply.status(400).type('text/html').send('<html><body><h1>User not found.</h1></body></html>');
        }

        await prisma.notificationPref.upsert({
          where: {
            tenantId_userId_category: {
              tenantId: user.tenantId,
              userId: payload.userId,
              category: payload.category,
            },
          },
          create: {
            tenantId: user.tenantId,
            userId: payload.userId,
            category: payload.category,
            channels: ['in_app'],
          },
          update: { channels: ['in_app'] },
        });

        await audit({
          tx: prisma,
          actorUserId: payload.userId,
          actorKind: 'user',
          action: 'notification_prefs.email_unsubscribed',
          tenantId: user.tenantId,
          entityType: 'notification_pref',
          entityId: String(payload.userId),
          afterJson: { category: payload.category, channels: ['in_app'] },
        });

        logger.info({ userId: String(payload.userId), category: payload.category }, 'n02: unsubscribed from email');

        const categoryLabel = payload.category.replace(/_/g, ' ');
        return reply
          .status(200)
          .type('text/html')
          .send(
            `<html><body style="font-family:sans-serif;max-width:600px;margin:2rem auto;padding:1rem">
<h1>Unsubscribed</h1>
<p>You have been unsubscribed from <strong>${categoryLabel}</strong> email notifications.</p>
<p>To manage all your notification preferences, please <a href="${process.env.VICI2_APP_BASE_URL ?? ''}/settings/notifications">log in to your account</a>.</p>
</body></html>`,
          );
      } catch (err) {
        logger.error({ err }, 'n02: unsubscribe handler error');
        return reply.status(500).type('text/html').send('<html><body><h1>An error occurred. Please try again later.</h1></body></html>');
      }
    },
  );
}
