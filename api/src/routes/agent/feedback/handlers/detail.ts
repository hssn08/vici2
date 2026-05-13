// GET /api/agent/feedback/:id
// Get feedback detail for the authenticated agent.
// Permission: feedback:read (scope=own)
// S05 PLAN §10.3

import type { FastifyRequest, FastifyReply } from 'fastify';
import { FeedbackService } from '../../../../services/coaching/feedback-service.js';
import { getPrisma } from '../../../../lib/prisma.js';

export async function handleAgentGetFeedback(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = new FeedbackService(getPrisma());

  const feedback = await service.getById(BigInt(req.params.id), auth.tenantId);
  if (!feedback) return reply.code(404).send({ error: 'feedback_not_found' });

  // Own-scope enforcement: agent may only view their own feedback
  if (Number(feedback.agentId) !== auth.uid) {
    return reply.code(403).send({ error: 'forbidden' });
  }

  return reply.send({ feedback });
}
