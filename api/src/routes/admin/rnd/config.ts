/**
 * api/src/routes/admin/rnd/config.ts
 *
 * N06 — GET/PUT /api/admin/rnd/config
 * Read and update tenant RND credentials + settings.
 *
 * Permission: rnd:configure
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../../../lib/prisma.js';
import { getRedis } from '../../../lib/redis.js';
import { encrypt } from '../../../auth/encryption.js';
import { buildRndClient, RndCredentialInvalidError } from '../../../integrations/rnd/client.js';

type AuthReq = FastifyRequest & {
  auth?: { uid: number; tenantId: number; role: string };
};

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

const ConfigUpdateSchema = z.object({
  client_id: z.string().min(1).max(255).optional(),
  client_secret: z.string().min(1).max(255).optional(),
  tier: z.enum(['xs', 'small', 'medium', 'large', 'xl', 'jumbo']).optional(),
  monthly_budget_cents: z.number().int().positive().nullable().optional(),
  auto_scrub_on_launch: z.boolean().optional(),
  rescrub_interval_days: z.number().int().min(1).max(90).optional(),
  no_data_policy: z.enum(['safe', 'block']).optional(),
  use_reassigned_dnc: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// GET /api/admin/rnd/config
// ---------------------------------------------------------------------------

export async function handleGetConfig(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = getAuth(req);
  const tenantId = BigInt(auth.tenantId);
  const db = getPrisma();

  const config = await db.tenantRndConfig.findUnique({ where: { tenantId } });
  if (!config) {
    return reply.code(404).send({ error: 'rnd_not_configured' });
  }

  return reply.code(200).send({
    client_id: config.clientId,
    client_secret: '****',  // never return plaintext
    tier: config.tier,
    monthly_budget_cents: config.monthlyBudgetCents,
    auto_scrub_on_launch: config.autoScrubOnLaunch,
    rescrub_interval_days: config.rescrubIntervalDays,
    no_data_policy: config.noDataPolicy,
    use_reassigned_dnc: config.useReassignedDnc,
    is_active: config.isActive,
    created_at: config.createdAt.toISOString(),
    updated_at: config.updatedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// PUT /api/admin/rnd/config
// ---------------------------------------------------------------------------

export async function handleUpdateConfig(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = getAuth(req);
  const tenantId = BigInt(auth.tenantId);
  const db = getPrisma();

  const parsed = ConfigUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
  }
  const body = parsed.data;

  const existing = await db.tenantRndConfig.findUnique({ where: { tenantId } });

  // Determine effective credentials
  const effectiveClientId = body.client_id ?? existing?.clientId ?? '';

  // Validate credentials if changed
  const credentialsChanged = body.client_id !== undefined || body.client_secret !== undefined;
  if (credentialsChanged && effectiveClientId && body.client_secret) {
    try {
      const redis = getRedis();
      const testClient = buildRndClient({
        tenantId,
        clientId: effectiveClientId,
        clientSecret: body.client_secret,
        redis,
      });
      await testClient.validateCredentials();
    } catch (err) {
      if (err instanceof RndCredentialInvalidError) {
        return reply.code(422).send({ error: 'credential_invalid', message: err.message });
      }
      // Outage / network error — don't reject, save credentials optimistically
    }
  }

  // Encrypt client secret if provided
  let encResult: { ciphertextBlob: Uint8Array } | null = null;
  if (body.client_secret) {
    encResult = encrypt({
      table: 'tenant_rnd_config',
      column: 'client_secret_enc',
      rowId: tenantId,
      tenantId,
      plaintext: body.client_secret,
    });
  }

  // Track changed fields for audit (exclude secret)
  const changedFields: string[] = [];
  if (body.client_id !== undefined) changedFields.push('client_id');
  if (body.client_secret !== undefined) changedFields.push('client_secret');
  if (body.tier !== undefined) changedFields.push('tier');
  if (body.monthly_budget_cents !== undefined) changedFields.push('monthly_budget_cents');
  if (body.auto_scrub_on_launch !== undefined) changedFields.push('auto_scrub_on_launch');
  if (body.rescrub_interval_days !== undefined) changedFields.push('rescrub_interval_days');
  if (body.no_data_policy !== undefined) changedFields.push('no_data_policy');
  if (body.use_reassigned_dnc !== undefined) changedFields.push('use_reassigned_dnc');

  // Build update/create data
  const data: Parameters<typeof db.tenantRndConfig.upsert>[0] = {
    where: { tenantId },
    create: {
      tenantId,
      clientId: effectiveClientId,
      clientSecretEnc: encResult ? Buffer.from(encResult.ciphertextBlob) : Buffer.alloc(0),
      clientSecretIv: Buffer.alloc(16), // IV is embedded in ciphertextBlob (F05 layout)
      tier: body.tier ?? 'xs',
      monthlyBudgetCents: body.monthly_budget_cents ?? null,
      autoScrubOnLaunch: body.auto_scrub_on_launch ?? true,
      rescrubIntervalDays: body.rescrub_interval_days ?? 55,
      noDataPolicy: body.no_data_policy ?? 'safe',
      useReassignedDnc: body.use_reassigned_dnc ?? true,
      isActive: credentialsChanged && body.client_secret ? true : false,
    },
    update: {
      ...(body.client_id !== undefined ? { clientId: body.client_id } : {}),
      ...(encResult ? {
        clientSecretEnc: Buffer.from(encResult.ciphertextBlob),
        clientSecretIv: Buffer.alloc(16),
      } : {}),
      ...(body.tier !== undefined ? { tier: body.tier } : {}),
      ...(body.monthly_budget_cents !== undefined ? { monthlyBudgetCents: body.monthly_budget_cents } : {}),
      ...(body.auto_scrub_on_launch !== undefined ? { autoScrubOnLaunch: body.auto_scrub_on_launch } : {}),
      ...(body.rescrub_interval_days !== undefined ? { rescrubIntervalDays: body.rescrub_interval_days } : {}),
      ...(body.no_data_policy !== undefined ? { noDataPolicy: body.no_data_policy } : {}),
      ...(body.use_reassigned_dnc !== undefined ? { useReassignedDnc: body.use_reassigned_dnc } : {}),
      // Auto-activate if new credentials provided and validated
      ...(credentialsChanged && body.client_secret ? { isActive: true } : {}),
    },
  };

  const result = await db.tenantRndConfig.upsert(data);

  // Audit
  await db.$executeRaw`
    INSERT INTO audit_log
      (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id, after_json, ts)
    VALUES (
      ${tenantId}, ${BigInt(auth.uid)}, 'user', 'rnd.config.updated',
      'tenant_rnd_config', ${String(tenantId)},
      ${JSON.stringify({ changed_fields: changedFields, user_id: auth.uid })},
      NOW(6)
    )
  `;

  return reply.code(200).send({
    client_id: result.clientId,
    client_secret: '****',
    tier: result.tier,
    monthly_budget_cents: result.monthlyBudgetCents,
    auto_scrub_on_launch: result.autoScrubOnLaunch,
    rescrub_interval_days: result.rescrubIntervalDays,
    no_data_policy: result.noDataPolicy,
    use_reassigned_dnc: result.useReassignedDnc,
    is_active: result.isActive,
  });
}
