/**
 * workers/src/jobs/rnd-scrub/result-writer.ts
 *
 * N06 — Writes RND query results:
 *   1. Inserts rows into rnd_lookup_log
 *   2. Inserts DNC entries for 'yes' results (source='reassigned')
 *   3. Increments rnd_scrub_job counters
 *   4. Emits audit events for each flagged number
 */

import type { PrismaClient } from '@prisma/client';
import type { RndResultItem } from './client-types.js';
import type { PhoneWithConsent } from './batcher.js';
import { maskPhone } from './util.js';

export interface WriteResult {
  yesCount: number;
  noCount: number;
  noDataCount: number;
  errorCount: number;
  dncInserted: number;
}

export interface WriterAuditFn {
  (
    tenantId: bigint,
    action: string,
    data: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Write a batch of RND results to the database.
 */
export async function writeResults(params: {
  db: PrismaClient;
  tenantId: bigint;
  scrubJobId: string;
  campaignId: string;
  results: RndResultItem[];
  originals: PhoneWithConsent[];
  noDataPolicy: 'safe' | 'block';
  audit: WriterAuditFn;
}): Promise<WriteResult> {
  const { db, tenantId, scrubJobId, results, originals, noDataPolicy, audit } = params;

  const originalMap = new Map(originals.map((p) => [p.phoneE164, p]));
  let yesCount = 0;
  let noCount = 0;
  let noDataCount = 0;
  let errorCount = 0;
  let dncInserted = 0;

  // Build lookup log rows
  const lookupRows: Parameters<typeof db.rndLookupLog.createMany>[0]['data'] = [];
  const dncNumbers: Array<{ phoneE164: string; disconnectDate: string | null; asOf: string }> = [];

  for (const r of results) {
    const orig = originalMap.get(r.tn);
    const now = new Date();
    const isDncCandidate =
      r.result === 'yes' || (r.result === 'no_data' && noDataPolicy === 'block');

    lookupRows.push({
      tenantId,
      scrubJobId,
      phoneE164: r.tn,
      consentDate: orig?.consentDate ?? now,
      consentDateSrc: orig?.consentDateSrc ?? 'fallback',
      result: r.result,
      disconnectDate: r.disconnect_date ? new Date(r.disconnect_date) : null,
      queriedAt: new Date(r.queried_at),
      dncInserted: isDncCandidate,
    });

    if (r.result === 'yes') {
      yesCount++;
      dncNumbers.push({
        phoneE164: r.tn,
        disconnectDate: r.disconnect_date,
        asOf: orig ? formatDate(orig.consentDate) : 'unknown',
      });
      dncInserted++;

      // Emit per-number audit event
      await audit(tenantId, 'rnd.number.flagged_reassigned', {
        phoneE164Masked: maskPhone(r.tn),
        disconnectDate: r.disconnect_date,
        scrubJobId,
        consentDateSrc: orig?.consentDateSrc ?? 'fallback',
      });
    } else if (r.result === 'no') {
      noCount++;
    } else if (r.result === 'no_data') {
      noDataCount++;
      if (noDataPolicy === 'block') {
        dncNumbers.push({
          phoneE164: r.tn,
          disconnectDate: null,
          asOf: orig ? formatDate(orig.consentDate) : 'unknown',
        });
        dncInserted++;
      }
    } else {
      errorCount++;
    }
  }

  // Batch-insert lookup logs
  if (lookupRows.length > 0) {
    await db.rndLookupLog.createMany({
      data: lookupRows,
      skipDuplicates: true,
    });
  }

  // DNC insertions for reassigned numbers
  if (dncNumbers.length > 0) {
    const values = dncNumbers
      .map(
        (n) =>
          `(${BigInt(tenantId)}, '${escapeSql(n.phoneE164)}', 'reassigned', '__', '__GLOBAL__',` +
          ` 'RND:Yes:disconnect=${n.disconnectDate ?? 'unknown'}:as_of=${n.asOf}', NOW(6), NULL, NULL)`,
      )
      .join(', ');

    await db.$executeRawUnsafe(
      `INSERT IGNORE INTO dnc (tenant_id, phone_e164, source, state, campaign_id, notes, added_at, added_by, expires_at)` +
        ` VALUES ${values}`,
    );
  }

  // Update scrub job counters
  await db.rndScrubJob.update({
    where: { id: scrubJobId },
    data: {
      phonesQueried: { increment: results.length },
      phonesYes: { increment: yesCount },
      phonesNo: { increment: noCount },
      phonesNoData: { increment: noDataCount },
      phonesError: { increment: errorCount },
    },
  });

  return { yesCount, noCount, noDataCount, errorCount, dncInserted };
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "\\'");
}
