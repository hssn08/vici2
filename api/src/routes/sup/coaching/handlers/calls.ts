// GET /api/sup/coaching/calls/:uuid
// Return call metadata + recording info for the review page.
// Permission: scorecard:read

import type { FastifyRequest, FastifyReply } from 'fastify';
import { getPrisma } from '../../../../lib/prisma.js';

export async function handleGetCallForReview(
  req: FastifyRequest<{ Params: { uuid: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const { uuid } = req.params;
  const db = getPrisma();

  // Fetch from recording_log table (uuid is on RecordingLog, not Recording)
  const recLog = await db.recordingLog.findFirst({
    where: { uuid, tenantId: BigInt(auth.tenantId) },
    select: {
      id: true,
      uuid: true,
      userId: true,
      campaignId: true,
      durationSec: true,
      startTime: true,
      lifecycleState: true,
    },
  });

  if (!recLog) {
    return reply.code(404).send({ error: 'call_not_found' });
  }

  // Fetch agent info if present
  let agent = null;
  if (recLog.userId) {
    agent = await db.user.findFirst({
      where: { id: recLog.userId },
      select: { id: true, fullName: true, username: true },
    });
  }

  return reply.send({
    call_uuid: recLog.uuid,
    recording_log_id: recLog.id.toString(),
    agent,
    campaign_id: recLog.campaignId,
    duration_sec: recLog.durationSec,
    started_at: recLog.startTime,
    lifecycle_state: recLog.lifecycleState,
  });
}
