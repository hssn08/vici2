/**
 * api/src/services/rnd/rnd-service.ts
 *
 * N06 — RND business logic:
 *   - Resolve consent dates for phones (pewc → ebr → inferred → fallback)
 *   - Budget pre-flight check
 *   - Decrypt stored RND credentials (F05 KEK)
 *   - Build RndClient from tenant config
 */

import type { PrismaClient } from '@prisma/client';
import { decrypt } from '../../auth/encryption.js';
import { buildRndClient, type RndClient, type RndRedisClient } from '../../integrations/rnd/client.js';
import { estimateCostCents, estimateDurationSeconds, type RndTierKey } from './cost-estimator.js';

export interface PhoneWithConsent {
  phoneE164: string;
  consentDate: Date;
  consentDateSrc: 'pewc' | 'ebr' | 'inferred' | 'fallback';
}

export interface BudgetCheckResult {
  allowed: boolean;
  estimatedCostCents: number;
  estimatedDurationSeconds: number;
  budgetCents: number | null;
  budgetRemainingCents: number | null;
  queriesUsedThisMonth: number;
}

/**
 * Mask a phone number E.164 for audit logs: show last 4 digits only.
 * e.g. +12025551234 → +1202551****  (shows country code + area + last 4)
 */
export function maskPhone(e164: string): string {
  if (e164.length <= 4) return '****';
  return e164.slice(0, e164.length - 4) + '****';
}

/**
 * Fetch all active phones for a campaign, resolving their consent dates.
 * Falls back to campaign-launch date if no consent record found.
 */
export async function fetchActivePhonesForCampaign(
  db: PrismaClient,
  tenantId: bigint,
  campaignId: string,
): Promise<PhoneWithConsent[]> {
  // Get all leads in this campaign that are not already in DNC (reassigned source)
  const leads = await db.$queryRaw<
    Array<{ phone_number: string; consent_date: Date | null; consent_date_src: string | null }>
  >`
    SELECT DISTINCT
      l.phone_number,
      cl.consent_date,
      cl.consent_date_src
    FROM leads l
    JOIN campaign_lists clist ON clist.list_id = l.list_id AND clist.campaign_id = ${campaignId}
    LEFT JOIN consent_log cl ON cl.phone_e164 = l.phone_number
      AND cl.tenant_id = ${tenantId}
      AND cl.consent_date IS NOT NULL
    WHERE l.tenant_id = ${tenantId}
      AND l.phone_number IS NOT NULL
      AND l.phone_number != ''
      AND l.phone_number NOT IN (
        SELECT phone_e164 FROM dnc
        WHERE tenant_id = ${tenantId}
          AND source = 'reassigned'
      )
    ORDER BY l.phone_number, cl.consent_date DESC
  `;

  // Deduplicate (take first consent record per phone)
  const seen = new Set<string>();
  const result: PhoneWithConsent[] = [];
  const fallbackDate = new Date();
  fallbackDate.setFullYear(fallbackDate.getFullYear() - 1); // 1 year ago as fallback

  for (const row of leads) {
    if (seen.has(row.phone_number)) continue;
    seen.add(row.phone_number);

    let consentDate: Date;
    let consentDateSrc: PhoneWithConsent['consentDateSrc'];

    if (row.consent_date) {
      consentDate = row.consent_date;
      consentDateSrc = (row.consent_date_src as PhoneWithConsent['consentDateSrc']) ?? 'inferred';
    } else {
      consentDate = fallbackDate;
      consentDateSrc = 'fallback';
    }

    result.push({ phoneE164: row.phone_number, consentDate, consentDateSrc });
  }

  return result;
}

/**
 * Check if a scrub job would exceed the monthly budget.
 */
export async function checkBudget(
  db: PrismaClient,
  tenantId: bigint,
  phoneCount: number,
): Promise<BudgetCheckResult> {
  const config = await db.tenantRndConfig.findUnique({ where: { tenantId } });
  if (!config) {
    return {
      allowed: false,
      estimatedCostCents: 0,
      estimatedDurationSeconds: 0,
      budgetCents: null,
      budgetRemainingCents: null,
      queriesUsedThisMonth: 0,
    };
  }

  const now = new Date();
  const usage = await db.rndUsageLog.findUnique({
    where: {
      tenantId_periodYear_periodMonth: {
        tenantId,
        periodYear: now.getFullYear(),
        periodMonth: now.getMonth() + 1,
      },
    },
  });

  const queriesUsed = usage?.queriesCount ?? 0;
  const estimatedCostCents = estimateCostCents(
    config.tier as RndTierKey,
    phoneCount,
    queriesUsed,
  );
  const estimatedDurationSeconds = estimateDurationSeconds(phoneCount);

  let allowed = true;
  let budgetRemainingCents: number | null = null;

  if (config.monthlyBudgetCents !== null) {
    const usedCostCents = usage?.estimatedCostCents ?? 0;
    budgetRemainingCents = config.monthlyBudgetCents - usedCostCents;
    if (estimatedCostCents > budgetRemainingCents) {
      allowed = false;
    }
  }

  return {
    allowed,
    estimatedCostCents,
    estimatedDurationSeconds,
    budgetCents: config.monthlyBudgetCents,
    budgetRemainingCents,
    queriesUsedThisMonth: queriesUsed,
  };
}

/**
 * Decrypt tenant RND client secret from the stored encrypted blob.
 * Uses F05's AES-256-GCM envelope encryption (decrypt function).
 */
export function decryptClientSecret(
  tenantId: bigint,
  enc: Uint8Array,
): string {
  return decrypt({
    table: 'tenant_rnd_config',
    column: 'client_secret_enc',
    rowId: tenantId,
    tenantId,
    ciphertextBlob: enc,
  }).toString('utf-8');
}

/**
 * Build an RndClient for the given tenant, loading + decrypting credentials.
 */
export async function buildRndClientForTenant(
  db: PrismaClient,
  tenantId: bigint,
  redis: RndRedisClient,
): Promise<RndClient> {
  const config = await db.tenantRndConfig.findUnique({ where: { tenantId } });
  if (!config || !config.isActive) {
    // Return mock client if not configured/active
    return buildRndClient({ tenantId, clientId: '', clientSecret: '', redis });
  }

  const clientSecret = decryptClientSecret(tenantId, config.clientSecretEnc);
  return buildRndClient({
    tenantId,
    clientId: config.clientId,
    clientSecret,
    redis,
  });
}

/**
 * Update the monthly usage log after a scrub batch.
 */
export async function updateUsageLog(
  db: PrismaClient,
  tenantId: bigint,
  queriesCount: number,
  costCents: number,
): Promise<void> {
  const now = new Date();
  await db.rndUsageLog.upsert({
    where: {
      tenantId_periodYear_periodMonth: {
        tenantId,
        periodYear: now.getFullYear(),
        periodMonth: now.getMonth() + 1,
      },
    },
    create: {
      tenantId,
      periodYear: now.getFullYear(),
      periodMonth: now.getMonth() + 1,
      queriesCount,
      estimatedCostCents: costCents,
      scrubJobCount: 1,
    },
    update: {
      queriesCount: { increment: queriesCount },
      estimatedCostCents: { increment: costCents },
    },
  });
}
