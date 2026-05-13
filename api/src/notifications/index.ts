// N01 — Fastify plugin: route registration for notifications endpoints.
//
// Routes:
//   GET    /api/notifications                    list (cursor-paginated)
//   PATCH  /api/notifications/:id/read           mark single read
//   POST   /api/notifications/read-all           bulk mark read
//   DELETE /api/notifications/:id                dismiss
//   GET    /api/notifications/prefs              get delivery prefs
//   PATCH  /api/notifications/prefs              update delivery pref

import type { FastifyInstance } from "fastify";
import { handleListNotifications } from "./handlers/list.js";
import { handleMarkRead } from "./handlers/read.js";
import { handleReadAll } from "./handlers/read-all.js";
import { handleDismiss } from "./handlers/dismiss.js";
import { handleGetPrefs, handleUpdatePref } from "./handlers/prefs.js";
import type { AuthContext } from "../auth/middleware.js";
import type { FastifyRequest, FastifyReply } from "fastify";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function requireAuth(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const auth = (req as AuthReq).auth;
  if (!auth) {
    void reply.code(401).send({ error: "not_authenticated" });
    return;
  }
  done();
}

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  // All notification routes require auth
  const preHandler = [requireAuth];

  app.get(
    "/api/notifications",
    { preHandler },
    handleListNotifications,
  );

  app.patch(
    "/api/notifications/:id/read",
    { preHandler },
    handleMarkRead,
  );

  app.post(
    "/api/notifications/read-all",
    { preHandler },
    handleReadAll,
  );

  app.delete(
    "/api/notifications/:id",
    { preHandler },
    handleDismiss,
  );

  app.get(
    "/api/notifications/prefs",
    { preHandler },
    handleGetPrefs,
  );

  app.patch(
    "/api/notifications/prefs",
    { preHandler },
    handleUpdatePref,
  );
}
