#!/usr/bin/env tsx
// Generate test/rbac/golden.json from the TS RBAC matrix (M02 PLAN §5.2).
// Run from workspace root: pnpm --filter @vici2/api exec tsx ../../scripts/rbac/gen-golden.ts
// OR: cd api && pnpm exec tsx ../scripts/rbac/gen-golden.ts
// Output: test/rbac/golden.json (committed; CI asserts unchanged)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Inline the Can() logic to avoid relative-path issues across packages
// These types + functions match shared/auth/rbac/can.ts

type Scope = 'tenant' | 'group' | 'own' | 'self';
interface Grant { scope: Scope; sensitive?: true }
type Role = 'super_admin' | 'admin' | 'supervisor' | 'agent' | 'viewer' | 'integrator';
type Verb = string;

interface AuthContext {
  uid: bigint;
  tenantId: bigint;
  role: Role;
  userGroupId: bigint | null;
  allowedCampaigns: bigint[] | '*';
  perms?: Set<Verb>;
  jti: string;
  totpVerified?: boolean;
  active?: boolean;
}

interface ScopeContext {
  tenantId?: bigint;
  campaignId?: bigint;
  ownerUserId?: bigint;
  assignedTo?: bigint[];
  targetUserId?: bigint;
}

interface Decision {
  allow: boolean;
  sensitive?: boolean;
  reason?: string;
}

// Copied from shared/types/src/rbac.ts — kept in sync by gen-rbac
const SENSITIVE_VERBS = new Set<string>([
  'call:listen','call:whisper','call:barge',
  'lead:import','lead:export','lead:bulk_update',
  'recording:download','recording:delete',
  'dnc:edit','dnc:bypass','audit:export',
  'user:delete','user:role-change','user:rotate-sip',
  'campaign:delete','report:export','tenant:edit',
  'sip:credentials:view','kek:rotate','eavesdrop:any',
]);

