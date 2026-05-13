// D04 — GET /api/admin/hangup-cause-map
// Returns the raw hangup-cause → status map for admin inspection.

import type { FastifyRequest, FastifyReply } from "fastify";
import { getHangupMap } from "../hangup-map.js";

 
export async function handleGetHangupMap(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const map = getHangupMap();
  return reply.code(200).send({ map, entryCount: Object.keys(map).length });
}
