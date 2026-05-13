// GET /api/agent/feedback
// List own feedback notes for the authenticated agent.
// Permission: feedback:read (scope=own)
// S05 PLAN §10.3

import type { FastifyRequest, FastifyReply } from 'fastify';
import { FeedbackService } from '../../../../services/coaching/feedback-service.js';
import { getPrisma } from '../../../../lib/prisma.js';

export async function handleAgentListFeedback(
  req: FastifyRequest<{ Querystring: { limit?: string; offset?: string; unacknowledged?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = new FeedbackService(getPrisma());

  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offset = Number(req.query.offset ?? 0);
  const unacknowledgedOnly = req.query.unacknowledged === 'true';

  const feedback = await service.listForAgent({
    tenantId: auth.tenantId,
    agentId: auth.uid,
    limit,
    offset,
    unacknowledgedOnly,
  });

  // Count unacknowledged
  const unreadCount = feedback.filter((f: { acknowledgedAt: Date | null }) => f.acknowledgedAt === null).length;

  return reply.send({ feedback, unread_count: unreadCount });
}
