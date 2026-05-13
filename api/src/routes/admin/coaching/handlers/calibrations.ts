// Calibration stub endpoints — all return 501 (Phase 2)
// POST /api/admin/coaching/calibrations
// GET  /api/admin/coaching/calibrations
// GET  /api/admin/coaching/calibrations/:id
// POST /api/admin/coaching/calibrations/:id/close
// S05 PLAN §10.4

import type { FastifyRequest, FastifyReply } from 'fastify';

const NOT_IMPLEMENTED = { error: 'not_implemented', message: 'Calibration workflow is Phase 2' };

export function handleCalibrationStub(_req: FastifyRequest, reply: FastifyReply): void {
  reply.code(501).send(NOT_IMPLEMENTED);
}
