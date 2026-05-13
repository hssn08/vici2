// GET /api/sup/coaching/reports/agent-trend
// GET /api/sup/coaching/reports/team-summary
// S05 PLAN §8, §10.1

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { CoachingReportService } from '../../../../services/coaching/coaching-report-service.js';
import { getPrisma } from '../../../../lib/prisma.js';
import type { TrendInterval } from '../../../../services/coaching/coaching-report-service.js';

const AgentTrendQuerySchema = z.object({
  agent_id: z.string(),
  template_id: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  interval: z.enum(['day', 'week', 'month']).default('week'),
});

const TeamSummaryQuerySchema = z.object({
  campaign_id: z.string().optional(),
  template_id: z.string().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

function getService() {
  return new CoachingReportService(getPrisma());
}

export async function handleAgentTrend(
  req: FastifyRequest<{ Querystring: Record<string, string> }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const parsed = AgentTrendQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
  }

  const q = parsed.data;
  const service = getService();

  const result = await service.getAgentTrend({
    tenantId: auth.tenantId,
    agentId: Number(q.agent_id),
    templateId: q.template_id ? Number(q.template_id) : undefined,
    from: new Date(`${q.from}T00:00:00Z`),
    to: new Date(`${q.to}T23:59:59Z`),
    interval: q.interval as TrendInterval,
  });

  if (!result) return reply.code(404).send({ error: 'agent_not_found' });
  return reply.send(result);
}

export async function handleTeamSummary(
  req: FastifyRequest<{ Querystring: Record<string, string> }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const parsed = TeamSummaryQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
  }

  const q = parsed.data;
  const service = getService();

  const result = await service.getTeamSummary({
    tenantId: auth.tenantId,
    supervisorId: auth.uid,
    campaignId: q.campaign_id,
    templateId: q.template_id ? Number(q.template_id) : undefined,
    from: new Date(`${q.from}T00:00:00Z`),
    to: new Date(`${q.to}T23:59:59Z`),
  });

  return reply.send(result);
}
