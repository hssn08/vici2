// N03 — SF Integration service: OAuth flow, config CRUD.

import crypto from 'node:crypto';
import pino from 'pino';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import { getPrisma } from '../../../lib/prisma.js';
import { audit, type AuditAction } from '../../../auth/audit.js';
import type { AuthContext } from '../../../auth/middleware.js';
import {
  encryptSfToken,
  decryptSfToken,
  defaultSfHttpClient,
  type SfHttpClient,
} from './token-store.js';
import {
  ConnectBodySchema,
  PatchConfigBodySchema,
  SfFieldMappingsSchema,
  type GetConfigResponse,
} from './schema.js';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'n03' } });

// CSRF state token TTL (10 minutes in seconds stored in Redis via a simple DB row)
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as FastifyRequest & { auth?: AuthContext }).auth;
  if (!auth) throw new Error('Unauthenticated');
  return auth;
}

function toResponse(row: {
  id: bigint;
  tenantId: bigint;
  enabled: boolean;
  instanceUrl: string | null;
  clientId: string | null;
  clientSecret: Uint8Array | null;
  accessToken: Uint8Array | null;
  refreshToken: Uint8Array | null;
  tokenExpiry: Date | null;
  fieldMappings: unknown;
  lastWritebackAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}): GetConfigResponse {
  return {
    id: row.id.toString(),
    tenantId: row.tenantId.toString(),
    enabled: row.enabled,
    instanceUrl: row.instanceUrl,
    clientId: row.clientId,
    hasSecret: row.clientSecret !== null,
    hasTokens: row.accessToken !== null && row.refreshToken !== null,
    tokenExpiry: row.tokenExpiry?.toISOString() ?? null,
    fieldMappings: SfFieldMappingsSchema.parse(row.fieldMappings ?? {}),
    lastWritebackAt: row.lastWritebackAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class SfIntegrationService {
  private readonly httpClient: SfHttpClient;

  constructor(
    _app: FastifyInstance,
    httpClient: SfHttpClient = defaultSfHttpClient,
  ) {
    this.httpClient = httpClient;
  }

  // GET /api/admin/sf-integration
  async getConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = getAuth(req);
    const tenantId = BigInt(auth.tenantId);
    const db = getPrisma();

    const row = await db.sfIntegration.findUnique({ where: { tenantId } });
    if (!row) {
      // Return a default (not-configured) response
      const now = new Date();
      return reply.send({
        id: '0',
        tenantId: tenantId.toString(),
        enabled: false,
        instanceUrl: null,
        clientId: null,
        hasSecret: false,
        hasTokens: false,
        tokenExpiry: null,
        fieldMappings: {},
        lastWritebackAt: null,
        lastError: null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
    }

    return reply.send(toResponse(row));
  }

  // PATCH /api/admin/sf-integration
  async patchConfig(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = getAuth(req);
    const tenantId = BigInt(auth.tenantId);
    const db = getPrisma();

    const parsed = PatchConfigBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'validation_error', message: parsed.error.message });
    }
    const { enabled, fieldMappings } = parsed.data;

    const row = await db.sfIntegration.upsert({
      where: { tenantId },
      create: {
        tenantId,
        enabled: enabled ?? false,
        fieldMappings: (fieldMappings as object) ?? {},
      },
      update: {
        ...(enabled !== undefined ? { enabled } : {}),
        ...(fieldMappings !== undefined ? { fieldMappings: fieldMappings as object } : {}),
      },
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      tenantId: auth.tenantId,
      action: 'sf_integration.patched' as AuditAction,
      entityType: 'sf_integration',
      entityId: row.id.toString(),
      afterJson: { enabled, hasFieldMappings: fieldMappings !== undefined },
    });

    return reply.send(toResponse(row));
  }

  // POST /api/admin/sf-integration/connect
  async initiateOAuth(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = getAuth(req);
    const tenantId = BigInt(auth.tenantId);
    const db = getPrisma();

    const parsed = ConnectBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ code: 'validation_error', message: parsed.error.message });
    }
    const { instanceUrl, clientId, clientSecret } = parsed.data;

    // Upsert the integration row so we have an id for encryption AAD
    const row = await db.sfIntegration.upsert({
      where: { tenantId },
      create: { tenantId, enabled: false, clientId, fieldMappings: {} },
      update: { clientId },
    });

    // Encrypt and store the client secret
    const encryptedSecret = Buffer.from(encryptSfToken({
      column: 'client_secret',
      rowId: row.id,
      tenantId,
      plaintext: clientSecret,
    }));

    await db.sfIntegration.update({
      where: { tenantId },
      data: {
        instanceUrl,
        clientSecret: encryptedSecret,
        // Clear old tokens when reconnecting
        accessToken: null,
        refreshToken: null,
        tokenExpiry: null,
        lastError: null,
      },
    });

    // Generate CSRF state: HMAC-SHA256(secret, tenantId + timestamp)
    const stateRandom = crypto.randomBytes(16).toString('hex');
    const statePayload = `${tenantId}:${Date.now()}:${stateRandom}`;
    const stateToken = crypto
      .createHmac('sha256', process.env.SF_OAUTH_STATE_SECRET ?? 'vici2-sf-state-secret')
      .update(statePayload)
      .digest('hex');
    const state = Buffer.from(JSON.stringify({ tenantId: tenantId.toString(), ts: Date.now(), random: stateRandom, sig: stateToken })).toString('base64url');

    // Store state in DB with TTL-tracked metadata (Phase 1: store in sfIntegration lastError field temporarily — no Redis needed)
    await db.sfIntegration.update({
      where: { tenantId },
      data: { lastError: `oauth_state:${state}:${Date.now() + OAUTH_STATE_TTL_MS}` },
    });

    const redirectUri = encodeURIComponent(
      `${process.env.API_BASE_URL ?? 'https://api.vici2.example.com'}/admin/sf-integration/oauth/callback`,
    );
    const authUrl =
      `${instanceUrl}/services/oauth2/authorize` +
      `?response_type=code` +
      `&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${redirectUri}` +
      `&state=${encodeURIComponent(state)}`;

    logger.info({ tenantId: tenantId.toString() }, 'SF OAuth flow initiated');
    return reply.send({ authUrl });
  }

  // GET /admin/sf-integration/oauth/callback
  async oauthCallback(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const db = getPrisma();
    const query = req.query as Record<string, string>;
    const { code, state, error, error_description } = query;

    const adminUiBase = process.env.WEB_BASE_URL ?? 'https://app.vici2.example.com';

    if (error) {
      logger.warn({ error, error_description }, 'SF OAuth callback error');
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=${encodeURIComponent(error)}`);
    }

    if (!code || !state) {
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=missing_params`);
    }

    // Decode and validate state
    let stateObj: { tenantId: string; ts: number; random: string; sig: string };
    try {
      stateObj = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
    } catch {
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=invalid_state`);
    }

    const tenantId = BigInt(stateObj.tenantId);
    const row = await db.sfIntegration.findUnique({ where: { tenantId } });
    if (!row) {
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=tenant_not_found`);
    }

    // Verify state sig and TTL
    const expectedSig = crypto
      .createHmac('sha256', process.env.SF_OAUTH_STATE_SECRET ?? 'vici2-sf-state-secret')
      .update(`${stateObj.tenantId}:${stateObj.ts}:${stateObj.random}`)
      .digest('hex');
    if (expectedSig !== stateObj.sig) {
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=invalid_state_sig`);
    }

    // Check expiry (stored in lastError field as oauth_state:<state>:<expiry>)
    const storedMeta = row.lastError ?? '';
    const metaParts = storedMeta.split(':');
    if (metaParts[0] !== 'oauth_state') {
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=state_not_found`);
    }
    const expiry = parseInt(metaParts[metaParts.length - 1] ?? '0', 10);
    if (Date.now() > expiry) {
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=state_expired`);
    }

    // Exchange code for tokens
    const clientSecret = decryptSfToken({
      column: 'client_secret',
      rowId: row.id,
      tenantId,
      ciphertextBlob: row.clientSecret!,
    });

    const redirectUri = `${process.env.API_BASE_URL ?? 'https://api.vici2.example.com'}/admin/sf-integration/oauth/callback`;
    const tokenBody = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: row.clientId!,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    });

    let tokenData;
    try {
      tokenData = await this.httpClient.tokenRequest(row.instanceUrl!, tokenBody);
    } catch (err) {
      logger.error({ err }, 'SF token exchange HTTP error');
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=token_exchange_failed`);
    }

    if (!tokenData.access_token) {
      logger.warn({ error: tokenData.error }, 'SF token exchange returned no access_token');
      return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?error=${encodeURIComponent(tokenData.error ?? 'no_token')}`);
    }

    const newExpiry = new Date(Date.now() + (tokenData.expires_in ?? 7200) * 1000);
    const instanceUrl = tokenData.instance_url ?? row.instanceUrl!;

    const encAccessToken = Buffer.from(encryptSfToken({
      column: 'access_token',
      rowId: row.id,
      tenantId,
      plaintext: tokenData.access_token,
    }));

    const encRefreshToken = tokenData.refresh_token
      ? Buffer.from(encryptSfToken({
          column: 'refresh_token',
          rowId: row.id,
          tenantId,
          plaintext: tokenData.refresh_token,
        }))
      : undefined;

    await db.sfIntegration.update({
      where: { tenantId },
      data: {
        instanceUrl,
        accessToken: encAccessToken,
        ...(encRefreshToken ? { refreshToken: encRefreshToken } : {}),
        tokenExpiry: newExpiry,
        enabled: true,
        lastError: null,
      },
    });

    logger.info({ tenantId: tenantId.toString() }, 'SF OAuth complete — tokens stored');
    return reply.redirect(`${adminUiBase}/admin/settings/sf-integration?connected=1`);
  }

  // DELETE /api/admin/sf-integration/disconnect
  async disconnect(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    const auth = getAuth(req);
    const tenantId = BigInt(auth.tenantId);
    const db = getPrisma();

    const row = await db.sfIntegration.findUnique({ where: { tenantId } });
    if (!row) {
      return reply.send({ ok: true });
    }

    // Best-effort revoke access token
    if (row.accessToken && row.instanceUrl) {
      try {
        const token = decryptSfToken({
          column: 'access_token',
          rowId: row.id,
          tenantId,
          ciphertextBlob: row.accessToken,
        });
        await this.httpClient.revokeToken(row.instanceUrl, token);
      } catch (err) {
        logger.warn({ err }, 'SF token revocation failed (continuing disconnect)');
      }
    }

    await db.sfIntegration.update({
      where: { tenantId },
      data: {
        enabled: false,
        accessToken: null,
        refreshToken: null,
        tokenExpiry: null,
        lastError: null,
      },
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      tenantId: auth.tenantId,
      action: 'sf_integration.disconnected' as AuditAction,
      entityType: 'sf_integration',
      entityId: row.id.toString(),
    });

    return reply.send({ ok: true });
  }
}
