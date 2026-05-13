// POST /api/sup/coaching/calls/:uuid/feedback
// GET  /api/sup/coaching/agents/:agentId/feedback
// S05 PLAN §10.1

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FeedbackService, FeedbackError } from '../../../../services/coaching/feedback-service.js';
import { ScorecardService } from '../../../../services/coaching/scorecard-service.js';
import { audit } from '../../../../auth/audit.js';
import { getPrisma } from '../../../../lib/prisma.js';

const CreateFeedbackSchema = z.object({
  agent_id: z.string(),
  body: z.string().min(1).max(5000),
  related_scorecard_id: z.string().optional().nullable(),
});

function getService() {
  return new FeedbackService(getPrisma());
}

export async function handleCreateFeedbackForCall(
  req: FastifyRequest<{ Params: { uuid: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const parsed = CreateFeedbackSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
  }

  const data = parsed.data;
  const db = getPrisma();
  const service = getService();

  // Resolve agent: if not provided in body, look at the scorecard for the call
  let agentId = Number(data.agent_id);
  if (!agentId) {
    const scorecardService = new ScorecardService(db);
    const scorecard = await scorecardService.getByCallUuid(req.params.uuid, auth.tenantId);
    if (scorecard?.agentId) agentId = Number(scorecard.agentId);
  }
  if (!agentId) return reply.code(422).send({ error: 'agent_id required' });

  try {
    const feedback = await service.create({
      tenantId: auth.tenantId,
      agentId,
      supervisorId: auth.uid,
      body: data.body,
      relatedCallUuid: req.params.uuid,
      relatedScorecardId: data.related_scorecard_id ? BigInt(data.related_scorecard_id) : null,
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.feedback.created',
      tenantId: auth.tenantId,
      entityType: 'agent_feedback',
      entityId: feedback.id.toString(),
      afterJson: { agent_id: agentId, call_uuid: req.params.uuid },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Notify agent
    const supervisor = await db.user.findFirst({
      where: { id: BigInt(auth.uid) },
      select: { fullName: true, username: true },
    });
    const supervisorName = supervisor?.fullName ?? supervisor?.username ?? 'Supervisor';

    await db.notification.create({
      data: {
        tenantId: BigInt(auth.tenantId),
        userId: BigInt(agentId),
        channel: 'in_app',
        category: 'coaching.feedback.new',
        subject: `Feedback from ${supervisorName}`,
        body: data.body.slice(0, 200),
        severity: 'info',
        link: '/feedback',
      },
    });

    return reply.code(201).send({ feedback });
  } catch (err) {
    if (err instanceof FeedbackError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}

export async function handleGetAgentFeedback(
  req: FastifyRequest<{ Params: { agentId: string }; Querystring: { limit?: string; offset?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const agentId = Number(req.params.agentId);
  if (!agentId) return reply.code(400).send({ error: 'invalid_agent_id' });

  const service = getService();
  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offset = Number(req.query.offset ?? 0);

  const feedbackList = await service.listForSupervisor({
    tenantId: auth.tenantId,
    supervisorId: auth.uid,
    agentId,
    limit,
    offset,
  });

  return reply.send({ feedback: feedbackList });
}
