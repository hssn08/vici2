# M02 — RBAC Enforcement Middleware — PLAN

**Module:** M02 (Runtime RBAC enforcement; cross-cutting through Phase 4)
**Author:** M02 PLAN sub-agent (Claude Sonnet 4.6)
**Date:** 2026-05-13
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 15 sections, 50+ citations.
**Depends on (PLANs already FROZEN):** F02 (schema), F05 (auth + JWT shape), M01 (admin UI),
C03 (AuditWriter), F04 (Valkey).
**Blocks:** Every protected REST route, WS op, BullMQ worker action, Server Action, and RSC
that carries a human or machine actor.

> **Module-naming resolution (RESEARCH §13.1, Option A adopted).** SPEC.md §6 originally
> assigned "Campaign CRUD" to M02. The orchestrator's brief redefined M02 as the RBAC
> enforcement middleware. This PLAN keeps the slot as M02. "Campaign CRUD" is
> re-numbered to M09 (or the next available M-track slot). No RFC required — additive
> renumber only.

---

## 0. TL;DR (10-bullet decision summary)

1. **M02 = runtime enforcement; M01 = management UI.** M01 owns the role/group
   admin UI. M02 owns the enforcement decision and the six binding surfaces. Neither
   crosses the other's boundary.
2. **Permission model: RBAC + 3 orthogonal scope predicates** (`tenant`, `group`,
   `own`/`self`). Not ABAC, not Zanzibar. Static matrix in code; no runtime-editable
   policy store in Phase 1.
3. **Six roles shipped in Phase 1:** the five from the schema enum (`super_admin`,
   `admin`, `supervisor`, `agent`, `integrator`) plus `viewer` (added via F02
   amendment A7). `viewer` is orthogonal to the hierarchy — not in the chain.
4. **One `Can(authCtx, verb, scopeCtx) → Decision` pure function**, implemented in
   TS (`shared/auth/rbac/can.ts`) and generated Go (`dialer/internal/auth/rbac/can.go`).
   All six middleware bindings call into it; it performs zero I/O.
5. **Roll our own ~400 LOC × 2 languages.** Casbin/OPA/Permify/OpenFGA explicitly
   rejected. CASL retained for M01's UI side only (`<Can>` / `useAbility()`).
   Documented Phase-4 migration paths to Casbin (runtime-editable matrix) and
   OpenFGA (relationship-based scoping) via `Can()` API shim.
6. **JWT claims extended:** F05 access token gains `ug` (user_group_id), `cmps_kind`
   (`"all" | "list" | "ref"`), and `cmps` (campaign ID array, present when kind=list)
   or `cmps_ref` (present when kind=ref). Zero extra DB hops on the hot path.
7. **Two-tier cache:** L1 = per-process LRU (1024 entries, 30 s TTL); L2 = Valkey
   HASH `t:{tid}:rbac:effective:{uid}` (300 s TTL). Invalidation via Valkey pub/sub
   channel `rbac.user.invalidated`. Role-downgrade staleness bounded by access-token
   TTL (15 min); emergency `logout-all` is the instant-revoke lever.
8. **Audit on every deny (`rbac.denied`) and every sensitive-allow
   (`rbac.allowed_sensitive`)** via C03 `AuditWriter`. Audit goes into the same
   transaction as the (rejected/sensitive) action. Fail-closed: a failing audit write
   returns 500, not a silent 403.
9. **CI enforcement: two gates.** (a) Golden-table parity test: generated
   `test/rbac/golden.json` asserted by both `api/test/auth/rbac/golden.test.ts` and
   `dialer/internal/auth/rbac/golden_test.go`; build fails on any delta. (b) Grep gate:
   every route handler must have `requirePermission` in its `preHandler`; every
   WS op must appear in `WS_OP_TO_VERB`; every Server Action must call `withPermission`.
10. **F02, F05, C03 amendments filed.** F02: adds `viewer` to `UserRole` enum. F05:
    extends JWT claim shape + `logout-all` session revoke path. C03: registers new audit
    action strings (`rbac.denied`, `rbac.allowed_sensitive`, `rbac.system_error`,
    `rbac.matrix_drift`, `auth.cross_tenant_action`).

---

## 1. Goals and non-goals

### 1.1 Goals (M02)

- Runtime enforcement of the RBAC matrix on **all six surfaces** (Fastify, Go/chi,
  BullMQ, WebSocket, Next.js Server Action, Next.js RSC).
- A single `Can()` decision function — the only place that reads the matrix and evaluates
  scope predicates.
- Cache layer that keeps the p99 check budget under 100 µs (hot path) and the worst-case
  cache-miss path under 2 ms.
- Audit trail on every deny and every sensitive allow, in the C03 hash-chain.
- CI gates that prevent new unprotected routes from silently shipping.
- `viewer` role added to schema and matrix.
- JWT claim extension for cache-free hot-path scope hydration.
- Documentation of the Phase-4 escape hatch to Casbin / OpenFGA.

### 1.2 Non-goals (M02)

- **Admin UI** for managing roles, user-group membership, or campaign allowlists — that
  is M01's responsibility.
- **Per-user permission overrides** (`user_permissions` table) — deferred to Phase 4. The
  Phase-1 workaround is a role change; the schema hook is documented in §11.
- **Field-level redaction** (e.g., `lead.ssn_last4` hidden from agents) — Phase 4.
  Phase-1 answer is per-route response shaping.
- **TOTP/2FA enforcement inside `Can()`** — F06 owns this; M02 ships the `DenyReason`
  slot `'totp_required_not_verified'` and the check stub for F06 to wire.
- **Phase-4 SaaS operator UI** and cross-tenant super-admin console — out of scope.
- **OPA/Rego sidecar** — explicitly rejected; see §4.

---

## 2. Permission model

### 2.1 Six roles

| Role | Hierarchy level | Notes |
|---|---|---|
| `super_admin` | 100 | Multi-tenant operator; all verbs, tenant-scoped per JWT. Cross-tenant only via Path A re-auth (§7.2). |
| `admin` | 80 | Tenant-wide; everything except cross-tenant and super-admin-only ops. |
| `supervisor` | 60 | Own user-group campaigns; listen/whisper/barge; read across assigned agents. |
| `agent` | 40 | Own state + assigned leads only. |
| `viewer` | 0 (orthogonal) | Read-only everywhere in tenant; no write, no call ops. SOC 2 auditor persona. |
| `integrator` | 0 (orthogonal) | Machine-to-machine; permissions per API key, not the static matrix. Phase-1 stub: key issuance is 404; verification path ships. |

`viewer` and `integrator` are **not in the hierarchy chain**. `roleAtLeast(viewer, agent)`
is `false`; `roleAtLeast(admin, supervisor)` is `true`.

F02 amendment A7: add `viewer` to `UserRole` enum and a new migration.

### 2.2 Three scope predicates (orthogonal to role check)

Every `Can()` invocation first asserts `tenant` scope (non-negotiable bigint compare),
then evaluates the matrix cell's declared scope predicate:

