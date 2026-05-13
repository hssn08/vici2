// S03 — Agent script render route.
//
// Route:
//   GET /api/agent/script/:campaignId
//     ?lead_id=<bigint>
//     &call_uuid=<uuid>
//     &call_started_at=<iso8601>
//
// Returns: { html: string, scriptId: string, version: number }
// RBAC: script:read (agents have this verb per rbac.ts)

import { z } from "zod";
import type { FastifyRequest, FastifyReply } from "fastify";
import type { AuthContext } from "../auth/middleware.js";
import { renderScriptForAgent } from "./service.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

const AgentScriptQuerySchema = z.object({
  lead_id: z.string().optional(),
  call_uuid: z.string().uuid().optional(),
  call_started_at: z.string().datetime({ offset: true }).optional(),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAgentScriptRoutes(app: any): Promise<void> {
  app.get(
    "/api/agent/script/:campaignId",
    { preHandler: [app.requireAuth, app.requirePermission("script:read")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { campaignId: string };

      const parsed = AgentScriptQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }

      const { lead_id, call_uuid, call_started_at } = parsed.data;

      // Derive agent name from auth claims
      const agentName =
        (auth.rawClaims as { full_name?: string } | undefined)?.full_name ??
        (auth.rawClaims as { sub?: string } | undefined)?.sub ??
        "";

      const result = await renderScriptForAgent(auth.tenantId, params.campaignId, {
        leadId: lead_id ? BigInt(lead_id) : null,
        callUuid: call_uuid ?? null,
        callStartedAt: call_started_at ?? null,
        agentName,
      });

      if (!result) {
        // No active script found for this campaign — return empty HTML
        return reply.send({ html: "", scriptId: null, version: 0 });
      }

      return reply.send(result);
    },
  );
}
