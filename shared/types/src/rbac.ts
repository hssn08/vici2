// RBAC: single source of truth (PLAN §6).
// All TS modules import from here. `make gen-rbac` generates the Go mirror.

export const ROLES = ['super_admin', 'admin', 'supervisor', 'agent', 'integrator'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_HIERARCHY: Record<Role, number> = {
  super_admin: 40,
  admin: 30,
  supervisor: 20,
  agent: 10,
  integrator: 0,
};

export const PERMISSIONS = [
  'auth:login',
  'auth:logout',
  'call:dial',
  'call:transfer',
  'call:hangup',
  'call:hold',
  'call:listen',
  'call:eavesdrop',
  'call:whisper',
  'call:barge',
  'lead:read',
  'lead:edit',
  'lead:create',
  'lead:delete',
  'lead:import',
  'lead:export',
  'recording:list',
  'recording:download',
  'recording:delete',
  'campaign:read',
  'campaign:edit',
  'campaign:delete',
  'campaign:create',
  'carrier:read',
  'carrier:edit',
  'dnc:read',
  'dnc:edit',
  'dnc:bypass',
  'audit:view',
  'user:create',
  'user:edit',
  'user:delete',
  'user:rotate-sip',
  'tenant:edit',
  'sip:credentials:view',
  'kek:rotate',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const COMMON: Permission[] = ['auth:login', 'auth:logout'];

const AGENT_PERMS: Permission[] = [
  ...COMMON,
  'call:dial',
  'call:transfer',
  'call:hangup',
  'call:hold',
  'lead:read',
  'lead:edit',
  'user:rotate-sip',
];

const SUPERVISOR_PERMS: Permission[] = [
  ...AGENT_PERMS,
  'call:listen',
  'call:eavesdrop',
  'call:whisper',
  'call:barge',
  'recording:list',
  'recording:download',
  'campaign:read',
];

const ADMIN_PERMS: Permission[] = [
  ...SUPERVISOR_PERMS,
  'lead:create',
  'lead:delete',
  'lead:import',
  'lead:export',
  'recording:delete',
  'campaign:edit',
  'campaign:delete',
  'campaign:create',
  'carrier:read',
  'carrier:edit',
  'dnc:read',
  'dnc:edit',
  'user:create',
  'user:edit',
  'user:delete',
];

const SUPER_ADMIN_PERMS: Permission[] = [
  ...ADMIN_PERMS,
  'dnc:bypass',
  'audit:view',
  'tenant:edit',
  'sip:credentials:view',
  'kek:rotate',
];

const INTEGRATOR_PERMS: Permission[] = [...COMMON];

export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Permission>> = {
  super_admin: SUPER_ADMIN_PERMS,
  admin: ADMIN_PERMS,
  supervisor: SUPERVISOR_PERMS,
  agent: AGENT_PERMS,
  integrator: INTEGRATOR_PERMS,
};

export function roleAtLeast(actual: Role, required: Role): boolean {
  // Integrator is orthogonal: never satisfies hierarchical requirements.
  if (actual === 'integrator' || required === 'integrator') return actual === required;
  return ROLE_HIERARCHY[actual] >= ROLE_HIERARCHY[required];
}

export function hasPermission(role: Role, perm: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role];
  return perms.includes(perm);
}

export function permissionsFor(role: Role): ReadonlyArray<Permission> {
  return ROLE_PERMISSIONS[role];
}
