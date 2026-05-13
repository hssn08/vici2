/**
 * api/src/routes/admin/rnd/status.ts
 *
 * N06 — GET /api/admin/rnd/status/:campaign_id
 * Poll the latest scrub job progress for a campaign.
 *
 * Permission: rnd:scrub
 */

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '../../../lib/prisma.js';

type AuthReq = FastifyRequest & {
  auth?: { uid: number; tenantId: number; role: string };
};

function getAuth(req: FastifyRequest) {
  const auth = (req as AuthReq).auth;
  if (!auth) throw Object.assign(new Error('Unauthenticated'), { statusCode: 401 });
  return auth;
}

export async function handleGetStatus(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const auth = getAuth(req);
  const tenantId = BigInt(auth.tenantId);
  const params = req.params as { campaign_id: string };
  const campaignId = params.campaign_id;

  const db = getPrisma();

  // Get the latest scrub job for this campaign
  const job = await db.rndScrubJob.findFirst({
    where: { tenantId, campaignId },
    orderBy: { createdAt: 'desc' },
  });

  if (!job) {
    return reply.code(404).send({ error: 'no_scrub_job_found', campaign_id: campaignId });
  }

  const campaign = await db.campaign.findFirst({
    where: { id: campaignId, tenantId },
    select: { rndScrubStatus: true, rndLastScrubAt: true },
  });

  const progressPct =
    job.totalPhones > 0
      ? Math.round((job.phonesQueried / job.totalPhones) * 100)
      : job.status === 'completed' ? 100 : 0;

  return reply.code(200).send({
    campaign_id: campaignId,
    scrub_job_id: job.id,
    status: job.status,
    total_phones: job.totalPhones,
    phones_queried: job.phonesQueried,
    phones_yes: job.phonesYes,
    phones_no: job.phonesNo,
    phones_no_data: job.phonesNoData,
    phones_error: job.phonesError,
    progress_pct: progressPct,
    estimated_cost_cents: job.estimatedCostCents,
    actual_cost_cents: job.actualCostCents,
    query_mode: job.queryMode,
    trigger_reason: job.triggerReason,
    started_at: job.startedAt?.toISOString() ?? null,
    completed_at: job.completedAt?.toISOString() ?? null,
    error_message: job.errorMessage ?? null,
    rnd_scrub_status: campaign?.rndScrubStatus ?? null,
    last_scrub_at: campaign?.rndLastScrubAt?.toISOString() ?? null,
  });
}
