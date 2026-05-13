// GET /api/agent/scorecards
// GET /api/agent/scorecards/:id
// List/view own finalized scorecards for the authenticated agent.
// Permission: scorecard:read (scope=own)
// S05 PLAN §10.3

import type { FastifyRequest, FastifyReply } from 'fastify';
import { ScorecardService } from '../../../../services/coaching/scorecard-service.js';
import { getPrisma } from '../../../../lib/prisma.js';

export async function handleAgentListScorecards(
  req: FastifyRequest<{ Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = new ScorecardService(getPrisma());

  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offset = Number(req.query.offset ?? 0);

  const scorecards = await service.listForAgent({
    tenantId: auth.tenantId,
    agentId: auth.uid,
    status: 'finalized', // agent only sees finalized
    limit,
    offset,
  });

  return reply.send({ scorecards });
}

export async function handleAgentGetScorecard(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = new ScorecardService(getPrisma());

  const scorecard = await service.getById(BigInt(req.params.id), auth.tenantId);
  if (!scorecard) return reply.code(404).send({ error: 'scorecard_not_found' });

  // Own-scope: agent may only view their own scorecards
  if (scorecard.agentId && Number(scorecard.agentId) !== auth.uid) {
    return reply.code(403).send({ error: 'forbidden' });
  }

  // Agent may only see finalized scorecards
  if (scorecard.status !== 'finalized') {
    return reply.code(404).send({ error: 'scorecard_not_found' });
  }

  return reply.send({ scorecard });
}