const ROLE_VERBS: Record<Role, Map<Verb, Grant>> = {
  super_admin: new Map<Verb,Grant>(Object.entries({
    'auth:login':{scope:'tenant'},'auth:logout':{scope:'tenant'},'auth:me':{scope:'tenant'},'auth:ws-token':{scope:'tenant'},
    'call:dial':{scope:'tenant'},'call:transfer':{scope:'tenant'},'call:hangup':{scope:'tenant'},'call:hold':{scope:'tenant'},
    'call:listen':{scope:'tenant',sensitive:true},'call:whisper':{scope:'tenant',sensitive:true},'call:barge':{scope:'tenant',sensitive:true},
    'lead:read':{scope:'tenant'},'lead:edit':{scope:'tenant'},'lead:create':{scope:'tenant'},'lead:delete':{scope:'tenant'},
    'lead:import':{scope:'tenant',sensitive:true},'lead:export':{scope:'tenant',sensitive:true},'lead:bulk_update':{scope:'tenant',sensitive:true},
    'recording:list':{scope:'tenant'},'recording:download':{scope:'tenant',sensitive:true},'recording:delete':{scope:'tenant',sensitive:true},
    'campaign:read':{scope:'tenant'},'campaign:create':{scope:'tenant'},'campaign:edit':{scope:'tenant'},'campaign:delete':{scope:'tenant',sensitive:true},
    'campaign:start':{scope:'tenant'},'campaign:pause':{scope:'tenant'},
    'carrier:read':{scope:'tenant'},'carrier:edit':{scope:'tenant'},'did:read':{scope:'tenant'},'did:edit':{scope:'tenant'},
    'ingroup:read':{scope:'tenant'},'ingroup:edit':{scope:'tenant'},
    'dnc:read':{scope:'tenant'},'dnc:edit':{scope:'tenant',sensitive:true},'dnc:bypass':{scope:'tenant',sensitive:true},
    'audit:view':{scope:'tenant'},'audit:export':{scope:'tenant',sensitive:true},
    'user:read':{scope:'tenant'},'user:create':{scope:'tenant'},'user:edit':{scope:'tenant'},
    'user:delete':{scope:'tenant',sensitive:true},'user:role-change':{scope:'tenant',sensitive:true},'user:rotate-sip':{scope:'tenant',sensitive:true},
    'usergroup:read':{scope:'tenant'},'usergroup:edit':{scope:'tenant'},
    'status:read':{scope:'tenant'},'status:edit':{scope:'tenant'},'pause-code:read':{scope:'tenant'},'pause-code:edit':{scope:'tenant'},
    'script:read':{scope:'tenant'},'script:edit':{scope:'tenant'},
    'report:view':{scope:'tenant'},'report:export':{scope:'tenant',sensitive:true},
    'tenant:read':{scope:'tenant'},'tenant:edit':{scope:'tenant',sensitive:true},
    'sip:credentials:view':{scope:'tenant',sensitive:true},'kek:rotate':{scope:'tenant',sensitive:true},
    'wallboard:view':{scope:'tenant'},'eavesdrop:any':{scope:'tenant',sensitive:true},'callback:read':{scope:'tenant'},'callback:edit':{scope:'tenant'},
  } as Record<Verb,Grant>)),
  admin: new Map<Verb,Grant>(Object.entries({
    'auth:login':{scope:'tenant'},'auth:logout':{scope:'tenant'},'auth:me':{scope:'tenant'},'auth:ws-token':{scope:'tenant'},
    'call:dial':{scope:'tenant'},'call:transfer':{scope:'tenant'},'call:hangup':{scope:'tenant'},'call:hold':{scope:'tenant'},
    'call:listen':{scope:'tenant',sensitive:true},'call:whisper':{scope:'tenant',sensitive:true},'call:barge':{scope:'tenant',sensitive:true},
    'lead:read':{scope:'tenant'},'lead:edit':{scope:'tenant'},'lead:create':{scope:'tenant'},'lead:delete':{scope:'tenant'},
    'lead:import':{scope:'tenant',sensitive:true},'lead:export':{scope:'tenant',sensitive:true},'lead:bulk_update':{scope:'tenant',sensitive:true},
    'recording:list':{scope:'tenant'},'recording:download':{scope:'tenant',sensitive:true},'recording:delete':{scope:'tenant',sensitive:true},
    'campaign:read':{scope:'tenant'},'campaign:create':{scope:'tenant'},'campaign:edit':{scope:'tenant'},'campaign:delete':{scope:'tenant',sensitive:true},
    'campaign:start':{scope:'tenant'},'campaign:pause':{scope:'tenant'},
    'carrier:read':{scope:'tenant'},'carrier:edit':{scope:'tenant'},'did:read':{scope:'tenant'},'did:edit':{scope:'tenant'},
    'ingroup:read':{scope:'tenant'},'ingroup:edit':{scope:'tenant'},
    'dnc:read':{scope:'tenant'},'dnc:edit':{scope:'tenant',sensitive:true},
    'audit:view':{scope:'tenant'},
    'user:read':{scope:'tenant'},'user:create':{scope:'tenant'},'user:edit':{scope:'tenant'},
    'user:delete':{scope:'tenant',sensitive:true},'user:role-change':{scope:'tenant',sensitive:true},'user:rotate-sip':{scope:'tenant',sensitive:true},
    'usergroup:read':{scope:'tenant'},'usergroup:edit':{scope:'tenant'},
    'status:read':{scope:'tenant'},'status:edit':{scope:'tenant'},'pause-code:read':{scope:'tenant'},'pause-code:edit':{scope:'tenant'},
    'script:read':{scope:'tenant'},'script:edit':{scope:'tenant'},
    'report:view':{scope:'tenant'},'report:export':{scope:'tenant',sensitive:true},
    'tenant:read':{scope:'tenant'},
    'wallboard:view':{scope:'tenant'},'eavesdrop:any':{scope:'tenant',sensitive:true},'callback:read':{scope:'tenant'},'callback:edit':{scope:'tenant'},
  } as Record<Verb,Grant>)),
  supervisor: new Map<Verb,Grant>(Object.entries({
    'auth:login':{scope:'tenant'},'auth:logout':{scope:'tenant'},'auth:me':{scope:'tenant'},'auth:ws-token':{scope:'tenant'},
    'call:dial':{scope:'tenant'},'call:transfer':{scope:'tenant'},'call:hangup':{scope:'tenant'},'call:hold':{scope:'tenant'},
    'call:listen':{scope:'group',sensitive:true},'call:whisper':{scope:'group',sensitive:true},'call:barge':{scope:'group',sensitive:true},
    'lead:read':{scope:'group'},'lead:edit':{scope:'group'},'lead:export':{scope:'group',sensitive:true},
    'recording:list':{scope:'group'},'recording:download':{scope:'group',sensitive:true},
    'campaign:read':{scope:'group'},'campaign:start':{scope:'group'},'campaign:pause':{scope:'group'},
    'ingroup:read':{scope:'group'},'dnc:read':{scope:'tenant'},
    'user:read':{scope:'group'},'user:edit':{scope:'group'},'user:rotate-sip':{scope:'self',sensitive:true},
    'usergroup:read':{scope:'group'},
    'status:read':{scope:'tenant'},'pause-code:read':{scope:'tenant'},'script:read':{scope:'tenant'},
    'report:view':{scope:'group'},'report:export':{scope:'group',sensitive:true},
    'wallboard:view':{scope:'group'},'eavesdrop:any':{scope:'group',sensitive:true},'callback:read':{scope:'group'},'callback:edit':{scope:'group'},
  } as Record<Verb,Grant>)),
  agent: new Map<Verb,Grant>(Object.entries({
    'auth:login':{scope:'tenant'},'auth:logout':{scope:'tenant'},'auth:me':{scope:'tenant'},'auth:ws-token':{scope:'tenant'},
    'call:dial':{scope:'own'},'call:transfer':{scope:'own'},'call:hangup':{scope:'own'},'call:hold':{scope:'own'},
    'lead:read':{scope:'own'},'lead:edit':{scope:'own'},'recording:list':{scope:'own'},
    'campaign:read':{scope:'group'},'dnc:read':{scope:'tenant'},
    'user:read':{scope:'self'},'user:edit':{scope:'self'},'user:rotate-sip':{scope:'self',sensitive:true},
    'status:read':{scope:'tenant'},'pause-code:read':{scope:'tenant'},'script:read':{scope:'group'},
    'callback:read':{scope:'own'},'callback:edit':{scope:'own'},
  } as Record<Verb,Grant>)),
  viewer: new Map<Verb,Grant>(Object.entries({
    'auth:login':{scope:'tenant'},'auth:logout':{scope:'tenant'},'auth:me':{scope:'tenant'},
    'lead:read':{scope:'tenant'},'lead:export':{scope:'tenant',sensitive:true},
    'recording:list':{scope:'tenant'},'recording:download':{scope:'tenant',sensitive:true},
    'campaign:read':{scope:'tenant'},'carrier:read':{scope:'tenant'},'did:read':{scope:'tenant'},
    'ingroup:read':{scope:'tenant'},'dnc:read':{scope:'tenant'},
    'audit:view':{scope:'tenant'},'audit:export':{scope:'tenant',sensitive:true},
    'user:read':{scope:'tenant'},'usergroup:read':{scope:'tenant'},
    'status:read':{scope:'tenant'},'pause-code:read':{scope:'tenant'},'script:read':{scope:'tenant'},
    'report:view':{scope:'tenant'},'report:export':{scope:'tenant',sensitive:true},
    'tenant:read':{scope:'self'},
    'wallboard:view':{scope:'tenant'},'callback:read':{scope:'tenant'},
  } as Record<Verb,Grant>)),
  integrator: new Map<Verb,Grant>(Object.entries({
    'auth:me':{scope:'tenant'},
  } as Record<Verb,Grant>)),
};

