// Can() — single pure permission decision function (M02 PLAN §3).
// Zero I/O. All inputs must be pre-hydrated by the caller.
// Called by all six middleware bindings.

import { ROLE_VERBS, SENSITIVE_VERBS } from '@vici2/types';
import type { Role, Verb } from '@vici2/types';
import { passGroupScope, passOwnScope, passSelfScope } from './scope.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AuthContext = {
  uid:              bigint;
  tenantId:         bigint;
  role:             Role;
  userGroupId:      bigint | null;
  allowedCampaigns: bigint[] | '*';
  /** integrator only — loaded from JWT authCtx.perms */
  perms?:           Set<Verb>;
  jti:              string;
  /** F06 hook — always false in Phase 1 */
  totpVerified?:    boolean;
  /** if false, all decisions deny with 'inactive_user' */
  active?:          boolean;
};

export type ScopeContext = {
  tenantId?:     bigint;
  campaignId?:   bigint;
  ownerUserId?:  bigint;
  assignedTo?:   bigint[];
  targetUserId?: bigint; // user:edit, user:rotate-sip
  entityId?:     bigint; // for audit row annotation
};

export type DenyReason =
  | 'no_grant'
  | 'inactive_user'
  | 'tenant_mismatch'
  | 'scope_group'
  | 'scope_own'
  | 'scope_self'
  | 'integrator_key_lacks_perm'
  | 'totp_required_not_verified'
  | 'cross_tenant_not_allowed'
  | 'system_error';

export type Decision =
  | { allow: true;  sensitive: boolean }
  | { allow: false; reason: DenyReason };

// ---------------------------------------------------------------------------
// Can() — pure decision function
// ---------------------------------------------------------------------------

/**
 * Evaluate whether authCtx may perform verb within scopeCtx.
 *
 * Decision flow (fail-fast):
 *   1. tenant_mismatch
 *   2. inactive_user
 *   3. totp_required_not_verified (stub for F06)
 *   4. integrator path (reads authCtx.perms)
 *   5. matrix lookup
 *   6. scope predicate
 *   7. allow
 */
export function Can(
  authCtx:  AuthContext,
  verb:     Verb,
  scopeCtx: ScopeContext = {},
): Decision {
  try {
    // 1. Tenant mismatch — the most important guard
    if (scopeCtx.tenantId !== undefined && authCtx.tenantId !== scopeCtx.tenantId) {
      return { allow: false, reason: 'tenant_mismatch' };
    }

    // 2. Inactive user
    if (authCtx.active === false) {
      return { allow: false, reason: 'inactive_user' };
    }

    // 3. TOTP stub — F06 will wire totpVerified + user.totpRequired
    // Phase 1: skip (totpVerified always treated as true)

    // 4. Integrator path — perms come from the JWT per-key set
    if (authCtx.role === 'integrator') {
      if (authCtx.perms?.has(verb)) {
        return { allow: true, sensitive: SENSITIVE_VERBS.has(verb) };
      }
      return { allow: false, reason: 'integrator_key_lacks_perm' };
    }

    // 5. Matrix lookup
    const grant = ROLE_VERBS[authCtx.role]?.get(verb);
    if (!grant) {
      return { allow: false, reason: 'no_grant' };
    }

    // 6. Scope predicate (only evaluated when role check passed)
    switch (grant.scope) {
      case 'tenant':
        // already satisfied by step 1 (or no tenantId in scope = allowed)
        break;
      case 'group':
        if (!passGroupScope(authCtx, scopeCtx)) {
          return { allow: false, reason: 'scope_group' };
        }
        break;
      case 'own':
        if (!passOwnScope(authCtx, scopeCtx)) {
          return { allow: false, reason: 'scope_own' };
        }
        break;
      case 'self':
        if (!passSelfScope(authCtx, scopeCtx)) {
          return { allow: false, reason: 'scope_self' };
        }
        break;
    }

    // 7. Allow
    return { allow: true, sensitive: grant.sensitive ?? false };
  } catch {
    // Never throw — return system_error so caller can escalate to 500
    return { allow: false, reason: 'system_error' };
  }
}
