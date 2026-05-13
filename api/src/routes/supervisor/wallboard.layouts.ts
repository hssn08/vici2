// GET  /api/sup/wallboard/layouts  — list active wallboard layouts for the tenant.
// POST /api/sup/wallboard/layouts  — create/replace a layout (admin+ only).
//
// Phase 1: returns a single default layout if no custom layouts exist in the DB.
// The wallboard_layouts table is created by the S04 migration.
//
// RBAC:
//   GET  — wallboard:view  (supervisor+)
//   POST — wallboard:manage (admin+)
//
// S04 PLAN §5, §6.

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export interface WallboardLayout {
  id: number;
  name: string;
  /** Ordered array of board IDs: "agents" | "campaigns" | "queue" | "performers" */
  boards: string[];
  rotateSeconds: number;
  active: boolean;
}

/** Default layout returned when no custom layouts are configured. */
const DEFAULT_LAYOUT: WallboardLayout = {
  id: 0,
  name: "Default",
  boards: ["agents", "campaigns", "queue", "performers"],
  rotateSeconds: 30,
  active: true,
};

export function registerWallboardLayoutsRoute(app: FastifyInstance): void {
  // GET /api/sup/wallboard/layouts
  app.get(
    "/api/sup/wallboard/layouts",
    {
      preHandler: [app.requireAuth, app.requireRole("supervisor")],
    },
    async (_req: FastifyRequest, reply: FastifyReply) => {
      // Phase 1 stub: always return the default layout.
      // TODO(Phase-2): query wallboard_layouts table for tenant.
      return reply.send({
        layouts: [DEFAULT_LAYOUT],
      });
    },
  );

  // POST /api/sup/wallboard/layouts
  app.post(
    "/api/sup/wallboard/layouts",
    {
      preHandler: [app.requireAuth, app.requireRole("admin")],
    },
    async (
      req: FastifyRequest<{
        Body: {
          name?: string;
          boards?: string[];
          rotateSeconds?: number;
          active?: boolean;
        };
      }>,
      reply: FastifyReply,
    ) => {
      const { name, boards, rotateSeconds, active } = req.body ?? {};

      // Validate boards array.
      const VALID_BOARDS = new Set(["agents", "campaigns", "queue", "performers"]);
      if (boards !== undefined) {
        if (!Array.isArray(boards) || boards.some((b) => !VALID_BOARDS.has(b))) {
          return reply.code(400).send({
            error: "boards must be a non-empty array of valid board IDs",
            validBoards: [...VALID_BOARDS],
          });
        }
        if (boards.length === 0) {
          return reply.code(400).send({ error: "boards array must not be empty" });
        }
      }

      if (rotateSeconds !== undefined) {
        if (typeof rotateSeconds !== "number" || rotateSeconds < 5 || rotateSeconds > 3600) {
          return reply.code(400).send({
            error: "rotateSeconds must be a number between 5 and 3600",
          });
        }
      }

      // Phase 1 stub: echo back the created layout with id=1.
      // TODO(Phase-2): INSERT into wallboard_layouts for this tenant.
      const layout: WallboardLayout = {
        id: 1,
        name: typeof name === "string" ? name.trim() : "Custom Layout",
        boards: boards ?? DEFAULT_LAYOUT.boards,
        rotateSeconds: rotateSeconds ?? DEFAULT_LAYOUT.rotateSeconds,
        active: active !== undefined ? Boolean(active) : true,
      };

      return reply.code(201).send({ layout });
    },
  );
}
