/**
 * D03 Fastify plugin — timezone resolver.
 * Registers all admin routes and sets up preload + pubsub subscription.
 */
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { preload, subscribe } from './resolve.js';
import { registerOverridesHandlers } from './handlers/overrides.js';
import { registerLookupHandler } from './handlers/lookup.js';
import { registerReloadHandler } from './handlers/reload.js';
// Register metrics collectors (side effect: registers them with prom-client)
import './metrics.js';

interface TzPluginOptions {
  prisma: PrismaClient;
  valkey: Redis;
}

const tzPlugin: FastifyPluginAsync<TzPluginOptions> = async (app, opts) => {
  const { prisma, valkey } = opts;

  // Preload caches at boot — fail-fast if MySQL is down
  app.addHook('onReady', async () => {
    await preload(prisma, valkey);
    subscribe(valkey, prisma);
  });

  // Register admin routes
  registerOverridesHandlers(app, prisma, valkey);
  registerLookupHandler(app);
  registerReloadHandler(app, prisma, valkey);
};

export default fp(tzPlugin, {
  name: 'tz',
  fastify: '>=5.0.0',
});

// Re-export public API
export { resolveTimezone, resolveBatch, preload, subscribe, setCampaignDefault } from './resolve.js';
export type { ResolveRequest, ResolveResult, Confidence, NumberType } from './types.js';
