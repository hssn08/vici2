// S05 — ScorecardService
// computeTotal(), validate(), create(), update(), finalize()
// S05 PLAN §2.2, §5

import type { PrismaClient } from '@prisma/client';
import type { ScorecardCriterion, ScoreEntry } from './types.js';

export class ScorecardValidationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'ScorecardValidationError';
  }
}

// ---------------------------------------------------------------------------
// computeTotal — pure function, runs client-side mirrored here server-side
// ---------------------------------------------------------------------------

export function computeTotal(criteria: ScorecardCriterion[], scores: ScoreEntry[]): number {
  // 1. Check auto_fail first
  const autoFailCriteria = criteria.filter(c => c.auto_fail);
  for (const c of autoFailCriteria) {
    const entry = scores.find(s => s.criterion_id === c.id);
    if (entry && entry.score === 0 && !entry.na) return 0.0;
  }

  // 2. Weighted sum, with NA re-normalization
  const scoringCriteria = criteria.filter(c => c.type !== 'text_only' && !c.auto_fail);
  const naIds = new Set(scores.filter(s => s.na).map(s => s.criterion_id));

  const activeWeight = scoringCriteria
    .filter(c => !naIds.has(c.id))
    .reduce((acc, c) => acc + c.weight, 0);

  if (activeWeight === 0) return 0.0;

  let total = 0;
  for (const c of scoringCriteria) {
    if (naIds.has(c.id)) continue;
    const entry = scores.find(s => s.criterion_id === c.id);
    const score = entry?.score ?? 0;
    const normalizedWeight = (c.weight / activeWeight) * 100;
    total += (score / c.max_score) * normalizedWeight;
  }

  return Math.round(total * 100) / 100; // 2dp
}

// ---------------------------------------------------------------------------
// validateScores — checks all required criteria are scored
// ---------------------------------------------------------------------------

export function validateScoresComplete(
  criteria: ScorecardCriterion[],
  scores: ScoreEntry[],
): string | null {
  const required = criteria.filter(c => c.type !== 'text_only');
  for (const c of required) {
    const entry = scores.find(s => s.criterion_id === c.id);
    if (!entry) {
      return `Criterion "${c.label}" (${c.id}) is missing a score`;
    }
    if (!entry.na && (entry.score === undefined || entry.score === null)) {
      return `Criterion "${c.label}" (${c.id}) has no score and is not marked N/A`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ScorecardService
// ---------------------------------------------------------------------------

export class ScorecardService {
  constructor(private readonly db: PrismaClient) {}

  async getByCallUuid(
    callUuid: string,
    tenantId: number,
    supervisorId?: number,
  ) {
    const where: Record<string, unknown> = { callUuid, tenantId: BigInt(tenantId) };
    if (supervisorId !== undefined) {
      where.supervisorId = BigInt(supervisorId);
    }
    return this.db.callScorecard.findFirst({
      where,
      include: {
        template: true,
        annotations: { orderBy: { timestampMs: 'asc' } },
      },
    });
  }

  async create(params: {
    tenantId: number;
    callUuid: string;
    templateId: bigint;
    supervisorId: number;
    agentId?: number | null;
    campaignId?: string | null;
    scores: ScoreEntry[];
    comments?: string | null;
    criteria: ScorecardCriterion[];
  }) {
    const totalScore = computeTotal(params.criteria, params.scores);
    return this.db.callScorecard.create({
      data: {
        tenantId: BigInt(params.tenantId),
        callUuid: params.callUuid,
        templateId: params.templateId,
        supervisorId: BigInt(params.supervisorId),
        agentId: params.agentId ? BigInt(params.agentId) : null,
        campaignId: params.campaignId ?? null,
        scores: params.scores as unknown as import('@prisma/client').Prisma.InputJsonValue,
        totalScore,
        comments: params.comments ?? null,
        status: 'draft',
      },
    });
  }

  async update(params: {
    id: bigint;
    tenantId: number;
    scores?: ScoreEntry[];
    comments?: string | null;
    criteria: ScorecardCriterion[];
  }) {
    const existing = await this.db.callScorecard.findFirst({
      where: { id: params.id, tenantId: BigInt(params.tenantId) },
    });
    if (!existing) throw new ScorecardValidationError(404, 'Scorecard not found');
    if (existing.status === 'finalized') {
      throw new ScorecardValidationError(409, 'Scorecard already finalized');
    }

    const scores = params.scores ?? (existing.scores as unknown as ScoreEntry[]);
    const totalScore = computeTotal(params.criteria, scores);

    return this.db.callScorecard.update({
      where: { id: params.id },
      data: {
        scores: scores as unknown as import('@prisma/client').Prisma.InputJsonValue,
        totalScore,
        comments: params.comments !== undefined ? params.comments : existing.comments,
      },
    });
  }

  async finalize(params: {
    id: bigint;
    tenantId: number;
    criteria: ScorecardCriterion[];
  }) {
    const existing = await this.db.callScorecard.findFirst({
      where: { id: params.id, tenantId: BigInt(params.tenantId) },
      include: { template: true },
    });
    if (!existing) throw new ScorecardValidationError(404, 'Scorecard not found');
    if (existing.status === 'finalized') {
      throw new ScorecardValidationError(409, 'Scorecard already finalized');
    }

    const scores = existing.scores as unknown as ScoreEntry[];
    const missing = validateScoresComplete(params.criteria, scores);
    if (missing) throw new ScorecardValidationError(422, missing);

    const totalScore = computeTotal(params.criteria, scores);

    return this.db.callScorecard.update({
      where: { id: params.id },
      data: {
        status: 'finalized',
        totalScore,
        finalizedAt: new Date(),
      },
    });
  }

  async unlock(params: { id: bigint; tenantId: number }) {
    const existing = await this.db.callScorecard.findFirst({
      where: { id: params.id, tenantId: BigInt(params.tenantId) },
    });
    if (!existing) throw new ScorecardValidationError(404, 'Scorecard not found');

    return this.db.callScorecard.update({
      where: { id: params.id },
      data: { status: 'draft', finalizedAt: null },
    });
  }

  async listForAgent(params: {
    tenantId: number;
    agentId: number;
    status?: 'draft' | 'finalized';
    limit?: number;
    offset?: number;
  }) {
    return this.db.callScorecard.findMany({
      where: {
        tenantId: BigInt(params.tenantId),
        agentId: BigInt(params.agentId),
        isCalibration: false,
        ...(params.status ? { status: params.status } : {}),
      },
      include: { template: { select: { id: true, name: true, version: true } } },
      orderBy: { createdAt: 'desc' },
      take: params.limit ?? 50,
      skip: params.offset ?? 0,
    });
  }

  async getById(id: bigint, tenantId: number) {
    return this.db.callScorecard.findFirst({
      where: { id, tenantId: BigInt(tenantId) },
      include: {
        template: true,
        annotations: { orderBy: { timestampMs: 'asc' } },
        supervisor: { select: { id: true, fullName: true, username: true } },
        agent: { select: { id: true, fullName: true, username: true } },
      },
    });
  }
}
