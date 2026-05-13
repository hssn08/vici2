// D05 — DNC hot-path check (TS / API side).
//
// Algorithm per PLAN §2.1:
//  1. Validate phone format.
//  2. Pipeline BF.EXISTS across sources (one RTT).
//  3. On all-negative → return IsDNC=false (typical case).
//  4. For positive sources → MySQL confirmation query.
//  5. Return result + emit metrics.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRedis = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrisma = any;
import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  type CheckRequest,
  type CheckResult,
  type DncSource,
  sortSourcesByPriority,
} from "./types.js";
import { bloomMexistsPipeline } from "./bloom.js";

// ── MySQL confirmation ────────────────────────────────────────────────────────

interface DncRow {
  source: string;
  state: string;
  campaign_id: string;
}

async function confirmMySQL(
  prisma: AnyPrisma,
  phone: string,
  tenantId: number,
  campaignId: string | undefined,
  leadState: string | undefined,
  positiveSources: DncSource[],
): Promise<DncSource[]> {
  // Build raw SQL per PLAN §2.1 step 4
  const sourceList = positiveSources.map((s) => `'${s}'`).join(",");
  const campId = campaignId ?? "__GLOBAL__";
  const st = leadState ?? "__";

   
  const rows: DncRow[] = await prisma.$queryRawUnsafe(
    `SELECT source, state, campaign_id FROM dnc
     WHERE phone_e164 = ?
       AND tenant_id IN (?, 0)
       AND source IN (${sourceList})
       AND (
             source = 'federal'
          OR source = 'litigator'
          OR (source = 'internal' AND tenant_id = ?
                AND campaign_id IN ('__GLOBAL__', ?))
          OR (source = 'state' AND tenant_id = 0
                AND state IN (?, '__'))
       )
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 4`,
    phone,
    tenantId,
    tenantId,
    campId,
    st,
  );

   
  return [...new Set(rows.map((r) => r.source as DncSource))];
}

// ── Normalize phone ───────────────────────────────────────────────────────────

function normalizePhone(raw: string): string | null {
  // Accept E.164 or local; re-validate
  const parsed = parsePhoneNumberFromString(raw, "US");
  if (!parsed || !parsed.isValid()) return null;
  return parsed.format("E.164"); // "+1XXXXXXXXXX"
}

// ── Main Check ────────────────────────────────────────────────────────────────

export async function dncCheck(
  redis: AnyRedis,
  prisma: AnyPrisma,
  req: CheckRequest,
): Promise<CheckResult> {
  const start = process.hrtime.bigint();

  // Step 1: validate phone
  const phone = normalizePhone(req.phoneE164);
  if (!phone) {
    return {
      isDnc: true,
      sources: [],
      latencyMicros: Number(process.hrtime.bigint() - start) / 1000,
      bloomFalsePositive: false,
      reason: "malformed",
    };
  }

  // Step 2: Bloom pipeline
  const bloomHits = await bloomMexistsPipeline(
    redis,
    req.sources,
    req.tenantId,
    phone,
  );

  const positiveSources = req.sources.filter((s) => bloomHits.get(s) === true);

  const latencyAfterBloom = Number(process.hrtime.bigint() - start) / 1000;

  // Step 3: all-negative → fast path
  if (positiveSources.length === 0) {
    return {
      isDnc: false,
      sources: [],
      latencyMicros: latencyAfterBloom,
      bloomFalsePositive: false,
    };
  }

  // Step 4: MySQL confirmation
  let confirmedSources: DncSource[] = [];
  try {
    confirmedSources = await confirmMySQL(
      prisma,
      phone,
      req.tenantId,
      req.campaignId,
      req.leadState,
      positiveSources,
    );
  } catch {
    // MySQL unreachable on positive bloom — fail-closed (PLAN §1.5)
    confirmedSources = positiveSources;
  }

  const latencyTotal = Number(process.hrtime.bigint() - start) / 1000;
  const bloomFp = positiveSources.length > 0 && confirmedSources.length === 0;

  // Step 5: result
  if (confirmedSources.length === 0) {
    return {
      isDnc: false,
      sources: [],
      latencyMicros: latencyTotal,
      bloomFalsePositive: bloomFp,
    };
  }

  return {
    isDnc: true,
    sources: sortSourcesByPriority(confirmedSources),
    latencyMicros: latencyTotal,
    bloomFalsePositive: false,
  };
}
