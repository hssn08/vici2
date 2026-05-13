// N05 — BullMQ job: branded-calling:register-did
// Submits a single DID to the provider API for branded display registration.
//
// This worker receives a PrismaClient instance from the worker index (same
// pattern as number-pool-reaper) to avoid circular package imports.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export interface RegisterDidJobPayload {
  tenantId: string;    // string because BullMQ serializes BigInt as string
  didId: string;
  providerId: string;
  e164: string;
  callReason: string;
  effectiveDate: string;
}

// ---------------------------------------------------------------------------
// Score normalization helpers (kept local to workers package to avoid
// cross-package imports; real client logic lives in api/src/integrations/).
// ---------------------------------------------------------------------------

export function normalizeFirstOrionScore(score: number): number {
  return Math.round(Math.max(0, Math.min(100, score)));
}

export function normalizeHiyaScore(rawScore: number): number {
  return Math.round(Math.max(0, Math.min(100, rawScore * 10)));
}

export function normalizeTnsScore(overallRiskScore: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - overallRiskScore)));
}

// ---------------------------------------------------------------------------
// Job processor — accepts PrismaClient as dependency (injected by index.ts)
// ---------------------------------------------------------------------------

 
export async function processRegisterDid(
  job: Job<RegisterDidJobPayload>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  logger: Logger,
): Promise<void> {
  const { tenantId, didId, providerId, e164, callReason, effectiveDate } = job.data;

  const providerRow = await prisma.brandedCallingProvider.findUniqueOrThrow({
    where: { id: BigInt(providerId) },
  });

  if (!providerRow.providerBrandId) {
    throw new Error(
      `Provider ${providerRow.provider} has no provider_brand_id — brand must be registered first`,
    );
  }

  // Dynamic import of the branded-calling integration (lives in api package
  // which shares node_modules with workers in the monorepo; the import path
  // is resolved at runtime via tsx / node --require).
  // In tests, this is mocked via vi.mock().
  const { ProviderRegistry } = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — cross-package runtime import; not statically checked
    '../../../../../api/src/integrations/branded-calling/registry.js'
  );

  const client = await ProviderRegistry.getClient(providerRow);
  const results = await client.registerNumbers(providerRow.providerBrandId, [
    { e164, callReason, effectiveDate },
  ]);
  const result = results[0];
  if (!result) throw new Error('Provider returned empty results array');

  if (result.status === 'rejected') {
    await prisma.brandedDidRegistration.update({
      where: { didId_provider: { didId: BigInt(didId), provider: providerRow.provider } },
      data: {
        status: 'rejected',
        lastError: result.error,
        retryCount: { increment: 1 },
      },
    });
    logger.warn(
      { provider: providerRow.provider, e164, error: result.error },
      'N05: DID registration rejected by provider',
    );
    return; // do not retry; rejection is final
  }

  await prisma.brandedDidRegistration.update({
    where: { didId_provider: { didId: BigInt(didId), provider: providerRow.provider } },
    data: {
      status: result.status === 'active' ? 'active' : 'submitted',
      providerNumberId: result.providerNumberId,
      attestationLevel: result.attestationLevel,
      registeredAt: result.status === 'active' ? new Date() : null,
    },
  });

  await prisma.auditLog.create({
    data: {
      tenantId: BigInt(tenantId),
      actorUserId: null,
      actorKind: 'worker',
      action: 'branded_calling.did.registered',
      entityType: 'branded_did_registration',
      entityId: didId,
      beforeJson: null,
      afterJson: { provider: providerRow.provider, status: result.status, e164 },
      requestId: null,
      ipAddress: null,
      userAgent: null,
      ts: new Date(),
    },
  });

  logger.info(
    { provider: providerRow.provider, e164, status: result.status },
    'N05: DID registration submitted',
  );
}
