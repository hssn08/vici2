// D04 — POST /api/admin/d04/reload
// Hot-reloads the hangup-cause map from disk without restart.
// Requires admin:system (tenant:edit permission).

import type { FastifyRequest, FastifyReply } from "fastify";
import { loadHangupMap } from "../hangup-map.js";

 
export async function handleD04Reload(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  try {
    loadHangupMap(); // re-reads from disk
    return reply.code(200).send({ reloaded: true, timestamp: new Date().toISOString() });
  } catch (err: unknown) {
    const e = err as { message?: string };
    return reply.code(500).send({ error: "reload_failed", message: e.message });
  }
}