| Scope | Predicate | `DenyReason` on fail |
|---|---|---|
| `tenant` | `authCtx.tenantId === scopeCtx.tenantId` | `'tenant_mismatch'` |
| `group` | `scopeCtx.campaignId ∈ authCtx.allowedCampaigns` (or `allowedCampaigns === '*'`) | `'scope_group'` |
| `own` | `scopeCtx.ownerUserId === authCtx.uid` OR `authCtx.uid ∈ scopeCtx.assignedTo` | `'scope_own'` |
| `self` | `scopeCtx.targetUserId === authCtx.uid` | `'scope_self'` |

Scope predicates are evaluated **only when the role check passes**. A missing scope input
for a scoped verb is treated as a predicate failure (deny), not an error — fail-closed.

### 2.3 Full role × verb × scope matrix

The matrix ratifies the RESEARCH §1.2 draft. Every cell is a `Grant` object
`{ scope: Scope; sensitive?: true }`. Absent cells = deny. Summary of key assignments:

| Verb | super_admin | admin | supervisor | agent | viewer | integrator |
|---|---|---|---|---|---|---|
| `auth:login` | tenant | tenant | tenant | tenant | tenant | — (API key) |
| `auth:logout` | tenant | tenant | tenant | tenant | tenant | — |
| `auth:me` | tenant | tenant | tenant | tenant | tenant | tenant |
| `auth:ws-token` | tenant | tenant | tenant | tenant | — | — |
| `call:dial` | tenant | tenant | tenant | own | — | — |
| `call:transfer` | tenant | tenant | tenant | own | — | — |
| `call:hangup` | tenant | tenant | tenant | own | — | — |
| `call:hold` | tenant | tenant | tenant | own | — | — |
| `call:listen` | tenant/S | tenant/S | group/S | — | — | — |
| `call:whisper` | tenant/S | tenant/S | group/S | — | — | — |
| `call:barge` | tenant/S | tenant/S | group/S | — | — | — |
| `lead:read` | tenant | tenant | group | own | tenant | per-key |
| `lead:edit` | tenant | tenant | group | own | — | per-key |
| `lead:create` | tenant | tenant | — | — | — | per-key |
| `lead:delete` | tenant | tenant | — | — | — | — |
| `lead:import` | tenant/S | tenant/S | — | — | — | per-key/S |
| `lead:export` | tenant/S | tenant/S | group/S | — | tenant/S | per-key/S |
| `lead:bulk_update` | tenant/S | tenant/S | — | — | — | per-key/S |
| `recording:list` | tenant | tenant | group | own | tenant | — |
| `recording:download` | tenant/S | tenant/S | group/S | — | tenant/S | — |
| `recording:delete` | tenant/S | tenant/S | — | — | — | — |
| `campaign:read` | tenant | tenant | group | group | tenant | per-key |
| `campaign:create` | tenant | tenant | — | — | — | — |
| `campaign:edit` | tenant | tenant | — | — | — | — |
| `campaign:delete` | tenant/S | tenant/S | — | — | — | — |
| `campaign:start` | tenant | tenant | group | — | — | — |
| `campaign:pause` | tenant | tenant | group | — | — | — |
| `carrier:read` | tenant | tenant | — | — | tenant | — |
| `carrier:edit` | tenant | tenant | — | — | — | — |
| `did:read` | tenant | tenant | — | — | tenant | — |
| `did:edit` | tenant | tenant | — | — | — | — |
| `ingroup:read` | tenant | tenant | group | — | tenant | — |
| `ingroup:edit` | tenant | tenant | — | — | — | — |
| `dnc:read` | tenant | tenant | tenant | — | tenant | per-key |
| `dnc:edit` | tenant/S | tenant/S | — | — | — | per-key/S |
| `dnc:bypass` | tenant/S | — | — | — | — | — |
| `audit:view` | tenant | — | — | — | tenant | — |
| `audit:export` | tenant/S | — | — | — | tenant/S | — |
| `user:read` | tenant | tenant | group | self | tenant | — |
| `user:create` | tenant | tenant | — | — | — | — |
| `user:edit` | tenant | tenant | group(ltd) | self(ltd) | — | — |
| `user:delete` | tenant/S | tenant/S | — | — | — | — |
| `user:role-change` | tenant/S | tenant/S | — | — | — | — |
| `user:rotate-sip` | tenant/S | tenant/S | — | self/S | — | — |
| `usergroup:read` | tenant | tenant | group | — | tenant | — |
| `usergroup:edit` | tenant | tenant | — | — | — | — |
| `status:read` | tenant | tenant | tenant | tenant | tenant | — |
| `status:edit` | tenant | tenant | — | — | — | — |
| `pause-code:read` | tenant | tenant | tenant | tenant | tenant | — |
| `pause-code:edit` | tenant | tenant | — | — | — | — |
| `script:read` | tenant | tenant | tenant | group | tenant | — |
| `script:edit` | tenant | tenant | — | — | — | — |
| `report:view` | tenant | tenant | group | — | tenant | — |
| `report:export` | tenant/S | tenant/S | group/S | — | tenant/S | — |
| `tenant:read` | tenant | tenant | — | — | self | — |
| `tenant:edit` | tenant/S | — | — | — | — | — |
| `sip:credentials:view` | tenant/S | — | — | — | — | — |
| `kek:rotate` | tenant/S | — | — | — | — | — |
| `wallboard:view` | tenant | tenant | group | — | tenant | — |
| `eavesdrop:any` | tenant/S | tenant/S | group/S | — | — | — |
| `callback:read` | tenant | tenant | group | own | tenant | — |
| `callback:edit` | tenant | tenant | group | own | — | — |

`/S` = `sensitive: true` in the Grant, triggering an `rbac.allowed_sensitive` audit row.

`per-key` = integrator: scope is derived from the API key's `permissions: Verb[]` field,
not the static matrix. `Can()` for integrators reads `authCtx.perms` (a `Set<Verb>`)
instead of the matrix. `viewer`'s `tenant:read` is `self` scope — they can read their
own tenant metadata but not cross to another tenant's record.

### 2.4 Hierarchy encoding

`ROLE_HIERARCHY` is updated in `shared/types/src/rbac.ts`:

```ts
export const ROLE_HIERARCHY: Record<Role, number> = {
  super_admin: 100,
  admin:        80,
  supervisor:   60,
  agent:        40,
  viewer:        0,   // orthogonal
  integrator:    0,   // orthogonal
};
export const HIERARCHICAL_ROLES = new Set<Role>(['super_admin','admin','supervisor','agent']);
```

`roleAtLeast(have, required)` returns `false` when either role is outside
`HIERARCHICAL_ROLES`. The matrix is built at boot by inheriting ancestor grants into
descendant maps, with the descendant's own grants overriding (so `supervisor.recording:download`
has `scope:'group'`, not admin's `scope:'tenant'`).

### 2.5 Sensitive verb catalog

```ts
export const SENSITIVE_VERBS = new Set<Verb>([
  'call:listen', 'call:whisper', 'call:barge',
  'lead:import', 'lead:export', 'lead:bulk_update',
  'recording:download', 'recording:delete',
  'dnc:edit', 'dnc:bypass',
  'audit:export',
  'user:delete', 'user:role-change', 'user:rotate-sip',
  'campaign:delete',
  'report:export',
  'tenant:edit',
  'sip:credentials:view', 'kek:rotate',
  'eavesdrop:any',
]);
```

