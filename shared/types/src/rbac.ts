// RBAC: single source of truth (M02 PLAN §2, §5).
// All TS modules import from here. `make gen-rbac` generates the Go mirror.
// DO NOT manually edit dialer/internal/auth/rbac/matrix_gen.go — run `make gen-rbac`.

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const ROLES = [
  'super_admin',
  'admin',
  'supervisor',
  'agent',
  'viewer',
  'integrator',
] as const;
export type Role = (typeof ROLES)[number];

/** Hierarchy levels. viewer + integrator are orthogonal (level 0). */
export const ROLE_HIERARCHY: Record<Role, number> = {
  super_admin: 100,
  admin:        80,
  supervisor:   60,
  agent:        40,
  viewer:         0, // orthogonal — not in the chain
  integrator:     0, // orthogonal — machine-to-machine
};

/** Only these roles participate in the >= hierarchy. */
export const HIERARCHICAL_ROLES = new Set<Role>(['super_admin', 'admin', 'supervisor', 'agent']);

// ---------------------------------------------------------------------------
// Verbs (60)
// ---------------------------------------------------------------------------

export const VERBS = [
  // auth
  'auth:login',
  'auth:logout',
  'auth:me',
  'auth:ws-token',
  // call
  'call:dial',
  'call:transfer',
  'call:hangup',
  'call:hold',
  'call:listen',
  'call:whisper',
  'call:barge',
  // lead
  'lead:read',
  'lead:edit',
  'lead:create',
  'lead:delete',
  'lead:import',
  'lead:export',
  'lead:bulk_update',
  // recording
  'recording:list',
  'recording:download',
  'recording:delete',
  // campaign
  'campaign:read',
  'campaign:create',
  'campaign:edit',
  'campaign:delete',
  'campaign:start',
  'campaign:pause',
  // carrier
  'carrier:read',
  'carrier:edit',
  // did
  'did:read',
  'did:edit',
  // ingroup
  'ingroup:read',
  'ingroup:edit',
  // dnc
  'dnc:read',
  'dnc:edit',
  'dnc:bypass',
  // audit
  'audit:view',
  'audit:export',
  // user
  'user:read',
  'user:create',
  'user:edit',
  'user:delete',
  'user:role-change',
  'user:rotate-sip',
  // usergroup
  'usergroup:read',
  'usergroup:edit',
  // status / pause-code
  'status:read',
  'status:edit',
  'pause-code:read',
  'pause-code:edit',
  // script
  'script:read',
  'script:edit',
  // report
  'report:view',
  'report:export',
  // tenant
  'tenant:read',
  'tenant:edit',
  // sip / kek
  'sip:credentials:view',
  'kek:rotate',
  // wallboard / eavesdrop / callback
  'wallboard:view',
  'eavesdrop:any',
  'callback:read',
  'callback:edit',
  // alert / on-call (O03)
  'alert:read',
  'alert:configure',
  // list management (D07)
  'list:read',
  'list:write',
  'list:delete',
  'list:reset',
  'list:purge',
  // voicemail (I03)
  'voicemail:read',
  'voicemail:manage',
] as const;

export type Verb = (typeof VERBS)[number];

// Keep the old `Permission` alias so F05 consumers still compile.
export type Permission = Verb;
export const PERMISSIONS = VERBS;

// ---------------------------------------------------------------------------
// Scope + Grant
// ---------------------------------------------------------------------------

export type Scope = 'tenant' | 'group' | 'own' | 'self';

export interface Grant {
  scope: Scope;
  /** true → triggers rbac.allowed_sensitive audit row on allow */
  sensitive?: true;
}

// ---------------------------------------------------------------------------
// Sensitive verbs catalog
// ---------------------------------------------------------------------------

export const SENSITIVE_VERBS = new Set<Verb>([
  'call:listen',
  'call:whisper',
  'call:barge',
  'lead:import',
  'lead:export',
  'lead:bulk_update',
  'recording:download',
  'recording:delete',
  'dnc:edit',
  'dnc:bypass',
  'audit:export',
  'user:delete',
  'user:role-change',
  'user:rotate-sip',
  'campaign:delete',
  'report:export',
  'tenant:edit',
  'sip:credentials:view',
  'kek:rotate',
  'eavesdrop:any',
  // D07 — bulk list operations are sensitive (mass data modification)
  'list:reset',
  'list:purge',
  'list:delete',
]);

// ---------------------------------------------------------------------------
// Role x Verb x Grant matrix
// Absent cells = deny. /S = sensitive: true.
// ---------------------------------------------------------------------------

