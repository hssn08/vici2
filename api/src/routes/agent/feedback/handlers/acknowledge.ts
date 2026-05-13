// PATCH /api/agent/feedback/:id/acknowledge
// Acknowledge feedback (sets acknowledged_at). Immutable once set.
// Permission: feedback:read (scope=own)
// S05 PLAN §6.3, §10.3

import type { FastifyRequest, FastifyReply } from 'fastify';
import { FeedbackService, FeedbackError } from '../../../../services/coaching/feedback-service.js';
import { audit } from '../../../../auth/audit.js';
import { getPrisma } from '../../../../lib/prisma.js';

export async function handleAgentAcknowledgeFeedback(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const db = getPrisma();
  const service = new FeedbackService(db);

  try {
    const feedback = await service.acknowledge({
      id: BigInt(req.params.id),
      tenantId: auth.tenantId,
      agentId: auth.uid,
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.feedback.acknowledged',
      tenantId: auth.tenantId,
      entityType: 'agent_feedback',
      entityId: req.params.id,
      afterJson: { acknowledged_at: feedback.acknowledgedAt },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.send({ feedback });
  } catch (err) {
    if (err instanceof FeedbackError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}
