// N05 — BullMQ job: branded-calling:poll-reputation
// Polls reputation scores for a batch of active branded DIDs from the provider API.
// Updates did_numbers.brand_reputation_score and triggers X04 quarantine hook.

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { brandRepScoreGauge } from '../../lib/metrics.js';

export interface PollReputationJobPayload {
  tenantId: string;
  providerId: string;
  didIds: string[];  // batch of up to 100 branded_did_registrations.id values
}

const DEFAULT_THRESHOLD = 30;

 
export async function processPollReputation(
  job: Job<PollReputationJobPayload>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  logger: Logger,
): Promise<void> {
  const { tenantId, providerId, didIds } = job.data;

  const providerRow = await prisma.brandedCallingProvider.findUniqueOrThrow({
    where: { id: BigInt(providerId) },
  });

  const { ProviderRegistry } = await import(
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    '../../../../../api/src/integrations/branded-calling/registry.js'
  );
  const client = await ProviderRegistry.getClient(providerRow);

  const registrations = await prisma.brandedDidRegistration.findMany({
    where: {
      providerId: BigInt(providerId),
      status: 'active',
      id: { in: didIds.map(BigInt) },
    },
    include: { did: { select: { e164: true } } },
  });

  for (const reg of registrations) {
    let score;
    try {
      score = await client.getReputation(reg.did.e164);
    } catch (err) {
      logger.warn(
        { err, e164: reg.did.e164, provider: providerRow.provider },
        'N05: rep poll failed',
      );
      continue;
    }

    await prisma.brandedDidRegistration.update({
      where: { id: reg.id },
      data: {
        reputationScore: score.normalizedScore,
        reputationLastPolledAt: score.polledAt,
        rawScore: score.rawScore,
        rawScoreAt: score.polledAt,
      },
    });

    // Update did_numbers.brand_reputation_score with worst score across providers.
    await updateDidWorstScore(reg.didId, BigInt(tenantId), prisma);

    // Emit Prometheus gauge.
    brandRepScoreGauge
      .labels({ provider: providerRow.provider, tenant_id: tenantId })
      .set(score.normalizedScore);

    // Trigger X04 quarantine hook if below threshold.
    const threshold = Number(process.env['BRAND_QUARANTINE_THRESHOLD'] ?? DEFAULT_THRESHOLD);
    if (score.normalizedScore < threshold) {
      try {
        await quarantineDidGlobally(reg.didId, BigInt(tenantId), score.normalizedScore, prisma, logger);
      } catch (hookErr) {
        logger.error({ hookErr, didId: String(reg.didId) }, 'N05: quarantine hook failed');
      }
    }
  }

  logger.info(
    { provider: providerRow.provider, polled: registrations.length, tenantId },
    'N05: poll-reputation complete',
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function updateDidWorstScore(didId: bigint, tenantId: bigint, prisma: any): Promise<void> {
  const allRegs = await prisma.brandedDidRegistration.findMany({
    where: { didId, tenantId, status: 'active', reputationScore: { not: null } },
    select: { reputationScore: true },
  });
  if (allRegs.length === 0) return;
  const worst = Math.min(...allRegs.map((r: { reputationScore: number }) => r.reputationScore));
  await prisma.didNumber.update({
    where: { id: didId },
    data: { brandReputationScore: worst },
  });
}

async function quarantineDidGlobally(
  didId: bigint,
  tenantId: bigint,
  normalizedScore: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  logger: Logger,
): Promise<void> {
  const result = await prisma.numberPoolDid.updateMany({
    where: { didId, tenantId, quarantined: false },
    data: {
      quarantined: true,
      quarantinedAt: new Date(),
      quarantineReason: 'brand_reputation',
      quarantineMeta: { normalizedScore },
    },
  });

  if (result.count > 0) {
    await prisma.auditLog.create({
      data: {
        tenantId,
        actorUserId: null,
        actorKind: 'worker',
        action: 'number_pool.did.quarantined',
        entityType: 'did_number',
        entityId: String(didId),
        beforeJson: null,
        afterJson: { reason: 'brand_reputation', normalizedScore, poolsAffected: result.count },
        requestId: null,
        ipAddress: null,
        userAgent: null,
        ts: new Date(),
      },
    });
    logger.warn(
      { didId: String(didId), normalizedScore, poolsAffected: result.count },
      'N05: DID auto-quarantined (brand_reputation)',
    );
  }
}