const VERBS = [
  'auth:login','auth:logout','auth:me','auth:ws-token',
  'call:dial','call:transfer','call:hangup','call:hold','call:listen','call:whisper','call:barge',
  'lead:read','lead:edit','lead:create','lead:delete','lead:import','lead:export','lead:bulk_update',
  'recording:list','recording:download','recording:delete',
  'campaign:read','campaign:create','campaign:edit','campaign:delete','campaign:start','campaign:pause',
  'carrier:read','carrier:edit','did:read','did:edit','ingroup:read','ingroup:edit',
  'dnc:read','dnc:edit','dnc:bypass','audit:view','audit:export',
  'user:read','user:create','user:edit','user:delete','user:role-change','user:rotate-sip',
  'usergroup:read','usergroup:edit','status:read','status:edit','pause-code:read','pause-code:edit',
  'script:read','script:edit','report:view','report:export','tenant:read','tenant:edit',
  'sip:credentials:view','kek:rotate','wallboard:view','eavesdrop:any','callback:read','callback:edit',
];

const ROLES: Role[] = ['super_admin','admin','supervisor','agent','viewer','integrator'];

function passGroupScope(auth: AuthContext, scope: ScopeContext): boolean {
  if (scope.campaignId === undefined) return false;
  if (auth.allowedCampaigns === '*') return true;
  if (!Array.isArray(auth.allowedCampaigns)) return false;
  return auth.allowedCampaigns.includes(scope.campaignId);
}
function passOwnScope(auth: AuthContext, scope: ScopeContext): boolean {
  if (scope.ownerUserId !== undefined && scope.ownerUserId === auth.uid) return true;
  if (Array.isArray(scope.assignedTo) && scope.assignedTo.includes(auth.uid)) return true;
  return false;
}
function passSelfScope(auth: AuthContext, scope: ScopeContext): boolean {
  return scope.targetUserId !== undefined && scope.targetUserId === auth.uid;
}

