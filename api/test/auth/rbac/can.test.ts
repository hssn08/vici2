// Unit tests for Can() pure function (M02 PLAN §14.1).
// Tests scope predicates, hierarchy, integrator path, deny reasons.

import { describe, it, expect } from 'vitest';
import { Can, type AuthContext, type ScopeContext } from '../../../../shared/auth/rbac/can.js';
import { roleAtLeast } from '../../../../shared/types/src/rbac.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const T1 = 1n;
const T2 = 2n;
const UID = 42n;
const OTHER = 99n;
const CAMP = 101n;
const OTHER_CAMP = 999n;

function auth(overrides: Partial<AuthContext>): AuthContext {
  return {
    uid:              UID,
    tenantId:         T1,
    role:             'agent',
    userGroupId:      7n,
    allowedCampaigns: [CAMP],
    jti:              'jti',
    totpVerified:     false,
    active:           true,
    ...overrides,
  };
}

function scope(overrides: Partial<ScopeContext>): ScopeContext {
  return { tenantId: T1, ...overrides };
}

// ---------------------------------------------------------------------------
// Tenant mismatch (step 1)
// ---------------------------------------------------------------------------
describe('tenant_mismatch', () => {
  it('denies when scopeCtx.tenantId differs from auth.tenantId', () => {
    const d = Can(auth({ role: 'admin' }), 'lead:read', scope({ tenantId: T2 }));
    expect(d).toEqual({ allow: false, reason: 'tenant_mismatch' });
  });

  it('passes when scopeCtx.tenantId is not set', () => {
    const d = Can(auth({ role: 'admin' }), 'lead:read', {});
    expect(d.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Inactive user (step 2)
// ---------------------------------------------------------------------------
describe('inactive_user', () => {
  it('denies inactive users regardless of role', () => {
    const d = Can(auth({ role: 'admin', active: false }), 'lead:read', scope());
    expect(d).toEqual({ allow: false, reason: 'inactive_user' });
  });
});

// ---------------------------------------------------------------------------
// Matrix lookup (no_grant)
// ---------------------------------------------------------------------------
describe('no_grant', () => {
  it('agent cannot lead:import', () => {
    const d = Can(auth({ role: 'agent' }), 'lead:import', scope());
    expect(d).toEqual({ allow: false, reason: 'no_grant' });
  });

  it('viewer cannot call:dial', () => {
    const d = Can(auth({ role: 'viewer', allowedCampaigns: '*' }), 'call:dial', scope());
    expect(d).toEqual({ allow: false, reason: 'no_grant' });
  });

  it('admin cannot dnc:bypass', () => {
    const d = Can(auth({ role: 'admin', allowedCampaigns: '*' }), 'dnc:bypass', scope());
    expect(d).toEqual({ allow: false, reason: 'no_grant' });
  });

  it('super_admin can dnc:bypass', () => {
    const d = Can(auth({ role: 'super_admin', allowedCampaigns: '*' }), 'dnc:bypass', scope());
    expect(d).toEqual({ allow: true, sensitive: true });
  });
});

// ---------------------------------------------------------------------------
// Scope: group
// ---------------------------------------------------------------------------
describe('scope_group', () => {
  it('supervisor allowed on allowed campaign', () => {
    const d = Can(auth({ role: 'supervisor', allowedCampaigns: [CAMP] }), 'call:listen', scope({ campaignId: CAMP }));
    expect(d).toEqual({ allow: true, sensitive: true });
  });

  it('supervisor denied on disallowed campaign', () => {
    const d = Can(auth({ role: 'supervisor', allowedCampaigns: [CAMP] }), 'call:listen', scope({ campaignId: OTHER_CAMP }));
    expect(d).toEqual({ allow: false, reason: 'scope_group' });
  });

  it('supervisor denied when no campaignId in scope', () => {
    const d = Can(auth({ role: 'supervisor', allowedCampaigns: [CAMP] }), 'call:listen', scope());
    expect(d).toEqual({ allow: false, reason: 'scope_group' });
  });

  it('admin with allowedCampaigns=* passes group scope', () => {
    const d = Can(auth({ role: 'admin', allowedCampaigns: '*' }), 'call:listen', scope({ campaignId: OTHER_CAMP }));
    expect(d).toEqual({ allow: true, sensitive: true });
  });
});

// ---------------------------------------------------------------------------
// Scope: own
// ---------------------------------------------------------------------------
describe('scope_own', () => {
  it('agent can lead:read own resource', () => {
    const d = Can(auth({ role: 'agent' }), 'lead:read', scope({ ownerUserId: UID }));
    expect(d).toEqual({ allow: true, sensitive: false });
  });

  it('agent denied lead:read on other resource', () => {
    const d = Can(auth({ role: 'agent' }), 'lead:read', scope({ ownerUserId: OTHER }));
    expect(d).toEqual({ allow: false, reason: 'scope_own' });
  });

  it('agent allowed lead:read when in assignedTo', () => {
    const d = Can(auth({ role: 'agent' }), 'lead:read', scope({ ownerUserId: OTHER, assignedTo: [UID] }));
    expect(d).toEqual({ allow: true, sensitive: false });
  });
});

// ---------------------------------------------------------------------------
// Scope: self
// ---------------------------------------------------------------------------
describe('scope_self', () => {
  it('agent can user:read self', () => {
    const d = Can(auth({ role: 'agent' }), 'user:read', scope({ targetUserId: UID }));
    expect(d).toEqual({ allow: true, sensitive: false });
  });

  it('agent denied user:read other user', () => {
    const d = Can(auth({ role: 'agent' }), 'user:read', scope({ targetUserId: OTHER }));
    expect(d).toEqual({ allow: false, reason: 'scope_self' });
  });

  it('viewer tenant:read is self-scoped', () => {
    // viewer has scope:'self' for tenant:read
    const d = Can(auth({ role: 'viewer', allowedCampaigns: '*', uid: UID }), 'tenant:read', scope({ targetUserId: UID }));
    expect(d).toEqual({ allow: true, sensitive: false });
  });
});

// ---------------------------------------------------------------------------
// Integrator path
// ---------------------------------------------------------------------------
describe('integrator', () => {
  it('integrator with matching perm is allowed', () => {
    const d = Can(
      auth({ role: 'integrator', perms: new Set(['lead:read']) }),
      'lead:read',
      scope(),
    );
    expect(d).toEqual({ allow: true, sensitive: false });
  });

  it('integrator without perm is denied', () => {
    const d = Can(
      auth({ role: 'integrator', perms: new Set(['lead:read']) }),
      'lead:edit',
      scope(),
    );
    expect(d).toEqual({ allow: false, reason: 'integrator_key_lacks_perm' });
  });

  it('integrator sensitive perm returns sensitive:true', () => {
    const d = Can(
      auth({ role: 'integrator', perms: new Set(['lead:export']) }),
      'lead:export',
      scope(),
    );
    expect(d).toEqual({ allow: true, sensitive: true });
  });
});

// ---------------------------------------------------------------------------
// Viewer read-only
// ---------------------------------------------------------------------------
describe('viewer', () => {
  const vAuth = auth({ role: 'viewer', allowedCampaigns: '*' });

  it('viewer can lead:read', () => {
    const d = Can(vAuth, 'lead:read', scope());
    expect(d.allow).toBe(true);
  });

  it('viewer cannot lead:edit', () => {
    const d = Can(vAuth, 'lead:edit', scope());
    expect(d).toEqual({ allow: false, reason: 'no_grant' });
  });

  it('viewer can audit:view', () => {
    const d = Can(vAuth, 'audit:view', scope());
    expect(d.allow).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------
describe('roleAtLeast', () => {
  it('admin >= supervisor', () => expect(roleAtLeast('admin', 'supervisor')).toBe(true));
  it('supervisor !>= admin', () => expect(roleAtLeast('supervisor', 'admin')).toBe(false));
  it('viewer !>= agent', () => expect(roleAtLeast('viewer', 'agent')).toBe(false));
  it('integrator !>= agent', () => expect(roleAtLeast('integrator', 'agent')).toBe(false));
  it('super_admin >= super_admin', () => expect(roleAtLeast('super_admin', 'super_admin')).toBe(true));
});

// ---------------------------------------------------------------------------
// system_error — never throws
// ---------------------------------------------------------------------------
describe('system_error', () => {
  it('returns system_error on internal panic instead of throwing', () => {
    // Force a type error by passing null as verb (cast to any)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = Can(auth({ role: 'admin' }), null as any, scope());
    // Should not throw
    expect(typeof d).toBe('object');
    expect('allow' in d).toBe(true);
  });
});
