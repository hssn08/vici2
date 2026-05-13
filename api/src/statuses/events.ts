// D04 — lead.status_changed event publisher.
//
// Events are published to the Valkey pubsub channel:
//   pubsub:t:{tenantId}:lead_status_changed
//
// Consumers (E01, T04, D06) subscribe and process asynchronously.
// Failure to publish does NOT roll back the disposition transaction.

import pino from "pino";

const logger = pino({ level: "info" });

export interface LeadStatusChangedEvent {
  tenantId: number | bigint;
  leadId: number | bigint;
  oldStatus: string;
  newStatus: string;
  timestamp: Date;
  userId?: number | null;
  campaignId?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function publishLeadStatusChanged(redis: any, event: LeadStatusChangedEvent): Promise<void> {
  const channel = `pubsub:t:${event.tenantId}:lead_status_changed`;
  const payload = JSON.stringify({
    ...event,
    tenantId: String(event.tenantId),
    leadId: String(event.leadId),
    timestamp: event.timestamp.toISOString(),
  });
  try {
    await redis.publish(channel, payload);
  } catch (err) {
    logger.error({ err, channel }, "d04:events: failed to publish lead.status_changed");
    // Non-fatal: consumers cold-start sweep reads dispositions table
  }
}
