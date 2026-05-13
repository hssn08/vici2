// N02 — GET /api/admin/email-templates

import type { FastifyRequest, FastifyReply } from 'fastify';
import { listTemplates } from '../service.js';
import { getPrisma } from '../../lib/prisma.js';

export async function handleList(
  req: FastifyRequest<{
    Querystring: { category?: string; lang?: string; active?: string };
  }>,
  reply: FastifyReply,
): Promise<void> {
  const prisma = getPrisma();
  const tenantId = BigInt((req as { auth?: { tenantId?: number | bigint } }).auth?.tenantId ?? 1);

  const activeQuery = req.query.active;
  let active: boolean | 'all';
  if (activeQuery === 'all') {
    active = 'all';
  } else if (activeQuery === 'false') {
    active = false;
  } else {
    active = true;
  }

  const result = await listTemplates(prisma, tenantId, {
    category: req.query.category,
    lang: req.query.lang,
    active,
  });

  return reply.send(result);
}
