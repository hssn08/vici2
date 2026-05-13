// N05 — Branded Calling reputation + dispute handlers.
// GET  /api/admin/branded-calling/:provider/dids/:didId/reputation
// POST /api/admin/branded-calling/:provider/dids/:didId/dispute
// Permission: branded_calling:register_did

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '../../../lib/prisma.js';
import { audit } from '../../../auth/audit.js';
import { ProviderRegistry } from '../../../integrations/branded-calling/registry.js';
import { DisputeSchema, PROVIDER_KINDS } from './schemas.js';
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
// GET /api/admin/branded-calling/:provider/dids/:didId/reputation
// ---------------------------------------------------------------------------

export async function handleGetReputation(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string; didId: string };
  const provider = validateProvider(params.provider);
  const didIdBig = BigInt(params.didId);

  const db = getPrisma();

  const reg = await db.brandedDidRegistration.findFirst({
    where: {
      didId: didIdBig,
      provider: provider as Parameters<typeof db.brandedDidRegistration.findFirst>[0]['where']['provider'],
      tenantId: BigInt(auth.tenantId),
    },
    include: { did: { select: { e164: true } }, providerRow: true },
  });
  if (!reg) return reply.code(404).send({ error: 'registration_not_found' });

  // Optionally force-poll reputation from provider.
  const query = req.query as { poll?: string };
  if (query.poll === 'true' && reg.status === 'active') {
    try {
      const client = await ProviderRegistry.getClient(reg.providerRow);
      const score = await client.getReputation(reg.did.e164);
      await db.brandedDidRegistration.update({
        where: { id: reg.id },
        data: {
          reputationScore: score.normalizedScore,
          reputationLastPolledAt: score.polledAt,
          rawScore: score.rawScore,
          rawScoreAt: score.polledAt,
        },
      });
      return reply.code(200).send({
        registrationId: String(reg.id),
        provider,
        e164: reg.did.e164,
        reputationScore: score.normalizedScore,
        rawScore: score.rawScore,
        isBlocked: score.isBlocked,
        spamLabel: score.spamLabel,
        polledAt: score.polledAt.toISOString(),
        fresh: true,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(502).send({ error: 'provider_poll_failed', message: msg });
    }
  }

  return reply.code(200).send({
    registrationId: String(reg.id),
    provider,
    e164: reg.did.e164,
    reputationScore: reg.reputationScore,
    rawScore: reg.rawScore ? Number(reg.rawScore) : null,
    reputationLastPolledAt: reg.reputationLastPolledAt?.toISOString() ?? null,
    disputeOpen: reg.disputeOpen,
    fresh: false,
  });
}

// ---------------------------------------------------------------------------
// POST /api/admin/branded-calling/:provider/dids/:didId/dispute
// ---------------------------------------------------------------------------

export async function handleSubmitDispute(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = getAuth(req);
  const params = req.params as { provider: string; didId: string };
  const provider = validateProvider(params.provider);
  const didIdBig = BigInt(params.didId);

  const parsed = DisputeSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(422).send({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const { notes } = parsed.data;

  const db = getPrisma();
  const reg = await db.brandedDidRegistration.findFirst({
    where: {
      didId: didIdBig,
      provider: provider as Parameters<typeof db.brandedDidRegistration.findFirst>[0]['where']['provider'],
      tenantId: BigInt(auth.tenantId),
    },
    include: { did: { select: { e164: true } }, providerRow: true },
  });
  if (!reg) return reply.code(404).send({ error: 'registration_not_found' });
  if (reg.disputeOpen) return reply.code(409).send({ error: 'dispute_already_open' });

  // Submit to provider.
  try {
    const client = await ProviderRegistry.getClient(reg.providerRow);
    await client.submitDispute(reg.did.e164, notes);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(502).send({ error: 'provider_dispute_failed', message: msg });
  }

  await db.brandedDidRegistration.update({
    where: { id: reg.id },
    data: {
      disputeOpen: true,
      disputeSubmittedAt: new Date(),
      disputeNotes: notes,
    },
  });

  await audit({
    tx: db, actorUserId: auth.uid, actorKind: 'user',
    action: 'branded_calling.did.dispute_submitted',
    tenantId: auth.tenantId,
    entityType: 'branded_did_registration', entityId: String(reg.id),
    afterJson: { provider, didId: String(didIdBig), e164: reg.did.e164 },
  });

  return reply.code(200).send({ ok: true, disputeSubmittedAt: new Date().toISOString() });
}