---

## 3. `Can()` — single pure decision function

### 3.1 Types

```ts
// shared/auth/rbac/can.ts (authoritative types; PLAN freezes these)

export type AuthContext = {
  uid:              bigint;
  tenantId:         bigint;
  role:             Role;
  userGroupId:      bigint | null;
  allowedCampaigns: bigint[] | '*';
  perms?:           Set<Verb>;   // integrator only — loaded from JWT
  jti:              string;
  totpVerified?:    boolean;     // F06 hook
};

export type ScopeContext = {
  tenantId?:     bigint;
  campaignId?:   bigint;
  ownerUserId?:  bigint;
  assignedTo?:   bigint[];
  targetUserId?: bigint;        // user:edit, user:rotate-sip
  entityId?:     bigint;        // for audit row annotation
};

export type Decision =
  | { allow: true;  sensitive: boolean }
  | { allow: false; reason: DenyReason };

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

export function Can(
  authCtx:  AuthContext,
  verb:     Verb,
  scopeCtx: ScopeContext = {},
  opts?:    { verbose?: boolean },  // dev-only trace
): Decision;
```

### 3.2 Decision flow (in order, fail-fast)

```
1.  tenant_mismatch   — authCtx.tenantId !== scopeCtx.tenantId
2.  inactive_user     — (caller sets this flag on authCtx if user.active=false)
3.  totp_required_not_verified — grant.sensitive && !authCtx.totpVerified && user.totpRequired
4.  integrator path   — if authCtx.role === 'integrator':
       return authCtx.perms?.has(verb)
           ? { allow:true, sensitive: SENSITIVE_VERBS.has(verb) }
           : { allow:false, reason:'integrator_key_lacks_perm' }
5.  matrix lookup     — grant = ROLE_VERBS[authCtx.role].get(verb)
       if !grant → { allow:false, reason:'no_grant' }
6.  scope predicate   — switch(grant.scope):
       'tenant' → pass (already checked in step 1)
       'group'  → passGroupScope(authCtx, scopeCtx) || deny 'scope_group'
       'own'    → passOwnScope(authCtx, scopeCtx)   || deny 'scope_own'
       'self'   → passSelfScope(authCtx, scopeCtx)  || deny 'scope_self'
7.  allow → { allow:true, sensitive: grant.sensitive ?? false }
```

The function is **pure** — zero I/O; all inputs must be pre-hydrated by the caller.
`verbose` mode (step numbers + intermediate values returned) is stripped in
`NODE_ENV=production` builds by a TypeScript `const enum` / dead-code elimination.

### 3.3 Scope predicate implementations

```ts
// shared/auth/rbac/scope.ts

export function passGroupScope(auth: AuthContext, scope: ScopeContext): boolean {
  if (scope.campaignId === undefined) return false;
  if (auth.allowedCampaigns === '*') return true;
  return auth.allowedCampaigns.includes(scope.campaignId);
}

export function passOwnScope(auth: AuthContext, scope: ScopeContext): boolean {
  if (scope.ownerUserId !== undefined && scope.ownerUserId === auth.uid) return true;
  if (scope.assignedTo?.includes(auth.uid)) return true;
  return false;
}

export function passSelfScope(auth: AuthContext, scope: ScopeContext): boolean {
  return scope.targetUserId === auth.uid;
}
```

`allowedCampaigns === null` (user with no group) is treated as an empty array —
`passGroupScope` returns `false` → deny `scope_group`. Documented edge case.

### 3.4 List endpoint scope injection

For list endpoints (`GET /api/admin/leads`), scope is **pushed into the SQL WHERE clause**
rather than per-row `Can()` calls:

```ts
// services/leads/list-leads.ts
const where: Prisma.leadWhereInput = { tenantId: auth.tenantId };
if (auth.role === 'supervisor' && auth.allowedCampaigns !== '*') {
  where.campaignId = { in: auth.allowedCampaigns };
}
if (auth.role === 'agent') {
  where.OR = [{ ownerUserId: auth.uid }, { dispositions: { some: { agentUserId: auth.uid } } }];
}
```

**Consistency test:** for a random sample of returned rows, assert that
`Can('lead:read', auth, { tenantId, campaignId: row.campaignId, ownerUserId: row.ownerUserId })`
returns `{ allow: true }` — ensuring the WHERE clause never admits rows `Can()` would
deny.

---

## 4. Library decision: roll our own

### 4.1 Rejected candidates (with documented Phase-4 migration paths)

| Library | Rejection reason | Phase-4 migration path |
|---|---|---|
| **Casbin** (Node + Go) | Two separate policy stores; Lua-style matcher DSL hard to type-check; 600 KB bundle; per-language state machines drift. | If runtime-editable matrix is needed: swap `Can()` body for `casbin.enforce()`. Call sites unchanged. |
| **OPA / Rego** | Sidecar binary or embedded library; Rego DSL unfamiliar to team; HTTP hop (100–500 µs) or embedded OPA kills the 100 µs budget; 60-row table is overkill for OPA. | If Kubernetes admission-controller policy is needed (Phase 4): OPA is the right tool there, not for application RBAC. |
| **Permify / OpenFGA / SpiceDB** | Separate service + DB per product; graph-walk for shallow 2-level relationships; operational cost > benefit. | If deep relationship-based scoping is needed (Phase 4): `Can()` API shim calls OpenFGA `Check` API. |
| **`@casl/ability`** (backend) | TS-only; no Go equivalent; JS expression conditions in rule objects fight type system. | Retained for M01 UI side only. CASL `Ability` built at boot from `shared/types/src/rbac.ts` via `buildAbility(role, allowedCampaigns)` helper — one source of truth. |

### 4.2 Roll-our-own scope

| File | LOC target | Language |
|---|---|---|
| `shared/auth/rbac/can.ts` | ~120 | TS |
| `shared/auth/rbac/scope.ts` | ~60 | TS |
| `shared/auth/rbac/cache.ts` | ~120 | TS |
| `shared/auth/rbac/audit.ts` | ~80 | TS |
| `dialer/internal/auth/rbac/can.go` | ~150 | Go (generated via `make gen-rbac`) |
| `dialer/internal/auth/rbac/scope.go` | ~80 | Go (generated) |
| Total TS core + bindings | ~800 | TS |
| Total Go core | ~230 | Go |

If the TS core + six middleware bindings exceed 1500 LOC, that is the trigger for a
Casbin-migration RFC.

---

## 5. Codegen pipeline

### 5.1 `make gen-rbac` (F05 PLAN §6.2 target, extended by M02)

Source: `shared/types/src/rbac.ts` — single source of truth.

M02 extends the matrix shape from F05's current flat `Permission[]` per role to a richer
`Record<Role, Partial<Record<Verb, Grant>>>` (with `scope` and `sensitive` fields).
The codegen script (`scripts/rbac/gen-rbac.go`) reads the TS file via a tiny TS→JSON
serialiser step (`scripts/rbac/emit-matrix.ts` → `scripts/rbac/matrix.json`) and then
renders `dialer/internal/auth/rbac/matrix_gen.go`.

