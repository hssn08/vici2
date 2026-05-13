/**
 * api/src/routes/admin/rnd/usage.ts
 *
 * N06 — GET /api/admin/rnd/usage
 * Monthly cost breakdown for RND queries.
 *
 * Permission: rnd:scrub
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPrisma } from '../../../lib/prisma.js';
import { TIER_SPECS, type RndTierKey } from '../../../services/rnd/cost-estimator.js';

type AuthReq = FastifyRequest & {
  auth?: { uid: number; tenantId: number; role: string };
};

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2024).max(2099).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});

export async function handleGetUsage(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = getAuth(req);
  const tenantId = BigInt(auth.tenantId);
  const db = getPrisma();

  const queryParsed = QuerySchema.safeParse(req.query);
  if (!queryParsed.success) {
    return reply.code(400).send({ error: 'validation_error', details: queryParsed.error.issues });
  }

  const now = new Date();
  const year = queryParsed.data.year ?? now.getFullYear();
  const month = queryParsed.data.month ?? (now.getMonth() + 1);

  const [config, usage] = await Promise.all([
    db.tenantRndConfig.findUnique({ where: { tenantId } }),
    db.rndUsageLog.findUnique({
      where: {
        tenantId_periodYear_periodMonth: { tenantId, periodYear: year, periodMonth: month },
      },
    }),
  ]);

  const tier = (config?.tier ?? 'xs') as RndTierKey;
  const tierSpec = TIER_SPECS[tier];
  const queriesCount = usage?.queriesCount ?? 0;
  const estimatedCostCents = usage?.estimatedCostCents ?? 0;
  const budgetCents = config?.monthlyBudgetCents ?? null;

  const tierMonthlyCapDisplay = tierSpec.monthlyCapQueries === Infinity
    ? null
    : tierSpec.monthlyCapQueries;
  const tierRemaining = tierMonthlyCapDisplay !== null
    ? Math.max(0, tierMonthlyCapDisplay - queriesCount)
    : null;

  return reply.code(200).send({
    period: `${year}-${String(month).padStart(2, '0')}`,
    queries_count: queriesCount,
    estimated_cost_cents: estimatedCostCents,
    scrub_job_count: usage?.scrubJobCount ?? 0,
    budget_cents: budgetCents,
    budget_remaining_cents: budgetCents !== null
      ? Math.max(0, budgetCents - estimatedCostCents)
      : null,
    tier,
    tier_monthly_cap: tierMonthlyCapDisplay,
    tier_remaining: tierRemaining,
    tier_monthly_fee_cents: tierSpec.monthlyFeeCents,
  });
}
