// D06 — POST /api/agent/callbacks — create callback.

import type { FastifyRequest, FastifyReply } from "fastify";
import { CreateCallbackBody } from "../../schemas.js";
import { createCallback } from "../../service.js";
import { getPrisma } from "../../../lib/prisma.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function handleScheduleCallback(redis: any) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const auth = (req as AuthReq).auth;
    if (!auth) { await reply.code(401).send({ error: "not_authenticated" }); return; }

    const parsed = CreateCallbackBody.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: "validation_error", details: parsed.error.flatten() });
      return;
    }

    try {
      const { callback, tcpaWarning } = await createCallback(getPrisma(), redis, auth, parsed.data);
      const body: Record<string, unknown> = { ...callback };
      if (tcpaWarning) body.tcpa_warning = tcpaWarning;
      await reply.code(201).send(body);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; code?: string };
      await reply.code(e.statusCode ?? 500).send({ error: e.code ?? "internal_error" });
    }
  };
}
