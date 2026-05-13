import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { publishInvalidate } from '../resolve.js';
import { tzInvalidations } from '../metrics.js';

const UpsertBody = z.object({
  area_code: z.string().length(3).regex(/^\d+$/),
  exchange_code: z.string().length(3).regex(/^\d+$/),
  tz_iana: z.string().min(1).max(50),
  reason: z.string().min(1).max(255),
});

const NpaParams = z.object({
  npa: z.string().length(3),
  nxx: z.string().length(3),
});

export function registerOverridesHandlers(
  app: FastifyInstance,
  prisma: PrismaClient,
  valkey: Redis,
): void {
  // GET /api/admin/tz/overrides — list all overrides
  app.get('/api/admin/tz/overrides', async (_req: FastifyRequest, reply: FastifyReply) => {
    const rows = await prisma.phoneCodesOverrides.findMany({
      orderBy: [{ area_code: 'asc' }, { exchange_code: 'asc' }],
    });
    return reply.send(rows);
  });

  // POST /api/admin/tz/overrides — upsert override
  app.post('/api/admin/tz/overrides', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = UpsertBody.parse(req.body);

    // Validate IANA name
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: body.tz_iana });
    } catch {
      return reply.status(400).send({ error: `Invalid IANA timezone: ${body.tz_iana}` });
    }

    await prisma.phoneCodesOverrides.upsert({
      where: {
        area_code_exchange_code: {
          area_code: body.area_code,
          exchange_code: body.exchange_code,
        },
      },
      create: {
        area_code: body.area_code,
        exchange_code: body.exchange_code,
        tz_iana: body.tz_iana,
        reason: body.reason,
      },
      update: {
        tz_iana: body.tz_iana,
        reason: body.reason,
      },
    });

    await publishInvalidate(valkey, body.area_code, body.exchange_code);
    tzInvalidations.inc({ reason: 'admin' });

    return reply.status(200).send({ ok: true });
  });

  // DELETE /api/admin/tz/overrides/:npa/:nxx — remove override
  app.delete<{ Params: { npa: string; nxx: string } }>(
    '/api/admin/tz/overrides/:npa/:nxx',
    async (req: FastifyRequest<{ Params: { npa: string; nxx: string } }>, reply: FastifyReply) => {
      const { npa, nxx } = NpaParams.parse(req.params);

      const existing = await prisma.phoneCodesOverrides.findUnique({
        where: { area_code_exchange_code: { area_code: npa, exchange_code: nxx } },
      });
      if (!existing) {
        return reply.status(404).send({ error: 'Override not found' });
      }

      await prisma.phoneCodesOverrides.delete({
        where: { area_code_exchange_code: { area_code: npa, exchange_code: nxx } },
      });

      await publishInvalidate(valkey, npa, nxx);
      tzInvalidations.inc({ reason: 'admin' });

      return reply.status(204).send();
    },
  );
}
