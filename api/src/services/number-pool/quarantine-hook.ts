// N05 — X04 quarantine integration hook.
// Called by the branded-calling poll-reputation worker when a DID's normalized
// reputation score drops below BRAND_QUARANTINE_THRESHOLD (default 30).
// Quarantines the DID in ALL pools in the tenant (reason: brand_reputation).

import type { BrandedCallingReputationHook } from '../../integrations/branded-calling/types.js';
import { getPrisma } from '../../lib/prisma.js';
import { audit } from '../../auth/audit.js';

const DEFAULT_THRESHOLD = 30;

export const x04QuarantineHook: BrandedCallingReputationHook = {
  async onRepScoreUpdated(didId: bigint, tenantId: bigint, normalizedScore: number): Promise<void> {
    const threshold = Number(process.env['BRAND_QUARANTINE_THRESHOLD'] ?? DEFAULT_THRESHOLD);
    if (normalizedScore >= threshold) return;

    const db = getPrisma();

    // Quarantine ALL pool memberships for this DID in the tenant.
    const now = new Date();
    const result = await db.numberPoolDid.updateMany({
      where: {
        didId,
        tenantId,
        quarantined: false,
      },
      data: {
        quarantined: true,
        quarantinedAt: now,
        quarantineReason: 'brand_reputation',
        quarantineMeta: { normalizedScore },
      },
    });

    if (result.count > 0) {
      await audit({
        tx: db,
        actorUserId: null,
        actorKind: 'worker',
        action: 'number_pool.did.quarantined',
        tenantId,
        entityType: 'did_number',
        entityId: String(didId),
        afterJson: {
          reason: 'brand_reputation',
          normalizedScore,
          poolsAffected: result.count,
        },
      });
    }
  },
};
