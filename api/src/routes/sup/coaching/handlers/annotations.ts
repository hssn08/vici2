// CRUD /api/sup/coaching/calls/:uuid/annotations
// Permission: scorecard:read (GET), scorecard:create (POST/PATCH/DELETE)
// S05 PLAN §4, §10.1

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { AnnotationService, AnnotationError } from '../../../../services/coaching/annotation-service.js';
import type { AnnotationTagValue } from '../../../../services/coaching/annotation-service.js';
import { audit } from '../../../../auth/audit.js';
import { getPrisma } from '../../../../lib/prisma.js';

const AnnotationTagSchema = z.enum([
  'positive',
  'needs_improvement',
  'training_opportunity',
  'compliance_flag',
  'praise',
]);

const CreateAnnotationSchema = z.object({
  scorecard_id: z.string().optional().nullable(),
  timestamp_ms: z.number().int().min(0),
  text: z.string().min(1).max(2000),
  tag: AnnotationTagSchema.default('needs_improvement'),
});

const UpdateAnnotationSchema = z.object({
  text: z.string().min(1).max(2000).optional(),
  tag: AnnotationTagSchema.optional(),
  timestamp_ms: z.number().int().min(0).optional(),
});

function getService() {
  return new AnnotationService(getPrisma());
}

export async function handleListAnnotations(
  req: FastifyRequest<{ Params: { uuid: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = getService();
  const annotations = await service.list(req.params.uuid, auth.tenantId);
  return reply.send({ annotations });
}

export async function handleCreateAnnotation(
  req: FastifyRequest<{ Params: { uuid: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const parsed = CreateAnnotationSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
  }

  const data = parsed.data;
  const service = getService();
  const db = getPrisma();

  try {
    const annotation = await service.create({
      tenantId: auth.tenantId,
      callUuid: req.params.uuid,
      scorecardId: data.scorecard_id ? BigInt(data.scorecard_id) : null,
      supervisorId: auth.uid,
      timestampMs: data.timestamp_ms,
      text: data.text,
      tag: data.tag as AnnotationTagValue,
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.annotation.created',
      tenantId: auth.tenantId,
      entityType: 'call_annotation',
      entityId: annotation.id.toString(),
      afterJson: { call_uuid: req.params.uuid, tag: data.tag },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.code(201).send({ annotation });
  } catch (err) {
    if (err instanceof AnnotationError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}

export async function handleUpdateAnnotation(
  req: FastifyRequest<{ Params: { uuid: string; id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const parsed = UpdateAnnotationSchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
  }

  const service = getService();
  const db = getPrisma();

  try {
    const annotation = await service.update({
      id: BigInt(req.params.id),
      tenantId: auth.tenantId,
      supervisorId: auth.uid,
      text: parsed.data.text,
      tag: parsed.data.tag as AnnotationTagValue | undefined,
      timestampMs: parsed.data.timestamp_ms,
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.annotation.updated',
      tenantId: auth.tenantId,
      entityType: 'call_annotation',
      entityId: req.params.id,
      afterJson: parsed.data,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.send({ annotation });
  } catch (err) {
    if (err instanceof AnnotationError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}

export async function handleDeleteAnnotation(
  req: FastifyRequest<{ Params: { uuid: string; id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const service = getService();
  const db = getPrisma();

  try {
    await service.delete({
      id: BigInt(req.params.id),
      tenantId: auth.tenantId,
      supervisorId: auth.uid,
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.annotation.deleted',
      tenantId: auth.tenantId,
      entityType: 'call_annotation',
      entityId: req.params.id,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.code(204).send();
  } catch (err) {
    if (err instanceof AnnotationError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}
