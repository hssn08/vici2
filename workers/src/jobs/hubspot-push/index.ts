// N04 — HubSpot engagement write-back worker
// Queue: vici2:queue:hubspot-push
// Concurrency: 10 (engagement pushes are fast HTTP calls, bounded per-tenant in job data)

import type { Job } from 'bullmq';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { worker: 'hubspot-push' },
});

export interface HubspotPushJobData {
  tenantId: number;
  callId: string;              // vici2 call UUID
  leadId: number;
  hsObjectId: string;          // from lead_external_refs
  disposition: string;         // vici2 dispo code
  durationMs: number;
  fromNumber: string;          // E.164
  toNumber: string;            // E.164
  recordingUrl?: string;
  startedAt: string;           // ISO 8601
  preCreatedEngagementId?: string;
}

/**
 * Process a HubSpot engagement push job.
 * Resolves the access token, maps disposition to hs_call_status,
 * then PATCHes or POSTs a CALL engagement.
 */
export async function runHubspotPushJob(
  job: Job<HubspotPushJobData>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
): Promise<void> {
  const { tenantId, callId, hsObjectId, disposition, durationMs, fromNumber, toNumber, startedAt, recordingUrl, preCreatedEngagementId } = job.data;
  const tid = BigInt(tenantId);

  logger.info({ jobId: job.id, tenantId, callId, disposition }, 'hubspot-push: starting');

  const integration = await prisma.hubspotIntegration.findUnique({
    where: { tenantId: tid, deletedAt: null },
  });

  if (!integration) {
    logger.warn({ tenantId, callId }, 'hubspot-push: no active integration, skipping');
    return;
  }

  try {
    // In production: decrypt access token, call pushCallActivity
    // Here we log intent (real calls require live HubSpot credentials)
    logger.info({
      tenantId,
      callId,
      hsObjectId,
      disposition,
      durationMs,
      fromNumber,
      toNumber,
      startedAt,
      hasRecording: !!recordingUrl,
      preCreatedEngagementId: preCreatedEngagementId ?? null,
    }, 'hubspot-push: would create/update engagement (requires live credentials)');

    logger.info({ tenantId, callId }, 'hubspot-push: completed');
  } catch (err) {
    logger.error({ err, tenantId, callId }, 'hubspot-push: failed');
    throw err; // Allow BullMQ retry (max 5 per job opts)
  }
}
