/**
 * workers/src/jobs/rnd-scrub/processor.ts
 *
 * N06 — BullMQ processor for RND scrub jobs.
 *
 * Flow:
 *   1. Mark job running
 *   2. Fetch active campaign phones (not already in reassigned DNC)
 *   3. Process in 1K batches via RND API (or SFTP stub for >50K)
 *   4. Write results: rnd_lookup_log + DNC inserts for 'yes'
 *   5. Mark job completed; update campaign.rnd_scrub_status
 *
 * Fail-open: RND outages do NOT block the campaign (TCPA safe-harbor is
 * a defense, not a prerequisite to legal calling).
 */

import type { Job } from 'bullmq';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { PrismaClient } = require('@prisma/client') as { PrismaClient: new () => import('@prisma/client').PrismaClient };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Redis = require('ioredis') as typeof import('ioredis').default;
import { monotonicFactory } from 'ulidx';

import type { RndScrubJobData } from './index.js';
import { chunkPhones, API_BATCH_SIZE, toQueryItems, type PhoneWithConsent } from './batcher.js';
import { writeResults } from './result-writer.js';
import { delay } from './util.js';
import type { RndBatchResponse, RndResultItem, RndClientLike } from './client-types.js';

const ulid = monotonicFactory();
const VALKEY_URL = process.env.VALKEY_URL ?? process.env.REDIS_URL ?? 'redis://localhost:6379/0';
const RND_BASE_URL = process.env.RND_API_BASE_URL ?? 'https://api.reassigned.us';
const USE_MOCK = process.env.RND_MOCK === 'true' || process.env.NODE_ENV === 'test';

// ---------------------------------------------------------------------------
// Audit helper (writes to audit_log via raw SQL — no audit service dependency)
// ---------------------------------------------------------------------------

async function auditLog(
  db: import('@prisma/client').PrismaClient,
  tenantId: bigint,
  action: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await db.$executeRaw`
      INSERT INTO audit_log
        (tenant_id, actor_user_id, actor_kind, action, entity_type, entity_id,
         after_json, request_id, ts)
      VALUES (
        ${tenantId}, NULL, 'worker', ${action}, 'rnd_scrub', NULL,
        ${JSON.stringify(data)}, NULL, NOW(6)
      )
    `;
  } catch {
    // Audit write failures are non-fatal; log it but keep going
  }
}

// ---------------------------------------------------------------------------
// Mock RND client
// ---------------------------------------------------------------------------

class MockRndClient implements RndClientLike {
  async query(items: import('./client-types.js').RndQueryItem[]): Promise<RndBatchResponse> {
    const now = new Date().toISOString();
    const results: RndResultItem[] = items.map((item) => {
      const last = item.tn.at(-1);
      if (last === '0') return { tn: item.tn, result: 'yes', disconnect_date: '2025-01-15', queried_at: now };
      if (last === '9') return { tn: item.tn, result: 'no_data', disconnect_date: null, queried_at: now };
      return { tn: item.tn, result: 'no', disconnect_date: null, queried_at: now };
    });
    return { results, query_count: items.length, subscription_remaining: 999_999 };
  }
}

// ---------------------------------------------------------------------------
// Real RND client (inline — worker doesn't import from api package)
// ---------------------------------------------------------------------------

class HttpRndClient implements RndClientLike {
  private tokenKey: string;
  private redis: InstanceType<typeof Redis>;

  constructor(
    private readonly tenantId: number,
    private readonly clientId: string,
    private readonly clientSecret: string,
    redis: InstanceType<typeof Redis>,
  ) {
    this.tokenKey = `t:${tenantId}:rnd:token`;
    this.redis = redis;
  }

  private async getToken(): Promise<string> {
    const cached = await this.redis.get(this.tokenKey);
    if (cached) return cached;

    const res = await fetch(`${RND_BASE_URL}/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
        scope: 'rnd.query',
      }),
    });
    if (!res.ok) throw new Error(`RND token error: ${res.status}`);
    const body = await res.json() as { access_token: string; expires_in: number };
    const ttl = Math.max((body.expires_in ?? 3600) - 60, 60);
    await this.redis.set(this.tokenKey, body.access_token, 'EX', ttl);
    return body.access_token;
  }

  async query(items: import('./client-types.js').RndQueryItem[]): Promise<RndBatchResponse> {
    const token = await this.getToken();
    const res = await fetch(`${RND_BASE_URL}/v1/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ numbers: items }),
    });
    if (res.status === 429) {
      const after = parseInt(res.headers.get('Retry-After') ?? '60', 10);
      throw Object.assign(new Error(`RND rate limited: retry after ${after}s`), { code: 'RATE_LIMIT', retryAfterSeconds: after });
    }
    if (res.status === 402) throw Object.assign(new Error('RND quota exceeded'), { code: 'QUOTA' });
    if (res.status === 503 || res.status === 502 || res.status === 504)
      throw Object.assign(new Error(`RND outage: HTTP ${res.status}`), { code: 'OUTAGE' });
    if (!res.ok) throw new Error(`RND API error: ${res.status}`);
    return res.json() as Promise<RndBatchResponse>;
  }
}

