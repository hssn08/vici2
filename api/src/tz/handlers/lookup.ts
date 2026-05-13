import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { resolveTimezone } from '../resolve.js';

const LookupQuery = z.object({
  phone_e164: z.string().min(1),
  zip: z.string().optional(),
  state: z.string().length(2).optional(),
});

export function registerLookupHandler(app: FastifyInstance): void {
  // GET /api/admin/tz/lookup?phone_e164=+13175551212&zip=46201&state=IN
  app.get('/api/admin/tz/lookup', async (req: FastifyRequest, reply: FastifyReply) => {
    const q = LookupQuery.parse(req.query);

    const result = await resolveTimezone({
      phoneE164: q.phone_e164,
      zip: q.zip,
      state: q.state,
    });

    return reply.send({
      phone_e164: q.phone_e164,
      npa: result.npa ?? null,
      nxx: result.nxx ?? null,
      iana: result.iana,
      confidence: result.confidence,
      source: result.source,
      number_type: result.numberType ?? 'UNKNOWN',
      from_override: result.confidence === 'NXX' && result.source.includes('override'),
      lookup_at: new Date().toISOString(),
    });
  });
}
