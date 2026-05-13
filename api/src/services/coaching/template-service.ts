// S05 — TemplateService
// CRUD + versioning logic + criteria validation
// S05 PLAN §2.1, §10.2

import type { PrismaClient } from '@prisma/client';
import type { ScorecardCriterion, ScorecardCriteriaValidationError } from './types.js';

export class TemplateValidationError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly issues?: ScorecardCriteriaValidationError[],
  ) {
    super(message);
    this.name = 'TemplateValidationError';
  }
}

// ---------------------------------------------------------------------------
// validateCriteria — enforces all rules from PLAN §2.1
// ---------------------------------------------------------------------------

export function validateCriteria(criteria: ScorecardCriterion[]): ScorecardCriteriaValidationError[] {
  const errors: ScorecardCriteriaValidationError[] = [];

  if (!Array.isArray(criteria) || criteria.length === 0) {
    errors.push({ field: 'criteria', message: 'At least one criterion is required' });
    return errors;
  }
  if (criteria.length > 50) {
    errors.push({ field: 'criteria', message: 'Maximum 50 criteria allowed' });
  }

  let scoringWeightSum = 0;
  let hasScoringCriteria = false;

  for (const c of criteria) {
    if (!c.id || typeof c.id !== 'string') {
      errors.push({ field: `criteria[${c.label}].id`, message: 'Criterion id must be a UUID string' });
    }
    if (!c.label || typeof c.label !== 'string') {
      errors.push({ field: `criteria[${c.label}].label`, message: 'Criterion label is required' });
    }
    if (!['numeric', 'binary', 'auto_fail', 'text_only'].includes(c.type)) {
      errors.push({ field: `criteria[${c.id}].type`, message: `Invalid type: ${c.type}` });
      continue;
    }

    if (c.type === 'auto_fail') {
      if (c.weight !== 0) {
        errors.push({ field: `criteria[${c.id}].weight`, message: 'auto_fail criterion must have weight=0' });
      }
      if (c.max_score !== 1) {
        errors.push({ field: `criteria[${c.id}].max_score`, message: 'auto_fail criterion must have max_score=1' });
      }
    } else if (c.type === 'text_only') {
      if (c.weight !== 0) {
        errors.push({ field: `criteria[${c.id}].weight`, message: 'text_only criterion must have weight=0' });
      }
      if (c.max_score !== 0) {
        errors.push({ field: `criteria[${c.id}].max_score`, message: 'text_only criterion must have max_score=0' });
      }
    } else {
      // numeric or binary
      if (c.max_score < 1) {
        errors.push({ field: `criteria[${c.id}].max_score`, message: 'max_score must be ≥ 1' });
      }
      if (c.type === 'binary' && c.max_score !== 1) {
        errors.push({ field: `criteria[${c.id}].max_score`, message: 'binary criterion must have max_score=1' });
      }
      scoringWeightSum += c.weight;
      hasScoringCriteria = true;
    }
  }

  if (!hasScoringCriteria) {
    errors.push({ field: 'criteria', message: 'At least one scoring criterion (numeric or binary) is required' });
  } else {
    // Weight sum must be 100.0 ± 0.01
    if (Math.abs(scoringWeightSum - 100) > 0.01) {
      errors.push({
        field: 'criteria',
        message: `Scoring criteria weights must sum to 100 (±0.01). Got: ${scoringWeightSum.toFixed(2)}`,
      });
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// TemplateService
// ---------------------------------------------------------------------------

export class TemplateService {
  constructor(private readonly db: PrismaClient) {}

  async list(tenantId: number, includeInactive = false) {
    return this.db.scorecardTemplate.findMany({
      where: {
        tenantId: BigInt(tenantId),
        ...(includeInactive ? {} : { active: true }),
      },
      select: {
        id: true, name: true, description: true, version: true,
        active: true, parentId: true, createdAt: true, updatedAt: true,
        creator: { select: { id: true, fullName: true, username: true } },
      },
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
    });
  }

  async getById(id: bigint, tenantId: number) {
    return this.db.scorecardTemplate.findFirst({
      where: { id, tenantId: BigInt(tenantId) },
      include: {
        creator: { select: { id: true, fullName: true, username: true } },
        parent: { select: { id: true, name: true, version: true } },
        children: { select: { id: true, name: true, version: true, active: true } },
      },
    });
  }

  async create(params: {
    tenantId: number;
    name: string;
    description?: string | null;
    criteria: ScorecardCriterion[];
    createdBy: number;
  }) {
    const errors = validateCriteria(params.criteria);
    if (errors.length > 0) throw new TemplateValidationError(422, 'Invalid criteria', errors);

    return this.db.scorecardTemplate.create({
      data: {
        tenantId: BigInt(params.tenantId),
        name: params.name,
        description: params.description ?? null,
        criteria: params.criteria as unknown as import('@prisma/client').Prisma.InputJsonValue,
        createdBy: BigInt(params.createdBy),
      },
    });
  }

  async update(params: {
    id: bigint;
    tenantId: number;
    name?: string;
    description?: string | null;
    criteria?: ScorecardCriterion[];
    updatedBy: number;
  }) {
    const existing = await this.db.scorecardTemplate.findFirst({
      where: { id: params.id, tenantId: BigInt(params.tenantId) },
    });
    if (!existing) throw new TemplateValidationError(404, 'Template not found');
    if (!existing.active) throw new TemplateValidationError(409, 'Template is archived');

    const criteria = params.criteria ?? (existing.criteria as unknown as ScorecardCriterion[]);
    if (params.criteria) {
      const errors = validateCriteria(params.criteria);
      if (errors.length > 0) throw new TemplateValidationError(422, 'Invalid criteria', errors);
    }

    // Check if this template has any finalized scorecards → must version
    const finalizedCount = await this.db.callScorecard.count({
      where: { templateId: params.id, status: 'finalized' },
    });

    if (finalizedCount > 0) {
      // Create new version, archive old
      const newTemplate = await this.db.scorecardTemplate.create({
        data: {
          tenantId: BigInt(params.tenantId),
          parentId: params.id,
          version: existing.version + 1,
          name: params.name ?? existing.name,
          description: params.description !== undefined ? params.description : existing.description,
          criteria: criteria as unknown as import('@prisma/client').Prisma.InputJsonValue,
          createdBy: BigInt(params.updatedBy),
          active: true,
        },
      });
      // Archive old
      await this.db.scorecardTemplate.update({
        where: { id: params.id },
        data: { active: false },
      });
      return { template: newTemplate, versioned: true };
    }

    // In-place update
    const updated = await this.db.scorecardTemplate.update({
      where: { id: params.id },
      data: {
        name: params.name ?? existing.name,
        description: params.description !== undefined ? params.description : existing.description,
        criteria: criteria as unknown as import('@prisma/client').Prisma.InputJsonValue,
      },
    });
    return { template: updated, versioned: false };
  }

  async deactivate(id: bigint, tenantId: number) {
    const existing = await this.db.scorecardTemplate.findFirst({
      where: { id, tenantId: BigInt(tenantId) },
    });
    if (!existing) throw new TemplateValidationError(404, 'Template not found');

    return this.db.scorecardTemplate.update({
      where: { id },
      data: { active: false },
    });
  }
}