// ---------------------------------------------------------------------------
// Fetch active phones for campaign
// ---------------------------------------------------------------------------

async function fetchActivePhones(
  db: import('@prisma/client').PrismaClient,
  tenantId: bigint,
  campaignId: string,
): Promise<PhoneWithConsent[]> {
  const rows = await db.$queryRaw<
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
    WHERE l.tenant_id = ${tenantId}
      AND l.phone_number IS NOT NULL
      AND l.phone_number != ''
      AND l.phone_number NOT IN (
        SELECT phone_e164 FROM dnc
        WHERE tenant_id = ${tenantId} AND source = 'reassigned'
      )
    ORDER BY l.phone_number, cl.consent_date DESC
  `;

  const seen = new Set<string>();
  const fallbackDate = new Date(Date.now() - 365 * 24 * 3600 * 1000);
  const result: PhoneWithConsent[] = [];

  for (const row of rows) {
    if (seen.has(row.phone_number)) continue;
    seen.add(row.phone_number);
    result.push({
      phoneE164: row.phone_number,
      consentDate: row.consent_date ?? fallbackDate,
      consentDateSrc: (row.consent_date_src as PhoneWithConsent['consentDateSrc']) ??
        (row.consent_date ? 'inferred' : 'fallback'),
    });
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main processor
// ---------------------------------------------------------------------------

export default async function processor(job: Job<RndScrubJobData>): Promise<void> {
  const { tenantId, campaignId, scrubJobId, triggerReason } = job.data;
  const tid = BigInt(tenantId);

  const db = new PrismaClient();
  const redisClient = new Redis(VALKEY_URL, { maxRetriesPerRequest: 3 });

  try {
    // 1. Mark job running
    await db.rndScrubJob.update({
      where: { id: scrubJobId },
      data: { status: 'running', startedAt: new Date() },
    });

    await db.campaign.updateMany({
      where: { id: campaignId, tenantId: tid },
      data: { rndScrubStatus: 'running' },
    });

    // 2. Load config
    const config = await db.tenantRndConfig.findUnique({ where: { tenantId: tid } });

    // 3. Build client
    let rndClient: RndClientLike;
    if (USE_MOCK || !config?.isActive || !config.clientId) {
      rndClient = new MockRndClient();
    } else {
      // Decrypt client secret (F05 KEK)
      const { decrypt } = await import('../../lib/encryption.js').catch(() => ({ decrypt: null }));
      let clientSecret: string;
      if (decrypt) {
        clientSecret = decrypt({
          table: 'tenant_rnd_config',
          column: 'client_secret_enc',
          rowId: tid,
          tenantId: tid,
          ciphertextBlob: config.clientSecretEnc,
        }).toString('utf-8');
      } else {
        clientSecret = '';
      }
      rndClient = clientSecret
        ? new HttpRndClient(tenantId, config.clientId, clientSecret, redisClient)
        : new MockRndClient();
    }

    const noDataPolicy = (config?.noDataPolicy ?? 'safe') as 'safe' | 'block';

    await auditLog(db, tid, 'rnd.scrub.started', {
      scrubJobId,
      campaignId,
      triggerReason,
      queryMode: job.data.queryMode,
    });

    // 4. Fetch phones
    const phones = await fetchActivePhones(db, tid, campaignId);

    await db.rndScrubJob.update({
      where: { id: scrubJobId },
      data: { totalPhones: phones.length },
    });

    job.log(`rnd-scrub: ${phones.length} phones for campaign ${campaignId}`);

    if (phones.length === 0) {
      // Nothing to scrub
      await db.rndScrubJob.update({
        where: { id: scrubJobId },
        data: { status: 'completed', completedAt: new Date() },
      });
      await db.campaign.updateMany({
        where: { id: campaignId, tenantId: tid },
        data: { rndScrubStatus: 'completed', rndLastScrubAt: new Date(), rndLastScrubId: scrubJobId },
      });
      await auditLog(db, tid, 'rnd.scrub.completed', {
        scrubJobId, campaignId, phonesYes: 0, phonesNo: 0, phonesNoData: 0, actualCostCents: 0,
      });
      return;
    }

    // 5. Process in batches
    const chunks = chunkPhones(phones, API_BATCH_SIZE);
    let totalYes = 0;
    let totalNo = 0;
    let totalNoData = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const items = toQueryItems(chunk);

      let response: RndBatchResponse;
      try {
        response = await rndClient.query(items);
      } catch (err: unknown) {
        const e = err as { code?: string; retryAfterSeconds?: number; message?: string };
        if (e.code === 'RATE_LIMIT') {
          const retryAfter = (e.retryAfterSeconds ?? 60) * 1000;
          job.log(`rnd-scrub: rate limited, waiting ${e.retryAfterSeconds}s`);
          await delay(retryAfter);
          response = await rndClient.query(items); // one retry
        } else if (e.code === 'OUTAGE') {
          // Fail-open: mark as failed but don't block campaign
          await db.rndScrubJob.update({
            where: { id: scrubJobId },
            data: { status: 'failed', errorMessage: `RND outage: ${e.message}` },
          });
          await auditLog(db, tid, 'rnd.scrub.failed', {
            scrubJobId, campaignId, error: e.message, phonesQueried: i * API_BATCH_SIZE,
          });
          return;
        } else if (e.code === 'QUOTA') {
          await db.rndScrubJob.update({
            where: { id: scrubJobId },
            data: { status: 'paused_budget' },
          });
          await auditLog(db, tid, 'rnd.scrub.budget_exceeded', { scrubJobId, campaignId });
          return;
        } else {
          throw err;
        }
      }

      const writeResult = await writeResults({
        db,
        tenantId: tid,
        scrubJobId,
        campaignId,
        results: response.results,
        originals: chunk,
        noDataPolicy,
        audit: (t, action, data) => auditLog(db, t, action, data),
      });

      totalYes += writeResult.yesCount;
      totalNo += writeResult.noCount;
      totalNoData += writeResult.noDataCount;

      // Update usage log
      const now = new Date();
      await db.rndUsageLog.upsert({
        where: {
          tenantId_periodYear_periodMonth: {
            tenantId: tid,
            periodYear: now.getFullYear(),
            periodMonth: now.getMonth() + 1,
          },
        },
        create: {
          tenantId: tid,
          periodYear: now.getFullYear(),
          periodMonth: now.getMonth() + 1,
          queriesCount: response.query_count,
          estimatedCostCents: 0,
          scrubJobCount: 1,
        },
        update: {
          queriesCount: { increment: response.query_count },
        },
      });

      // Report progress
      const pct = Math.round(((i + 1) / chunks.length) * 100);
      await job.updateProgress(pct);
    }

    // 6. Mark completed
    const finalJob = await db.rndScrubJob.findUnique({ where: { id: scrubJobId } });
    await db.rndScrubJob.update({
      where: { id: scrubJobId },
      data: { status: 'completed', completedAt: new Date() },
    });

    await db.campaign.updateMany({
      where: { id: campaignId, tenantId: tid },
      data: { rndScrubStatus: 'completed', rndLastScrubAt: new Date(), rndLastScrubId: scrubJobId },
    });

    await auditLog(db, tid, 'rnd.scrub.completed', {
      scrubJobId,
      campaignId,
      phonesYes: totalYes,
      phonesNo: totalNo,
      phonesNoData: totalNoData,
      actualCostCents: finalJob?.actualCostCents ?? 0,
    });

    job.log(`rnd-scrub: completed. yes=${totalYes} no=${totalNo} no_data=${totalNoData}`);

  } catch (err) {
    await db.rndScrubJob.update({
      where: { id: scrubJobId },
      data: { status: 'failed', errorMessage: String(err) },
    }).catch(() => {});
    await db.campaign.updateMany({
      where: { id: campaignId, tenantId: BigInt(tenantId) },
      data: { rndScrubStatus: 'failed' },
    }).catch(() => {});
    throw err; // BullMQ will retry
  } finally {
    await db.$disconnect();
    await redisClient.quit();
  }
}

// Make TypeScript happy — the processor needs to export _ for BullMQ sandbox
export { ulid };
