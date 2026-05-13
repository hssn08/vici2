// N05 — BullMQ job: branded-calling:bulk-register
// Registers up to 500 DIDs with the provider API in a single bulk call.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export interface BulkRegisterJobPayload {
  tenantId: string;
  providerId: string;
  didIds: string[];      // up to 500 DID IDs
  callReason: string;
  effectiveDate: string;
}

const CHUNK_SIZE = 500;

 
export async function processBulkRegister(
  job: Job<BulkRegisterJobPayload>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  logger: Logger,
): Promise<void> {
  const { tenantId, providerId, didIds, callReason, effectiveDate } = job.data;

  const providerRow = await prisma.brandedCallingProvider.findUniqueOrThrow({
    where: { id: BigInt(providerId) },
  });

  if (!providerRow.providerBrandId) {
    throw new Error(
      `Provider ${providerRow.provider} has no provider_brand_id — brand must be registered first`,
    );
  }

  const dids = await prisma.didNumber.findMany({
    where: { id: { in: didIds.map(BigInt) }, tenantId: BigInt(tenantId) },
    select: { id: true, e164: true },
  });

  if (dids.length === 0) {
    logger.warn({ providerId, tenantId }, 'N05: bulk-register: no DIDs found');
    return;
  }

  // Create pending registration rows (skip existing).
  for (const did of dids) {
    try {
      await prisma.brandedDidRegistration.create({
        data: {
          tenantId: BigInt(tenantId),
          didId: did.id,
          providerId: providerRow.id,
          provider: providerRow.provider,
          callReason,
          status: 'pending',
        },
      });
    } catch (err) {
      const e = err as { code?: string };
      if (e.code === 'P2002') continue;
      throw err;
    }
  }

  const { ProviderRegistry } = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    '../../../../../api/src/integrations/branded-calling/registry.js'
  );

  const client = await ProviderRegistry.getClient(providerRow);
  const requests = dids.map((d: { e164: string }) => ({ e164: d.e164, callReason, effectiveDate }));

  let activeCount = 0;
  let rejectedCount = 0;

  for (let i = 0; i < requests.length; i += CHUNK_SIZE) {
    const chunk = requests.slice(i, i + CHUNK_SIZE);
    const chunkDids = dids.slice(i, i + CHUNK_SIZE);

    const results = await client.registerNumbers(providerRow.providerBrandId, chunk);

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const did = chunkDids[j];

      if (result.status === 'rejected') {
        rejectedCount++;
        await prisma.brandedDidRegistration.update({
          where: { didId_provider: { didId: did.id, provider: providerRow.provider } },
          data: { status: 'rejected', lastError: result.error, retryCount: { increment: 1 } },
        });
      } else {
        if (result.status === 'active') activeCount++;
        await prisma.brandedDidRegistration.update({
          where: { didId_provider: { didId: did.id, provider: providerRow.provider } },
          data: {
            status: result.status === 'active' ? 'active' : 'submitted',
            providerNumberId: result.providerNumberId,
            attestationLevel: result.attestationLevel,
            registeredAt: result.status === 'active' ? new Date() : null,
          },
        });
      }
    }

    await job.updateProgress(Math.round(((i + CHUNK_SIZE) / requests.length) * 100));
  }

  logger.info(
    { provider: providerRow.provider, total: dids.length, active: activeCount, rejected: rejectedCount },
    'N05: bulk-register complete',
  );
}