function Can(auth: AuthContext, verb: Verb, scopeCtx: ScopeContext): Decision {
  if (scopeCtx.tenantId !== undefined && auth.tenantId !== scopeCtx.tenantId)
    return { allow: false, reason: 'tenant_mismatch' };
  if (auth.active === false) return { allow: false, reason: 'inactive_user' };
  if (auth.role === 'integrator') {
    if (auth.perms?.has(verb)) return { allow: true, sensitive: SENSITIVE_VERBS.has(verb) };
    return { allow: false, reason: 'integrator_key_lacks_perm' };
  }
  const grant = ROLE_VERBS[auth.role]?.get(verb);
  if (!grant) return { allow: false, reason: 'no_grant' };
  switch (grant.scope) {
    case 'tenant': break;
    case 'group': if (!passGroupScope(auth, scopeCtx)) return { allow: false, reason: 'scope_group' }; break;
    case 'own':   if (!passOwnScope(auth, scopeCtx))   return { allow: false, reason: 'scope_own' };   break;
    case 'self':  if (!passSelfScope(auth, scopeCtx))  return { allow: false, reason: 'scope_self' };  break;
  }
  return { allow: true, sensitive: grant.sensitive ?? false };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const ACTOR_UID = 42n, OTHER_UID = 99n, ALLOWED_CAMP = 101n, DENIED_CAMP = 999n, T1 = 1n, T2 = 2n;

function makeAuth(role: Role): AuthContext {
  return {
    uid: ACTOR_UID, tenantId: T1, role,
    userGroupId: (role === 'supervisor' || role === 'agent') ? 7n : null,
    allowedCampaigns: (role === 'super_admin' || role === 'admin' || role === 'viewer') ? '*' : [ALLOWED_CAMP],
    jti: 'test', totpVerified: false, active: true,
  };
}

const SCOPE_FIXTURES: Array<{ name: string; scope: ScopeContext }> = [
  { name: 'tenant_only',        scope: { tenantId: T1 } },
  { name: 'allowed_campaign',   scope: { tenantId: T1, campaignId: ALLOWED_CAMP } },
  { name: 'denied_campaign',    scope: { tenantId: T1, campaignId: DENIED_CAMP } },
  { name: 'own_resource',       scope: { tenantId: T1, ownerUserId: ACTOR_UID } },
  { name: 'other_resource',     scope: { tenantId: T1, ownerUserId: OTHER_UID } },
  { name: 'cross_tenant',       scope: { tenantId: T2 } },
  { name: 'self_target',        scope: { tenantId: T1, targetUserId: ACTOR_UID } },
  { name: 'other_user_target',  scope: { tenantId: T1, targetUserId: OTHER_UID } },
];

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
interface GoldenEntry { role: string; verb: string; scopeName: string; decision: Decision }

const entries: GoldenEntry[] = [];
for (const role of ROLES) {
  const auth = makeAuth(role);
  for (const verb of VERBS) {
    for (const { name, scope } of SCOPE_FIXTURES) {
      entries.push({ role, verb, scopeName: name, decision: Can(auth, verb, scope) });
    }
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.resolve(__dirname, '../../test/rbac/golden.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(entries, replacer, 2) + '\n', 'utf8');
console.log(`Generated ${entries.length} golden entries → ${outPath}`);

function replacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  return value;
}
