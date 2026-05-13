// N04 — HubSpot inbound webhook endpoint
// POST /api/webhooks/hubspot — public; validated by SHA-256 HMAC(client_secret + raw_body)

import type { FastifyRequest, FastifyReply } from 'fastify';
import { Queue } from 'bullmq';
import { verifyHubspotWebhookSignature } from '../../integrations/hubspot/webhook-verify.js';
import { env } from '../../lib/env.js';
import { getPrisma } from '../../lib/prisma.js';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Redis = require('ioredis') as typeof import('ioredis').default;

const HUBSPOT_WEBHOOK_QUEUE = 'vici2:queue:hubspot-webhook';
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB

interface HubspotWebhookEvent {
  eventId: number;
  subscriptionId: number;
  portalId: number;
  appId?: number;
  occurredAt: number;
  eventType: string;
  propertyName?: string;
  propertyValue?: string;
  objectId: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerHubspotWebhookRoute(app: any): Promise<void> {
  const db = getPrisma();

  // Register with raw body parsing for HMAC verification
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, function (
    _req: FastifyRequest,
    body: Buffer,
    done: (err: Error | null, payload?: unknown) => void,
  ) {
    try {
      const parsed = JSON.parse(body.toString('utf-8'));
      // Attach raw body for HMAC verification
      (done as unknown as ((e: null, p: unknown) => void))(null, { parsed, raw: body });
    } catch (e) {
      done(e as Error);
    }
  });

  app.post(
    '/api/webhooks/hubspot',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const signature = (req.headers['x-hubspot-signature'] as string) ?? '';
      const body = req.body as { parsed: HubspotWebhookEvent[]; raw: Buffer } | HubspotWebhookEvent[];

      // Handle both raw+parsed body and plain JSON body (fallback for test)
      let rawBody: Buffer;
      let events: HubspotWebhookEvent[];

      if (body && typeof body === 'object' && 'raw' in body && 'parsed' in body) {
        rawBody = (body as { parsed: HubspotWebhookEvent[]; raw: Buffer }).raw;
        events = (body as { parsed: HubspotWebhookEvent[]; raw: Buffer }).parsed;
      } else {
        rawBody = Buffer.from(JSON.stringify(body));
        events = body as HubspotWebhookEvent[];
      }

      // Enforce 1 MB limit
      if (rawBody.length > MAX_BODY_BYTES) {
        return reply.code(413).send({ code: 'body_too_large' });
      }

      // Verify HMAC signature
      const secret = env.hubspotClientSecret;
      if (secret && !verifyHubspotWebhookSignature(secret, rawBody, signature)) {
        return reply.code(403).send({ code: 'invalid_signature' });
      }

      if (!Array.isArray(events) || events.length === 0) {
        return reply.send({});
      }

      // Group events by portalId to dispatch to correct tenant
      const portalGroups = new Map<number, HubspotWebhookEvent[]>();
      for (const ev of events) {
        if (!ev.portalId) continue;
        const group = portalGroups.get(ev.portalId) ?? [];
        group.push(ev);
        portalGroups.set(ev.portalId, group);
      }

      for (const [portalId, evts] of portalGroups) {
        try {
          // Find tenant by portal_id
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const integration = await (db as any).hubspotIntegration.findFirst({
            where: { portalId: BigInt(portalId), deletedAt: null },
            select: { tenantId: true },
          });

          if (!integration) continue;

          const redis = new Redis(
            process.env.VALKEY_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379/0',
            { maxRetriesPerRequest: null, enableReadyCheck: false },
          );
          const queue = new Queue(HUBSPOT_WEBHOOK_QUEUE, { connection: redis });

          await queue.add(
            'hubspot-webhook',
            { tenantId: Number(integration.tenantId), events: evts },
            { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
          );

          await queue.close();
          redis.disconnect();
        } catch (err) {
          req.log?.error({ err, portalId }, 'hubspot-webhook: failed to enqueue');
        }
      }

      return reply.send({});
    },
  );
}
