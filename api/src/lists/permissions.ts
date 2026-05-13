// D07 — RBAC permission helpers for list management.

import type { FastifyRequest } from "fastify";
import type { FastifyReply } from "fastify";
import { hasPermission } from "../auth/rbac.js";
import type { Verb } from "@vici2/types";
import type { AuthContext } from "../auth/middleware.js";

type AuthReq = FastifyRequest & { auth?: AuthContext };

export function getAuth(req: FastifyRequest): AuthContext | undefined {
  return (req as AuthReq).auth;
}

/**
 * Checks the given list permission, sends 401/403 if denied.
 * Returns true if allowed.
 */
export function checkListPerm(
  auth: AuthContext | undefined,
  perm: Verb,
  reply: FastifyReply,
): boolean {
  if (!auth) {
    void reply.code(401).send({ error: "not_authenticated" });
    return false;
  }
  if (!auth.perms.has(perm) && !hasPermission(auth.role, perm)) {
    void reply.code(403).send({ error: "forbidden", required: perm });
    return false;
  }
  return true;
}
