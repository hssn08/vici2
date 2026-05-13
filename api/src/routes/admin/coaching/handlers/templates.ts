// Admin template management handlers
// CRUD /api/admin/coaching/templates
// S05 PLAN §10.2

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { TemplateService, TemplateValidationError } from '../../../../services/coaching/template-service.js';
import { audit } from '../../../../auth/audit.js';
import { getPrisma } from '../../../../lib/prisma.js';
import type { ScorecardCriterion } from '../../../../services/coaching/types.js';

const CriterionSchema = z.object({
  id: z.string(),
  label: z.string().min(1).max(200),
  type: z.enum(['numeric', 'binary', 'auto_fail', 'text_only']),
  weight: z.number(),
  max_score: z.number(),
  section: z.string().optional(),
  auto_fail: z.boolean().optional(),
  na_eligible: z.boolean().optional(),
});

const CreateTemplateSchema = z.object({
  name: z.string().min(1).max(128),
  description: z.string().optional().nullable(),
  criteria: z.array(CriterionSchema).min(1).max(50),
});

const UpdateTemplateSchema = z.object({
  name: z.string().min(1).max(128).optional(),
  description: z.string().optional().nullable(),
  criteria: z.array(CriterionSchema).min(1).max(50).optional(),
});

function getService() {
  return new TemplateService(getPrisma());
}

export async function handleAdminListTemplates(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = req.auth!;
  const service = getService();
  const templates = await service.list(auth.tenantId, true); // include inactive
  return reply.send({ templates });
}

export async function handleAdminGetTemplate(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = getService();
  const template = await service.getById(BigInt(req.params.id), auth.tenantId);
  if (!template) return reply.code(404).send({ error: 'template_not_found' });
  return reply.send({ template });
}

export async function handleAdminCreateTemplate(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const auth = req.auth!;
  const parsed = CreateTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
  }

  const db = getPrisma();
  const service = getService();

  try {
    const template = await service.create({
      tenantId: auth.tenantId,
      name: parsed.data.name,
      description: parsed.data.description,
      criteria: parsed.data.criteria as ScorecardCriterion[],
      createdBy: auth.uid,
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.template.created',
      tenantId: auth.tenantId,
      entityType: 'scorecard_template',
      entityId: template.id.toString(),
      afterJson: { name: template.name },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.code(201).send({ template });
  } catch (err) {
    if (err instanceof TemplateValidationError) {
      return reply.code(err.statusCode).send({ error: err.message, issues: err.issues });
    }
    throw err;
  }
}

export async function handleAdminUpdateTemplate(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const parsed = UpdateTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
  }

  const db = getPrisma();
  const service = getService();

  try {
    const result = await service.update({
      id: BigInt(req.params.id),
      tenantId: auth.tenantId,
      name: parsed.data.name,
      description: parsed.data.description,
      criteria: parsed.data.criteria as ScorecardCriterion[] | undefined,
      updatedBy: auth.uid,
    });

    const action = result.versioned ? 'coaching.template.versioned' : 'coaching.template.updated';
    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action,
      tenantId: auth.tenantId,
      entityType: 'scorecard_template',
      entityId: result.template.id.toString(),
      afterJson: { name: result.template.name, versioned: result.versioned },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.send({ template: result.template, versioned: result.versioned });
  } catch (err) {
    if (err instanceof TemplateValidationError) {
      return reply.code(err.statusCode).send({ error: err.message, issues: err.issues });
    }
    throw err;
  }
}

export async function handleAdminDeactivateTemplate(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const db = getPrisma();
  const service = getService();

  try {
    const template = await service.deactivate(BigInt(req.params.id), auth.tenantId);

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.template.deactivated',
      tenantId: auth.tenantId,
      entityType: 'scorecard_template',
      entityId: req.params.id,
      afterJson: { active: false },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.send({ template });
  } catch (err) {
    if (err instanceof TemplateValidationError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}
