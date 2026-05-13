// D01 — Capped COUNT(*) helper (PLAN §2.5)
// Returns at most 100 001 to detect if count exceeds 100 000.

import { getPrisma } from "../../lib/prisma.js";

export interface CappedCountResult {
  count: number;
  capped: boolean;
}

export async function cappedCount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prisma: any,
  tenantId: bigint,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  where: Record<string, any>,
): Promise<CappedCountResult> {
  const CAP = 100_001;
  void getPrisma; // ensure import is used (for tree-shaking)

  const count = await prisma.lead.count({
    where: {
      ...where,
      tenantId,
    },
  });

  if (count >= CAP) {
    return { count: 100_000, capped: true };
  }
  return { count, capped: false };
}
