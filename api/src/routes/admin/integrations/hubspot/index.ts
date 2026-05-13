// N04 — HubSpot integration: Fastify route registration
//
// Routes:
//   GET    /api/admin/integrations/hubspot                  integration:hs:configure
//   PATCH  /api/admin/integrations/hubspot                  integration:hs:configure
//   DELETE /api/admin/integrations/hubspot                  integration:hs:configure
//   GET    /api/admin/integrations/hubspot/oauth/start      integration:hs:configure
//   GET    /api/admin/integrations/hubspot/oauth/callback   (public — CSRF state)
//   POST   /api/admin/integrations/hubspot/sync             integration:hs:configure
//   GET    /api/admin/integrations/hubspot/sync/jobs        integration:hs:configure
//   GET    /api/admin/integrations/hubspot/sync/jobs/:id    integration:hs:configure
//   GET    /api/admin/integrations/hubspot/lists            integration:hs:configure
//   POST   /api/admin/integrations/hubspot/lists/:listId/import   integration:hs:configure
//   POST   /api/admin/integrations/hubspot/widget-token     integration:hs:click_to_dial

import { randomBytes, createHmac } from 'node:crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../../../../lib/prisma.js';
import { env } from '../../../../lib/env.js';
import { encrypt, decrypt } from '../../../../auth/encryption.js';
import { exchangeCode, fetchTokenInfo, buildAuthUrl, refreshAccessToken } from '../../../../integrations/hubspot/oauth.js';
import { HubspotClient } from '../../../../integrations/hubspot/hubspot-client.js';
import { fetchHubspotLists } from '../../../../integrations/hubspot/list-import.js';
import { Queue } from 'bullmq';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Redis = require('ioredis') as typeof import('ioredis').default;
import * as jose from 'jose';

const BASE = '/api/admin/integrations/hubspot';

// ---------------------------------------------------------------------------
// Auth helper
// ---------------------------------------------------------------------------
interface AuthContext {
  uid: number;
  tenantId: number;
  role: string;
  perms: Set<string>;
}
type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

function parseId(raw: unknown): bigint {
  const n = BigInt(String(raw));
  if (n <= 0n) throw Object.assign(new Error('Invalid id'), { statusCode: 400 });
  return n;
}

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------
const PatchSettingsSchema = z.object({
  syncIntervalMinutes: z.number().int().min(5).max(1440).optional(),
  syncMode: z.enum(['ALL_CONTACTS', 'LIST_ONLY']).optional(),
  includeRecordingUrl: z.boolean().optional(),
  syncOverwritesManual: z.boolean().optional(),
  statusMap: z.record(z.string()).optional(),
  dispositionMap: z.record(z.string()).optional(),
});

const PostSyncSchema = z.object({
  mode: z.enum(['FULL', 'INCREMENTAL']).default('INCREMENTAL'),
});

const ImportListSchema = z.object({
  vici2ListName: z.string().min(1).max(128),
  campaignId: z.number().int().positive().optional(),
  syncOngoing: z.boolean().default(false),
});

// ---------------------------------------------------------------------------
// Queue constants
// ---------------------------------------------------------------------------
const HUBSPOT_SYNC_QUEUE    = 'vici2:queue:hubspot-sync';
const HUBSPOT_WEBHOOK_QUEUE = 'vici2:queue:hubspot-webhook';

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------
const OAUTH_STATE_PREFIX = 'hs:oauth:state:';
const STATE_TTL_SEC = 600;

function getRedis() {
  const url = process.env.VALKEY_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379/0';
  return new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });
}

async function generateOAuthState(tenantId: number): Promise<string> {
  const nonce = randomBytes(16).toString('hex');
  const payload = JSON.stringify({ tenantId, nonce, exp: Date.now() + STATE_TTL_SEC * 1000 });
  const hmac = createHmac('sha256', env.hubspotClientSecret || 'dev-secret')
    .update(payload)
    .digest('hex');
  const state = Buffer.from(JSON.stringify({ payload, hmac })).toString('base64url');

  const redis = getRedis();
  try {
    await redis.set(`${OAUTH_STATE_PREFIX}${nonce}`, state, 'EX', STATE_TTL_SEC);
  } finally {
    redis.disconnect();
  }

  return state;
}

