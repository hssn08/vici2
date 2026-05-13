// S05 — AnnotationService
// CRUD + lock enforcement (draft-only mutations)
// S05 PLAN §4.2, §10.1

import type { PrismaClient } from '@prisma/client';

// Use local string type to avoid Prisma client generation dependency
export type AnnotationTagValueValue = 'positive' | 'needs_improvement' | 'training_opportunity' | 'compliance_flag' | 'praise';

export const MAX_ANNOTATIONS_PER_CALL = 200;

export class AnnotationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'AnnotationError';
  }
}

export class AnnotationService {
  constructor(private readonly db: PrismaClient) {}

  async list(callUuid: string, tenantId: number) {
    return this.db.callAnnotation.findMany({
      where: { callUuid, tenantId: BigInt(tenantId) },
      include: {
        supervisor: { select: { id: true, fullName: true, username: true } },
      },
      orderBy: { timestampMs: 'asc' },
    });
  }

  async create(params: {
    tenantId: number;
    callUuid: string;
    scorecardId?: bigint | null;
    supervisorId: number;
    timestampMs: number;
    text: string;
    tag: AnnotationTagValue;
    callDurationMs?: number;
  }) {
    // Validate against call duration if provided
    if (params.callDurationMs !== undefined && params.timestampMs > params.callDurationMs) {
      throw new AnnotationError(
        422,
        `timestampMs (${params.timestampMs}) exceeds call duration (${params.callDurationMs})`,
      );
    }

    // Cap at 200 per call
    const count = await this.db.callAnnotation.count({
      where: { callUuid: params.callUuid, tenantId: BigInt(params.tenantId) },
    });
    if (count >= MAX_ANNOTATIONS_PER_CALL) {
      throw new AnnotationError(429, `Maximum ${MAX_ANNOTATIONS_PER_CALL} annotations per call reached`);
    }

    // If linked to scorecard, validate scorecard is in draft
    if (params.scorecardId) {
      const scorecard = await this.db.callScorecard.findFirst({
        where: { id: params.scorecardId, tenantId: BigInt(params.tenantId) },
      });
      if (scorecard && scorecard.status === 'finalized') {
        throw new AnnotationError(403, 'Cannot add annotations to a finalized scorecard');
      }
    }

    return this.db.callAnnotation.create({
      data: {
        tenantId: BigInt(params.tenantId),
        callUuid: params.callUuid,
        scorecardId: params.scorecardId ?? null,
        supervisorId: BigInt(params.supervisorId),
        timestampMs: params.timestampMs,
        text: params.text,
        tag: params.tag,
      },
    });
  }

  async update(params: {
    id: bigint;
    tenantId: number;
    supervisorId: number;
    text?: string;
    tag?: AnnotationTagValue;
    callDurationMs?: number;
    timestampMs?: number;
  }) {
    const existing = await this.db.callAnnotation.findFirst({
      where: { id: params.id, tenantId: BigInt(params.tenantId) },
    });
    if (!existing) throw new AnnotationError(404, 'Annotation not found');

    // Only the creating supervisor may edit
    if (existing.supervisorId && Number(existing.supervisorId) !== params.supervisorId) {
      throw new AnnotationError(403, 'Only the creating supervisor may edit this annotation');
    }

    // Check scorecard lock
    if (existing.scorecardId) {
      const scorecard = await this.db.callScorecard.findFirst({
        where: { id: existing.scorecardId },
      });
      if (scorecard && scorecard.status === 'finalized') {
        throw new AnnotationError(403, 'Scorecard is finalized — annotations are locked');
      }
    }

    if (params.timestampMs !== undefined && params.callDurationMs !== undefined) {
      if (params.timestampMs > params.callDurationMs) {
        throw new AnnotationError(422, 'timestampMs exceeds call duration');
      }
    }

    return this.db.callAnnotation.update({
      where: { id: params.id },
      data: {
        ...(params.text !== undefined ? { text: params.text } : {}),
        ...(params.tag !== undefined ? { tag: params.tag } : {}),
        ...(params.timestampMs !== undefined ? { timestampMs: params.timestampMs } : {}),
      },
    });
  }

  async delete(params: { id: bigint; tenantId: number; supervisorId: number }) {
    const existing = await this.db.callAnnotation.findFirst({
      where: { id: params.id, tenantId: BigInt(params.tenantId) },
    });
    if (!existing) throw new AnnotationError(404, 'Annotation not found');

    if (existing.supervisorId && Number(existing.supervisorId) !== params.supervisorId) {
      throw new AnnotationError(403, 'Only the creating supervisor may delete this annotation');
    }

    if (existing.scorecardId) {
      const scorecard = await this.db.callScorecard.findFirst({
        where: { id: existing.scorecardId },
      });
      if (scorecard && scorecard.status === 'finalized') {
        throw new AnnotationError(403, 'Scorecard is finalized — annotations are locked');
      }
    }

    return this.db.callAnnotation.delete({ where: { id: params.id } });
  }
}
