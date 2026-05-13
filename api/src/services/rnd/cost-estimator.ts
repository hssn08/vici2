/**
 * api/src/services/rnd/cost-estimator.ts
 *
 * N06 — RND subscription tier cost calculator.
 *
 * Pricing (FCC interim, revised 2024 — subject to FCC adjustment):
 *   xs     ≤100K/mo  ~$45/mo   $0.00045/overage
 *   small  ≤500K/mo  ~$110/mo  $0.00022/overage
 *   medium ≤1M/mo    ~$175/mo  $0.000175/overage
 *   large  ≤5M/mo    ~$600/mo  $0.00012/overage
 *   xl     ≤10M/mo   ~$1000/mo $0.0001/overage
 *   jumbo  >10M/mo   ~$2000/mo $0.00008/overage
 */

export type RndTierKey = 'xs' | 'small' | 'medium' | 'large' | 'xl' | 'jumbo';

export interface TierSpec {
  monthlyCapQueries: number;
  monthlyFeeCents: number;
  overagePricePerQueryCents: number;
}

export const TIER_SPECS: Record<RndTierKey, TierSpec> = {
  xs:     { monthlyCapQueries: 100_000,    monthlyFeeCents:  4500, overagePricePerQueryCents: 0.045 },
  small:  { monthlyCapQueries: 500_000,    monthlyFeeCents: 11000, overagePricePerQueryCents: 0.022 },
  medium: { monthlyCapQueries: 1_000_000,  monthlyFeeCents: 17500, overagePricePerQueryCents: 0.0175 },
  large:  { monthlyCapQueries: 5_000_000,  monthlyFeeCents: 60000, overagePricePerQueryCents: 0.012 },
  xl:     { monthlyCapQueries: 10_000_000, monthlyFeeCents: 100_000, overagePricePerQueryCents: 0.01 },
  jumbo:  { monthlyCapQueries: Infinity,   monthlyFeeCents: 200_000, overagePricePerQueryCents: 0.008 },
};

/**
 * Estimate the incremental cost in cents for `queryCount` additional queries
 * given the tier and how many queries have already been used this month.
 */
export function estimateCostCents(
  tier: RndTierKey,
  queryCount: number,
  queriesUsedThisMonth: number,
): number {
  if (queryCount <= 0) return 0;
  const spec = TIER_SPECS[tier];
  const cap = spec.monthlyCapQueries;
  const alreadyUsed = queriesUsedThisMonth;
  const remaining = Math.max(0, cap - alreadyUsed);

  if (remaining >= queryCount) {
    // All queries fit within the tier cap — cost is 0 incremental
    return 0;
  }

  // Some or all are overage
  const overageCount = queryCount - remaining;
  return Math.ceil(overageCount * spec.overagePricePerQueryCents);
}

/**
 * Estimate duration for an API-mode scrub (respecting 100 req/60s rate limit).
 */
export function estimateDurationSeconds(phoneCount: number): number {
  if (phoneCount <= 0) return 0;
  const batchCount = Math.ceil(phoneCount / 1000);
  // 100 batches per 60 seconds = 1.67 batches/sec → 0.6s per batch minimum
  // Add 2s per batch for DB writes and network
  const minSeconds = Math.ceil((batchCount / 100) * 60);
  const dbSeconds = batchCount * 2;
  return minSeconds + dbSeconds;
}