```
npm run rbac:emit-matrix   →  scripts/rbac/matrix.json
go run scripts/rbac/gen-rbac.go  →  dialer/internal/auth/rbac/matrix_gen.go
npm run rbac:gen-golden    →  test/rbac/golden.json
```

**CI step:** `make gen-rbac && git diff --exit-code dialer/internal/auth/rbac/matrix_gen.go`
— fails build if generated file is stale.

### 5.2 Golden table generation

```ts
// scripts/rbac/gen-golden.ts
const SCOPE_FIXTURES: ScopeContext[] = [
  { tenantId: 1n },
  { tenantId: 1n, campaignId: 101n },           // allowed campaign
  { tenantId: 1n, campaignId: 999n },           // disallowed campaign
  { tenantId: 1n, ownerUserId: ACTOR_UID },     // own resource
  { tenantId: 1n, ownerUserId: OTHER_UID },     // other's resource
  { tenantId: 2n },                             // cross-tenant
  { tenantId: 1n, targetUserId: ACTOR_UID },   // self
  { tenantId: 1n, targetUserId: OTHER_UID },   // other user
];
// generates ~(6 roles × 60 verbs × 8 scope fixtures) = ~2880 entries
```

The JSON is committed to `test/rbac/golden.json`. Both the TS test suite and the Go test
suite load it and assert that `Can()` returns the exact `Decision`. Build fails on any
disagreement across languages.

### 5.3 CASL ability builder

```ts
// packages/auth/src/ability.ts
import { ROLE_VERBS } from 'shared/types/src/rbac';
import { AbilityBuilder, createMongoAbility } from '@casl/ability';

export function buildAbility(role: Role, allowedCampaigns: bigint[] | '*') {
  const { can, build } = new AbilityBuilder(createMongoAbility);
  for (const [verb, grant] of ROLE_VERBS[role].entries()) {
    const [action, subject] = verb.split(':');
    if (grant.scope === 'group' && allowedCampaigns !== '*') {
      can(action, subject, { campaignId: { $in: allowedCampaigns.map(Number) } });
    } else {
      can(action, subject);
    }
  }
  return build();
}
```

Used by M01's `<Can>` JSX helper and `useAbility()` hook. The UI's ability is always
derived from the same matrix the backend enforces — no second source of truth.

---

## 6. JWT claim shape extension

F05 amendment: add three new claims to the access token. The base shape from F05 §1.3
is preserved; these are additive.

```jsonc
{
  "iss": "vici2-api",
  "aud": "api",
  "sub": "u_42",
  "uid": 42,
  "tenant_id": 1,
  "role": "supervisor",
  "ug": 7,                     // user_group_id (null if no group)
  "cmps_kind": "list",         // "all" | "list" | "ref"
  "cmps": [101, 102, 103],     // present when cmps_kind == "list" (≤50 campaigns)
  // OR
  // "cmps_kind": "all",       // allowedCampaigns === '*' (admin, super_admin)
  // OR
  // "cmps_kind": "ref",       // >50 campaigns; read from Valkey at first request
  "iat": 1746500000,
  "exp": 1746500900,
  "jti": "uuid-v7",
  "kid": "ed25519-2026-1",
  "totp_verified": true
}
```

**Threshold:** if a user's `allowed_campaigns` array exceeds 50 entries (estimated 4 KB
header budget pressure), the login path writes the full list to Valkey at
`t:{tid}:rbac:usergroup:{ug_id}` and issues `cmps_kind: "ref"`. The auth-context builder
(`requireAuth`) reads from Valkey on the first request for that user and populates L1
LRU so subsequent requests are O(1).

**Backward compatibility:** existing tokens without `ug`/`cmps_kind` are treated as
`cmps_kind: "all"` for `admin`/`super_admin` roles and `cmps_kind: "ref"` for others
(triggers a cache hydration from MySQL). Rolling deploys during upgrade are safe.

---

## 7. Cache layer

### 7.1 Architecture

```
HTTP request
  → L0: req.auth (built once by requireAuth; ~10 ns)
  → L1: per-process LRU (lru-cache v11; 1024 entries; 30 s TTL; ~1 µs)
  → L2: Valkey HASH t:{tid}:rbac:effective:{uid} (300 s TTL; ~200 µs local)
  → L3: MySQL SELECT users JOIN user_groups (one read at cache miss; ~2–5 ms)
```

The cache stores **scope inputs only** (`userGroupId`, `allowedCampaigns`, `role`).
The permission set itself is `ROLE_VERBS[role]` — a precomputed constant; no caching
needed.

### 7.2 Cache key namespace

| Key | Type | TTL | Notes |
|---|---|---|---|
| `t:{tid}:rbac:effective:{uid}` | HASH | 300 s | Per-user scope inputs + `cache_version` field |
| `t:{tid}:rbac:usergroup:{ug_id}` | HASH | 300 s | Group's `allowed_campaigns` (for batch hydration) |
| `t:{tid}:rbac:invalidation_seq` | STRING (counter) | none | Lamport-style seq for race detection |
| `rbac.user.invalidated` | PUB/SUB channel | n/a | Cross-process L1 eviction |

`cache_version` is a constant baked into the build from the SHA-256 prefix of `rbac.ts`.
Version mismatch on Valkey read triggers a fresh L3 load and logs `rbac.matrix_drift`.

### 7.3 Cache invalidation events

| Event | Valkey action | Pub/sub broadcast |
|---|---|---|
| `auth.role.changed` | `DEL t:{tid}:rbac:effective:{uid}` | publish `rbac.user.invalidated`, payload `{uid}` |
| `auth.user.usergroup_changed` | same | same |
| `auth.user.deactivated` | same + revoke all JTIs (F05 `logout-all` path) | same |
| `user_groups.allowed_campaigns updated` | `DEL t:{tid}:rbac:effective:{uid}` per member | broadcast per uid |
| Deploy with bumped `CACHE_VERSION` | `DEL t:*:rbac:effective:*` (boot-time sweep) | none needed |

Subscribers call `lru.delete(uid)` on each message. Valkey pub/sub is at-most-once;
bounded TTLs (30 s L1, 300 s L2) cap worst-case staleness when a message is missed.

### 7.4 Role-downgrade staleness mitigation

Role demotions are **not instant** — the existing access token retains the old `role`
claim for up to 15 min (access-token TTL). The mitigation is:

1. **Document in the admin UI** (M01): "Role changes take effect on the user's next
   login or within 15 minutes."
