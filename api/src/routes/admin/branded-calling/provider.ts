// N05 — Branded Calling provider CRUD handlers.
// Endpoints: GET/POST/PATCH/DELETE /api/admin/branded-calling/:provider
// Permission: branded_calling:configure

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '../../../lib/prisma.js';
import { encrypt } from '../../../auth/encryption.js';
import { audit } from '../../../auth/audit.js';
import { ProviderRegistry } from '../../../integrations/branded-calling/registry.js';
import { ConfigureProviderSchema, UpdateProviderSchema, PROVIDER_KINDS } from './schemas.js';
import type { ProviderKind } from '../../../integrations/branded-calling/types.js';

type AuthReq = FastifyRequest & { auth?: { uid: number; tenantId: number } };

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

function validateProvider(raw: string): ProviderKind {
  if (!(PROVIDER_KINDS as readonly string[]).includes(raw)) {
    throw Object.assign(new Error('Invalid provider'), { statusCode: 400 });
  }
  return raw as ProviderKind;
}

// ---------------------------------------------------------------------------
// GET /api/admin/branded-calling — list all configured providers for tenant
// ---------------------------------------------------------------------------

export async function handleListProviders(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const db = getPrisma();

  const rows = await db.brandedCallingProvider.findMany({
    where: { tenantId: BigInt(auth.tenantId), active: true },
    select: {
      id: true, provider: true, brandName: true, logoUrl: true,
      vertical: true, callReasons: true, providerBrandId: true,
      brandStatus: true, brandSyncedAt: true, createdAt: true, updatedAt: true,
    },
    orderBy: { provider: 'asc' },
  });

  return reply.code(200).send({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: rows.map((r: any) => ({
      id: String(r.id),
      provider: r.provider,
      brandName: r.brandName,
      logoUrl: r.logoUrl,
      vertical: r.vertical,
      callReasons: r.callReasons,
      credentials: { configured: true },
      providerBrandId: r.providerBrandId,
      brandStatus: r.brandStatus,
      brandSyncedAt: r.brandSyncedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  });
}

// ---------------------------------------------------------------------------
// GET /api/admin/branded-calling/:provider
// ---------------------------------------------------------------------------

export async function handleGetProvider(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string };
  const provider = validateProvider(params.provider);
  const db = getPrisma();

  const row = await db.brandedCallingProvider.findFirst({
    where: { tenantId: BigInt(auth.tenantId), provider, active: true },
    select: {
      id: true, provider: true, brandName: true, logoUrl: true,
      vertical: true, callReasons: true, providerBrandId: true,
      brandStatus: true, brandSyncedAt: true, createdAt: true, updatedAt: true,
    },
  });

  if (!row) return reply.code(404).send({ error: 'not_configured' });

  return reply.code(200).send({
    id: String(row.id),
    provider: row.provider,
    brandName: row.brandName,
    logoUrl: row.logoUrl,
    vertical: row.vertical,
    callReasons: row.callReasons,
    credentials: { configured: true }, // never return raw creds
    providerBrandId: row.providerBrandId,
    brandStatus: row.brandStatus,
    brandSyncedAt: row.brandSyncedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/branded-calling/:provider — create/configure provider
// ---------------------------------------------------------------------------

export async function handleConfigureProvider(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string };
  const provider = validateProvider(params.provider);

  const parsed = ConfigureProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(422).send({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const {
    credentials, brandName, logoUrl, vertical, callReasons,
    website: _website, contactEmail: _contactEmail, // Phase 2: stored in provider brand-profile metadata
  } = parsed.data;

  const db = getPrisma();

  // Check for existing row (upsert-style: deactivate old, create new)
  const existing = await db.brandedCallingProvider.findFirst({
    where: { tenantId: BigInt(auth.tenantId), provider, active: true },
  });

  // Encrypt credentials
  const plaintext = JSON.stringify(credentials);
  const tempId = existing?.id ?? BigInt(0);
  const { ciphertextBlob, kekVersion } = encrypt({
    table: 'branded_calling_providers',
    column: 'credentials_enc',
    rowId: tempId,
    tenantId: BigInt(auth.tenantId),
    plaintext,
  });

  let row;
  if (existing) {
    // Update existing row
    row = await db.brandedCallingProvider.update({
      where: { id: existing.id },
      data: {
        credentialsEnc: Buffer.from(ciphertextBlob),
        kekVersion,
        brandName,
        logoUrl: logoUrl ?? null,
        vertical: vertical as Parameters<typeof db.brandedCallingProvider.update>[0]['data']['vertical'],
        callReasons: callReasons as Parameters<typeof db.brandedCallingProvider.update>[0]['data']['callReasons'],
        brandStatus: 'pending',
      },
    });
    ProviderRegistry.invalidate(BigInt(auth.tenantId), provider);

    await audit({
      tx: db, actorUserId: auth.uid, actorKind: 'user',
      action: 'branded_calling.provider.updated',
      tenantId: auth.tenantId,
      entityType: 'branded_calling_provider', entityId: String(row.id),
      afterJson: { provider, brandName },
    });
  } else {
    row = await db.brandedCallingProvider.create({
      data: {
        tenantId: BigInt(auth.tenantId),
        provider: provider as Parameters<typeof db.brandedCallingProvider.create>[0]['data']['provider'],
        credentialsEnc: Buffer.from(ciphertextBlob),
        kekVersion,
        brandName,
        logoUrl: logoUrl ?? null,
        vertical: vertical as Parameters<typeof db.brandedCallingProvider.create>[0]['data']['vertical'],
        callReasons: callReasons as Parameters<typeof db.brandedCallingProvider.create>[0]['data']['callReasons'],
      },
    });

    await audit({
      tx: db, actorUserId: auth.uid, actorKind: 'user',
      action: 'branded_calling.provider.created',
      tenantId: auth.tenantId,
      entityType: 'branded_calling_provider', entityId: String(row.id),
      afterJson: { provider, brandName },
    });
  }

  return reply.code(existing ? 200 : 201).send({
    id: String(row.id),
    provider: row.provider,
    brandStatus: row.brandStatus,
    providerBrandId: row.providerBrandId,
    createdAt: row.createdAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// PATCH /api/admin/branded-calling/:provider — update brand profile
// ---------------------------------------------------------------------------

export async function handleUpdateProvider(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string };
  const provider = validateProvider(params.provider);

  const parsed = UpdateProviderSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(422).send({ error: 'validation_failed', details: parsed.error.flatten() });
  }

  const db = getPrisma();
  const existing = await db.brandedCallingProvider.findFirst({
    where: { tenantId: BigInt(auth.tenantId), provider, active: true },
  });
  if (!existing) return reply.code(404).send({ error: 'not_configured' });

  const { credentials, ...profileFields } = parsed.data;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {};
  if (profileFields.brandName !== undefined) updateData['brandName'] = profileFields.brandName;
  if ('logoUrl' in profileFields)            updateData['logoUrl']   = profileFields.logoUrl ?? null;
  if (profileFields.vertical !== undefined)  updateData['vertical']  = profileFields.vertical;
  if (profileFields.callReasons !== undefined) updateData['callReasons'] = profileFields.callReasons;

  if (credentials) {
    const { ciphertextBlob, kekVersion } = encrypt({
      table: 'branded_calling_providers',
      column: 'credentials_enc',
      rowId: existing.id,
      tenantId: BigInt(auth.tenantId),
      plaintext: JSON.stringify(credentials),
    });
    updateData['credentialsEnc'] = Buffer.from(ciphertextBlob);
    updateData['kekVersion'] = kekVersion;
    ProviderRegistry.invalidate(BigInt(auth.tenantId), provider);
  }

  const row = await db.brandedCallingProvider.update({
    where: { id: existing.id },
    data: updateData,
  });

  await audit({
    tx: db, actorUserId: auth.uid, actorKind: 'user',
    action: 'branded_calling.provider.updated',
    tenantId: auth.tenantId,
    entityType: 'branded_calling_provider', entityId: String(row.id),
    afterJson: { provider, ...profileFields },
  });

  return reply.code(200).send({
    id: String(row.id),
    provider: row.provider,
    brandName: row.brandName,
    brandStatus: row.brandStatus,
    updatedAt: row.updatedAt.toISOString(),
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/branded-calling/:provider — soft-delete provider config
// ---------------------------------------------------------------------------

export async function handleDeleteProvider(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string };
  const provider = validateProvider(params.provider);
  const db = getPrisma();

  const existing = await db.brandedCallingProvider.findFirst({
    where: { tenantId: BigInt(auth.tenantId), provider, active: true },
  });
  if (!existing) return reply.code(404).send({ error: 'not_configured' });

  await db.brandedCallingProvider.update({
    where: { id: existing.id },
    data: { active: false },
  });

  ProviderRegistry.invalidate(BigInt(auth.tenantId), provider);

  await audit({
    tx: db, actorUserId: auth.uid, actorKind: 'user',
    action: 'branded_calling.provider.deleted',
    tenantId: auth.tenantId,
    entityType: 'branded_calling_provider', entityId: String(existing.id),
    afterJson: { provider },
  });

  return reply.code(200).send({ ok: true });
}

// ---------------------------------------------------------------------------
// POST /api/admin/branded-calling/:provider/test-connection
// ---------------------------------------------------------------------------

export async function handleTestConnection(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string };
  const provider = validateProvider(params.provider);
  const db = getPrisma();

  const row = await db.brandedCallingProvider.findFirst({
    where: { tenantId: BigInt(auth.tenantId), provider, active: true },
  });
  if (!row) return reply.code(404).send({ error: 'not_configured' });
  if (!row.providerBrandId) {
    return reply.code(422).send({ ok: false, error: 'brand_not_registered_with_provider' });
  }

  try {
    const client = await ProviderRegistry.getClient(row);
    const { status: brandStatus, syncedAt } = await client.getBrandStatus(row.providerBrandId);
    return reply.code(200).send({
      ok: true,
      brandStatus,
      providerBrandId: row.providerBrandId,
      syncedAt: syncedAt.toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(422).send({ ok: false, error: message });
  }
}

