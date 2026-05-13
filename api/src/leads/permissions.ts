// D01 — RBAC permission helpers (PLAN §1, §7)

import type { FastifyRequest } from "fastify";
import { roleAtLeast } from "../auth/rbac.js";

/**
 * Returns true if the requesting user is admin or above.
 */
export function isAdmin(req: FastifyRequest): boolean {
  return req.auth !== undefined && roleAtLeast(req.auth.role, "admin");
}

/**
 * Returns true if the user is super_admin.
 */
export function isSuperAdmin(req: FastifyRequest): boolean {
  return req.auth?.role === "super_admin";
}

/**
 * Checks if the user can access leads owned by other users
 * (agents can only see their own, supervisors+ can see all).
 */
export function canAccessAllLeads(req: FastifyRequest): boolean {
  return req.auth !== undefined && roleAtLeast(req.auth.role, "supervisor");
}

/**
 * Returns the owner_user_id filter for agent-scoped queries.
 * If the user is supervisor+, returns undefined (no filter needed).
 */
export function ownerFilter(req: FastifyRequest): bigint | undefined {
  if (!req.auth) return undefined;
  if (canAccessAllLeads(req)) return undefined;
  return BigInt(req.auth.uid);
}
