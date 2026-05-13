// D06 — RBAC helpers for callback endpoints.
// Encapsulates own-vs-supervisor logic per PLAN §5.3.

import type { AuthContext } from "../auth/middleware.js";
import { roleAtLeast } from "../auth/rbac.js";

/** Returns true if the actor is supervisor or admin. */
export function isSupervisor(auth: AuthContext): boolean {
  return roleAtLeast(auth.role, "supervisor");
}

/** Returns true if actor can manage another user's callbacks. */
export function canManageOthers(auth: AuthContext): boolean {
  return roleAtLeast(auth.role, "supervisor");
}

/** Validate that an actor can cancel a callback owned by ownerId. */
export function canCancel(auth: AuthContext, ownerId: bigint | null): boolean {
  if (isSupervisor(auth)) return true;
  // Agent can cancel their own PENDING callbacks
  if (ownerId === null) return false;  // GLOBAL — only supervisor
  return ownerId === BigInt(auth.uid);
}

/** Validate that an actor can snooze a callback. */
export function canSnooze(auth: AuthContext, ownerId: bigint | null): boolean {
  if (isSupervisor(auth)) return true;
  if (ownerId === null) return false;  // GLOBAL — only supervisor
  return ownerId === BigInt(auth.uid);
}