2. **Emergency `logout-all` button** (M01, wired to F05's force-logout path): adds all
   live JTIs for the user to `t:{tid}:auth:revoked_jti:{jti}` (TTL = remaining exp).
   Next request with that JTI returns 401 → user is re-authenticated at the new role.
3. The Valkey cache is already cleared by the `auth.role.changed` invalidation event, so
   any new login immediately reflects the new role.

---

## 8. Six middleware bindings

All six bindings call `Can()`. The pattern is: **build auth context once → call Can() →
emit audit on deny or sensitive-allow → pass or short-circuit**.

### 8.1 Fastify `preHandler` (api/)

```ts
// api/src/auth/middleware.ts
export function requirePermission(verb: Verb, extractScope?: (req: FastifyRequest) => ScopeContext) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = extractScope ? extractScope(req) : { tenantId: req.auth.tenantId };
    const decision = Can(req.auth, verb, scope);
    if (decision.allow) {
      if (decision.sensitive) await auditSensitiveAllow(req, verb, scope);
      return;
    }
    await auditDeny(req, verb, scope, decision.reason);
    return reply.code(403).send({
      error: 'forbidden',
      ...(process.env.NODE_ENV !== 'production' && { reason: decision.reason }),
    });
  };
}
```

`extractScope` is route-supplied. Routes with no dynamic scope omit it; default is
`{ tenantId: req.auth.tenantId }`. Routes checking ownership load the resource first
(one Prisma read in `preHandler`) and supply `ownerUserId` from it.

`noPermission()` middleware is used on intentionally open routes (health, JWKS, metrics)
to document the choice in code:

```ts
export function noPermission() {
  return async (_req: FastifyRequest, _reply: FastifyReply) => {
    // Intentionally no permission check — see M02 PLAN §8.1
  };
}
```

### 8.2 Go/chi middleware (dialer/)

```go
// dialer/internal/auth/middleware.go
func RequirePermission(verb Verb, extractScope func(*http.Request) ScopeContext) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            auth := AuthFromContext(r.Context())
            scope := extractScope(r)
            decision := Can(auth, verb, scope)
            if !decision.Allow {
                _ = AuditDeny(r.Context(), verb, scope, decision.Reason)
                http.Error(w, `{"error":"forbidden"}`, http.StatusForbidden)
                return
            }
            if decision.Sensitive {
                _ = AuditSensitiveAllow(r.Context(), verb, scope)
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

The Go `Can()` is generated from the same matrix; the golden-table CI test verifies
byte-equivalent output.

### 8.3 BullMQ worker wrapper (api/workers/)

```ts
// shared/workers/wrapJob.ts
export function wrapJob<T>(
  opts: { requires: Verb; extractScope?: (job: Job<T>) => ScopeContext },
  handler: (job: Job<T>, auth: AuthContext) => Promise<void>,
) {
  return async (job: Job<T>) => {
    const auth = await buildAuthFromActor(job.data.actorUserId, job.data.tenantId);
    const scope = opts.extractScope?.(job) ?? { tenantId: auth.tenantId };
    const decision = Can(auth, opts.requires, scope);
    if (!decision.allow) {
      await auditDenyFromWorker(auth, opts.requires, scope, decision.reason, job.id);
      throw new Error(`rbac:denied ${decision.reason}`);
    }
    if (decision.sensitive) await auditSensitiveFromWorker(auth, opts.requires, scope, job.id);
    return handler(job, auth);
  };
}
```

RBAC is checked **both at enqueue time** (Fastify route preHandler) **and at dequeue
time** (worker body) — defense in depth. The double-check catches race conditions where
the actor's role was changed between enqueue and execution.

### 8.4 WebSocket per-op check (A03)

```ts
// a03/src/ws/router.ts
const WS_OP_TO_VERB: Record<string, Verb> = {
  'agent.pause':       'status:edit',
  'call.listen':       'call:listen',
  'call.barge':        'call:barge',
  // ... (every op in the WS protocol maps to exactly one Verb)
};

socket.on('message', async (raw) => {
  const msg = parse(raw);
  const verb = WS_OP_TO_VERB[msg.op];
  if (!verb) return socket.send(err('unknown_op'));
  const scope = wsExtractScope(msg, socket.auth);
  const decision = Can(socket.auth, verb, scope);
  if (!decision.allow) {
    await audit({ action: 'rbac.denied', ...deniedFields(socket.auth, verb, scope, decision.reason) });
    return socket.send(err('forbidden', decision.reason));
  }
  if (decision.sensitive) {
    await audit({ action: 'rbac.allowed_sensitive', ...sensitiveFields(socket.auth, verb, scope) });
  }
  return dispatch(msg, socket.auth);
});
```

`socket.auth` is built once at WS handshake (full L0+L1+L2 hydration). Per-message
checks hit only in-memory structures: ~3 µs including the audit emit defer.

The CI grep gate includes `WS_OP_TO_VERB` coverage: every op defined in the A03 protocol
spec must appear as a key. Missing entries fail the build.

### 8.5 Next.js Server Action wrapper (admin/)

```ts
// packages/auth/src/server/with-permission.ts
export function withPermission<TArgs extends unknown[]>(
  verb: Verb,
  extractScope?: (...args: TArgs) => ScopeContext,
) {
  return <TReturn>(fn: (...args: [...TArgs, AuthContext]) => Promise<TReturn>) =>
    async (...args: TArgs): Promise<TReturn> => {
      const me = await getMe();               // reads sx_user cookie; cached per request
      const auth = buildAuthFromMe(me);
      const scope = extractScope?.(...args) ?? { tenantId: auth.tenantId };
      const decision = Can(auth, verb, scope);
      if (!decision.allow) {
        // emit audit via api HTTP call (Server Action can't write directly to audit_log)
        await emitAuditViaApi('rbac.denied', auth, verb, scope, decision.reason);
        throw new Error(`forbidden:${decision.reason}`);
      }
      if (decision.sensitive) {
        await emitAuditViaApi('rbac.allowed_sensitive', auth, verb, scope, undefined);
      }
      return fn(...args, auth);
    };
}
```

Server Actions call into the api Fastify endpoint for audit writes (they cannot write to
MySQL directly without a separate DB connection). The api endpoint **also re-checks RBAC**
— the Server Action layer is UX gating + early deny, not the security boundary.

Server Actions emit audit rows tagged `actor_kind: 'server_action'`. RSC pre-render
denials (the `requirePermission` call in a page that only gate whether a button renders)
emit **no audit rows** — they are UI gating only.

### 8.6 Next.js RSC helper (admin/)

```ts
// packages/auth/src/server/require-permission.ts
export async function requirePermission(
  verb: Verb,
  scopeExtractor?: () => ScopeContext,
): Promise<MeResponse> {
  const me = await getMe();
  const auth = buildAuthFromMe(me);
  const scope = scopeExtractor?.() ?? { tenantId: auth.tenantId };
  const decision = Can(auth, verb, scope);
  if (decision.allow) return me;
  redirect(`/403?reason=${encodeURIComponent(decision.reason)}&verb=${encodeURIComponent(verb)}`);
}
```

Used in RSC page bodies (M01 PLAN §9.3 already declared this signature; M02 freezes it
with `Verb` typing). Denials redirect to `/403`; no audit row emitted at RSC layer
(that happens at the api boundary).

---

## 9. Audit integration (C03)

### 9.1 Audit rows emitted

| Event | `action` string | Severity | Transaction |
|---|---|---|---|
| RBAC deny | `rbac.denied` | WARN | Own short transaction (deny has no business tx) |
| Sensitive allow | `rbac.allowed_sensitive` | INFO | Same transaction as the operation |
| Cross-tenant action | `auth.cross_tenant_action` | WARN | Own short transaction |
| Cache load failure | `rbac.system_error` | ERROR | Own short transaction |
| Matrix version mismatch | `rbac.matrix_drift` | PAGE | Own short transaction |

### 9.2 Deny audit row `after_json` shape

```jsonc
{
  "verb":           "lead:export",
  "scope":          { "tenantId": "1", "campaignId": "42" },
  "reason":         "scope_group",
  "actor":          { "role": "supervisor", "uid": "17", "userGroupId": "3" },
  "matrix_version": "rbac.v23"   // SHA-256 prefix of rbac.ts at build time
}
```

No PII in the audit row — entity IDs only, not names, emails, or phone numbers.
`matrix_version` enables replaying historical denies against the matrix version that
was live at the time.

### 9.3 Failing audit write → 500

If the `AuditWriter.append()` call inside the deny path throws, M02 returns 500 (not
403). Silent loss of denial evidence is worse than a noisy alert. Alerting rule:
`vici2_audit_write_error_total > 0` pages the on-call engineer.

### 9.4 Prometheus metrics

| Metric | Labels | Alert |
|---|---|---|
| `vici2_rbac_deny_total` | `reason`, `verb`, `role` | `cross_tenant_not_allowed > 0` → PAGE; `tenant_mismatch > 0 in 5min` → PAGE |
| `vici2_rbac_check_duration_seconds` | `surface` (fastify/go/ws/bullmq/sa/rsc) | p99 > 100 µs → WARN |
| `vici2_rbac_sensitive_allow_total` | `verb`, `role` | — (informational) |
| `vici2_rbac_system_error_total` | `surface` | `> 0` → WARN |

---

## 10. Multi-tenant scoping

### 10.1 Tenant check is universal and first

`Can()` asserts `authCtx.tenantId === scopeCtx.tenantId` before any matrix lookup. A
missing `scopeCtx.tenantId` is treated as a mismatch (fail-closed). This check costs one
bigint compare and is the most important single guard in the system.

### 10.2 Prisma middleware belt-and-braces

```ts
// api/src/db/tenant-scope-middleware.ts
prisma.$use(async (params, next) => {
  if (TENANT_SCOPED_TABLES.has(params.model ?? '')) {
    const tid = AsyncLocalStorage.getStore()?.tenantId;
    if (tid === undefined) throw new Error(`unscoped query on ${params.model}`);
    params.args.where = { ...params.args.where, tenantId: tid };
  }
  return next(params);
});
```

`AsyncLocalStorage` is populated by `requireAuth`'s hook entry. Workers and scripts that
legitimately operate across tenants call `withBypassedTenantScope(async () => ...)`,
which marks the ALS store with `tenantId: null` (accepted by the middleware as an
intentional bypass). All bypasses are audited with `auth.cross_tenant_action`.

`TENANT_SCOPED_TABLES` is maintained in `api/src/db/tenant-tables.ts`. New tables added
in future migrations must be added to this set; CI grep gate enforces: any Prisma model
not in `TENANT_SCOPED_TABLES` and not in `GLOBAL_TABLES` fails the build.

### 10.3 Cross-tenant super_admin

**Phase 1: Path A only** — re-auth. A super-admin selects a tenant in the operator UI;
the backend issues a new JWT with `tenant_id: <selected>`. Standard checks apply from
that point. Path B (per-request `X-Vici2-Cross-Tenant` header) is **not shipped in
Phase 1** — the trust model is simpler without it. Phase-4 RFC if operator tooling
demands it.

---

## 11. Schema additions

### 11.1 F02 amendment A7 — `viewer` role

Migration: add `'viewer'` to the `UserRole` enum in
`api/prisma/schema.prisma` and a corresponding `ALTER TABLE users MODIFY COLUMN role ENUM(...)`.

No other schema changes for Phase 1. The `user_permissions` override table is
**deferred to Phase 4**:

```prisma
// Phase 4 only — do not create now
model UserPermission {
  id         BigInt   @id @default(autoincrement())
  tenantId   BigInt   @map("tenant_id")
  userId     BigInt   @map("user_id")
  verb       String   @db.VarChar(64)
  grantedAt  DateTime @default(now()) @map("granted_at") @db.DateTime(6)
  grantedBy  BigInt   @map("granted_by")
  expiresAt  DateTime? @map("expires_at") @db.DateTime(6)
  reason     String?  @db.VarChar(256)
}
```

When Phase 4 adds this table, `Can()` gains an `extraPerms: Set<Verb>` field on
`AuthContext` and ORs the matrix result with `authCtx.extraPerms?.has(verb)`.

### 11.2 F05 amendment — JWT claim shape

Extend login and refresh-token response to include `ug`, `cmps_kind`, and conditionally
`cmps` or `cmps_ref`. Login path pre-warms the Valkey scope-cache if `cmps_kind=ref`.

### 11.3 Integrator table (Phase 4, N01)

```prisma
// Phase 4 N01 — documented here for forward compatibility
model Integrator {
  id           BigInt   @id @default(autoincrement())
  tenantId     BigInt   @map("tenant_id")
  name         String   @db.VarChar(64)
  apiKeyHash   String   @map("api_key_hash") @db.VarChar(64)
  permissions  Json                               // Verb[]
  rateLimitRpm Int      @default(60) @map("rate_limit_rpm")
  active       Boolean  @default(true)
  createdAt    DateTime @default(now()) @map("created_at") @db.DateTime(6)
}
```

Phase 1 ships only the `Can()` integrator path that reads `authCtx.perms` from the JWT.
Key issuance endpoints are 404.

---

## 12. CI gates

### 12.1 Golden-table parity (TS ↔ Go)

```
make rbac:gen-golden        # generates test/rbac/golden.json from TS matrix
npm test api/test/auth/rbac/golden.test.ts      # asserts all ~2880 entries
go test ./dialer/internal/auth/rbac/...          # asserts same entries
```

Any delta in Go output vs TS output fails CI. Also run `make gen-rbac && git diff
--exit-code` to ensure generated Go matrix is committed and current.

### 12.2 Unprotected route grep

```bash
# scripts/ci/check-rbac-coverage.sh
# Fails if any Fastify route handler lacks requirePermission or noPermission in preHandler
grep -rn 'fastify\.\(get\|post\|put\|patch\|delete\)' api/src/routes/ \
  | grep -v 'requirePermission\|noPermission' \
  && { echo "ERROR: route missing permission middleware"; exit 1; } || true

# Fails if any WS op is not in WS_OP_TO_VERB
# (cross-referenced against A03 protocol spec)

# Fails if any Server Action in admin/ lacks withPermission()
grep -rn "^export.*async function\|^export const.*=.*async" admin/src/app/ \
  | grep -v 'withPermission\|"use server"' \
  | grep '"use server"' \  # only check files with 'use server'
  && { echo "ERROR: Server Action missing withPermission"; exit 1; } || true
```

### 12.3 Bench regression gate

```
npm run bench:rbac:l1-hit       # 1M calls; assert p99 < 5 µs
npm run bench:rbac:l2-hit       # 1M calls (L1 disabled); assert p99 < 300 µs
npm run bench:rbac:e2e          # Fastify route; RBAC p99 contribution < 100 µs
```

Regression > 20 % vs baseline (committed in `bench/baselines/rbac.json`) fails CI.

### 12.4 Matrix version check

A `MATRIX_VERSION` constant = `sha256(rbac.ts)[:8]` is baked at build time. At startup,
the api process reads the live Valkey cache-version field and logs `rbac.matrix_drift`
if there's a mismatch (expected during rolling deploys; the 300 s TTL bounds the window).

---

## 13. Files to create

```
shared/types/src/rbac.ts              MODIFY — extend with Grant, Scope, viewer role, SENSITIVE_VERBS
shared/auth/rbac/can.ts               CREATE — Can() decision function
shared/auth/rbac/scope.ts             CREATE — passGroupScope, passOwnScope, passSelfScope
shared/auth/rbac/cache.ts             CREATE — loadEffective(), pub/sub subscriber, LRU
shared/auth/rbac/audit.ts             CREATE — auditDeny(), auditSensitiveAllow() helpers
shared/workers/wrapJob.ts             CREATE — BullMQ RBAC wrapper
packages/auth/src/server/can.ts               CREATE — re-export for Next.js consumers
packages/auth/src/server/require-permission.ts CREATE — RSC helper
packages/auth/src/server/with-permission.ts   CREATE — Server Action HOF
packages/auth/src/server/get-me.ts            CREATE — sx_user cookie → MeResponse (cached per-request)
packages/auth/src/ability.ts          CREATE — CASL Ability builder from shared matrix
api/src/auth/middleware.ts            MODIFY — fill requirePermission body (F05 ships skeleton)
api/src/auth/rbac/extract.ts          CREATE — extractScope helpers per route family
api/src/db/tenant-scope-middleware.ts CREATE — Prisma ALS tenant auto-inject
api/src/db/tenant-tables.ts           CREATE — TENANT_SCOPED_TABLES + GLOBAL_TABLES sets
dialer/internal/auth/rbac/can.go       CREATE (generated) — Go Can() mirror
dialer/internal/auth/rbac/scope.go     CREATE (generated) — Go scope predicates
dialer/internal/auth/rbac/matrix_gen.go CREATE (generated) — matrix constants
dialer/internal/auth/middleware.go     MODIFY — fill RequirePermission body
a03/src/ws/router.ts                   MODIFY — swap has() check for full Can() + WS_OP_TO_VERB
scripts/rbac/emit-matrix.ts           CREATE — serialise TS matrix to JSON
scripts/rbac/gen-rbac.go              CREATE — render Go matrix from JSON
scripts/rbac/gen-golden.ts            CREATE — generate golden.json
scripts/ci/check-rbac-coverage.sh     CREATE — unprotected route grep
test/rbac/golden.json                 CREATE (generated, committed)
api/test/auth/rbac/golden.test.ts      CREATE — TS golden assertions
dialer/internal/auth/rbac/golden_test.go CREATE — Go golden assertions
bench/rbac-l1-hit.bench.ts            CREATE — performance gate
bench/rbac-l2-hit.bench.ts            CREATE — performance gate
api/prisma/migrations/YYYYMMDDXXXXXX_add_viewer_role/ CREATE — F02 amendment A7
```

---

## 14. Test plan

### 14.1 Unit — `Can()` correctness (Layer 1)

- **Golden table assertions** (TS + Go) — ~2880 cells, covering all 6 roles × ~60 verbs
  × 8 scope fixtures. Auto-generated; both implementations must agree exactly.
- **Fuzz** — 100k random `(role, verb, scopeCtx)` via `fast-check`; assert `Can()` never
  throws and always returns a well-formed `Decision`. Run offline + pre-release.
- **Scope predicates** — direct unit tests of `passGroupScope`, `passOwnScope`,
  `passSelfScope` with null/empty/overflow edge cases (null `allowedCampaigns`, missing
  `campaignId`, `assignedTo` empty array).
- **Hierarchy correctness** — `roleAtLeast(admin, supervisor)` = true; `roleAtLeast(viewer, agent)` = false;
  supervisor does NOT inherit admin's tenant-scoped `recording:download`.

### 14.2 Integration — per binding × per role × per scope (Layer 2)

For each of the six surfaces, run:

| Role | Verb | Scope fixture | Expected |
|---|---|---|---|
| admin | lead:export | same-tenant | 200 + sensitive-allow audit row |
| supervisor | lead:export | own-group campaign | 200 + audit row |
| supervisor | lead:export | out-of-group campaign | 403 + deny audit row |
| agent | lead:export | any | 403 + deny audit row |
| viewer | lead:export | any | 200 + sensitive-allow audit row |
| agent | call:dial | own campaign | 200, no audit row |
| any | any | cross-tenant | 403, reason=tenant_mismatch |

Fastify routes and Go handlers use `testcontainers` (MySQL + Valkey). Server Actions use
Next.js test utilities. BullMQ worker uses an in-process Queue. WS ops use a WebSocket
client against a running a03 test instance.

### 14.3 Cache invalidation (Layer 3)

1. **Role change** — hydrate L1; change role via admin API; assert `Can()` returns new
   role's decision within 1 s (pub/sub invalidation path).
2. **User-group change** — same shape; change `user.user_group_id`.
3. **Allowed-campaigns update** — change `user_groups.allowed_campaigns`; assert all
   members reflect new scope within 1 s.
4. **Valkey down** — disable Valkey; assert L1 serves for 30 s then L3 fallback engages;
   assert `Can()` still returns valid decisions (not throws).
5. **Both down** — disable Valkey + MySQL; assert `Can()` returns
   `{ allow:false, reason:'system_error' }` and the check does NOT fail-open.

### 14.4 Chaos (Layer 4)

- **Invalidate-during-request** — inject 100 ms delay in route body; invalidate cache
  mid-flight; assert request completes with its original auth context.
- **Matrix drift** — deploy old matrix to Valkey; assert startup detects drift, logs
  `rbac.matrix_drift`, and falls back to fresh L3 load.
- **Concurrent role changes** — 100 concurrent goroutines changing the same user's role;
  assert no deadlock, no wrong-role decision returned.

### 14.5 Security review (pre-MVP, manual)

Checklist (different author from implementor):

- Every protected Fastify route has `requirePermission` or `noPermission` in `preHandler`.
- Every WS op is in `WS_OP_TO_VERB`.
- Every Server Action calls `withPermission`.
- No raw `if (req.auth.role === 'admin')` checks in handler bodies outside middleware.
- `tenant_id` enforced at `Can()` + Prisma middleware + route `requireTenant`.
- No PII in audit row `after_json`.
- `verbose` trace absent from production builds.

### 14.6 Coverage targets

| Package | Coverage target |
|---|---|
| `shared/auth/rbac/**` | ≥ 95 % |
| `api/src/auth/**` | ≥ 90 % |
| `dialer/internal/auth/rbac/**` | ≥ 95 % (Go) |
| `packages/auth/src/server/**` | ≥ 85 % |

---

## 15. Acceptance criteria

The M02 implementation is **DONE** when all of the following pass:

1. `make gen-rbac && git diff --exit-code` exits 0 (Go matrix in sync).
2. `npm run rbac:gen-golden && git diff --exit-code test/rbac/golden.json` exits 0.
3. Both `api/test/auth/rbac/golden.test.ts` and `dialer/internal/auth/rbac/golden_test.go`
   pass with 0 failures — all ~2880 cells agree across languages.
4. `scripts/ci/check-rbac-coverage.sh` passes — no undecorated routes, ops, or actions.
5. `bench/rbac-l1-hit.bench.ts` p99 < 5 µs.
6. `bench/rbac-l2-hit.bench.ts` p99 < 300 µs against local Valkey.
7. Cache invalidation integration test: role change reflected within 1 s.
8. Valkey-down failover: `Can()` serves correct decisions from L1 for 30 s, then falls
   back to MySQL, never fail-opens.
9. Both-down failover: `Can()` returns `system_error`, never an inadvertent allow.
10. Every deny produces a `rbac.denied` audit row in `audit_log` within the same request.
11. Every sensitive-allow produces a `rbac.allowed_sensitive` audit row.
12. `viewer` role exists in `UserRole` enum, appears in `ROLE_PERMISSIONS`, and passes
    integration tests for all read-only verbs it is granted.
13. Prisma tenant-scope middleware blocks unscoped queries on all tables in
    `TENANT_SCOPED_TABLES` and logs an error (not silently passing).
14. Security review checklist (§14.5) signed off by a second engineer.
15. `api/test/auth/rbac/list-scope-consistency.test.ts` passes — list query WHERE
    clause is consistent with per-row `Can()` outcomes.

---

## 16. Open question resolutions

### 16.1 Module naming (RESEARCH §13.1)

**Resolved: M02 stays as RBAC enforcement middleware.** Old "Campaign CRUD" is re-numbered
M09. No RFC; orchestrator approves at review.

### 16.2 `viewer` role (RESEARCH §1.1, §13.2 adjacent)

**Resolved: `viewer` ships in Phase 1** as the sixth role. Use case is real (SOC 2
auditor walkthrough). F02 amendment A7 adds it to the enum. Matrix cells documented in
§2.3.

### 16.3 Per-user permission overrides (RESEARCH §13.2)

**Resolved: Phase 4.** Schema hook documented in §11.1. Phase-1 workaround: role change.
No `user_permissions` table in MVP.

### 16.4 Field-level redaction (RESEARCH §13.3)

**Resolved: Phase 4.** Phase-1 answer: per-route response shaping (caller trims fields
based on `req.auth.role`). No `redact()` helper in Phase 1.

### 16.5 Cross-tenant Path B (RESEARCH §13.9)

**Resolved: never.** `X-Vici2-Cross-Tenant` header not shipped. Super-admin re-auths
per tenant (Path A). Cleaner invariant; no header-trust surface.

### 16.6 Server Action audit noise (RESEARCH §13.8)

**Resolved:** RSC `requirePermission` → no audit row (UI gating). Server Action
`withPermission` deny → audit row tagged `actor_kind:'server_action'`. Fastify route →
always audits. The api is the security boundary; earlier layers are UX.

### 16.7 Integrator scope DSL (RESEARCH §13.4)

**Resolved: Phase 4.** Phase-1 integrators carry `perms: Verb[]` per key, tenant-scoped.
No per-campaign integrator grants. Upgrade path: extend `authCtx.perms` to
`Map<Verb, Grant>` (with scope) when N01 ships.

### 16.8 TOTP interaction (RESEARCH §13.5)

**Resolved: F06 stub shipped.** `Can()` includes the `totp_required_not_verified` check
path (§3.2 step 3) but it is always skipped in Phase 1 (F06 populates `totpVerified` in
Phase 2). The stub keeps the Phase-1 matrix-version and the F06-wired matrix-version
byte-identical.

### 16.9 Integrator verb `auth:login` / `auth:me`

**Resolved:** Integrators use API-key authentication, not password login. `auth:login` is
excluded from the integrator path. `auth:me` is allowed (key health check). All other
verbs are per-key grants.

---

## 17. Dependencies and risks

### 17.1 Hard dependencies

| Dependency | What M02 needs | Risk if delayed |
|---|---|---|
| F05 PLAN (FROZEN) | JWT shape, `requireAuth` skeleton, `requireTenant`, JWKS endpoint | M02 cannot implement the Fastify binding without F05's `req.auth` type. |
| F05 amendment | `ug`, `cmps_kind`, `cmps` claims in JWT | Hot-path cache-free scope hydration degrades to L2/L3 on every request. Acceptable fallback; amendment is low-risk additive. |
| F02 (FROZEN) | Schema enum for roles; `user_groups.allowed_campaigns JSON` column | `viewer` enum value needed before M02 integration tests pass. F02 amendment A7 is a one-line migration. |
| C03 PLAN (FROZEN) | `AuditWriter.append()` API | Audit-on-deny is a hard requirement; M02 blocks on C03 shipping the writer. `audit()` helper is defined as a direct C03 call, not an abstraction layer. |
| F04 (FROZEN) | Valkey client bootstrap; key namespace conventions | Cache layer depends on F04's `createValkeyClient()` and `t:{tid}:` prefix convention. |
| A03 | WS protocol op-code list | `WS_OP_TO_VERB` table must be complete; M02 and A03 must co-ordinate on the op-code spec. |

### 17.2 Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | TS ↔ Go matrix drift | Medium | High | Codegen + CI golden-table gate. No manual Go edits. |
| R2 | Route missing `requirePermission` | Medium | High (silent priv escalation) | CI grep gate (§12.2); manual security review (§14.5). |
| R3 | Role-downgrade staleness | High (inherent to JWT) | Medium | Bounded by 15 min access-token TTL; `logout-all` emergency lever documented in M01 admin UI. |
| R4 | Audit write failure → silent loss | Low | High | Audit failure escalates 403 to 500; page alert on `vici2_audit_write_error_total`. |
| R5 | L1 miss on Valkey round-trip > 100 µs | Medium | Medium | Pre-warm at login; wider LRU if needed; bench gate fails CI on regression. |
| R6 | In-tree library grows beyond scope | Medium | Medium | 1500 LOC trigger for Casbin RFC. Tracked in tech-debt board. |
| R7 | `viewer` role missing from CASL ability | Low | Low (UI shows wrong buttons) | CASL `buildAbility()` derives from shared matrix; viewer row is in matrix. |
| R8 | Prisma middleware ALS context missing in tests | Medium | Medium | Test setup must populate ALS; factory helpers do this. |
| R9 | `reason` string info-leak to client | Low | Low | Gate on `NODE_ENV !== 'production'`; production returns generic `forbidden`. |
| R10 | WS op added to A03 without `WS_OP_TO_VERB` entry | Medium | High | CI grep gate; A03 + M02 co-own the op-code map. |
| R11 | Valkey pub/sub miss during disconnection | High (inherent) | Low (bounded by 30 s L1 TTL) | TTLs bound staleness; no cross-tenant concern since tenant_id is in the JWT. |
| R12 | `null` userGroupId user hits group-scoped verb | Medium | Low | `passGroupScope` treats null as empty → deny `scope_group`. Documented. |
| R13 | Server Action bypassed via direct fetch | High (trivial) | Low (api re-checks) | Defense-in-depth; api is the boundary. Document explicitly. |
| R14 | C03 `AuditWriter` API changes after M02 starts | Low | Medium | Coordinate with C03 IMPLEMENT on the `audit()` function signature before M02 IMPLEMENT begins. |

---

*End of M02 PLAN — RBAC Enforcement Middleware*
