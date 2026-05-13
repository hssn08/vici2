// POST /api/admin/coaching/scorecards/:id/unlock
// Admin: revert finalized scorecard to draft (emergency)
// S05 PLAN §10.2

import type { FastifyRequest, FastifyReply } from 'fastify';
import { ScorecardService, ScorecardValidationError } from '../../../../services/coaching/scorecard-service.js';
import { audit } from '../../../../auth/audit.js';
import { getPrisma } from '../../../../lib/prisma.js';

export async function handleAdminUnlockScorecard(
  req: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<void> {
  const auth = req.auth!;
  const db = getPrisma();
  const service = new ScorecardService(db);

  try {
    const scorecard = await service.unlock({
      id: BigInt(req.params.id),
      tenantId: auth.tenantId,
    });

    await audit({
      tx: db,
      actorUserId: auth.uid,
      actorKind: 'user',
      action: 'coaching.scorecard.unlocked',
      tenantId: auth.tenantId,
      entityType: 'call_scorecard',
      entityId: req.params.id,
      afterJson: { status: 'draft', unlocked_by: auth.uid },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    });

    return reply.send({ scorecard });
  } catch (err) {
    if (err instanceof ScorecardValidationError) {
      return reply.code(err.statusCode).send({ error: err.message });
    }
    throw err;
  }
}
