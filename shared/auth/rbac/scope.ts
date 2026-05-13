// Scope predicate functions (M02 PLAN §3.3).
// These are pure functions — zero I/O.

import type { AuthContext, ScopeContext } from './can.js';

/**
 * group scope: campaignId must be in authCtx.allowedCampaigns.
 * null/undefined campaignId → deny (fail-closed).
 * allowedCampaigns === '*' → always pass.
 */
export function passGroupScope(auth: AuthContext, scope: ScopeContext): boolean {
  if (scope.campaignId === undefined) return false;
  if (auth.allowedCampaigns === '*') return true;
  // allowedCampaigns === null (no group) treated as empty array → deny
  if (!Array.isArray(auth.allowedCampaigns)) return false;
  return auth.allowedCampaigns.includes(scope.campaignId);
}

/**
 * own scope: ownerUserId === actor uid, OR uid in assignedTo list.
 * Missing ownerUserId and missing assignedTo → deny.
 */
export function passOwnScope(auth: AuthContext, scope: ScopeContext): boolean {
  if (scope.ownerUserId !== undefined && scope.ownerUserId === auth.uid) return true;
  if (Array.isArray(scope.assignedTo) && scope.assignedTo.includes(auth.uid)) return true;
  return false;
}

/**
 * self scope: targetUserId must equal the actor's uid.
 * Missing targetUserId → deny.
 */
export function passSelfScope(auth: AuthContext, scope: ScopeContext): boolean {
  return scope.targetUserId !== undefined && scope.targetUserId === auth.uid;
}