const RAW_MATRIX: Record<Role, Partial<Record<Verb, Grant>>> = {
  super_admin: {
    'auth:login':           { scope: 'tenant' },
    'auth:logout':          { scope: 'tenant' },
    'auth:me':              { scope: 'tenant' },
    'auth:ws-token':        { scope: 'tenant' },
    'call:dial':            { scope: 'tenant' },
    'call:transfer':        { scope: 'tenant' },
    'call:hangup':          { scope: 'tenant' },
    'call:hold':            { scope: 'tenant' },
    'call:listen':          { scope: 'tenant', sensitive: true },
    'call:whisper':         { scope: 'tenant', sensitive: true },
    'call:barge':           { scope: 'tenant', sensitive: true },
    'lead:read':            { scope: 'tenant' },
    'lead:edit':            { scope: 'tenant' },
    'lead:create':          { scope: 'tenant' },
    'lead:delete':          { scope: 'tenant' },
    'lead:import':          { scope: 'tenant', sensitive: true },
    'lead:export':          { scope: 'tenant', sensitive: true },
    'lead:bulk_update':     { scope: 'tenant', sensitive: true },
    'recording:list':       { scope: 'tenant' },
    'recording:download':   { scope: 'tenant', sensitive: true },
    'recording:delete':     { scope: 'tenant', sensitive: true },
    'campaign:read':        { scope: 'tenant' },
    'campaign:create':      { scope: 'tenant' },
    'campaign:edit':        { scope: 'tenant' },
    'campaign:delete':      { scope: 'tenant', sensitive: true },
    'campaign:start':       { scope: 'tenant' },
    'campaign:pause':       { scope: 'tenant' },
    'carrier:read':         { scope: 'tenant' },
    'carrier:edit':         { scope: 'tenant' },
    'did:read':             { scope: 'tenant' },
    'did:edit':             { scope: 'tenant' },
    'ingroup:read':         { scope: 'tenant' },
    'ingroup:edit':         { scope: 'tenant' },
    'dnc:read':             { scope: 'tenant' },
    'dnc:edit':             { scope: 'tenant', sensitive: true },
    'dnc:bypass':           { scope: 'tenant', sensitive: true },
    'audit:view':           { scope: 'tenant' },
    'audit:export':         { scope: 'tenant', sensitive: true },
    'user:read':            { scope: 'tenant' },
    'user:create':          { scope: 'tenant' },
    'user:edit':            { scope: 'tenant' },
    'user:delete':          { scope: 'tenant', sensitive: true },
    'user:role-change':     { scope: 'tenant', sensitive: true },
    'user:rotate-sip':      { scope: 'tenant', sensitive: true },
    'usergroup:read':       { scope: 'tenant' },
    'usergroup:edit':       { scope: 'tenant' },
    'status:read':          { scope: 'tenant' },
    'status:edit':          { scope: 'tenant' },
    'pause-code:read':      { scope: 'tenant' },
    'pause-code:edit':      { scope: 'tenant' },
    'script:read':          { scope: 'tenant' },
    'script:edit':          { scope: 'tenant' },
    'report:view':          { scope: 'tenant' },
    'report:export':        { scope: 'tenant', sensitive: true },
    'tenant:read':          { scope: 'tenant' },
    'tenant:edit':          { scope: 'tenant', sensitive: true },
    'sip:credentials:view': { scope: 'tenant', sensitive: true },
    'kek:rotate':           { scope: 'tenant', sensitive: true },
    'wallboard:view':       { scope: 'tenant' },
    'eavesdrop:any':        { scope: 'tenant', sensitive: true },
    'callback:read':        { scope: 'tenant' },
    'callback:edit':        { scope: 'tenant' },
    'alert:read':           { scope: 'tenant' },
    'alert:configure':      { scope: 'tenant' },
    'list:read':            { scope: 'tenant' },
    'list:write':           { scope: 'tenant' },
    'list:delete':          { scope: 'tenant', sensitive: true },
    'list:reset':           { scope: 'tenant', sensitive: true },
    'list:purge':           { scope: 'tenant', sensitive: true },
    'voicemail:read':       { scope: 'tenant' },
    'voicemail:manage':     { scope: 'tenant' },
  },

  admin: {
    'auth:login':           { scope: 'tenant' },
    'auth:logout':          { scope: 'tenant' },
    'auth:me':              { scope: 'tenant' },
    'auth:ws-token':        { scope: 'tenant' },
    'call:dial':            { scope: 'tenant' },
    'call:transfer':        { scope: 'tenant' },
    'call:hangup':          { scope: 'tenant' },
    'call:hold':            { scope: 'tenant' },
    'call:listen':          { scope: 'tenant', sensitive: true },
    'call:whisper':         { scope: 'tenant', sensitive: true },
    'call:barge':           { scope: 'tenant', sensitive: true },
    'lead:read':            { scope: 'tenant' },
    'lead:edit':            { scope: 'tenant' },
    'lead:create':          { scope: 'tenant' },
    'lead:delete':          { scope: 'tenant' },
    'lead:import':          { scope: 'tenant', sensitive: true },
    'lead:export':          { scope: 'tenant', sensitive: true },
    'lead:bulk_update':     { scope: 'tenant', sensitive: true },
    'recording:list':       { scope: 'tenant' },
    'recording:download':   { scope: 'tenant', sensitive: true },
    'recording:delete':     { scope: 'tenant', sensitive: true },
    'campaign:read':        { scope: 'tenant' },
    'campaign:create':      { scope: 'tenant' },
    'campaign:edit':        { scope: 'tenant' },
    'campaign:delete':      { scope: 'tenant', sensitive: true },
    'campaign:start':       { scope: 'tenant' },
    'campaign:pause':       { scope: 'tenant' },
    'carrier:read':         { scope: 'tenant' },
    'carrier:edit':         { scope: 'tenant' },
    'did:read':             { scope: 'tenant' },
    'did:edit':             { scope: 'tenant' },
    'ingroup:read':         { scope: 'tenant' },
    'ingroup:edit':         { scope: 'tenant' },
    'dnc:read':             { scope: 'tenant' },
    'dnc:edit':             { scope: 'tenant', sensitive: true },
    'audit:view':           { scope: 'tenant' },
    'user:read':            { scope: 'tenant' },
    'user:create':          { scope: 'tenant' },
    'user:edit':            { scope: 'tenant' },
    'user:delete':          { scope: 'tenant', sensitive: true },
    'user:role-change':     { scope: 'tenant', sensitive: true },
    'user:rotate-sip':      { scope: 'tenant', sensitive: true },
    'usergroup:read':       { scope: 'tenant' },
    'usergroup:edit':       { scope: 'tenant' },
    'status:read':          { scope: 'tenant' },
    'status:edit':          { scope: 'tenant' },
    'pause-code:read':      { scope: 'tenant' },
    'pause-code:edit':      { scope: 'tenant' },
    'script:read':          { scope: 'tenant' },
    'script:edit':          { scope: 'tenant' },
    'report:view':          { scope: 'tenant' },
    'report:export':        { scope: 'tenant', sensitive: true },
    'tenant:read':          { scope: 'tenant' },
    'wallboard:view':       { scope: 'tenant' },
    'eavesdrop:any':        { scope: 'tenant', sensitive: true },
    'callback:read':        { scope: 'tenant' },
    'callback:edit':        { scope: 'tenant' },
    'alert:read':           { scope: 'tenant' },
    'alert:configure':      { scope: 'tenant' },
    'list:read':            { scope: 'tenant' },
    'list:write':           { scope: 'tenant' },
    'list:delete':          { scope: 'tenant', sensitive: true },
    'list:reset':           { scope: 'tenant', sensitive: true },
    'list:purge':           { scope: 'tenant', sensitive: true },
    'voicemail:read':       { scope: 'tenant' },
    'voicemail:manage':     { scope: 'tenant' },
  },

  supervisor: {
    'auth:login':           { scope: 'tenant' },
    'auth:logout':          { scope: 'tenant' },
    'auth:me':              { scope: 'tenant' },
    'auth:ws-token':        { scope: 'tenant' },
    'call:dial':            { scope: 'tenant' },
    'call:transfer':        { scope: 'tenant' },
    'call:hangup':          { scope: 'tenant' },
    'call:hold':            { scope: 'tenant' },
    'call:listen':          { scope: 'group', sensitive: true },
    'call:whisper':         { scope: 'group', sensitive: true },
    'call:barge':           { scope: 'group', sensitive: true },
    'lead:read':            { scope: 'group' },
    'lead:edit':            { scope: 'group' },
    'lead:export':          { scope: 'group', sensitive: true },
    'recording:list':       { scope: 'group' },
    'recording:download':   { scope: 'group', sensitive: true },
    'campaign:read':        { scope: 'group' },
    'campaign:start':       { scope: 'group' },
    'campaign:pause':       { scope: 'group' },
    'ingroup:read':         { scope: 'group' },
    'dnc:read':             { scope: 'tenant' },
    'user:read':            { scope: 'group' },
    'user:edit':            { scope: 'group' },
    'user:rotate-sip':      { scope: 'self', sensitive: true },
    'usergroup:read':       { scope: 'group' },
    'status:read':          { scope: 'tenant' },
    'pause-code:read':      { scope: 'tenant' },
    'script:read':          { scope: 'tenant' },
    'report:view':          { scope: 'group' },
    'report:export':        { scope: 'group', sensitive: true },
    'wallboard:view':       { scope: 'group' },
    'eavesdrop:any':        { scope: 'group', sensitive: true },
    'callback:read':        { scope: 'group' },
    'callback:edit':        { scope: 'group' },
    'alert:read':           { scope: 'group' },
    'list:read':            { scope: 'group' },
    'voicemail:read':       { scope: 'group' },
  },

  agent: {
    'auth:login':           { scope: 'tenant' },
    'auth:logout':          { scope: 'tenant' },
    'auth:me':              { scope: 'tenant' },
    'auth:ws-token':        { scope: 'tenant' },
    'call:dial':            { scope: 'own' },
    'call:transfer':        { scope: 'own' },
    'call:hangup':          { scope: 'own' },
    'call:hold':            { scope: 'own' },
    'lead:read':            { scope: 'own' },
    'lead:edit':            { scope: 'own' },
    'recording:list':       { scope: 'own' },
    'campaign:read':        { scope: 'group' },
    'dnc:read':             { scope: 'tenant' },
    'user:read':            { scope: 'self' },
    'user:edit':            { scope: 'self' },
    'user:rotate-sip':      { scope: 'self', sensitive: true },
    'status:read':          { scope: 'tenant' },
    'pause-code:read':      { scope: 'tenant' },
    'script:read':          { scope: 'group' },
    'callback:read':        { scope: 'own' },
    'callback:edit':        { scope: 'own' },
    'voicemail:read':       { scope: 'own' },
  },

  viewer: {
    // Read-only everywhere in tenant — SOC 2 auditor persona
    'auth:login':           { scope: 'tenant' },
    'auth:logout':          { scope: 'tenant' },
    'auth:me':              { scope: 'tenant' },
    'lead:read':            { scope: 'tenant' },
    'lead:export':          { scope: 'tenant', sensitive: true },
    'recording:list':       { scope: 'tenant' },
    'recording:download':   { scope: 'tenant', sensitive: true },
    'campaign:read':        { scope: 'tenant' },
    'carrier:read':         { scope: 'tenant' },
    'did:read':             { scope: 'tenant' },
    'ingroup:read':         { scope: 'tenant' },
    'dnc:read':             { scope: 'tenant' },
    'audit:view':           { scope: 'tenant' },
    'audit:export':         { scope: 'tenant', sensitive: true },
    'user:read':            { scope: 'tenant' },
    'usergroup:read':       { scope: 'tenant' },
    'status:read':          { scope: 'tenant' },
    'pause-code:read':      { scope: 'tenant' },
    'script:read':          { scope: 'tenant' },
    'report:view':          { scope: 'tenant' },
    'report:export':        { scope: 'tenant', sensitive: true },
    'tenant:read':          { scope: 'self' }, // own tenant only
    'wallboard:view':       { scope: 'tenant' },
    'callback:read':        { scope: 'tenant' },
    'alert:read':           { scope: 'tenant' },
    'list:read':            { scope: 'tenant' },
    'voicemail:read':       { scope: 'tenant' },
  },

  integrator: {
    // perms come from authCtx.perms (per-API-key set); Phase 1 stub
    'auth:me':              { scope: 'tenant' },
  },
};

