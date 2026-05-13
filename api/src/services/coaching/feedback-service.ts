// S05 — FeedbackService
// create(), acknowledge(), list()
// S05 PLAN §6.3, §10.3

import type { PrismaClient } from '@prisma/client';

export class FeedbackError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'FeedbackError';
  }
}

export class FeedbackService {
  constructor(private readonly db: PrismaClient) {}

  async create(params: {
    tenantId: number;
    agentId: number;
    supervisorId: number;
    body: string;
    relatedScorecardId?: bigint | null;
    relatedCallUuid?: string | null;
  }) {
    return this.db.agentFeedback.create({
      data: {
        tenantId: BigInt(params.tenantId),
        agentId: BigInt(params.agentId),
        supervisorId: BigInt(params.supervisorId),
        body: params.body,
        relatedScorecardId: params.relatedScorecardId ?? null,
        relatedCallUuid: params.relatedCallUuid ?? null,
      },
    });
  }

  async acknowledge(params: { id: bigint; tenantId: number; agentId: number }) {
    const existing = await this.db.agentFeedback.findFirst({
      where: { id: params.id, tenantId: BigInt(params.tenantId) },
    });
    if (!existing) throw new FeedbackError(404, 'Feedback not found');

    // Only the target agent may acknowledge
    if (Number(existing.agentId) !== params.agentId) {
      throw new FeedbackError(403, 'You may only acknowledge your own feedback');
    }

    // Idempotency: already acknowledged → 409
    if (existing.acknowledgedAt !== null) {
      throw new FeedbackError(409, 'Feedback already acknowledged');
    }

    return this.db.agentFeedback.update({
      where: { id: params.id },
      data: { acknowledgedAt: new Date() },
    });
  }

  async listForAgent(params: {
    tenantId: number;
    agentId: number;
    limit?: number;
    offset?: number;
    unacknowledgedOnly?: boolean;
  }) {
    return this.db.agentFeedback.findMany({
      where: {
        tenantId: BigInt(params.tenantId),
        agentId: BigInt(params.agentId),
        ...(params.unacknowledgedOnly ? { acknowledgedAt: null } : {}),
      },
      include: {
        supervisor: { select: { id: true, fullName: true, username: true } },
        scorecard: { select: { id: true, callUuid: true, totalScore: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
    });
  }

  async getById(id: bigint, tenantId: number) {
    return this.db.agentFeedback.findFirst({
      where: { id, tenantId: BigInt(tenantId) },
      include: {
        supervisor: { select: { id: true, fullName: true, username: true } },
        agent: { select: { id: true, fullName: true, username: true } },
        scorecard: {
          include: {
            template: { select: { id: true, name: true, version: true } },
            annotations: { orderBy: { timestampMs: 'asc' } },
          },
        },
      },
    });
  }

  async listForSupervisor(params: {
    tenantId: number;
    supervisorId: number;
    agentId?: number;
    limit?: number;
    offset?: number;
  }) {
    return this.db.agentFeedback.findMany({
      where: {
        tenantId: BigInt(params.tenantId),
        supervisorId: BigInt(params.supervisorId),
        ...(params.agentId ? { agentId: BigInt(params.agentId) } : {}),
      },
      include: {
        agent: { select: { id: true, fullName: true, username: true } },
        scorecard: { select: { id: true, callUuid: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
    });
  }
}
