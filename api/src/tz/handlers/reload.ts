import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { preload, publishFullReload } from '../resolve.js';
import { tzInvalidations } from '../metrics.js';

export function registerReloadHandler(
  app: FastifyInstance,
  prisma: PrismaClient,
  valkey: Redis,
): void {
  // POST /api/admin/tz/reload — trigger full cache reload on all processes
  app.post('/api/admin/tz/reload', async (_req: FastifyRequest, reply: FastifyReply) => {
    // Reload this process first
    await preload(prisma, valkey);
    tzInvalidations.inc({ reason: 'full_reload' });

    // Signal all other processes via pubsub
    await publishFullReload(valkey);

    return reply.send({ ok: true, reloaded_at: new Date().toISOString() });
  });
}
