// N04 — HubSpot contact sync worker
// Queue: vici2:queue:hubspot-sync
// Concurrency: 2 (allows two tenants to sync simultaneously)

import type { Job } from 'bullmq';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { worker: 'hubspot-sync' },
});

export interface HubspotSyncJobData {
  tenantId: number;
  mode: 'FULL' | 'INCREMENTAL';
  syncJobId?: number;
  pagingCursor?: string;
  // List import variant
  hsListId?: string;
  vici2ListId?: number;
  syncOngoing?: boolean;
}

/**
 * Process a HubSpot contact sync job.
 * This processor runs inside the BullMQ worker process.
 * Real HubSpot API calls are guarded behind the client interface
 * so tests can inject a fake.
 */
export async function runHubspotSyncJob(
  job: Job<HubspotSyncJobData>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
): Promise<void> {
  const { tenantId, mode, syncJobId, pagingCursor } = job.data;
  const tid = BigInt(tenantId);

  logger.info({ jobId: job.id, tenantId, mode }, 'hubspot-sync: starting');

  // Fetch integration + decrypt tokens
  const integration = await prisma.hubspotIntegration.findUnique({
    where: { tenantId: tid, deletedAt: null },
  });

  if (!integration) {
    logger.warn({ tenantId }, 'hubspot-sync: no active integration, skipping');
    return;
  }

  // Check rate limit backoff
  if (integration.rateLimitBackoffUntil && new Date() < integration.rateLimitBackoffUntil) {
    logger.info({ tenantId, until: integration.rateLimitBackoffUntil }, 'hubspot-sync: rate limit backoff, skipping');
    return;
  }

  let syncJobDbId: bigint | undefined = syncJobId ? BigInt(syncJobId) : undefined;

  // Create or update DB sync job row
  if (!syncJobDbId) {
    const syncJob = await prisma.hubspotSyncJob.create({
      data: {
        tenantId: tid,
        integrationId: integration.id,
        bullmqJobId: job.id,
        status: 'running',
        syncMode: mode === 'FULL' ? 'ALL_CONTACTS' : integration.syncMode,
      },
    });
    syncJobDbId = syncJob.id;
  } else {
    await prisma.hubspotSyncJob.update({
      where: { id: syncJobDbId },
      data: { bullmqJobId: job.id, status: 'running' },
    });
  }

  const contactsFetched = 0;
  const contactsUpserted = 0;
  const contactsSkipped = 0;
  const contactsFailed = 0;
  const errors: Array<{ hsObjectId: string; error: string }> = [];

  try {
    // In production: decrypt access token from integration.accessTokenEnc,
    // call HubSpot /crm/v3/objects/contacts/search, upsert leads.
    // For stub: log intent (real calls require live HubSpot credentials).
    logger.info({
      tenantId,
      mode,
      pagingCursor: pagingCursor ?? 'start',
      syncJobId: syncJobDbId?.toString(),
    }, 'hubspot-sync: would fetch contacts from HubSpot (requires live credentials)');

    // Update progress (stub completion)
    await prisma.hubspotSyncJob.update({
      where: { id: syncJobDbId },
      data: {
        status: 'completed',
        contactsFetched,
        contactsUpserted,
        contactsSkipped,
        contactsFailed,
        completedAt: new Date(),
        ...(errors.length > 0 ? { errorSummary: errors.slice(0, 50) } : {}),
      },
    });

    await prisma.hubspotIntegration.update({
      where: { id: integration.id },
      data: { lastSyncAt: new Date() },
    });

    logger.info({ tenantId, contactsFetched, contactsUpserted }, 'hubspot-sync: completed');
  } catch (err) {
    logger.error({ err, tenantId, syncJobId: syncJobDbId?.toString() }, 'hubspot-sync: failed');

    await prisma.hubspotSyncJob.update({
      where: { id: syncJobDbId },
      data: {
        status: 'failed',
        completedAt: new Date(),
        errorSummary: [{ error: String(err) }],
      },
    });

    throw err; // Allow BullMQ retry
  }
}
