// GET/POST/PATCH /api/sup/coaching/calls/:uuid/scorecard
// POST /api/sup/coaching/calls/:uuid/scorecard/finalize
// S05 PLAN §5, §10.1

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ScorecardService, ScorecardValidationError } from '../../../../services/coaching/scorecard-service.js';
import { TemplateService } from '../../../../services/coaching/template-service.js';
import { audit } from '../../../../auth/audit.js';
import { getPrisma } from '../../../../lib/prisma.js';
import type { ScorecardCriterion } from '../../../../services/coaching/types.js';

const ScoreEntrySchema = z.object({
  criterion_id: z.string(),
  score: z.number(),
  na: z.boolean().optional(),
  comment: z.string().optional(),
});

const CreateScorecardSchema = z.object({
  template_id: z.string(),
  agent_id: z.string().optional().nullable(),
  campaign_id: z.string().optional().nullable(),
  scores: z.array(ScoreEntrySchema).default([]),
  comments: z.string().optional().nullable(),
});

const UpdateScorecardSchema = z.object({
  scores: z.array(ScoreEntrySchema).optional(),
  comments: z.string().optional().nullable(),
});

function getService() {
  return new ScorecardService(getPrisma());
}

export async function handleGetScorecard(
  req: FastifyRequest<{ Params: { uuid: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = getService();
  const scorecard = await service.getByCallUuid(req.params.uuid, auth.tenantId);
  if (!scorecard) return reply.code(404).send({ error: 'scorecard_not_found' });
  return reply.send({ scorecard });
}

export async function handleCreateScorecard(
  req: FastifyRequest<{ Params: { uuid: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const parsed = CreateScorecardSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
  }

  const data = parsed.data;
  const db = getPrisma();
  const templateService = new TemplateService(db);
  const templateId = BigInt(data.template_id);

  const template = await templateService.getById(templateId, auth.tenantId);
  if (!template) return reply.code(404).send({ error: 'template_not_found' });

  const service = getService();

  // Check if a scorecard already exists for this call
  const existing = await service.getByCallUuid(req.params.uuid, auth.tenantId);
  if (existing) {
    return reply.code(409).send({ error: 'scorecard_already_exists', scorecard_id: existing.id.toString() });
  }

  try {
    const scorecard = await service.create({
      tenantId: auth.tenantId,
      callUuid: req.params.uuid,
      templateId,
      supervisorId: auth.uid,
      agentId: data.agent_id ? Number(data.agent_id) : null,
      campaignId: data.campaign_id,
      scores: data.scores,
      comments: data.comments,
      criteria: template.criteria as unknown as ScorecardCriterion[],
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.scorecard.draft_saved',
      tenantId: auth.tenantId,
      entityType: 'call_scorecard',
      entityId: scorecard.id.toString(),
      afterJson: { call_uuid: req.params.uuid, template_id: data.template_id },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.code(201).send({ scorecard });
  } catch (err) {
    if (err instanceof ScorecardValidationError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}

export async function handleUpdateScorecard(
  req: FastifyRequest<{ Params: { uuid: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const parsed = UpdateScorecardSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
  }

  const db = getPrisma();
  const service = getService();
  const existing = await service.getByCallUuid(req.params.uuid, auth.tenantId);
  if (!existing) return reply.code(404).send({ error: 'scorecard_not_found' });

  const templateService = new TemplateService(db);
  const template = await templateService.getById(existing.templateId, auth.tenantId);
  if (!template) return reply.code(404).send({ error: 'template_not_found' });

  try {
    const scorecard = await service.update({
      id: existing.id,
      tenantId: auth.tenantId,
      scores: parsed.data.scores,
      comments: parsed.data.comments,
      criteria: template.criteria as unknown as ScorecardCriterion[],
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.scorecard.draft_saved',
      tenantId: auth.tenantId,
      entityType: 'call_scorecard',
      entityId: scorecard.id.toString(),
      afterJson: { call_uuid: req.params.uuid },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.send({ scorecard });
  } catch (err) {
    if (err instanceof ScorecardValidationError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}

export async function handleFinalizeScorecard(
  req: FastifyRequest<{ Params: { uuid: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const db = getPrisma();
  const service = getService();

  const existing = await service.getByCallUuid(req.params.uuid, auth.tenantId);
  if (!existing) return reply.code(404).send({ error: 'scorecard_not_found' });

  const templateService = new TemplateService(db);
  const template = await templateService.getById(existing.templateId, auth.tenantId);
  if (!template) return reply.code(404).send({ error: 'template_not_found' });

  try {
    const scorecard = await service.finalize({
      id: existing.id,
      tenantId: auth.tenantId,
      criteria: template.criteria as unknown as ScorecardCriterion[],
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.scorecard.finalized',
      tenantId: auth.tenantId,
      entityType: 'call_scorecard',
      entityId: scorecard.id.toString(),
      afterJson: {
        call_uuid: req.params.uuid,
        total_score: scorecard.totalScore,
        agent_id: existing.agentId?.toString(),
      },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Insert notification for agent
    if (existing.agentId) {
      const supervisor = await db.user.findFirst({
        where: { id: BigInt(auth.uid) },
        select: { fullName: true, username: true },
      });
      const supervisorName = supervisor?.fullName ?? supervisor?.username ?? 'Supervisor';

      await db.notification.create({
        data: {
          tenantId: BigInt(auth.tenantId),
          userId: existing.agentId,
          channel: 'in_app',
          category: 'coaching.scorecard.new',
          subject: `New evaluation from ${supervisorName}`,
          body: `A call evaluation has been submitted for your review.`,
          severity: 'info',
          link: `/feedback/scorecards/${scorecard.id}`,
        },
      });
    }

    return reply.send({ scorecard });
  } catch (err) {
    if (err instanceof ScorecardValidationError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}

export async function handleGetAgentScorecards(
  req: FastifyRequest<{ Params: { agentId: string }; Querystring: { status?: string; limit?: string; offset?: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = getService();
  const agentId = Number(req.params.agentId);
  if (!agentId) return reply.code(400).send({ error: 'invalid_agent_id' });

  const limit = Math.min(Number(req.query.limit ?? 50), 100);
  const offset = Number(req.query.offset ?? 0);
  const status = req.query.status === 'draft' ? 'draft' : req.query.status === 'finalized' ? 'finalized' : undefined;

  const scorecards = await service.listForAgent({ tenantId: auth.tenantId, agentId, status, limit, offset });
  return reply.send({ scorecards });
}