async function verifyOAuthState(state: string): Promise<{ tenantId: number; nonce: string } | null> {
  try {
    const { payload: payloadStr, hmac } = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
    const expectedHmac = createHmac('sha256', env.hubspotClientSecret || 'dev-secret')
      .update(payloadStr)
      .digest('hex');
    if (hmac !== expectedHmac) return null;

    const { tenantId, nonce, exp } = JSON.parse(payloadStr);
    if (Date.now() > exp) return null;

    const redis = getRedis();
    let stored: string | null;
    try {
      stored = await redis.get(`${OAUTH_STATE_PREFIX}${nonce}`);
      if (stored) await redis.del(`${OAUTH_STATE_PREFIX}${nonce}`);
    } finally {
      redis.disconnect();
    }

    if (stored !== state) return null;
    return { tenantId, nonce };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Encryption helpers for tokens
// ---------------------------------------------------------------------------
function encryptToken(token: string, rowId: bigint, tenantId: bigint, column: string) {
  return encrypt({ table: 'hubspot_integrations', column, rowId, tenantId, plaintext: token });
}

function decryptToken(blob: Uint8Array, rowId: bigint, tenantId: bigint, column: string): string {
  return decrypt({ table: 'hubspot_integrations', column, rowId, tenantId, ciphertextBlob: blob }).toString('utf-8');
}

// ---------------------------------------------------------------------------
// Status DTO (no tokens)
// ---------------------------------------------------------------------------
function toStatusDto(integration: Record<string, unknown>, recentJobs: unknown[] = []) {
  return {
    connected: integration.status === 'connected',
    portalId: String(integration.portalId),
    hubDomain: integration.hubDomain,
    status: integration.status,
    syncMode: integration.syncMode,
    syncIntervalMinutes: integration.syncIntervalMinutes,
    lastSyncAt: integration.lastSyncAt,
    lastSyncCursor: integration.lastSyncCursor,
    includeRecordingUrl: integration.includeRecordingUrl,
    syncOverwritesManual: integration.syncOverwritesManual,
    tokenExpiresAt: integration.tokenExpiresAt,
    rateLimitBackoffUntil: integration.rateLimitBackoffUntil,
    recentJobs,
  };
}

// ---------------------------------------------------------------------------
// Route registration
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerHubspotIntegrationRoutes(app: any): Promise<void> {
  const db = getPrisma();

  // -------------------------------------------------------------------------
  // GET /api/admin/integrations/hubspot — status
  // -------------------------------------------------------------------------
  app.get(
    BASE,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const integration = await (db as any).hubspotIntegration.findUnique({
        where: { tenantId, deletedAt: null },
      });

      if (!integration) {
        return reply.send({ connected: false, status: 'disconnected' });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const recentJobs = await (db as any).hubspotSyncJob.findMany({
        where: { integrationId: integration.id },
        orderBy: { startedAt: 'desc' },
        take: 5,
        select: {
          id: true, status: true, syncMode: true,
          contactsFetched: true, contactsUpserted: true,
          contactsFailed: true, startedAt: true, completedAt: true,
        },
      });

      return reply.send(toStatusDto(integration, recentJobs));
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/integrations/hubspot — update settings
  // -------------------------------------------------------------------------
  app.patch(
    BASE,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);

      const parsed = PatchSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'validation_error', message: parsed.error.message });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (db as any).hubspotIntegration.findUnique({
        where: { tenantId, deletedAt: null },
      });
      if (!existing) {
        return reply.code(404).send({ code: 'not_found', message: 'No HubSpot integration found' });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const updated = await (db as any).hubspotIntegration.update({
        where: { id: existing.id },
        data: {
          ...(parsed.data.syncIntervalMinutes !== undefined ? { syncIntervalMinutes: parsed.data.syncIntervalMinutes } : {}),
          ...(parsed.data.syncMode !== undefined ? { syncMode: parsed.data.syncMode } : {}),
          ...(parsed.data.includeRecordingUrl !== undefined ? { includeRecordingUrl: parsed.data.includeRecordingUrl } : {}),
          ...(parsed.data.syncOverwritesManual !== undefined ? { syncOverwritesManual: parsed.data.syncOverwritesManual } : {}),
          ...(parsed.data.statusMap !== undefined ? { statusMap: parsed.data.statusMap } : {}),
          ...(parsed.data.dispositionMap !== undefined ? { dispositionMap: parsed.data.dispositionMap } : {}),
        },
      });

      return reply.send(toStatusDto(updated));
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/admin/integrations/hubspot — disconnect
  // -------------------------------------------------------------------------
  app.delete(
    BASE,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const existing = await (db as any).hubspotIntegration.findUnique({
        where: { tenantId, deletedAt: null },
      });
      if (!existing) {
        return reply.code(404).send({ code: 'not_found', message: 'No HubSpot integration found' });
      }

      // Zero out tokens + soft-delete
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (db as any).hubspotIntegration.update({
        where: { id: existing.id },
        data: {
          status: 'disconnected',
          deletedAt: new Date(),
          accessTokenEnc: Buffer.alloc(0),
          refreshTokenEnc: Buffer.alloc(0),
        },
      });

      // Cancel repeatable BullMQ sync job
      try {
        const redis = getRedis();
        const queue = new Queue(HUBSPOT_SYNC_QUEUE, { connection: redis });
        await queue.removeRepeatableByKey(`hs-sync-${auth.tenantId}`);
        await queue.close();
        redis.disconnect();
      } catch {
        // Non-fatal: if queue is not running, ignore
      }

      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/integrations/hubspot/oauth/start — initiate OAuth flow
  // -------------------------------------------------------------------------
  app.get(
    `${BASE}/oauth/start`,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const state = await generateOAuthState(auth.tenantId);
      const authUrl = buildAuthUrl(state);
      return reply.code(302).redirect(authUrl);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/integrations/hubspot/oauth/callback — OAuth callback (public)
  // -------------------------------------------------------------------------
  app.get(
    `${BASE}/oauth/callback`,
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { code, state, error } = req.query as Record<string, string>;

      const adminBase = '/admin/integrations/hubspot';

      if (error || !code || !state) {
        return reply.code(302).redirect(`${adminBase}?status=error&reason=access_denied`);
      }

      const stateData = await verifyOAuthState(state);
      if (!stateData) {
        return reply.code(302).redirect(`${adminBase}?status=error&reason=csrf`);
      }

      const { tenantId } = stateData;

      try {
        // Exchange code for tokens
        const tokens = await exchangeCode(code);
        const tokenInfo = await fetchTokenInfo(tokens.access_token);

        // Ensure portal_id uniqueness across all tenants
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existingPortal = await (db as any).hubspotIntegration.findFirst({
          where: { portalId: BigInt(tokenInfo.hub_id), NOT: { tenantId: BigInt(tenantId) }, deletedAt: null },
        });
        if (existingPortal) {
          return reply.code(302).redirect(`${adminBase}?status=error&reason=portal_in_use`);
        }

        const tokenExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

        // Upsert integration row — we need the row ID for encryption AAD
        // First check if row exists
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let integration = await (db as any).hubspotIntegration.findUnique({
          where: { tenantId: BigInt(tenantId) },
        });

        if (!integration) {
          // Create a stub row to get the ID, then update with encrypted tokens
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          integration = await (db as any).hubspotIntegration.create({
            data: {
              tenantId: BigInt(tenantId),
              portalId: BigInt(tokenInfo.hub_id),
              hubDomain: tokenInfo.hub_domain,
              accessTokenEnc: Buffer.alloc(1),
              refreshTokenEnc: Buffer.alloc(1),
              kekVersion: 1,
              tokenExpiresAt,
              status: 'connected',
              deletedAt: null,
            },
          });
        }

        // Encrypt tokens with row ID in AAD
        const { ciphertextBlob: accessEnc, kekVersion } = encryptToken(
          tokens.access_token, integration.id, BigInt(tenantId), 'access_token_enc',
        );
        const { ciphertextBlob: refreshEnc } = encryptToken(
          tokens.refresh_token, integration.id, BigInt(tenantId), 'refresh_token_enc',
        );

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).hubspotIntegration.update({
          where: { id: integration.id },
          data: {
            portalId: BigInt(tokenInfo.hub_id),
            hubDomain: tokenInfo.hub_domain,
            accessTokenEnc: Buffer.from(accessEnc),
            refreshTokenEnc: Buffer.from(refreshEnc),
            kekVersion,
            tokenExpiresAt,
            status: 'connected',
            deletedAt: null,
          },
        });

        // Enqueue initial full sync
        try {
          const redis = getRedis();
          const queue = new Queue(HUBSPOT_SYNC_QUEUE, { connection: redis });
          await queue.add(
            'hubspot-sync',
            { tenantId, mode: 'FULL' },
            {
              attempts: 3,
              backoff: { type: 'exponential', delay: 30_000 },
            },
          );
          await queue.close();
          redis.disconnect();
        } catch {
          // Non-fatal: sync will pick up on next repeatable cycle
        }

        return reply.code(302).redirect(`${adminBase}?status=connected`);
      } catch (err) {
        req.log?.error({ err }, 'hubspot-oauth-callback: failed');
        return reply.code(302).redirect(`${adminBase}?status=error&reason=token_exchange_failed`);
      }
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/integrations/hubspot/sync — trigger manual sync
  // -------------------------------------------------------------------------
  app.post(
    `${BASE}/sync`,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);

      const parsed = PostSyncSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'validation_error', message: parsed.error.message });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const integration = await (db as any).hubspotIntegration.findUnique({
        where: { tenantId, deletedAt: null },
      });
      if (!integration) {
        return reply.code(404).send({ code: 'not_found', message: 'No HubSpot integration found' });
      }

      // Create DB sync job row
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const syncJob = await (db as any).hubspotSyncJob.create({
        data: {
          tenantId,
          integrationId: integration.id,
          status: 'running',
          syncMode: parsed.data.mode === 'FULL' ? 'ALL_CONTACTS' : integration.syncMode,
        },
      });

      // Enqueue BullMQ job
      let bullmqJobId: string | undefined;
      try {
        const redis = getRedis();
        const queue = new Queue(HUBSPOT_SYNC_QUEUE, { connection: redis });
        const job = await queue.add(
          'hubspot-sync',
          { tenantId: Number(tenantId), mode: parsed.data.mode, syncJobId: Number(syncJob.id) },
          { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
        );
        bullmqJobId = job.id;
        await queue.close();
        redis.disconnect();
      } catch {
        // Best-effort
      }

      if (bullmqJobId) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (db as any).hubspotSyncJob.update({
          where: { id: syncJob.id },
          data: { bullmqJobId },
        });
      }

      return reply.code(202).send({ jobId: bullmqJobId, syncJobId: String(syncJob.id) });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/integrations/hubspot/sync/jobs — job history
  // -------------------------------------------------------------------------
  app.get(
    `${BASE}/sync/jobs`,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const { limit = '20', offset = '0' } = req.query as Record<string, string>;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jobs = await (db as any).hubspotSyncJob.findMany({
        where: { tenantId },
        orderBy: { startedAt: 'desc' },
        take: Math.min(parseInt(limit, 10), 100),
        skip: parseInt(offset, 10),
      });

      return reply.send({ jobs });
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/integrations/hubspot/sync/jobs/:id
  // -------------------------------------------------------------------------
  app.get(
    `${BASE}/sync/jobs/:id`,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const params = req.params as { id: string };
      const id = parseId(params.id);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const job = await (db as any).hubspotSyncJob.findFirst({
        where: { id, tenantId },
      });

      if (!job) {
        return reply.code(404).send({ code: 'not_found', message: 'Sync job not found' });
      }

      return reply.send(job);
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/integrations/hubspot/lists — fetch HubSpot lists
  // -------------------------------------------------------------------------
  app.get(
    `${BASE}/lists`,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const integration = await (db as any).hubspotIntegration.findUnique({
        where: { tenantId, deletedAt: null },
      });
      if (!integration) {
        return reply.code(404).send({ code: 'not_found', message: 'No HubSpot integration found' });
      }

      const accessToken = decryptToken(
        integration.accessTokenEnc, integration.id, tenantId, 'access_token_enc',
      );

      const client = new HubspotClient({ accessToken });
      const lists = await fetchHubspotLists(client);

      return reply.send({ lists });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/integrations/hubspot/lists/:listId/import
  // -------------------------------------------------------------------------
  app.post(
    `${BASE}/lists/:listId/import`,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:configure')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const tenantId = BigInt(auth.tenantId);
      const { listId } = req.params as { listId: string };

      const parsed = ImportListSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: 'validation_error', message: parsed.error.message });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const integration = await (db as any).hubspotIntegration.findUnique({
        where: { tenantId, deletedAt: null },
      });
      if (!integration) {
        return reply.code(404).send({ code: 'not_found', message: 'No HubSpot integration found' });
      }

      // Create a vici2 list row for the HubSpot list
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const list = await (db as any).list.create({
        data: {
          tenantId,
          name: parsed.data.vici2ListName,
          source: 'hubspot',
          settings: { hs_list_id: listId, sync_ongoing: parsed.data.syncOngoing },
        },
      }).catch(() => null);

      if (!list) {
        return reply.code(500).send({ code: 'internal_error', message: 'Failed to create list' });
      }

      // Enqueue list import job via hubspot-sync queue
      let bullmqJobId: string | undefined;
      try {
        const redis = getRedis();
        const queue = new Queue(HUBSPOT_SYNC_QUEUE, { connection: redis });
        const job = await queue.add(
          'hubspot-list-import',
          {
            tenantId: Number(tenantId),
            hsListId: listId,
            vici2ListId: Number(list.id),
            syncOngoing: parsed.data.syncOngoing,
          },
          { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } },
        );
        bullmqJobId = job.id;
        await queue.close();
        redis.disconnect();
      } catch {
        // Best-effort
      }

      return reply.code(202).send({ listId: String(list.id), bullmqJobId });
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/integrations/hubspot/widget-token — issue widget JWT
  // -------------------------------------------------------------------------
  app.post(
    `${BASE}/widget-token`,
    { preHandler: [app.requireAuth, app.requirePermission('integration:hs:click_to_dial')] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);

      // Sign a short-lived widget token
      const secret = new TextEncoder().encode(
        process.env.VICI2_JWT_SECRET ?? process.env.JWT_SECRET ?? 'dev-secret-change-me',
      );

      const expiresIn = 3600; // 1 hour
      const token = await new jose.SignJWT({
        tenant_id: auth.tenantId,
        user_id: auth.uid,
        aud: 'hs-widget',
      })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuedAt()
        .setExpirationTime(`${expiresIn}s`)
        .sign(secret);

      const baseUrl = process.env.VICI2_PUBLIC_URL ?? `http://localhost:${env.port}`;
      const url = `${baseUrl}/hubspot-calling?tid=${auth.tenantId}&token=${token}`;

      return reply.send({ token, url, expiresIn });
    },
  );
}
