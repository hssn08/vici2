// N05 — Branded Calling DID registration handlers.
// Endpoints under /api/admin/branded-calling/:provider/dids
// Permission: branded_calling:register_did

import type { FastifyRequest, FastifyReply } from 'fastify';
import { Queue, type ConnectionOptions } from 'bullmq';
import { getRedis } from '../../../lib/redis.js';
import { getPrisma } from '../../../lib/prisma.js';
import { audit } from '../../../auth/audit.js';
import { RegisterDidSchema, BulkRegisterSchema, ListDidsQuerySchema, PROVIDER_KINDS } from './schemas.js';
import type { ProviderKind } from '../../../integrations/branded-calling/types.js';

const QUEUE_NAME = 'vici2:queue:branded-calling';

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

function getQueue() {
  return new Queue(QUEUE_NAME, { connection: getRedis() as unknown as ConnectionOptions });
}

// ---------------------------------------------------------------------------
// GET /api/admin/branded-calling/:provider/dids
// ---------------------------------------------------------------------------

export async function handleListDids(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string };
  const provider = validateProvider(params.provider);

  const queryParsed = ListDidsQuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    return reply.code(422).send({ error: 'invalid_query', details: queryParsed.error.flatten() });
  }
  const { page, pageSize, status } = queryParsed.data;

  const db = getPrisma();
  const providerRow = await db.brandedCallingProvider.findFirst({
    where: { tenantId: BigInt(auth.tenantId), provider, active: true },
  });
  if (!providerRow) return reply.code(404).send({ error: 'provider_not_configured' });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {
    tenantId: BigInt(auth.tenantId),
    providerId: providerRow.id,
    provider,
  };
  if (status !== 'all') where['status'] = status;

  const skip = (page - 1) * pageSize;
  const [rows, total] = await Promise.all([
    db.brandedDidRegistration.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: 'desc' },
      include: { did: { select: { e164: true } } },
    }),
    db.brandedDidRegistration.count({ where }),
  ]);

  return reply.code(200).send({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    items: rows.map((r: any) => ({
      registrationId: String(r.id),
      didId: String(r.didId),
      e164: r.did.e164,
      status: r.status,
      attestationLevel: r.attestationLevel,
      reputationScore: r.reputationScore,
      reputationLastPolledAt: r.reputationLastPolledAt?.toISOString() ?? null,
      disputeOpen: r.disputeOpen,
      registeredAt: r.registeredAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize,
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/branded-calling/:provider/dids — register individual DID
// ---------------------------------------------------------------------------

export async function handleRegisterDid(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string };
  const provider = validateProvider(params.provider);

  const parsed = RegisterDidSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(422).send({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const { didId, callReason } = parsed.data;

  const db = getPrisma();
  const providerRow = await db.brandedCallingProvider.findFirst({
    where: { tenantId: BigInt(auth.tenantId), provider, active: true },
  });
  if (!providerRow) return reply.code(404).send({ error: 'provider_not_configured' });
  if (!providerRow.providerBrandId) {
    return reply.code(422).send({ error: 'brand_not_registered_with_provider' });
  }

  // Verify DID belongs to tenant.
  const did = await db.didNumber.findFirst({
    where: { id: BigInt(didId), tenantId: BigInt(auth.tenantId) },
  });
  if (!did) return reply.code(404).send({ error: 'did_not_found' });

  // Create registration row (pending).
  let reg;
  try {
    reg = await db.brandedDidRegistration.create({
      data: {
        tenantId: BigInt(auth.tenantId),
        didId: BigInt(didId),
        providerId: providerRow.id,
        provider: provider as Parameters<typeof db.brandedDidRegistration.create>[0]['data']['provider'],
        callReason,
        status: 'pending',
      },
    });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === 'P2002') return reply.code(409).send({ error: 'already_registered' });
    throw err;
  }

  // Enqueue registration job.
  const queue = getQueue();
  const job = await queue.add('branded-calling:register-did', {
    tenantId: String(auth.tenantId),
    didId,
    providerId: String(providerRow.id),
    e164: did.e164,
    callReason,
    effectiveDate: new Date().toISOString().slice(0, 10),
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 30_000 },
    removeOnComplete: 100,
    removeOnFail: 50,
  });
  await queue.close();

  await audit({
    tx: db, actorUserId: auth.uid, actorKind: 'user',
    action: 'branded_calling.did.registration_requested',
    tenantId: auth.tenantId,
    entityType: 'branded_did_registration', entityId: String(reg.id),
    afterJson: { provider, didId, e164: did.e164, callReason },
  });

  return reply.code(202).send({
    registrationId: String(reg.id),
    status: 'pending',
    jobId: job.id,
  });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/branded-calling/:provider/dids/:didId — deregister DID
// ---------------------------------------------------------------------------

export async function handleDeregisterDid(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string; didId: string };
  const provider = validateProvider(params.provider);
  const didIdBig = BigInt(params.didId);

  const db = getPrisma();
  const reg = await db.brandedDidRegistration.findFirst({
    where: { didId: didIdBig, provider: provider as Parameters<typeof db.brandedDidRegistration.findFirst>[0]['where']['provider'], tenantId: BigInt(auth.tenantId) },
    include: { did: { select: { e164: true } }, providerRow: true },
  });
  if (!reg) return reply.code(404).send({ error: 'registration_not_found' });
  if (reg.status === 'deregistered' || reg.status === 'deregistering') {
    return reply.code(409).send({ error: 'already_deregistering' });
  }

  // Mark as deregistering.
  await db.brandedDidRegistration.update({
    where: { id: reg.id },
    data: { status: 'deregistering' },
  });

  // Enqueue deregistration job.
  const queue = getQueue();
  const job = await queue.add('branded-calling:deregister-did', {
    tenantId: String(auth.tenantId),
    registrationId: String(reg.id),
    didId: String(didIdBig),
    providerId: String(reg.providerId),
    e164: reg.did.e164,
  }, {
    attempts: 3,
    backoff: { type: 'exponential', delay: 15_000 },
    removeOnComplete: 100,
  });
  await queue.close();

  await audit({
    tx: db, actorUserId: auth.uid, actorKind: 'user',
    action: 'branded_calling.did.deregistration_requested',
    tenantId: auth.tenantId,
    entityType: 'branded_did_registration', entityId: String(reg.id),
    afterJson: { provider, didId: String(didIdBig), e164: reg.did.e164 },
  });

  return reply.code(202).send({ registrationId: String(reg.id), status: 'deregistering', jobId: job.id });
}

// ---------------------------------------------------------------------------
// POST /api/admin/branded-calling/:provider/dids/bulk-register
// ---------------------------------------------------------------------------

export async function handleBulkRegister(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string };
  const provider = validateProvider(params.provider);

  const parsed = BulkRegisterSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(422).send({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const { didIds, callReason } = parsed.data;

  const db = getPrisma();
  const providerRow = await db.brandedCallingProvider.findFirst({
    where: { tenantId: BigInt(auth.tenantId), provider, active: true },
  });
  if (!providerRow) return reply.code(404).send({ error: 'provider_not_configured' });
  if (!providerRow.providerBrandId) {
    return reply.code(422).send({ error: 'brand_not_registered_with_provider' });
  }

  // Enqueue bulk-register job.
  const queue = getQueue();
  const job = await queue.add('branded-calling:bulk-register', {
    tenantId: String(auth.tenantId),
    providerId: String(providerRow.id),
    didIds,
    callReason,
    effectiveDate: new Date().toISOString().slice(0, 10),
  }, {
    attempts: 2,
    backoff: { type: 'exponential', delay: 60_000 },
    removeOnComplete: 50,
    removeOnFail: 25,
  });
  await queue.close();

  await audit({
    tx: db, actorUserId: auth.uid, actorKind: 'user',
    action: 'branded_calling.did.bulk_registration_requested',
    tenantId: auth.tenantId,
    entityType: 'branded_calling_provider', entityId: String(providerRow.id),
    afterJson: { provider, count: didIds.length, callReason },
  });

  return reply.code(202).send({ jobId: job.id, count: didIds.length });
}
