/**
 * api/src/routes/admin/rnd/scrub.ts
 *
 * N06 — POST /api/admin/rnd/scrub
 * Trigger a campaign RND scrub. Creates an rnd_scrub_job row and enqueues BullMQ job.
 *
 * Permission: rnd:scrub
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { Queue, type ConnectionOptions } from 'bullmq';
import { getPrisma } from '../../../lib/prisma.js';
import { getRedis } from '../../../lib/redis.js';
import { monotonicFactory } from 'ulidx';
import { checkBudget } from '../../../services/rnd/rnd-service.js';

const ulid = monotonicFactory();

const ScrubBodySchema = z.object({
  campaign_id: z.string().min(1).max(32),
  force: z.boolean().default(false),
});

type AuthReq = FastifyRequest & {
  auth?: { uid: number; tenantId: number; role: string };
};

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

let _queue: Queue | null = null;
function getRndScrubQueue(): Queue {
  if (!_queue) {
    _queue = new Queue('rnd-scrub', {
      connection: getRedis() as unknown as ConnectionOptions,
    });
  }
  return _queue;
}

export async function handleTriggerScrub(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = getAuth(req);
  const tenantId = BigInt(auth.tenantId);

  const parsed = ScrubBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: 'validation_error', details: parsed.error.issues });
  }
  const { campaign_id, force } = parsed.data;

  const db = getPrisma();

  // Verify campaign exists and belongs to tenant
  const campaign = await db.campaign.findFirst({
    where: { id: campaign_id, tenantId },
  });
  if (!campaign) {
    return reply.code(404).send({ error: 'campaign_not_found' });
  }

  // Verify RND config is active
  const config = await db.tenantRndConfig.findUnique({ where: { tenantId } });
  if (!config || !config.isActive) {
    return reply.code(422).send({
      error: 'rnd_not_configured',
      message: 'RND is not configured or not active for this tenant. Configure via PUT /api/admin/rnd/config',
    });
  }

  // Check for existing active job
  if (!force) {
    const existingJob = await db.rndScrubJob.findFirst({
      where: {
        tenantId,
        campaignId: campaign_id,
        status: { in: ['queued', 'running'] },
      },
    });
    if (existingJob) {
      return reply.code(409).send({
        error: 'scrub_already_active',
        scrub_job_id: existingJob.id,
        status: existingJob.status,
      });
    }
  }

  // Count phones for cost estimation
  const phoneCount = await db.$queryRaw<[{ cnt: bigint }]>`
    SELECT COUNT(DISTINCT l.phone_number) AS cnt
    FROM leads l
    JOIN campaign_lists clist ON clist.list_id = l.list_id AND clist.campaign_id = ${campaign_id}
    WHERE l.tenant_id = ${tenantId}
      AND l.phone_number IS NOT NULL AND l.phone_number != ''
      AND l.phone_number NOT IN (
        SELECT phone_e164 FROM dnc WHERE tenant_id = ${tenantId} AND source = 'reassigned'
      )
  `;
  const totalPhones = Number(phoneCount[0]?.cnt ?? 0);

  // Budget pre-flight check
  const budgetCheck = await checkBudget(db, tenantId, totalPhones);
  if (!budgetCheck.allowed) {
    return reply.code(402).send({
      error: 'budget_exceeded',
      estimated_cost_cents: budgetCheck.estimatedCostCents,
      budget_cents: budgetCheck.budgetCents,
      budget_remaining_cents: budgetCheck.budgetRemainingCents,
      message: 'Estimated scrub cost exceeds remaining monthly budget',
    });
  }

  // Determine query mode
  const queryMode: 'api' | 'sftp' = totalPhones > 50_000 ? 'sftp' : 'api';

  // Create job record
  const scrubJobId = ulid();
  await db.rndScrubJob.create({
    data: {
      id: scrubJobId,
      tenantId,
      campaignId: campaign_id,
      triggeredBy: BigInt(auth.uid),
      triggerReason: 'manual',
      status: 'queued',
      totalPhones,
      estimatedCostCents: budgetCheck.estimatedCostCents,
      queryMode,
    },
  });

  // Update campaign status
  await db.campaign.updateMany({
    where: { id: campaign_id, tenantId },
    data: { rndScrubStatus: 'pending' },
  });

  // Enqueue BullMQ job
  const queue = getRndScrubQueue();
  await queue.add('rnd-scrub', {
    tenantId: auth.tenantId,
    campaignId: campaign_id,
    scrubJobId,
    triggerReason: 'manual',
    triggeredByUserId: auth.uid,
    queryMode,
  }, {
    jobId: `rnd-manual:${scrubJobId}`,
    removeOnComplete: { count: 200 },
    removeOnFail: { count: 500 },
  });

  return reply.code(202).send({
    scrub_job_id: scrubJobId,
    campaign_id,
    status: 'queued',
    total_phones: totalPhones,
    query_mode: queryMode,
    estimated_cost_cents: budgetCheck.estimatedCostCents,
    estimated_duration_seconds: budgetCheck.estimatedDurationSeconds,
  });
}
