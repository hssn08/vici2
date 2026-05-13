// N05 — BullMQ job: branded-calling:deregister-did
// Removes a single DID from the provider's branded display registry.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';

export interface DeregisterDidJobPayload {
  tenantId: string;
  registrationId: string;
  didId: string;
  providerId: string;
  e164: string;
}

 
export async function processDeregisterDid(
  job: Job<DeregisterDidJobPayload>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  logger: Logger,
): Promise<void> {
  const { tenantId, registrationId, didId, providerId, e164 } = job.data;

  const providerRow = await prisma.brandedCallingProvider.findUniqueOrThrow({
    where: { id: BigInt(providerId) },
  });

  if (providerRow.providerBrandId) {
    const { ProviderRegistry } = await import(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      '../../../../../api/src/integrations/branded-calling/registry.js'
    );
    const client = await ProviderRegistry.getClient(providerRow);
    await client.deregisterNumber(providerRow.providerBrandId, e164);
  }

  await prisma.brandedDidRegistration.update({
    where: { id: BigInt(registrationId) },
    data: { status: 'deregistered', deregisteredAt: new Date() },
  });

  // Clear brand_reputation_score if no more active registrations for this DID.
  const remaining = await prisma.brandedDidRegistration.count({
    where: {
      didId: BigInt(didId),
      status: { in: ['active', 'submitted', 'pending'] },
    },
  });
  if (remaining === 0) {
    await prisma.didNumber.update({
      where: { id: BigInt(didId) },
      data: { brandReputationScore: null },
    });
  }

  await prisma.auditLog.create({
    data: {
      tenantId: BigInt(tenantId),
      actorUserId: null,
      actorKind: 'worker',
      action: 'branded_calling.did.deregistered',
      entityType: 'branded_did_registration',
      entityId: registrationId,
      beforeJson: null,
      afterJson: { provider: providerRow.provider, e164, didId },
      requestId: null,
      ipAddress: null,
      userAgent: null,
      ts: new Date(),
    },
  });

  logger.info({ provider: providerRow.provider, e164 }, 'N05: DID deregistered');
}
