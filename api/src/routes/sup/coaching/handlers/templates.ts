// GET /api/sup/coaching/templates
// List active scorecard templates for supervisor use.
// Permission: scorecard:read

import type { FastifyRequest, FastifyReply } from 'fastify';
import { TemplateService } from '../../../../services/coaching/template-service.js';
import { getPrisma } from '../../../../lib/prisma.js';

export async function handleListTemplates(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = req.auth!;
  const service = new TemplateService(getPrisma());
  const templates = await service.list(auth.tenantId, false);
  return reply.send({ templates });
}
