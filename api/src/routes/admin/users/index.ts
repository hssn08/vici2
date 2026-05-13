// M01 — Admin user-management route registration.
//
// Route map (all require admin+ auth):
//   GET    /api/admin/users                user:read (via campaign:read + user:edit scope)
//   POST   /api/admin/users                user:create
//   GET    /api/admin/users/:userId        user:read
//   PATCH  /api/admin/users/:userId        user:edit
//   DELETE /api/admin/users/:userId        user:delete
//   PATCH  /api/admin/users/:userId/role   user:edit

import type { FastifyRequest, FastifyReply } from "fastify";
import {
  UserCreateSchema,
  UserUpdateSchema,
  UserListQuerySchema,
  RoleAssignSchema,
} from "./schema.js";
import {
  listUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  assignRole,
} from "./service.js";
import type { AuthContext } from "../../../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

function getAuth(req: FastifyRequest): AuthContext {
  const auth = (req as AuthReq).auth;
  if (!auth) throw new Error("Unauthenticated");
  return auth;
}

function parseUserId(raw: unknown): bigint {
  const n = BigInt(String(raw));
  if (n <= 0n) throw new Error("Invalid userId");
  return n;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function registerAdminUserRoutes(app: any): Promise<void> {
  // -------------------------------------------------------------------------
  // GET /api/admin/users
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/users",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = UserListQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      const result = await listUsers(auth.tenantId, parsed.data);
      return reply.send(result);
    },
  );

  // -------------------------------------------------------------------------
  // POST /api/admin/users
  // -------------------------------------------------------------------------
  app.post(
    "/api/admin/users",
    { preHandler: [app.requireAuth, app.requirePermission("user:create")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const parsed = UserCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const user = await createUser(auth.tenantId, auth.uid, auth.role, parsed.data);
        return reply.code(201).send(user);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
          return reply.code(403).send({ code: "forbidden", message: (err as Error).message });
        }
        // Unique constraint violation (username already taken)
        if ((err as { code?: string }).code === "P2002") {
          return reply.code(409).send({ code: "conflict", message: "Username already exists" });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/admin/users/:userId
  // -------------------------------------------------------------------------
  app.get(
    "/api/admin/users/:userId",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { userId: string };
      let userId: bigint;
      try {
        userId = parseUserId(params.userId);
      } catch {
        return reply.code(400).send({ code: "invalid_param", message: "Invalid userId" });
      }
      const user = await getUser(auth.tenantId, userId);
      if (!user) return reply.code(404).send({ code: "not_found", message: "User not found" });
      return reply.send(user);
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/users/:userId
  // -------------------------------------------------------------------------
  app.patch(
    "/api/admin/users/:userId",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { userId: string };
      let userId: bigint;
      try {
        userId = parseUserId(params.userId);
      } catch {
        return reply.code(400).send({ code: "invalid_param", message: "Invalid userId" });
      }
      const parsed = UserUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const user = await updateUser(auth.tenantId, auth.uid, auth.role, userId, parsed.data);
        if (!user) return reply.code(404).send({ code: "not_found", message: "User not found" });
        return reply.send(user);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
          return reply.code(403).send({ code: "forbidden", message: (err as Error).message });
        }
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // DELETE /api/admin/users/:userId
  // -------------------------------------------------------------------------
  app.delete(
    "/api/admin/users/:userId",
    { preHandler: [app.requireAuth, app.requirePermission("user:delete")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { userId: string };
      let userId: bigint;
      try {
        userId = parseUserId(params.userId);
      } catch {
        return reply.code(400).send({ code: "invalid_param", message: "Invalid userId" });
      }
      // Prevent self-deletion
      if (BigInt(auth.uid) === userId) {
        return reply.code(400).send({ code: "self_delete", message: "Cannot delete your own account" });
      }
      const deleted = await deleteUser(auth.tenantId, auth.uid, userId);
      if (!deleted) return reply.code(404).send({ code: "not_found", message: "User not found" });
      return reply.code(204).send();
    },
  );

  // -------------------------------------------------------------------------
  // PATCH /api/admin/users/:userId/role  — explicit role-assignment endpoint
  // -------------------------------------------------------------------------
  app.patch(
    "/api/admin/users/:userId/role",
    { preHandler: [app.requireAuth, app.requirePermission("user:edit")] },
    async (req: FastifyRequest, reply: FastifyReply) => {
      const auth = getAuth(req);
      const params = req.params as { userId: string };
      let userId: bigint;
      try {
        userId = parseUserId(params.userId);
      } catch {
        return reply.code(400).send({ code: "invalid_param", message: "Invalid userId" });
      }
      const parsed = RoleAssignSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ code: "validation_error", message: parsed.error.message });
      }
      try {
        const user = await assignRole(
          auth.tenantId,
          auth.uid,
          auth.role,
          userId,
          parsed.data.role,
        );
        if (!user) return reply.code(404).send({ code: "not_found", message: "User not found" });
        return reply.send(user);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "FORBIDDEN") {
          return reply.code(403).send({ code: "forbidden", message: (err as Error).message });
        }
        throw err;
      }
    },
  );
}
