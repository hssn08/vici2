// I04 — Inbound Callback Queue: supervisor API routes.
//
// Route map:
//   GET /api/inbound-callbacks/queue/:ingroupId
//     — Supervisor/admin view of pending INBOUND callbacks for a specific in-group.
//     — RBAC: callback:view_inbound_queue (supervisor + admin + super_admin)
//     — Returns masked callback_number, pending_count, stale_count.

import type { FastifyRequest, FastifyReply } from "fastify";
import { getPrisma } from "../lib/prisma.js";
import { fetchQueueForIngroup } from "../inbound-callbacks/service.js";
import { InboundCallbackQueueQuery } from "../inbound-callbacks/schemas.js";
import type { AuthContext } from "../auth/middleware.js";

const prisma = getPrisma();

type AuthReq = FastifyRequest & { auth?: AuthContext };
function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerInboundCallbackRoutes(app: any): Promise<void> {

  // GET /api/inbound-callbacks/queue/:ingroupId
  // Supervisor view of pending INBOUND callbacks for an in-group.
  // I04 PLAN §7.1.
  app.get(
    "/api/inbound-callbacks/queue/:ingroupId",
    { preHandler: [app.requireAuth, app.requirePermission("callback:view_inbound_queue")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const { tenantId } = getAuth(req);
      const { ingroupId } = req.params as { ingroupId: string };

      const queryParsed = InboundCallbackQueueQuery.safeParse(req.query);
      if (!queryParsed.success) {
        return reply.code(400).send({ code: "validation_error", message: queryParsed.error.message });
      }

      const result = await fetchQueueForIngroup(
        prisma,
        BigInt(tenantId),
        ingroupId,
        { limit: queryParsed.data.limit },
      );

      return reply.send(result);
    },
  );
}
