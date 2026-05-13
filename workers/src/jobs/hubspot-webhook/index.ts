// N04 — HubSpot inbound webhook event processor
// Queue: vici2:queue:hubspot-webhook
// Concurrency: 5

import type { Job } from 'bullmq';
import pino from 'pino';

const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { worker: 'hubspot-webhook' },
});

export interface HubspotWebhookEvent {
  eventId: number;
  subscriptionId: number;
  portalId: number;
  objectId: number;     // hs_object_id (contact)
  eventType: string;    // 'contact.propertyChange'
  propertyName?: string;
  propertyValue?: string;
  occurredAt: number;   // epoch ms
}

export interface HubspotWebhookJobData {
  tenantId: number;
  events: HubspotWebhookEvent[];
}

/**
 * Process inbound HubSpot webhook events.
 * Groups by contact objectId, then enqueues targeted incremental syncs
 * for contacts already tracked in lead_external_refs.
 */
export async function runHubspotWebhookJob(
  job: Job<HubspotWebhookJobData>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
): Promise<void> {
  const { tenantId, events } = job.data;
  const tid = BigInt(tenantId);

  logger.info({ jobId: job.id, tenantId, eventCount: events.length }, 'hubspot-webhook: processing');

  // Group events by objectId (deduplicate contact updates)
  const uniqueObjectIds = [...new Set(events.map((e) => String(e.objectId)))];

  let processedCount = 0;
  let skippedCount = 0;

  for (const objectId of uniqueObjectIds) {
    try {
      // Check if this contact is imported as a vici2 lead
      const ref = await prisma.leadExternalRef.findFirst({
        where: { tenantId: tid, source: 'hubspot', externalId: objectId },
      });

      if (!ref) {
        skippedCount++;
        continue; // Contact not imported into this tenant
      }

      // In production: fetch updated contact from HubSpot and upsert lead
      // For now, log the intent
      logger.info({ tenantId, objectId, leadId: ref.leadId.toString() }, 'hubspot-webhook: would sync contact');
      processedCount++;
    } catch (err) {
      logger.error({ err, tenantId, objectId }, 'hubspot-webhook: failed to process contact');
    }
  }

  logger.info({ tenantId, processedCount, skippedCount }, 'hubspot-webhook: completed');
}