/** Exported map: Role -> Verb -> Grant */
export const ROLE_VERBS: Record<Role, ReadonlyMap<Verb, Grant>> = (Object.fromEntries(
  ROLES.map((role) => [role, new Map(Object.entries(RAW_MATRIX[role]) as [Verb, Grant][])]),
) as unknown) as Record<Role, ReadonlyMap<Verb, Grant>>;

// Flat list for backward compat with F05 consumers
export const ROLE_PERMISSIONS: Record<Role, ReadonlyArray<Verb>> = (Object.fromEntries(
  ROLES.map((role) => [role, [...ROLE_VERBS[role].keys()]]),
) as unknown) as Record<Role, ReadonlyArray<Verb>>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * True when `have` is at least as privileged as `required` in the hierarchy.
 * Returns false if either role is outside HIERARCHICAL_ROLES.
 */
export function roleAtLeast(have: Role, required: Role): boolean {
  if (!HIERARCHICAL_ROLES.has(have) || !HIERARCHICAL_ROLES.has(required)) {
    return have === required;
  }
  return ROLE_HIERARCHY[have] >= ROLE_HIERARCHY[required];
}

export function hasPermission(role: Role, perm: Verb): boolean {
  return ROLE_VERBS[role].has(perm);
}

export function permissionsFor(role: Role): ReadonlyArray<Verb> {
  return ROLE_PERMISSIONS[role];
}

export function isRole(s: string): s is Role {
  return (ROLES as readonly string[]).includes(s);
}
