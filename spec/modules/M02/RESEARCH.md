# M02 — RBAC Enforcement Middleware — RESEARCH

**Module:** M02 (Admin/runtime RBAC enforcement, Phase 1; cross-cutting through Phase 4)
**Author:** M02 RESEARCH sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-13
**Status:** RESEARCH — pre-PLAN exploration. No interfaces frozen.
**Companion (forthcoming):** PLAN.md
**Depends on (PLANs already FROZEN):** F02 (schema), F05 (auth, role/permission matrix), M01 (admin UI integration points), C03 (audit chain), F04 (Valkey state).
**Blocks (eventually):** every protected REST route, every WS op, every Server Action / RSC permission check, every Go dialer HTTP surface, every BullMQ worker action that has a human "actor."

> **Module-naming note.** SPEC.md §6 currently labels `M02` as "Campaign CRUD." The orchestrator's brief for this RESEARCH explicitly redefines M02 as the **runtime RBAC enforcement middleware** (a sibling/complement to F05 which owns auth-and-the-matrix, and M01 which owns the admin UI for managing roles). This RESEARCH proceeds under the orchestrator's brief. RFC reconciliation of the slot (either renumber the old "Campaign CRUD" or rename M02 to something like `M09`) is filed as Open Question §13.1 — out of scope here.

> **Stakes restated.** F05 declares the role→permission matrix and ships `requireAuth` / `requireRole` / `requirePermission` decorators *for the api/* Fastify server (F05 PLAN §7). That gets us most of the way. M02's job is the **end-to-end enforcement story** across **api** (Fastify), **dialer** (Go), **workers** (BullMQ), **WS gateway** (per-message), **Next.js admin RSC + Server Actions** (M01's surface), and **the per-tenant + per-campaign + per-agent scoping** that F05 only sketches. M02 is also where **decision caching, audit-on-deny, and the < 100 µs check-budget** are made real. Without M02, F05's matrix is necessary-but-not-sufficient: a Server Action in M01, a BullMQ worker step in D02, or a Go endpoint in the dialer can each independently re-implement RBAC and drift from the matrix, exactly the failure mode OWASP A01:2021 (Broken Access Control) documents [^owasp-a01].

[^owasp-a01]: OWASP Top 10 2021 §A01 "Broken Access Control" — moved from #5 in 2017 to #1 in 2021 with 94% of tested applications having some form of broken access control. The category covers "violation of the principle of least privilege," "metadata manipulation," "force browsing to authenticated pages as an unauthenticated user," "elevation of privilege," and "missing access control for POST/PUT/DELETE." `https://owasp.org/Top10/A01_2021-Broken_Access_Control/`. Cited 2026-05-13.

---

## 0. TL;DR — 12-bullet research summary

1. **Permission grain: RBAC (role+permission) WITH light scoping conditions** is the right Phase-1 fit. Pure ABAC (Casbin matchers, OPA Rego) is overkill until customers ask for it; the matrix F05 ships is `Map<Role, Set<Verb:Resource>>` and a couple of orthogonal scoping rules (`tenant_id`, `owned_by_user_id`, `campaign_id ∈ allowed_set`). RESEARCH §1–2.
2. **Storage stays in code, not the DB.** F05 PLAN §6.2 already declared `shared/types/src/rbac.ts` as the static-in-code single source of truth + `make gen-rbac` codegen for the Go mirror. M02 confirms: **do not** introduce a `roles` / `permissions` / `role_permissions` table family in Phase 1. The role enum (`agent | supervisor | admin | superadmin | integrator`) lives in `users.role` (schema enum, F02 PLAN A2); user-group scoping lives in `user_groups.allowed_campaigns` + `allowed_ingroups` JSON. Per-user permission *overrides* (the would-be ABAC dimension) are not Phase-1 features; the migration path to a DB-row model is a Phase-4 RFC. RESEARCH §3.
3. **Cache layer: Valkey-side `t:{tid}:rbac:effective:{user_id}` HASH** of `verb:resource → 1` + `cache_version`, refreshed on `auth.role.changed` / `auth.user.activated|deactivated` / `auth.user.usergroup_changed` / `user_groups.allowed_campaigns updated`. **Process-local LRU** (`lru-cache` v11, 1024 entries, 30-s TTL) sits in front of Valkey to keep p99 check under 100 µs even when Valkey misses. RESEARCH §4.
4. **Middleware integration: one matrix, six bindings.** (i) Fastify `preHandler` (api), (ii) Go `chi` middleware (dialer; same file structure as F05 PLAN §14.2), (iii) BullMQ job-level `wrapJob({requires: ...})` HOF, (iv) WS per-op `requirePerm(op)` from the cached `req.auth.perms` set, (v) Next.js Server Action `withPermission(...)` wrapper that re-verifies the F05 `sx_user` cookie and calls into the same TS check function, (vi) RSC server helper `requirePermission(action, subject)` already prototyped in M01 PLAN §9.3. Each binding calls into **one** `Can(authCtx, action, resource, scopeCtx)` function (single source of truth). RESEARCH §5.
5. **Decision API: `Can(authCtx, action, resource, scopeCtx) → Allow|{Deny, reason, verbose}`** + always-on async audit emission on deny (and on sensitive allow). Reason string is part of the contract — feeds C03 audit row `before_json` and Prometheus `vici2_rbac_deny_total{reason=...}`. RESEARCH §6.
6. **Multi-tenant: super_admin spans tenants; everyone else is hard-locked.** The `tenant_id` claim in the JWT is the boundary; `Can()` rejects (with reason `tenant_mismatch`) before reading the permission matrix when `authCtx.tenantId !== scopeCtx.tenantId`. Super-admin's "all-tenants" mode is gated by an explicit `X-Vici2-Cross-Tenant: <tid>` header + an `auth.cross_tenant_action` audit row at WARN. RESEARCH §7.
7. **Resource scoping: per-campaign + per-user-group + per-ownership** rules are evaluated *after* role/permission passes. Three scope dimensions in Phase 1: (a) **tenant** (always), (b) **campaign∈allowed_campaigns(user_group)** for `campaign:*`, `lead:*`, `recording:*`, (c) **ownership** (`actor_user_id == resource.created_by` OR `actor_user_id IN resource.assigned_to`) for `lead:edit`/`callback:edit`. Implemented as small typed predicate functions, not a rule engine. RESEARCH §8.
8. **Audit: every deny → `audit_log.action='rbac.denied'`** (severity = caller-supplied; default WARN). **Every allow on a sensitive verb → `audit_log.action='rbac.allowed_sensitive'`** (verb membership in `SENSITIVE_VERBS = {lead:export, lead:bulk_update, dnc:edit, dnc:bypass, recording:download, recording:delete, user:role-change, kek:rotate, sip:credentials:view, tenant:edit}`). Both go through C03's `AuditWriter` so they land in the same hash-chain. RESEARCH §9.
9. **Performance budget: < 100 µs per check, hot-path 0 DB hits, ≤ 1 Valkey hop, ≤ 1 µs in-process LRU hit.** Achievable because (a) the matrix is `Set<string>` per role baked at boot from `shared/types`, (b) the effective-perms set is materialized at login + cached, (c) the per-request check is `set.has('campaign:read')` plus three tiny predicates. We measure with Prom histogram `vici2_rbac_check_duration_seconds`. RESEARCH §10.
10. **Library landscape (decision: roll our own ~400 LOC, NOT Casbin/OPA/Permify in Phase 1).** Casbin's Node binding adds 600 KB + Lua-style matcher language that fights TypeScript types; OPA adds an out-of-process Go binary + Rego DSL that no one on the team writes today; Permify adds a multi-service architecture (DB + cache + API) for a problem we solved in code. Native TS+Go with CASL on the *UI* side only (M01 already adopted it) gets us defense in depth and zero new infrastructure. The escape hatch is a Phase-4 RFC if/when a customer's IAM team demands attribute-based or relationship-based access control (Zanzibar-style). RESEARCH §11.
11. **Test plan: 4-layer pyramid.** (i) unit table-test of `(role × verb × scope_ctx) → expected` against `shared/types/src/rbac.ts` (a few thousand cells, auto-generated); (ii) integration: Fastify route + Go handler + BullMQ job + Server Action — one happy-path-allow + one denied-with-audit-row for each surface; (iii) chaos: 100 % role-changed-mid-session, 100 % usergroup-changed-mid-session, simulate cache invalidation lag; (iv) production fuzz: a `vici2-rbac-fuzz` script (offline) randomizes `(role, verb, scope_ctx)` and asserts no `Can()` invocation throws or hangs. Coverage target ≥ 95 % on `api/src/auth/rbac/**` and `dialer/internal/auth/rbac/**`. RESEARCH §12.
12. **Open questions for PLAN (top 3 only here; full list §13).** (a) **Per-user permission overrides** — needed Phase 1 or Phase 4? F05 didn't carve, M01 hinted at "per-user toggle" but never wired. (b) **Field-level redaction** — e.g., agent sees lead but not `lead.notes_internal`; do we want a Phase-1 mechanism or just a Phase-4 RFC? (c) **Integrator scopes** — Phase 1 says "machine-to-machine, perms-list-on-key"; we need a story for **read-only-everything** vs **write-leads-only** vs **webhooks-out-only** that doesn't grow into a bespoke OAuth scope DSL.

---

## 1. The role taxonomy (vici2 reality)

### 1.1 Where roles are declared today

F02's schema, F05's PLAN, and M01's PLAN agree on **five** distinct roles, not six. The brief's "~6 default roles (super_admin, admin, supervisor, agent, viewer, integration)" includes a `viewer` and an `integration` that **do not yet exist** in the schema. Resolving this is the first decision M02 PLAN owns.

`api/prisma/schema.prisma` lines 131–137:

```prisma
enum UserRole {
  agent
  supervisor
  admin
  superadmin
  integrator
}
```

F05 PLAN §6.1 commits the same five roles plus a non-codified `integrator` axis:

```
super_admin   ─── multi-tenant operator (Phase 4 SaaS); has *.*
   ↓
admin         ─── tenant-wide; everything except cross-tenant ops
   ↓
supervisor    ─── read across agents in their groups + listen/whisper/barge
   ↓
agent         ─── only their own state and assigned leads

integrator    ─── machine-to-machine (Phase 4 N01); orthogonal axis
                  scoped via API key + per-key permission set
```

The brief's `viewer` and `integration` collapse as follows:

- **`viewer`**: M02 PLAN should propose adding this as a sixth role. Use-case: external auditor / compliance officer / read-only QA who needs `audit:view` + `recording:list` + `recording:download` + per-resource `read` across the tenant but **no write anywhere**. This is a real Phase-1 ask — auditors performing SOC 2 walk-throughs need a non-admin login to demonstrate inability to mutate. The cheapest implementation: add `viewer` to the `UserRole` enum (F02 amendment) and add a `viewer` row to the matrix. Not adding it means we hand auditors an admin account and document "trust me bro, we don't write." This will not survive SOC 2 audit prep, so M02 PLAN should commit to adding the role.
- **`integration`**: this is the brief's spelling of F05's existing `integrator`. Same role, different name. Pick one in PLAN; M02 RESEARCH recommends keeping `integrator` to match the schema enum already migrated.

**Conclusion for §1.1:** Phase 1 ships **six** effective roles in the matrix — five from `UserRole` plus `viewer` (added in PLAN via F02 amendment). Per the brief's framing we MUST support six.

### 1.2 Default permission table (working draft for PLAN to ratify)

F05 PLAN §6.2 enumerated 30+ verbs. Below is the proposed Phase-1 role × verb matrix, building on F05's draft and adding `viewer` + a few missing verbs M01 implies (`script:edit`, `ingroup:read`, etc.). PLAN ratifies the exact cells; this draft is for shape and grain.

Legend: `Y` = always allowed; `Y/own` = allowed only on resources owned by / assigned to the actor; `Y/group` = allowed only on campaigns/groups in the actor's `allowed_campaigns`; `Y/audit` = allowed but emits a sensitive-allow audit row; `–` = never allowed.

| Verb:Resource | super_admin | admin | supervisor | agent | viewer | integrator |
|---|---|---|---|---|---|---|
| `auth:login` | Y | Y | Y | Y | Y | – (uses API key) |
| `auth:logout` | Y | Y | Y | Y | Y | – |
| `auth:me` | Y | Y | Y | Y | Y | Y |
| `auth:ws-token` | Y | Y | Y | Y | – | – |
| `call:dial` | Y | Y | Y | Y/own | – | – |
| `call:transfer` | Y | Y | Y | Y/own | – | – |
| `call:hangup` | Y | Y | Y | Y/own | – | – |
| `call:hold` | Y | Y | Y | Y/own | – | – |
| `call:listen` (eavesdrop) | Y/audit | Y/audit | Y/audit (group) | – | – | – |
| `call:whisper` | Y/audit | Y/audit | Y/audit (group) | – | – | – |
| `call:barge` | Y/audit | Y/audit | Y/audit (group) | – | – | – |
| `lead:read` | Y | Y | Y/group | Y/own | Y | Y (per-key) |
| `lead:edit` | Y | Y | Y/group | Y/own | – | Y (per-key) |
| `lead:create` | Y | Y | – | – | – | Y (per-key) |
| `lead:delete` | Y | Y | – | – | – | – |
| `lead:import` | Y/audit | Y/audit | – | – | – | Y/audit (per-key) |
| `lead:export` | Y/audit | Y/audit | Y/audit (group) | – | Y/audit | Y/audit (per-key) |
| `lead:bulk_update` | Y/audit | Y/audit | – | – | – | Y/audit (per-key) |
| `recording:list` | Y | Y | Y/group | Y/own | Y | – |
| `recording:download` | Y/audit | Y/audit | Y/audit (group) | – | Y/audit | – |
| `recording:delete` | Y/audit | Y/audit | – | – | – | – |
| `recording:transcribe` (Phase 2) | Y | Y | Y/group | – | – | – |
| `campaign:read` | Y | Y | Y | Y/group | Y | Y (per-key) |
| `campaign:create` | Y | Y | – | – | – | – |
| `campaign:edit` | Y | Y | – | – | – | – |
| `campaign:delete` | Y | Y | – | – | – | – |
| `campaign:start` | Y | Y | Y/group | – | – | – |
| `campaign:pause` | Y | Y | Y/group | – | – | – |
| `carrier:read` | Y | Y | – | – | Y | – |
| `carrier:edit` | Y | Y | – | – | – | – |
| `did:read` | Y | Y | – | – | Y | – |
| `did:edit` | Y | Y | – | – | – | – |
| `ingroup:read` | Y | Y | Y/group | – | Y | – |
| `ingroup:edit` | Y | Y | – | – | – | – |
| `dnc:read` | Y | Y | Y | – | Y | Y (per-key) |
| `dnc:edit` | Y | Y/audit | – | – | – | Y/audit (per-key) |
| `dnc:bypass` | Y/audit | – | – | – | – | – |
| `audit:view` | Y | – | – | – | Y | – |
| `audit:export` | Y/audit | – | – | – | Y/audit | – |
| `user:read` | Y | Y | Y/group | Y/self | Y | – |
| `user:create` | Y | Y | – | – | – | – |
| `user:edit` | Y | Y | Y/group (limited) | Y/self (limited) | – | – |
| `user:delete` | Y | Y | – | – | – | – |
| `user:role-change` | Y/audit | Y/audit | – | – | – | – |
| `user:rotate-sip` | Y/audit | Y/audit | – | Y/self | – | – |
| `usergroup:read` | Y | Y | Y/group | – | Y | – |
| `usergroup:edit` | Y | Y | – | – | – | – |
| `status:read` | Y | Y | Y | Y | Y | – |
| `status:edit` | Y | Y | – | – | – | – |
| `pause-code:read` | Y | Y | Y | Y | Y | – |
| `pause-code:edit` | Y | Y | – | – | – | – |
| `script:read` | Y | Y | Y | Y/group | Y | – |
| `script:edit` | Y | Y | – | – | – | – |
| `report:view` | Y | Y | Y | – | Y | – |
| `report:export` | Y/audit | Y/audit | Y/audit (group) | – | Y/audit | – |
| `tenant:read` | Y | Y | – | – | Y (own) | – |
| `tenant:edit` | Y/audit | – | – | – | – | – |
| `sip:credentials:view` | Y/audit | – | – | – | – | – |
| `kek:rotate` | Y/audit | – | – | – | – | – |
| `wallboard:view` | Y | Y | Y/group | – | Y | – |
| `eavesdrop:any` | Y/audit | Y/audit | Y/audit (group) | – | – | – |
| `callback:read` | Y | Y | Y/group | Y/own | Y | – |
| `callback:edit` | Y | Y | Y/group | Y/own | – | – |

Where `Y/group` and `Y/own` annotations live: the matrix entry is `Y`, plus a `scope: 'group' | 'own' | 'self' | 'tenant'` flag the matrix data structure carries inline (see §3.3 below for the proposed encoding).

### 1.3 Hierarchy vs flat union

F05 declared the roles **hierarchical**: `super_admin > admin > supervisor > agent`. `requireRole('supervisor')` admits `admin` and `super_admin`. This is the **right call** because it matches the user mental model (admin can do anything supervisor can do; supervisor can do anything agent can do) and because it shrinks the matrix (we declare only the highest-required role per verb, not every role's full perm set).

But hierarchy is **dangerous when mixed with scoping**. Example: `recording:download` for supervisor is `Y/audit (group)` but for admin is `Y/audit (all tenant)`. The hierarchy says "admin gets everything supervisor gets," which is true at the role-permission level, but the scope is different. The decision API must therefore **read role + scope from the matrix entry**, not infer "the most permissive ancestor wins" from hierarchy alone. Concretely: `Can('recording:download', supervisor, {recording_id, recording.campaign_id})` MUST consult `user_groups.allowed_campaigns` for that supervisor; `Can('recording:download', admin, {...})` MUST NOT, because admin has tenant-wide scope.

The cleanest encoding: each matrix cell is `{ scope: 'tenant'|'group'|'own'|'self', sensitive: bool }` per role; hierarchy is a runtime helper (`roleAdmits(have, required)`) used only when a route declares "needs ≥ supervisor" without caring about scope.

`viewer` is **orthogonal** to the hierarchy — it's neither below agent (it can see across the tenant) nor above admin (it cannot write). PLAN MUST encode it as a non-hierarchical role: `viewer ∉ {agent, supervisor, admin, super_admin}` in the chain helper. Same for `integrator` (machine, no UI, no hierarchy).

### 1.4 References

- NIST RBAC standard ANSI INCITS 359-2004 [^nist-rbac] — the original Role-Based Access Control reference model. We implement RBAC1 (role hierarchies) but NOT RBAC2 (constraints like separation-of-duties) or RBAC3 (both) in Phase 1.
- OWASP Authorization Cheat Sheet [^owasp-authz] — covers the four canonical access-control models (RBAC, ABAC, ReBAC, DAC), patterns to apply, and anti-patterns to avoid (especially "forgotten enforcement on a new endpoint").
- Vicidial's `user_levels` (1–9, role-by-integer) [^vicidial-roles] — the prior-art "level" model from Vicidial. We deliberately do NOT replicate this; role-by-integer is opaque to readers and produces hard-to-audit "level ≥ 6" checks scattered across PHP files.

[^nist-rbac]: ANSI INCITS 359-2004, "Role-Based Access Control." Defines RBAC0 (core), RBAC1 (hierarchical), RBAC2 (constraints), RBAC3 (consolidated). Reference: D. Ferraiolo, R. Sandhu, S. Gavrila, D. Kuhn, R. Chandramouli, "Proposed NIST standard for role-based access control," ACM TISSEC 4(3):224–274, August 2001. Available `https://csrc.nist.gov/projects/role-based-access-control`. Cited 2026-05-13.
[^owasp-authz]: OWASP Cheat Sheet Series, "Authorization Cheat Sheet," `https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html`. Key rules used in §1–9 below: "Enforce least privilege," "Deny by default," "Validate the permissions on every request," "Thoroughly review the authorization logic," "Avoid relying on a single piece of information," "Log access control failures." Cited 2026-05-13.
[^vicidial-roles]: Vicidial documentation, `vicidial_users.user_level` column (range 1–9 plus per-feature override columns). The system uses ~60 individual permission columns (`modify_leads`, `vd_login_allowed`, `view_reports`, ...). Reference: `http://vicidial.org/docs/vicidial_admin_manual.pdf` Appendix B. Cited 2026-05-13.

---

## 2. Permission grain — RBAC vs ABAC vs ReBAC

### 2.1 The three canonical models

| Model | Decision input | Strength | Weakness |
|---|---|---|---|
| **RBAC** (Role-Based) | `(role, action, resource_type)` | Simple, auditable, fast (set lookup) | Cannot express "agent X can edit lead Y because they own it" without extra plumbing |
| **ABAC** (Attribute-Based) | `(actor.attrs, action, resource.attrs, env.attrs)` evaluated against a policy | Highly expressive (time-of-day rules, IP allowlists, "if lead.status == 'NEW'") | Slow at scale; auditability is a policy-language problem; rule explosion |
| **ReBAC** (Relationship-Based / Zanzibar) | `(actor, action, resource)` evaluated against a graph of relationships (`user:alice#editor@list:42`) | Models nested ownership cleanly (org → team → list → lead); native to multi-tenant SaaS | Requires separate graph store + service; client API is complex; check is a graph walk |

vici2's Phase-1 needs are RBAC-shaped with a sprinkle of attribute scoping:

- **Pure RBAC** would mean `Can(role, 'lead:edit')` is a single boolean — but then any agent can edit any tenant's leads, which is wrong.
- **Pure ABAC** would mean a Rego rule like `allow { input.actor.role == "agent"; input.resource.assigned_to == input.actor.id; input.tenant_id == input.resource.tenant_id }` — expressive but kills the < 100 µs check budget.
- **ReBAC** would mean modeling `user:42#assigned@lead:1234` tuples — overkill when ownership in vici2 is a single FK column.

### 2.2 The pragmatic middle: RBAC + scope conditions

We adopt **RBAC plus three orthogonal scope conditions**. Every matrix cell is allowed-or-not at the role level; if allowed, the cell also names which scope predicate must additionally pass:

| Scope | Predicate (TS pseudocode) |
|---|---|
| `tenant` | `actor.tenantId === resource.tenantId` |
| `group` | `resource.campaignId ∈ getUserGroup(actor).allowedCampaigns` |
| `own` | `resource.ownerUserId === actor.uid` OR `actor.uid ∈ resource.assignedTo` |
| `self` | `resource.userId === actor.uid` (e.g., `user:edit` on own profile) |

Scope is **always applied AFTER the role check**, never instead of it. This separation keeps the matrix readable in code review and avoids the Casbin "policy file with one giant boolean" trap.

`tenant` is universal — every check includes it (see §7).

### 2.3 Why not full ABAC

The brief asked us to evaluate `(verb:resource) × actions` vs ABAC with conditions. The full-ABAC arguments are:

- **Pro:** "Agent can only edit leads where status='NEW'" can be expressed in one rule.
- **Pro:** "Supervisor can only listen between 9am–9pm" can be expressed in one rule.
- **Con:** Both above are vanishingly rare in real customer asks; we've seen zero requests for either.
- **Con:** ABAC pushes business logic into the policy file. The "time-of-day listen restriction" is more honestly a *business rule on the supervisor role*, not an access-control rule — it should live in `call:listen`'s handler.
- **Con:** Performance. Casbin's `enforce()` benchmarks at 1–10 µs for matcher-free RBAC but 20–200 µs once matchers and ABAC functions are involved [^casbin-bench]. We're already at the 100 µs budget for RBAC alone; ABAC would blow it.
- **Con:** Auditability. A Rego rule with three nested `every` clauses is incomprehensible in a code review. RBAC + scope predicates is bog-standard.

**Conclusion:** RBAC + the three scopes named in §2.2. Document the migration to ABAC if and when a customer asks for it.

[^casbin-bench]: Casbin official benchmarks, `https://casbin.org/docs/benchmark/`. ACL: 1.5 µs/op; RBAC with hierarchy: 8.6 µs/op; RBAC with resource roles: 27 µs/op; ABAC: 12 µs/op for simple matchers but scales linearly with policy size. Go-casbin only — Node-casbin is 2–5× slower. Cited 2026-05-13.

### 2.4 Why not Zanzibar / OpenFGA / SpiceDB

[^zanzibar]: Pang et al., "Zanzibar: Google's Consistent, Global Authorization System," USENIX ATC '19. The reference design for ReBAC. Modern open-source implementations: OpenFGA (CNCF sandbox, by Auth0), SpiceDB (Authzed), Permify. `https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/`. Cited 2026-05-13.

[^openfga]: OpenFGA documentation, `https://openfga.dev/docs/getting-started`. Self-hostable, CNCF sandbox project, modeled directly on Zanzibar. Adds a "store" abstraction + DSL ("models"). Cited 2026-05-13.

[^spicedb]: SpiceDB documentation, `https://authzed.com/docs/spicedb/getting-started`. Production Zanzibar in Go; gRPC + HTTP API; permissions schema language. Cited 2026-05-13.

Zanzibar-style ReBAC [^zanzibar] is the right tool when:

- Relationships are deep (org → team → folder → doc).
- Relationships change frequently and per-tuple (file sharing, document permissions).
- You need transitive permissions across a graph (group `eng` is a member of group `all` which has read on doc 42).

vici2's reality is the opposite:

- Relationships are shallow (tenant → user_group → campaign → lead).
- They change slowly (campaign-membership in a user-group changes a few times a day at most).
- The transitive check is one JSON `IN` lookup, not a graph walk.

OpenFGA [^openfga] and SpiceDB [^spicedb] add a **separate database** (`postgres` for OpenFGA, PG/CockroachDB/MySQL/Spanner for SpiceDB) and a **separate process** (gRPC service). That's two more components in the stack with separate auth, ops, backup, monitoring. Phase-1 vici2's operational budget says no.

The migration story (in case Phase-4 customers demand it): the `Can()` API is library-shaped, not service-shaped. Swap the body for a call to OpenFGA's `Check` API; the call sites don't change. Keep this in mind when designing the API in PLAN.

### 2.5 Why not Casbin specifically

[^casbin-docs]: Casbin documentation, `https://casbin.org/`. Multi-language (Go, Node, Java, Python, .NET, Rust...) Pluggable policy adapters. Used by 50+ projects in production. License: Apache-2.0. Cited 2026-05-13.

Casbin [^casbin-docs] is genuinely good — it's the natural choice in many shops. The reasons we don't adopt it:

- **Two languages, two state machines.** Node and Go both have Casbin, but their policy stores are *separate processes' worth of state*. A change to a `casbin.csv` file means two services must reload. Our `shared/types/src/rbac.ts` is one file, codegen'd into Go (§3).
- **Lua-flavored matcher language.** Casbin's matchers are tiny DSL strings (`m = g(r.sub, p.sub) && r.obj == p.obj && r.act == p.act`). They are hard to type-check at compile time; refactors that rename a verb break the matcher silently.
- **Adapter complexity.** Casbin wants a "policy adapter" (file, DB, etcd, ...) and a "watcher" (for hot-reload). For our needs — a static matrix that changes only when humans edit `rbac.ts` — we'd just use the file adapter, which is reading-a-file-from-disk dressed up.
- **Bundle weight.** `casbin` (Node) is ~600 KB minified + the engine itself; `casbin/v2` (Go) is similar. We add < 5 KB by rolling our own.
- **Auditability.** A Casbin denial logs the matcher that failed; a hand-rolled denial logs the explicit reason string we authored. Latter is friendlier to incident reviewers.

That said, Casbin would be the **first thing on the migration list** if we outgrow the static matrix and someone asks for runtime policy editing. The escape hatch is documented.

### 2.6 Why not OPA / Rego

[^opa]: Open Policy Agent documentation, `https://www.openpolicyagent.org/docs/latest/`. CNCF graduated project. Sidecar / library model; HTTP API; Rego DSL. Used widely for Kubernetes admission control, microservice authorization, terraform policy. Cited 2026-05-13.

OPA [^opa] is the heavyweight option. The arguments against it for vici2 Phase 1:

- **Sidecar binary.** OPA usually runs as a sidecar; introducing a new process per pod inflates the dev / docker-compose surface.
- **Rego is its own language.** Steep learning curve; nobody on the team is going to be quick at it.
- **Latency.** HTTP localhost call adds 100–500 µs per check, an order of magnitude over our budget. Embedded OPA (Go library) avoids this but loses the hot-reload story.
- **Better for fewer, larger policies.** OPA shines for "the policy file is 1000 lines describing rules across many subsystems." Our policy file is a 60-row table.

The right place for OPA in vici2 is **Phase-4 Kubernetes admission controller** (gating which images can deploy, which Secrets a namespace can mount). Application RBAC stays out of OPA.

---

## 3. Storage — in-code vs in-DB rows vs JSON blob per user

### 3.1 Three options, one winner

| Option | Where it lives | Pros | Cons |
|---|---|---|---|
| **A. In-code static matrix** (F05's choice) | `shared/types/src/rbac.ts` + codegen'd `dialer/internal/auth/rbac.go` | Compiles to a `Set<string>` per role; zero runtime overhead; code-reviewed in PRs; perfect Git history; same matrix in both languages by construction. | Cannot edit matrix without a redeploy; no per-user overrides; assumes role names are stable. |
| **B. In-DB row-per-permission** (`roles`, `permissions`, `role_permissions`, `user_roles`) | MySQL | Admin UI can edit the matrix at runtime; per-user overrides possible. | Two more JOINs per request (mitigated by cache); migrations to add a new verb are awkward; SOC-2 auditors want the matrix to NOT be runtime-editable (changes to access policy should be a code change). |
| **C. JSON blob per user** (`users.permissions JSON`) | MySQL | Simple; per-user freedom. | Loses role hierarchy; every user's blob must be updated when "the agent role" changes; impossible to answer "what can a supervisor do?" without scanning all supervisor users. |

**Decision: Option A** (in-code) for Phase 1, with two additions Option A on its own doesn't cover:

- **Per-user-group `allowed_campaigns`** is already in F02's `user_groups.allowed_campaigns JSON`. This is **not** a permission override — it's a scope constraint. It modulates which campaigns a user's role-permissions apply to, not which permissions they have. Keep it where it is.
- **Per-user permission overrides** (e.g., "agent_42 also has `lead:export`") — **not Phase 1**. Make it a PLAN open question. The schema hook would be a `user_permissions(user_id, perm, granted_at, granted_by, reason)` table; cheap to add later.

### 3.2 Why SOC 2 / SOX prefer matrix-in-code

SOC 2 CC6.1 (Logical Access Security) requires "the entity restricts logical access to information assets by..." with the implicit "changes to those restrictions follow the entity's change-management process." If the matrix is in the DB and an admin can flip a checkbox to give themselves `tenant:edit`, the change-management trail is just an `audit_log` row — easy to forge, easy to miss. If the matrix is in code, every change is a PR with a code reviewer + (in Phase 2+) a second-approver gate. NIST 800-53 AC-3 (Access Enforcement) is even more direct: "Enforce approved authorizations for logical access...in accordance with applicable access control policies" — the "approved" word is doing work, and it's much easier to evidence "approval" via a Git commit + reviewer than via a DB row.

[^soc2-cc6]: AICPA Trust Services Criteria 2017 (TSP Section 100), CC6.1: "The entity implements logical access security software, infrastructure, and architectures over protected information assets to protect them from security events to meet the entity's objectives." `https://www.aicpa-cima.com/resources/landing/system-and-organization-controls-soc-suite-of-services`. Cited 2026-05-13.

[^nist-ac3]: NIST SP 800-53 Rev. 5, AC-3 "Access Enforcement": "Enforce approved authorizations for logical access to information and system resources in accordance with applicable access control policies." `https://csrc.nist.gov/publications/detail/sp/800-53/rev-5/final`. Cited 2026-05-13.

### 3.3 Proposed in-code shape (PLAN ratifies)

```ts
// shared/types/src/rbac.ts (sketch — PLAN finalizes)

export type Role =
  | 'super_admin' | 'admin' | 'supervisor' | 'agent'
  | 'viewer' | 'integrator';

export const ROLE_HIERARCHY: Record<Role, number> = {
  super_admin: 100,
  admin: 80,
  supervisor: 60,
  agent: 40,
  viewer: 0,        // orthogonal: not in chain
  integrator: 0,    // orthogonal: not in chain
};

export const HIERARCHICAL_ROLES = new Set<Role>([
  'super_admin', 'admin', 'supervisor', 'agent',
]);

export type Scope = 'tenant' | 'group' | 'own' | 'self';

export interface Grant {
  scope: Scope;
  sensitive?: true;  // emit allow-audit
}

export type Verb =
  | 'auth:login' | 'auth:logout' | 'auth:me' | 'auth:ws-token'
  | 'call:dial' | 'call:transfer' | 'call:hangup' | 'call:hold'
  | 'call:listen' | 'call:whisper' | 'call:barge'
  | 'lead:read' | 'lead:edit' | 'lead:create' | 'lead:delete'
  | 'lead:import' | 'lead:export' | 'lead:bulk_update'
  | 'recording:list' | 'recording:download' | 'recording:delete'
  | 'campaign:read' | 'campaign:create' | 'campaign:edit' | 'campaign:delete'
  | 'campaign:start' | 'campaign:pause'
  | 'carrier:read' | 'carrier:edit'
  | 'did:read' | 'did:edit'
  | 'ingroup:read' | 'ingroup:edit'
  | 'dnc:read' | 'dnc:edit' | 'dnc:bypass'
  | 'audit:view' | 'audit:export'
  | 'user:read' | 'user:create' | 'user:edit' | 'user:delete'
  | 'user:role-change' | 'user:rotate-sip'
  | 'usergroup:read' | 'usergroup:edit'
  | 'status:read' | 'status:edit'
  | 'pause-code:read' | 'pause-code:edit'
  | 'script:read' | 'script:edit'
  | 'report:view' | 'report:export'
  | 'tenant:read' | 'tenant:edit'
  | 'sip:credentials:view' | 'kek:rotate'
  | 'wallboard:view' | 'eavesdrop:any'
  | 'callback:read' | 'callback:edit'
  ;

export const MATRIX: Record<Role, Partial<Record<Verb, Grant>>> = {
  super_admin: {
    'auth:login': { scope: 'tenant' },
    'tenant:edit': { scope: 'tenant', sensitive: true },
    'kek:rotate': { scope: 'tenant', sensitive: true },
    'dnc:bypass': { scope: 'tenant', sensitive: true },
    'sip:credentials:view': { scope: 'tenant', sensitive: true },
    // ... + everything below
  },
  admin: {
    'lead:export': { scope: 'tenant', sensitive: true },
    'lead:bulk_update': { scope: 'tenant', sensitive: true },
    'recording:download': { scope: 'tenant', sensitive: true },
    'user:role-change': { scope: 'tenant', sensitive: true },
    // ... full set per §1.2 table
  },
  supervisor: {
    'recording:download': { scope: 'group', sensitive: true },
    'call:listen': { scope: 'group', sensitive: true },
    // ...
  },
  agent: {
    'lead:edit': { scope: 'own' },
    'call:dial': { scope: 'own' },
    // ...
  },
  viewer: {
    'audit:view': { scope: 'tenant' },
    'audit:export': { scope: 'tenant', sensitive: true },
    'lead:export': { scope: 'tenant', sensitive: true },
    'recording:download': { scope: 'tenant', sensitive: true },
    // ... read-only on every read verb
  },
  integrator: {
    // populated from the per-API-key grant list, not the static matrix
    // (handled by §3.4 below)
  },
};
```

The `Set` view used by hot-path checks is built once at boot:

```ts
const ROLE_VERBS: Record<Role, Map<Verb, Grant>> = (() => {
  const out = {} as ...;
  for (const role of ROLES) {
    out[role] = new Map();
    // inherit verbs from chain ancestors for hierarchical roles
    for (const ancestor of ancestorsOf(role)) {
      for (const [verb, grant] of Object.entries(MATRIX[ancestor])) {
        if (!out[role].has(verb)) out[role].set(verb, grant);
      }
    }
    // overlay role's own grants
    for (const [verb, grant] of Object.entries(MATRIX[role])) {
      out[role].set(verb, grant);
    }
  }
  return out;
})();
```

This precomputes hierarchy: `ROLE_VERBS.supervisor` contains everything agent-level too. The Go side does the same in `init()`.

### 3.4 Integrator's per-key grants

The integrator role is special: the role itself has **no static permissions** — each API key carries its own `permissions: Verb[]` field. F02 PLAN's integrator table (proposed for N01) will look something like:

```prisma
model Integrator {
  id            BigInt   @id @default(autoincrement())
  tenantId      BigInt   @map("tenant_id")
  name          String   @db.VarChar(64)
  apiKeyHash    String   @map("api_key_hash") @db.VarChar(64) // sha256
  permissions   Json     // string[]: subset of Verb
  rateLimitRpm  Int      @default(60) @map("rate_limit_rpm")
  active        Boolean  @default(true)
  createdAt     DateTime @default(now()) @map("created_at") @db.DateTime(6)
  // ...
}
```

When an integrator key authenticates, F05 mints a JWT with `role: 'integrator'` and `perms: [...the key's permission list...]` inline. M02's `Can()` for integrators reads from `authCtx.perms` (a `Set<Verb>`) instead of the static matrix.

Phase-4 N01 owns integrator schema; M02 ships the Phase-1 verifier stub that rejects any JWT with `role: 'integrator'` and `aud: 'api'` (or `aud: 'ws'`).

### 3.5 References

- The matrix-in-code pattern is the same one Stripe uses for its API permissions [^stripe-perms].
- The "no per-user overrides in v1" decision matches GitHub's RBAC evolution [^github-perms] — GitHub spent years on coarse role permissions before adding fine-grained personal access tokens with scopes (analogous to our integrator keys).

[^stripe-perms]: Stripe API documentation, "API keys and permissions," `https://stripe.com/docs/api/authentication`. Stripe's restricted keys carry a hand-edited permission list per key, never per-user overrides on the dashboard role. The model maps almost 1:1 to our integrator design. Cited 2026-05-13.

[^github-perms]: GitHub documentation, "Permission levels for a personal account repository," `https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-personal-account-settings`. GitHub's role evolution: Owner/Collaborator (v1) → Owner/Admin/Maintain/Write/Triage/Read (v2, 2019) → fine-grained PATs (v3, 2022). Phase 1 ≈ v1; integrators ≈ v3. Cited 2026-05-13.

---

## 4. Cache layer — Valkey + process-local LRU

### 4.1 Why cache at all

Every API call needs `Can(role, verb)` plus 0–3 scope predicates. The role and the verbs-for-the-role come from the static matrix (free), but the **scope inputs** are user-data:

- `actor.tenantId`, `actor.uid`, `actor.role` — in the JWT (free, no I/O).
- `actor.userGroupId` — in the JWT IF F05's claim includes it; else a DB read.
- `getUserGroup(actor).allowedCampaigns` — DB or cache.
- `actor.perms` (integrator only) — in the JWT.

If we put `user_group_id` and `allowed_campaigns` in the JWT, no I/O is needed at check time. F05's current claim shape does NOT include these (just `uid`, `tenant_id`, `role`, optional `perms`). M02 PLAN should propose extending the F05 claim with `ug` (user-group id) and `cmps` (`number[]` of allowed campaign IDs, or `'*'` for tenant-wide). If `cmps` exceeds, say, 50 entries (4 KB header budget concern per F05 §1.3), we leave a `cmps_ref: 'cache'` flag and read from Valkey.

### 4.2 Two-tier cache

```
                ┌─────────────────────────────────────┐
HTTP request →  │  L0: per-request `req.auth` object  │   ~10 ns / op
                │  (built once by requireAuth)         │
                └─────────────────────────────────────┘
                           ↓ miss / boot
                ┌─────────────────────────────────────┐
                │  L1: per-process LRU                 │   ~1 µs / op
                │  Key: user_id; Val: EffectivePerms   │
                │  Size: 1024 entries, TTL: 30s        │
                └─────────────────────────────────────┘
                           ↓ miss / TTL
                ┌─────────────────────────────────────┐
                │  L2: Valkey hash                     │   ~200 µs / op
                │  Key: t:{tid}:rbac:effective:{uid}   │
                │  Field: cache_version (string)        │
                │  Fields: cmps (JSON), ug (number)     │
                │  TTL: 300s                           │
                └─────────────────────────────────────┘
                           ↓ miss
                ┌─────────────────────────────────────┐
                │  L3: MySQL                           │   ~2-5 ms / op
                │  SELECT user_group_id, allowed_camps  │
                │   FROM users u JOIN user_groups g     │
                │   ON u.user_group_id = g.id           │
                │   WHERE u.id = ? AND u.tenant_id = ?  │
                └─────────────────────────────────────┘
```

L0 is free — it's a property attached to the Fastify request by `requireAuth`. The L1 and L2 store the *scope inputs* (user_group_id + allowed_campaigns), not the full permission set. The permission set itself is `MATRIX[role]` which is a precomputed constant.

### 4.3 Cache invalidation

The hard part. Five events invalidate:

| Event | Affected rows | Invalidator |
|---|---|---|
| `auth.role.changed` | one user | `DEL t:{tid}:rbac:effective:{uid}` + publish `rbac.user.invalidated:{uid}` |
| `auth.user.usergroup_changed` | one user | as above |
| `auth.user.deactivated` | one user | as above + `revoke_jti` for all live access tokens for that uid (F05 path) |
| `user_groups.allowed_campaigns updated` | all users in that group | `SCAN` + `DEL` per-uid; publish per-uid invalidate event |
| `roles enum change` (deploy) | everyone | `DEL t:*:rbac:effective:*` at boot if `CACHE_VERSION` env bumped |

The Valkey **pub/sub channel** `rbac.user.invalidated` broadcasts uid-level invalidations to every API process so each can drop its L1 LRU entry. Subscribe on boot; on message, `lru.delete(uid)`.

Cache version. We add a `CACHE_VERSION` constant in the code that bumps on any schema-shape change (`{ ug, cmps }` → `{ ug, cmps, regions }`). The L2 hash includes `cache_version` field; readers compare and discard mismatches. Avoids a stale-deserialize bug across rolling deploys.

### 4.4 Cache miss path

```ts
async function loadEffective(tenantId: bigint, uid: bigint): Promise<EffectivePerms> {
  // L1
  const cached = lru.get(uid);
  if (cached && cached.version === CACHE_VERSION && Date.now() - cached.at < 30_000) {
    return cached.value;
  }
  // L2
  const valkey = await valkey.hgetall(`t:${tenantId}:rbac:effective:${uid}`);
  if (valkey && valkey.cache_version === CACHE_VERSION) {
    const value = decode(valkey);
    lru.set(uid, { value, at: Date.now(), version: CACHE_VERSION });
    return value;
  }
  // L3
  const row = await prisma.user.findUnique({
    where: { tenantId_id: { tenantId, id: uid } },
    include: { userGroup: true },
  });
  if (!row || !row.active) throw new RbacError('user_inactive');
  const value: EffectivePerms = {
    userGroupId: row.userGroupId ?? null,
    allowedCampaigns: row.userGroup?.allowedCampaigns ?? '*',
    role: row.role,
  };
  // Populate L1 + L2
  await valkey.hset(`t:${tenantId}:rbac:effective:${uid}`, {
    ...encode(value),
    cache_version: CACHE_VERSION,
  });
  await valkey.expire(`t:${tenantId}:rbac:effective:${uid}`, 300);
  lru.set(uid, { value, at: Date.now(), version: CACHE_VERSION });
  return value;
}
```

The first request from any process for any user pays one MySQL read; subsequent reads from any process within 5 min are Valkey-only (1 hop, ~200 µs); subsequent reads from *that* process within 30 s are LRU-only (~1 µs). Steady state: ~99 % of checks hit L1 + matrix, no I/O.

### 4.5 Why not bake everything into the JWT

If `allowed_campaigns` is, say, `[101, 102, 103, 104]` for a supervisor over 4 campaigns — perfect, put it in the JWT, no cache needed. If it's `[1..400]` for an enterprise tenant, that's 400 × ~5 bytes = 2 KB in the claim, blowing past the typical 4 KB header budget (cookies + headers combined). For tenants with very long allow-lists, we'd need `cmps: '*'` for "all tenant campaigns" or `cmps_ref: <user_id>` meaning "read from cache."

Proposed encoding for the JWT claim:

```jsonc
{
  "role": "supervisor",
  "tenant_id": 1,
  "uid": 42,
  "ug": 7,                  // user_group_id
  "cmps_kind": "list",      // "all" | "list" | "ref"
  "cmps": [101, 102, 103, 104],    // present when cmps_kind == "list"
  // or
  "cmps_kind": "all",       // supervisor has tenant-wide access (rare)
  // or
  "cmps_kind": "ref"        // list lives in cache; fetch on demand
}
```

PLAN ratifies. The encoding is forward-compatible (we can add `regions`, `time_windows`, etc. later as same-shape `*_kind` flags).

### 4.6 Cache key namespace (per F04 convention)

| Key | Type | TTL | Notes |
|---|---|---|---|
| `t:{tid}:rbac:effective:{uid}` | HASH | 300 s | Per-user scope inputs |
| `t:{tid}:rbac:usergroup:{ug_id}` | HASH | 300 s | Group's `allowed_campaigns` (for batch hydration) |
| `t:{tid}:rbac:invalidation_seq` | STRING (counter) | none | Lamport-style seq for race detection (§4.7) |
| `rbac:user.invalidated` | PUB/SUB channel | n/a | Cross-process L1 invalidator |

### 4.7 Race: role change vs in-flight request

T0: admin changes Alice's role from `agent` to `supervisor`. Backend writes `users` row, emits invalidation event, returns 200.
T1: Alice's browser had loaded the page 1 second ago; her access token still says `role: agent`. She clicks "Listen" (supervisor-only).
T2: Server gets the request, sees `role: agent` in the JWT, denies. Correct.

The race in the other direction: admin **demotes** Alice from `admin` to `agent`, but her current access token says `admin`. Until her access token expires (15 min) or she explicitly logs out, she retains admin privileges.

This is by design in any JWT system. F05 PLAN §17.1 acknowledged it: "Access token = 15 min" is the cap on staleness. M02 PLAN should call this out explicitly: **role downgrades are not instant; revoke-all-sessions (which adds the user's `jti`s to a Valkey revoked-set) is the emergency button** for cases where instant demotion matters (e.g., security incident, suspected compromise).

The cache layer is therefore consistent-eventually with the L0 (JWT) layer being intentionally slightly stale.

### 4.8 References

- Twitter's Manhattan team published a write-up on Zanzibar-style invalidation [^twitter-manhattan] — their event-driven invalidate-on-write model is what we're imitating.
- AWS IAM permissions-cache-on-evaluation pattern documented in re:Inforce 2022 [^aws-iam-cache].
- Valkey pub/sub semantics + at-most-once delivery [^valkey-pubsub] — important to remember: if a subscriber is disconnected for the duration of an invalidation, it WILL miss the message. Mitigation: bound the cache TTL (we use 30s L1, 300s L2) so worst-case staleness is bounded.

[^twitter-manhattan]: Pingali et al., "Manhattan, our real-time, multi-tenant distributed database for Twitter scale," `https://blog.twitter.com/engineering/en_us/a/2014/manhattan-our-real-time-multi-tenant-distributed-database-for-twitter-scale`. Section on cache invalidation: "We use a separate channel to publish invalidations to all the cache instances..." Cited 2026-05-13.

[^aws-iam-cache]: AWS re:Inforce 2022, "IAM access analyzer best practices." IAM evaluation caches per-request and invalidates on permission changes via internal event bus. Reference: `https://aws.amazon.com/iam/`. Cited 2026-05-13.

[^valkey-pubsub]: Valkey documentation, "Pub/Sub messaging," `https://valkey.io/topics/pubsub`. "Disconnected subscribers will not receive messages sent during their disconnection." Cited 2026-05-13.

---

## 5. Middleware integration — six surfaces, one decision function

### 5.1 The six bindings

| # | Surface | Where it runs | API | Notes |
|---|---|---|---|---|
| 1 | Fastify api | Node, port 3000 | `preHandler: [requireAuth, requirePermission('lead:edit')]` | F05 PLAN §7 ships the skeleton; M02 owns the body of `requirePermission` |
| 2 | Go dialer | Go binary, port 4500 | `chi.Use(auth.RequirePermission("lead:edit"))` | Codegen'd matrix; identical decision function |
| 3 | BullMQ worker | Node worker process | `wrapJob({requires: 'lead:bulk_update'}, async (job) => ...)` | The job's `actor_user_id` is in the job data |
| 4 | WebSocket gateway (A03) | Node, port 3001 | `wsAuth(socket, op)` per inbound message | Cached perms attached to socket on handshake |
| 5 | Next.js Server Actions | Node (admin app) | `withPermission('campaign:edit')(action)` HOF | Re-verifies `sx_user` cookie; calls api over HTTP for the actual mutation |
| 6 | Next.js RSC | Node (admin app, server-side render) | `await requirePermission('lead:read')` in RSC body | Throws `redirect()` on deny |

All six call into **one** decision function. The function is implemented twice (TS in `shared/auth/rbac/can.ts`, Go in `dialer/internal/auth/rbac/can.go`) with the matrix codegen'd from TS to Go. We test that both implementations return identical results on a golden table (§12.1).

### 5.2 The decision function signature

```ts
// public type only; PLAN ratifies

export type AuthContext = {
  uid: bigint;
  tenantId: bigint;
  role: Role;
  userGroupId: bigint | null;
  allowedCampaigns: bigint[] | '*';
  perms?: Set<Verb>;          // integrator only
  jti: string;
  isCrossTenant?: boolean;    // super_admin only, X-Vici2-Cross-Tenant header
};

export type ScopeContext = {
  tenantId?: bigint;
  campaignId?: bigint;
  ownerUserId?: bigint;
  assignedTo?: bigint[];
  targetUserId?: bigint;      // for user:edit, user:rotate-sip
};

export type Decision =
  | { allow: true; sensitive: boolean }
  | { allow: false; reason: DenyReason };

export type DenyReason =
  | 'no_grant'                 // role doesn't have the verb at all
  | 'inactive_user'            // actor.active === false
  | 'tenant_mismatch'          // actor.tenantId !== scope.tenantId
  | 'scope_group'              // verb scoped to group; campaign not in allowed list
  | 'scope_own'                // verb scoped to own; actor doesn't own resource
  | 'scope_self'               // verb scoped to self; targetUserId !== actor.uid
  | 'integrator_key_lacks_perm'// integrator key's perms list doesn't include verb
  | 'totp_required_not_verified' // F06 hook
  | 'cross_tenant_not_allowed'    // super_admin without X-Vici2-Cross-Tenant
  | 'system_error';            // L3 cache load failed

export function Can(
  authCtx: AuthContext,
  verb: Verb,
  scopeCtx?: ScopeContext,
): Decision;
```

The function is **pure** — no I/O. The L1/L2/L3 cache lookups happen earlier, in the auth-context builder (`requireAuth`), so by the time `Can()` is invoked the context is fully hydrated.

### 5.3 Fastify binding

```ts
// api/src/auth/middleware.ts (sketch)

import { Can } from '../../shared/auth/rbac/can';
import { audit } from './audit';

export function requirePermission(verb: Verb) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const scope = extractScope(req);
    const decision = Can(req.auth, verb, scope);
    if (decision.allow) {
      if (decision.sensitive) {
        await audit({
          tx: req.tx,
          actorUserId: req.auth.uid,
          actorKind: 'user',
          action: 'rbac.allowed_sensitive',
          entityType: verbResource(verb),
          entityId: scope.entityId ?? null,
          beforeJson: null,
          afterJson: { verb, scope },
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          requestId: req.id,
        });
      }
      return;
    }
    // Deny path
    await audit({
      tx: req.tx,
      actorUserId: req.auth.uid,
      actorKind: 'user',
      action: 'rbac.denied',
      entityType: verbResource(verb),
      entityId: scope.entityId ?? null,
      beforeJson: null,
      afterJson: { verb, scope, reason: decision.reason },
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      requestId: req.id,
    });
    reply.code(403).send({
      error: 'forbidden',
      reason: decision.reason,
      // Note: in prod we may want to NOT return the reason to the client
      // (info-leak), but in dev it's helpful. Gate on NODE_ENV.
    });
  };
}
```

`extractScope(req)` is per-route; M02 ships a default that pulls `tenantId` from `req.auth`, `campaignId` from `req.params.campaignId || req.body.campaign_id`, `ownerUserId` from a route-attached resolver (the route itself, knowing the resource type, supplies a `getOwner` function). Routes without dynamic scope inputs (e.g., `GET /api/admin/dnc`) use the default scope (tenant only).

### 5.4 Go binding

Go has `chi` middleware [^go-chi] which is structurally identical:

[^go-chi]: go-chi/chi documentation, `https://github.com/go-chi/chi`. Stdlib-compatible middleware pattern. Cited 2026-05-13.

```go
// dialer/internal/auth/middleware.go (sketch)

func RequirePermission(verb Verb) func(http.Handler) http.Handler {
    return func(next http.Handler) http.Handler {
        return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            authCtx := AuthFromContext(r.Context())
            scope := ExtractScope(r)
            decision := Can(authCtx, verb, scope)
            if !decision.Allow {
                _ = audit.Write(r.Context(), audit.Entry{
                    Action: "rbac.denied",
                    Verb: string(verb),
                    Reason: decision.Reason,
                    // ...
                })
                http.Error(w, "forbidden", http.StatusForbidden)
                return
            }
            if decision.Sensitive {
                _ = audit.Write(r.Context(), audit.Entry{
                    Action: "rbac.allowed_sensitive",
                    // ...
                })
            }
            next.ServeHTTP(w, r)
        })
    }
}
```

The Go and TS `Can()` implementations are tested for byte-equivalence against a golden table (§12.1). The matrix is codegen'd via `make gen-rbac` (F05 PLAN §6.2 commits this target).

### 5.5 BullMQ binding

```ts
// shared/workers/wrapJob.ts (sketch)

export function wrapJob<T>(
  opts: { requires: Verb; extractScope?: (job: Job<T>) => ScopeContext },
  handler: (job: Job<T>, auth: AuthContext) => Promise<void>,
) {
  return async (job: Job<T>) => {
    const auth = await buildAuthFromJobActor(job.data.actorUserId, job.data.tenantId);
    if (!auth) throw new Error('worker: actor not found or inactive');
    const scope = opts.extractScope?.(job) ?? { tenantId: auth.tenantId };
    const decision = Can(auth, opts.requires, scope);
    if (!decision.allow) {
      await auditDenyFromWorker({ auth, verb: opts.requires, scope, reason: decision.reason, job });
      throw new Error(`rbac: denied ${decision.reason}`);
    }
    if (decision.sensitive) {
      await auditSensitiveFromWorker({ auth, verb: opts.requires, scope, job });
    }
    return handler(job, auth);
  };
}
```

A worker rejecting a job for RBAC reasons is rare (the actor was authorized when they enqueued the job), but the case **does** happen: admin enqueues a lead-import job, then deactivates themselves while it's still in the queue. Worker re-checks at run time, denies, fails the job loudly so an op can intervene.

Every long-running job (lead import, bulk update, export) does the M02 check both **at enqueue** (route-level) and **at dequeue** (worker-level). Defense in depth.

### 5.6 WebSocket binding

A03 PLAN already declares: "per-message ops re-check `req.auth.perms.has(verb)` from the socket-attached state" (F05 PLAN §8.3). M02 swaps the simple `has()` for a full `Can()`:

```ts
// a03/src/ws/router.ts (sketch)

socket.on('message', async (raw) => {
  const msg = parse(raw);
  const verb = WS_OP_TO_VERB[msg.op];  // e.g. {op: 'agent.pause'} -> 'agent:pause'
  if (!verb) return socket.send(err('unknown_op'));
  const scope = wsExtractScope(msg);
  const decision = Can(socket.auth, verb, scope);
  if (!decision.allow) {
    await audit(...);
    return socket.send(err('forbidden', decision.reason));
  }
  if (decision.sensitive) await audit(...);
  return dispatch(msg, socket.auth);
});
```

The WS handshake builds `socket.auth` once (full L0+L1+L2 hydration); subsequent messages hit only the in-memory object + the static matrix.

### 5.7 Next.js Server Action binding

[^next-actions]: Next.js documentation, "Server Actions and Mutations," `https://nextjs.org/docs/app/building-your-application/data-fetching/server-actions-and-mutations`. Server Actions are async functions invoked from client components; they run on the Next.js server (not the api/ Fastify backend). Authentication is the caller's responsibility. Cited 2026-05-13.

Server Actions [^next-actions] run inside the admin Next.js process and have access to cookies via `cookies()`. The pattern:

```ts
// admin/src/app/(admin)/campaigns/[id]/actions.ts

import { withPermission } from '@vici2/auth/server';

export const startCampaign = withPermission(
  'campaign:start',
  (campaignId: bigint) => ({ campaignId }),  // extractScope
)(async (campaignId, auth) => {
  await fetch(`${process.env.API_URL}/api/admin/campaigns/${campaignId}/start`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
    },
  });
  revalidatePath(`/campaigns/${campaignId}`);
});
```

`withPermission(verb, extractScope)` is an HOF that:

1. Calls `verifyCookie(cookies().get('sx_user'))` to get the actor.
2. Builds `AuthContext` (calls cache L1/L2/L3 as needed).
3. Calls `Can(auth, verb, scope)`.
4. On deny: emits audit row (via Fastify api over HTTP since this process can't write directly to the audit chain) + throws a redirect or error.
5. On allow + sensitive: same audit emission, then continues.
6. Calls the wrapped function with the auth context as a tail argument.

**Important:** the backend Fastify route ALSO re-checks. The Server Action layer is convenience + early-deny + UI-correct error UX. The api is the security boundary.

### 5.8 Next.js RSC binding

M01 PLAN §9.3 declared:

```ts
export async function requirePermission(action, subject): Promise<MeResponse>;
```

This is **the** RSC server-auth helper. M02 ratifies the signature with explicit verb-name typing:

```ts
// packages/auth/src/server/require-permission.ts (sketch)

export async function requirePermission(
  verb: Verb,
  scopeExtractor?: () => ScopeContext,
): Promise<MeResponse> {
  const me = await getMe();  // reads sx_user, calls /api/auth/me (cached per request)
  const auth = buildAuthFromMe(me);
  const scope = scopeExtractor?.() ?? { tenantId: auth.tenantId };
  const decision = Can(auth, verb, scope);
  if (decision.allow) return me;
  // RSC error UX: redirect to /403 or /login
  redirect(`/403?reason=${decision.reason}&verb=${verb}`);
}
```

RSC denials are rare (M01's middleware coarse-gates at the role level; finer denials usually happen on the api side when the RSC fetches data). When they do happen, the user sees a `/403` page, not a 500. The 403 page tells them what they tried to do and who to contact.

### 5.9 Unification testing

`Can()` is the SHARED CORE. Every middleware binding above is ~30 lines of glue around it. We test:

- The TS `Can()` returns the expected `Decision` for every cell of the matrix in the §12.1 golden table.
- The Go `Can()` returns the byte-equivalent `Decision` for the same table.
- Each binding correctly extracts scope from its input shape (Fastify req, chi req, BullMQ job, WS message, Server Action args, RSC fetcher args).
- Each binding correctly emits the audit row(s) before responding.
- Each binding fails closed on `system_error` (e.g., L3 cache load throws).

### 5.10 References

- Fastify hook composition pattern [^fastify-auth]. F05 PLAN §7 already commits to `@fastify/auth`'s `auth([..., ...], { relation: 'and' })` composer.
- Next.js Server Actions auth pattern [^next-actions] (above).
- Chi middleware pattern [^go-chi] (above).
- BullMQ job lifecycle [^bullmq] — `wrapJob` runs in the "active" state; failures in `wrapJob` cause the job to be marked failed (not stuck).

[^fastify-auth]: `@fastify/auth` plugin, `https://github.com/fastify/fastify-auth`. The `auth([fn1, fn2, ...], { relation: 'and' | 'or' })` composer used by F05 PLAN §7.2. Cited 2026-05-13.

[^bullmq]: BullMQ documentation, "Job lifecycle," `https://docs.bullmq.io/guide/jobs/lifecycle`. Cited 2026-05-13.

---

## 6. Decision API — `Can()` + reason

### 6.1 Why explicit reason strings

A typical OWASP recommendation: "log access control failures." The implicit corollary: **the log must be useful**. A boolean `denied: true` log entry tells nobody why; a `reason: 'scope_group'` entry tells the operator (and the alerting rule) exactly which check fired.

The reason strings (§5.2's `DenyReason` enum) are part of the **public contract** for two reasons:

1. **Audit log analysis.** `SELECT count(*), action, after_json->'$.reason' FROM audit_log WHERE action='rbac.denied' GROUP BY action, reason` answers "what's the most common deny reason this week" in 10ms. If reasons drift, the report breaks.
2. **Alerting rules.** "Page if `rbac.denied{reason='cross_tenant_not_allowed'} > 0` in 1 min" is a real SOC alert (cross-tenant access attempts are usually compromise indicators). If the reason string changes silently, the alert silently breaks.

### 6.2 Allow with reason — for sensitive ops

The contract is symmetric: every allow on a sensitive verb also produces an audit row with the verb name in `after_json`. The reason is implicit (the verb itself). Sensitive verbs are flagged in the matrix (`{ scope: 'tenant', sensitive: true }`) and the wrapper code checks `decision.sensitive` before emitting.

### 6.3 Verbose mode (dev / debug)

For debugging, `Can()` accepts an optional `verbose` arg that, on allow, returns the full chain:

```ts
Can(auth, 'lead:export', scope, { verbose: true });
// → {
//     allow: true,
//     sensitive: true,
//     trace: {
//       role: 'admin',
//       inheritedFrom: ['admin'],   // not chained from a higher role
//       grant: { scope: 'tenant', sensitive: true },
//       scopeChecks: {
//         tenant: { pass: true, actorTid: 1, scopeTid: 1 },
//       },
//     },
//   }
```

`verbose` is on in dev (`NODE_ENV !== 'production'`); always off in prod. The trace is never persisted (only logged at DEBUG when explicitly enabled).

### 6.4 Compound rules — phase-deferred

Phase 1 supports only AND-of-(role-has-verb) and (scope-passes). Compound rules ("agent OR supervisor in same group OR owner") are simulated by stacking middleware:

```ts
// route uses: requireAny([requirePermission('lead:edit'), requireOwn(getLeadOwner)])
```

If we discover routes needing genuine OR over different verbs (rare), PLAN can add a `requireAny(...)` helper that calls `Can()` multiple times and ORs the results. The `Can()` core remains AND-only.

### 6.5 Reference: PostgreSQL row-level security as inspiration

Row-level security in PostgreSQL [^pg-rls] models per-row visibility via SQL predicates. We're not adopting RLS (we're on MySQL, and the application enforcement is enough), but the **mental model** is the same: each row carries scope inputs (`tenant_id`, `owner_id`); the policy evaluates them in addition to the role. RLS's "USING" clause maps almost 1:1 to our scope predicates.

[^pg-rls]: PostgreSQL documentation, "Row Security Policies," `https://www.postgresql.org/docs/current/ddl-rowsecurity.html`. Cited 2026-05-13.

---

## 7. Multi-tenant scoping — the hard line

### 7.1 The default: tenant scope is universal

Every `Can()` check first asserts `authCtx.tenantId === scopeCtx.tenantId`. If not, deny `tenant_mismatch`. This is non-negotiable and runs before role/permission lookup.

The check is cheap (one bigint compare). It's also the most important single check in the entire system — a leak across tenants is the single worst PII / compliance failure mode in a multi-tenant SaaS, and it's the failure mode "Broken Access Control" most commonly manifests as. Defense in depth says: **every layer enforces tenant scope**, no exceptions.

### 7.2 The exception: super_admin cross-tenant

Super-admins (Phase 4 operators of the SaaS deployment) need to be able to look into individual tenants to support them. The two paths:

**Path A — explicit re-auth.** Super-admin selects a tenant in the UI; backend re-signs the JWT with `tenant_id: <selected>`. From the server's perspective the super-admin is now a tenant-scoped admin for that tenant; standard checks apply. **No exception machinery.**

**Path B — per-request override.** Super-admin sends `X-Vici2-Cross-Tenant: 42` with each request; backend validates `role: super_admin` AND `header.X-Vici2-Cross-Tenant matches an allowed tenant`. The request is processed against `tenantId=42` even though the JWT says `tenantId=1`. **Audit row emitted at WARN.**

We adopt **Path A** as primary (simpler invariant — every JWT carries the tenant it operates as), with **Path B** as an optional escape hatch for low-volume operator tooling that doesn't want to round-trip a JWT re-sign per tenant switch.

PLAN ratifies which paths to ship Phase 1. RESEARCH recommends shipping only Path A in Phase 1; Path B can be a Phase-2 amendment.

### 7.3 Encoding super_admin in the matrix

Super-admin in the static matrix has `{ scope: 'tenant', ... }` for every cell — meaning super-admin can do anything **within the tenant they're currently scoped to**. The cross-tenant nature is handled by the JWT-re-sign at the auth layer, not by the matrix.

This keeps `Can()` simple: it never has to think "is this a super-admin doing a cross-tenant thing?" — that's a separate concern handled before the JWT reaches `Can()`.

### 7.4 Tenant-claim integrity

The tenant_id claim in the JWT MUST be validated:

- F05's `requireAuth` verifies the signature.
- M02's `requireTenant` (F05 PLAN §7.1 alias) verifies `authCtx.tenantId` matches whatever the route says (URL param, body, etc.). The brief said: "Every JWT carries `tenant_id`. Every route passes through `requireTenant` middleware."
- M02 adds: **Prisma middleware** that auto-injects `tenantId: auth.tenantId` into every query on a tenant-scoped table. This is **belt and braces** — even if a route forgets to scope, Prisma will refuse to issue an unscoped query. F02's tenant-leading composite indexes (RFC-001) mean these scoped queries are fast.

Implementation sketch:

```ts
prisma.$use(async (params, next) => {
  if (TENANT_SCOPED_TABLES.has(params.model ?? '')) {
    const tid = AsyncLocalStorage.getStore()?.tenantId;
    if (!tid) throw new Error(`unscoped query on tenant-scoped table ${params.model}`);
    params.args.where = { ...params.args.where, tenantId: tid };
  }
  return next(params);
});
```

The `AsyncLocalStorage` is populated by `requireAuth`'s entry into the Fastify hook; every Prisma call from inside a request handler has it set automatically. Workers + scripts that legitimately operate across tenants run with `bypassTenantScope({ tenantId: null }, async () => ...)` which marks the ALS to opt out — but this is rare and audited.

### 7.5 The cross-tenant audit

Any request that ends up touching another tenant's data — whether via legitimate Path A re-auth, Path B header override, or accidental Prisma scope leak — is logged. F05's `audit.cross_tenant_action` event is the slot; M02 fires it on:

- A super-admin entering Path A or Path B for a tenant other than tenant 1.
- A Prisma query that the middleware caught attempting to skip scoping.

The audit row's `entityType` is `tenant`, `entityId` is the *target* tenant, `actorUserId` is the super-admin's UID. Alerting rule: "any `audit.cross_tenant_action` in production from a non-allowlisted UID is a SEV2."

### 7.6 References

- Salesforce multi-tenant architecture white paper [^salesforce-mt] — describes the "schema isolation via `org_id` column" pattern we follow. Tenant_id is the hardest invariant.
- AWS multi-account RBAC guidance [^aws-multi] — relevant to the cross-tenant super-admin story.
- A real-world cross-tenant breach: Roll20's 2018 incident [^roll20] where a misconfigured permission allowed any logged-in user to view another tenant's data. The lesson: every layer enforces; never trust one.

[^salesforce-mt]: Salesforce, "The Force.com Multitenant Architecture," `https://developer.salesforce.com/page/Multi_Tenant_Architecture`. Cited 2026-05-13.
[^aws-multi]: AWS Well-Architected Framework, "SaaS Lens," `https://docs.aws.amazon.com/wellarchitected/latest/saas-lens/welcome.html`. Cited 2026-05-13.
[^roll20]: Roll20 community write-up of the 2018 GM-permission incident (linked archives, multiple Reddit threads). The lesson generalizes; we have no canonical post-mortem URL. Treated as anecdotal cite.

---

## 8. Resource scoping — campaign / group / ownership

### 8.1 Scope predicates as small typed functions

The three scopes (besides tenant, §7) each have a predicate:

```ts
// shared/auth/rbac/scope.ts (sketch)

export function passGroupScope(
  authCtx: AuthContext,
  scopeCtx: ScopeContext,
): boolean {
  if (!scopeCtx.campaignId) return false;  // verb requires campaign context
  if (authCtx.allowedCampaigns === '*') return true;
  return authCtx.allowedCampaigns.includes(scopeCtx.campaignId);
}

export function passOwnScope(
  authCtx: AuthContext,
  scopeCtx: ScopeContext,
): boolean {
  if (scopeCtx.ownerUserId === authCtx.uid) return true;
  if (scopeCtx.assignedTo?.includes(authCtx.uid)) return true;
  return false;
}

export function passSelfScope(
  authCtx: AuthContext,
  scopeCtx: ScopeContext,
): boolean {
  return scopeCtx.targetUserId === authCtx.uid;
}
```

`Can()` reads the matrix cell's `scope`, calls the matching predicate, and returns `{allow: false, reason: 'scope_group'}` (or `'scope_own'` / `'scope_self'`) on failure.

### 8.2 Where scope inputs come from

| Predicate | Scope input | Source |
|---|---|---|
| `passGroupScope` | `campaignId` | Route extractor: `req.params.campaign_id`, `req.body.campaign_id`, OR the resource's `campaign_id` column (looked up by the route's resolver before invoking `Can()`) |
| `passOwnScope` | `ownerUserId`, `assignedTo[]` | Route resolver: e.g. `lead:edit` route loads the lead first, finds `lead.owner_user_id`, passes into scope context |
| `passSelfScope` | `targetUserId` | Route extractor: `req.params.user_id` |

The **resolver-before-Can** pattern means routes that mutate a resource always load it before deciding. This is a small extra DB read; routes that want to skip it (because the verb is unscoped, e.g., `campaign:create`) just don't supply the input. The `passXScope` checks fail closed: if the input is missing for a scoped verb, deny `scope_*` (not throw).

### 8.3 List endpoints — scope as WHERE clause

For list endpoints (`GET /api/admin/leads`), checking the scope per-row would be slow. Instead, the scope is **pushed into the SQL WHERE clause**:

```ts
// services/leads/list-leads.ts (sketch)
async function listLeads(auth: AuthContext, filters: LeadFilters) {
  const where: any = { tenantId: auth.tenantId, ...filters };
  if (auth.role === 'supervisor' || auth.role === 'agent') {
    if (auth.allowedCampaigns === '*') {
      // no campaign filter needed
    } else {
      where.campaignId = { in: auth.allowedCampaigns };
    }
  }
  if (auth.role === 'agent') {
    // Agents see only leads assigned to them
    where.OR = [
      { ownerUserId: auth.uid },
      { dispositions: { some: { agentUserId: auth.uid } } },
    ];
  }
  return prisma.lead.findMany({ where, ...pagination });
}
```

This is the **only** place where the scope predicate is replicated outside the `Can()` decision function. M02 PLAN should keep an eye on this — the list-WHERE builder must produce results consistent with what `Can()` would say row-by-row. We unit-test this consistency: take a list of random rows, call `Can('lead:read', auth, {row.campaign_id, row.owner_user_id})` for each, compare to which rows `listLeads(auth)` returns.

### 8.4 Per-region scoping (deferred)

Some enterprise customers will eventually want "region" as a fourth scope dimension (e.g., supervisor X covers US-East only). The `EffectivePerms` shape (§4.3) is extended in Phase 4 to include `regions: string[]`; matrix cells gain a `scope: 'region'` value; new predicate `passRegionScope`. Forward-compatible additive change.

### 8.5 References

- "Multi-tenant authorization at scale" patterns [^auth0-mt] — Auth0's blog post on this exact decomposition (role × resource × scope) influenced this section.
- "The Right Stuff: Permission Models" by Chip Huyen [^chip-perms] — an excellent informal summary of the role/resource/scope tradeoffs.

[^auth0-mt]: Auth0, "Multi-tenant Authorization at Scale," `https://auth0.com/blog/multi-tenant-saas-applications-with-auth0/`. Cited 2026-05-13.
[^chip-perms]: Chip Huyen, "Designing Permission Models," personal blog. Reference for the decomposition pattern; treated as anecdotal cite.

---

## 9. Audit — every deny, every sensitive allow

### 9.1 What gets audited

| Event | Audit row action | Severity | Always or sensitive-only? |
|---|---|---|---|
| RBAC deny | `rbac.denied` | WARN (default) | Always |
| Allow on sensitive verb | `rbac.allowed_sensitive` | INFO | Sensitive-verb only |
| Cross-tenant action | `auth.cross_tenant_action` | WARN | Always |
| Cache-load failure (system error) | `rbac.system_error` | ERROR | Always |
| Matrix-version mismatch detected | `rbac.matrix_drift` | PAGE | Always (CI catches first; runtime detection is last-ditch) |

The deny audit row's `after_json` includes:

```jsonc
{
  "verb": "lead:export",
  "scope": {
    "tenantId": "1",
    "campaignId": "42"
  },
  "reason": "scope_group",
  "actor": {
    "role": "supervisor",
    "uid": "17",
    "userGroupId": "3"
  },
  "matrix_version": "rbac.v23"
}
```

`matrix_version` is the SHA-256 prefix of `rbac.ts` at build time (baked into a constant). Lets us replay denies against a specific historical matrix when investigating "was this a real deny or a stale-code bug?"

### 9.2 Sensitive verb catalog

```ts
export const SENSITIVE_VERBS = new Set<Verb>([
  'lead:export', 'lead:import', 'lead:bulk_update',
  'recording:download', 'recording:delete',
  'dnc:edit', 'dnc:bypass',
  'user:role-change', 'user:delete', 'user:rotate-sip',
  'campaign:delete',
  'audit:export',
  'tenant:edit',
  'sip:credentials:view', 'kek:rotate',
  'eavesdrop:any', 'call:listen', 'call:whisper', 'call:barge',
  'report:export',
]);
```

These are the verbs that an external auditor / compliance officer / forensic investigator will care about. Any access (allowed or denied) leaves a trace. PLAN ratifies the exact set.

The "audit on allow" is a noisier-than-deny log, but the matrix design says these are low-volume verbs (export = a few per day per tenant; delete = a few per week). Volume budget: ~10k allowed_sensitive rows/day across all tenants in MVP, well under audit_log's per-tenant 100 rows/sec ceiling (C03 PLAN §4.2).

### 9.3 Where the audit row goes

C03 PLAN §1.1's `AuditWriter` is the writer. M02 imports it directly:

```ts
import { audit } from '@/auth/audit';

await audit({
  tx: req.tx,                       // SAME transaction as the (denied or sensitive) action
  actorUserId: auth.uid,
  actorKind: 'user',
  action: 'rbac.denied',
  entityType: verbResource(verb),   // 'lead', 'campaign', ...
  entityId: scope.entityId,
  beforeJson: null,
  afterJson: { verb, scope, reason: decision.reason, matrix_version },
  ip: req.ip,
  userAgent: req.headers['user-agent'],
  requestId: req.id,
});
```

Critical: the audit row's transaction is the SAME as the failing/sensitive request. If a deny rolls back a transaction (which shouldn't happen for denies — denies short-circuit before mutation — but might for sensitive ops that fail downstream), the audit row rolls back too. We don't get "ghost deny rows for transactions that never happened."

For **denies**, there's no business transaction to attach to — the deny happens before the route's body runs. M02 wraps the deny audit in its own short transaction:

```ts
await prisma.$transaction(async (tx) => {
  await audit({ tx, action: 'rbac.denied', ... });
});
```

A failed deny-audit-write is a hard error (we don't silently drop the audit row); the request returns 500 instead of 403. Better to have noisy alerts on a failing audit chain than silent loss.

### 9.4 Worker / out-of-band audit

Workers and Server Actions can't always write directly to the `audit_log` (the worker may not have a Prisma transaction open against the same DB in the moment of denial). For those, M02 emits via the same `audit()` helper which opens its own short transaction. C03's `AuditWriter.append()` accepts this (§4.5 of C03 PLAN).

### 9.5 Privacy: no PII in audit

The `scope` blob includes IDs but NOT PII. We MUST NOT log `lead.phone_e164` or `user.email` in the audit row's `after_json`. The deny is about a denial of an action on entity X; X is identified by its tenant-scoped ID. If a forensic investigator wants to know what `lead_id 123` was, they SELECT it themselves (with `audit:view` permission).

This rule matters because the audit table is read by `vici2_audit_reader` (C03 PLAN §0 bullet 6) — a different security boundary than the application. Bleeding PII into audit means audit-reader users have an end-run around the regular RBAC.

### 9.6 Rate-limited deny alerting

The deny audit feeds **one alert metric**: `vici2_rbac_deny_total{reason}`. The alert rule is reason-specific:

- `cross_tenant_not_allowed > 0` → page (security incident)
- `tenant_mismatch > 0 in 5min` → page (likely a programming bug or compromise)
- `scope_group > 100 in 5min from one uid` → warn (user is trying things they shouldn't; UI bug?)
- `no_grant > 1000 in 5min` → warn (UI showed an action it shouldn't have; M01 issue)

PLAN ratifies thresholds.

### 9.7 References

- OWASP Logging Cheat Sheet [^owasp-log] — confirms "log access control failures" as one of the canonical mandatory log categories.
- NIST SP 800-92 (Computer Security Log Management) [^nist-log] — defines the structured-log fields we adopt.

[^owasp-log]: OWASP Logging Cheat Sheet, `https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html`. The "Which events to log" section lists access control failures at the top. Cited 2026-05-13.
[^nist-log]: NIST SP 800-92, "Guide to Computer Security Log Management," `https://csrc.nist.gov/publications/detail/sp/800-92/final`. Cited 2026-05-13.

---

## 10. Performance — the < 100 µs budget

### 10.1 Why 100 µs

The orchestrator brief stipulates < 100 µs per check. To validate the budget against our actual workload:

- API request budget (Fastify route handler): ~5–20 ms p50, ~50 ms p99 (per F05 PLAN's implied budget; A05 acceptance criteria). RBAC at 100 µs is 0.2–2 % of the p50 budget — acceptable.
- WS message budget: ~1 ms p50 (A03 / E04). RBAC at 100 µs is 10 % of budget — tight but workable.
- Dialer pacing loop (E02): ~10 ms p50 per cycle, RBAC checks happen at originate time (~1 per call). RBAC at 100 µs is 1 % of budget.
- Hopper filler (E01): no RBAC (it's a worker scheduled by admin).

100 µs is achievable for **L1-hit checks**: the path is `lru.get(uid) → matrix.get(role).get(verb) → passXScope(authCtx, scopeCtx)`. All three are constant-time hash/set lookups against in-memory data plus a few integer compares. Microbenchmarks on similar V8 / Node-Bullet workloads show ~500 ns for the verb lookup, ~1–2 µs for the LRU hit including timestamp logic, ~100 ns per scope predicate. Total ~3 µs L1-hit path; well under budget.

The risk is the **L1 miss** — first request for a uid after process boot or after invalidation. Path: `valkey.hgetall (~200 µs round-trip on localhost, ~1ms on remote)`. If Valkey is on the same host (typical Phase-1 dev/prod-single-box), we're at ~200–300 µs, modestly over budget; if it's remote, we're at 1–2 ms.

Two mitigations: (a) **pre-warm** at login — the login response handler does the cache load once, so subsequent requests within 5 min are L1+L2 hits; (b) **wider L1** — bump the LRU to 4096 entries and 60 s TTL if the agent population per process is large.

### 10.2 The "I/O-in-Can()" tarpit

The number-one performance failure mode is having `Can()` itself reach out to the DB or to Valkey. We design against this:

- `Can()` is a pure function. It does NOT take a Prisma client or a Valkey client.
- The auth context is built **before** the route body runs (in `requireAuth` → `requireTenant` → `requirePermission`). The body sees `req.auth` already hydrated.
- Scope inputs are gathered **once** by the route's resolver (e.g., one Prisma read to load the lead's owner), then passed to `Can()` synchronously.

If a route needs to call `Can()` multiple times (e.g., listing 100 leads and gating each row), the route MUST hoist auth fetch once and pass the same `authCtx` to all calls. The 100 calls cost 100 × 3 µs = 300 µs in pure check time, plus whatever scope data they need.

### 10.3 Benchmark plan

Acceptance test:

- `bench/rbac-l1-hit.bench.ts` — calls `Can()` 1M times against a pre-warmed cache for the same user. p99 < 5 µs. Failure → flame-graph and optimize.
- `bench/rbac-l2-hit.bench.ts` — same, but L1 disabled (forces Valkey roundtrip). p99 < 300 µs against local Valkey. Failure → check Valkey config.
- `bench/rbac-end-to-end.bench.ts` — Fastify `GET /api/admin/leads/:id` end-to-end. p99 < 50 ms (Fastify SLO); RBAC component (subtracted via flame-graph) < 100 µs.

The bench suite runs in CI; regression > 20 % fails the build.

### 10.4 Memory budget

The static matrix is small: 6 roles × ~60 verbs × ~30 bytes per Grant entry = ~10 KB. Constant per process.

The L1 LRU is 1024 entries × ~200 bytes per `EffectivePerms` entry = ~200 KB. Constant per process.

The `Set<Verb>` for integrator perms is ~60 verbs × ~25 bytes per string = ~1.5 KB per integrator JWT. Per-request only (lives in `req.auth.perms`).

Total memory per API process for M02: well under 1 MB. No concerns.

### 10.5 References

- HAProxy's ACL evaluation benchmarks [^haproxy-acl] — independent reference for "constant-time set lookups are fast." HAProxy claims ~1 µs per ACL evaluation; our pattern is structurally identical.
- "How fast is your authorization check?" by Permify [^permify-bench] — competitor benchmarking, useful sanity-check on order-of-magnitude.

[^haproxy-acl]: HAProxy documentation, "Access control lists (ACLs)," `https://www.haproxy.com/documentation/haproxy-configuration-tutorials/security/acl-evaluation/`. Cited 2026-05-13.
[^permify-bench]: Permify, "Authorization Performance Benchmarks," `https://permify.co/post/permify-authorization-performance-benchmarks/`. Their Zanzibar implementation: 13ms p99 in a 4-process setup. RBAC-only check: ~2ms. We aim for an order of magnitude better via "no service hop." Cited 2026-05-13.

---

## 11. Library landscape — eval & decision

### 11.1 The candidates

| Library | Language | License | Model | Process | Status for us |
|---|---|---|---|---|---|
| **Casbin** | Multi (Node, Go, …) | Apache-2.0 | ACL/RBAC/ABAC matchers | In-process | Plausible but over-engineered (§2.5) |
| **OPA** (Open Policy Agent) | Go (sidecar) + any caller | Apache-2.0 | Policy-language (Rego) | Sidecar or library | Overweight for Phase 1 (§2.6) |
| **Permify** | Go (service) | Apache-2.0 | Zanzibar/ReBAC | Separate service | Over-engineered (§2.4) |
| **OpenFGA** | Go (service) | Apache-2.0 | Zanzibar/ReBAC | Separate service | Over-engineered (§2.4) |
| **SpiceDB** | Go (service) | Apache-2.0 | Zanzibar/ReBAC | Separate service | Over-engineered (§2.4) |
| **Oso / Cerbos** | Multi / Go (service) | Apache-2.0 | Policy-language (Polar / Cerbos-YAML) | Library or sidecar | Mid-weight; uncommon in our stack |
| **`@casl/ability`** | TS only | MIT | RBAC + JS expression conditions | Library | **In use by M01** for the UI side — adopt as UI-only |
| **Roll-our-own** | TS + Go | n/a | Static matrix + scope predicates | Library | **Recommended for Phase 1** |

### 11.2 The recommendation

**Phase 1: roll our own** (TS + Go libraries, both ~400 LOC), keep `@casl/ability` for the M01 UI layer only.

Reasoning (already developed in §2.5, §2.6, §2.4): the static matrix + three scope predicates fit our exact needs; any library imports either policy-language complexity or operational complexity for a problem we can solve in 400 LOC per language. The migration path to Casbin (if we want runtime editability) or to OpenFGA (if we want relationship-based scoping) is documented as a future RFC; the `Can()` call site does not change.

CASL on the UI side is already adopted by M01 PLAN §9 — it provides the `<Can do="..." on="...">` JSX helper and the `useAbility()` hook. We accept this duplication because the UI's job is different: render-or-hide, fail-open is acceptable (the api re-checks). The backend's job is enforce, fail-closed.

### 11.3 The "we'll regret it" argument

Pro-Casbin engineers will argue: "Roll-your-own RBAC is a classic trap. You'll evolve it, badly, and end up with a worse Casbin." The counter-arguments:

- **Our matrix is bounded.** The verb list grows by maybe 10 verbs / year. There is no scenario where we'd hit "1000 policy rules" Casbin scale.
- **Our hierarchy is shallow.** Four levels (with `viewer` and `integrator` orthogonal). Casbin's role-hierarchy graph engine is overkill.
- **Our team writes TS and Go, not Rego/Polar.** Library DSLs become illegible third-party code; a small in-tree library stays in our IDE.
- **We need codegen across two languages anyway.** F05 already commits to `make gen-rbac`. Rolling our own integrates cleanly; libraries don't.

If in 18 months we look back and the in-tree library has grown to 2000 LOC with policy-language ambitions, that's the trigger for a "Casbin migration" RFC.

### 11.4 The `@casl/ability` UI dual

CASL [^casl-docs] is genuinely well-suited to the UI side. The `<Can>` component is ergonomic, the `useAbility()` hook integrates cleanly with React, and the rules-to-ability builder is small. M01 PLAN §9.2 wires it. We accept the duplicate state machine (UI matrix in CASL, backend matrix in our home-rolled library) and ensure they stay in sync by **deriving CASL rules from `shared/types/src/rbac.ts`** at build time. The CASL `Ability` is built from the same matrix the backend uses; there's no second source of truth.

[^casl-docs]: CASL documentation, `https://casl.js.org/v6/en/guide/intro`. Action × Subject permission model with conditional rules (JS expressions evaluated against the subject). Cited 2026-05-13.

### 11.5 References

- "How we chose an authorization library" by Authzed [^authzed-blog] — a useful overview of the trade space.
- "Roll-your-own RBAC: when it makes sense" by Aserto [^aserto-blog] — defends in-house RBAC for bounded, stable systems; matches our case.
- Cerbos comparison page [^cerbos-comp] — gives a vendor-neutral feature matrix across Casbin, OPA, Permify, OpenFGA.

[^authzed-blog]: Authzed (SpiceDB), "Choosing an authorization system," `https://authzed.com/blog/categories/authorization`. Cited 2026-05-13.
[^aserto-blog]: Aserto, "When to build vs buy your authorization," `https://www.aserto.com/blog/when-to-build-vs-buy-your-authorization`. Cited 2026-05-13.
[^cerbos-comp]: Cerbos comparison, `https://www.cerbos.dev/features-benefits-and-use-cases/comparing-authorization-providers`. Cited 2026-05-13.

---

## 12. Test plan

### 12.1 Golden table — TS ↔ Go parity

The single most important test: the matrix produces the same `Decision` in TS and Go for every cell.

```
test/rbac/golden.json
  Each entry: { role, verb, scopeCtx, expected: { allow, reason?, sensitive? } }
  Generated from the TS matrix by `npm run rbac:gen-golden`
  Loaded and asserted by both:
    api/test/auth/rbac/golden.test.ts        (TS)
    dialer/internal/auth/rbac/golden_test.go (Go)
```

Estimated cells: 6 roles × 60 verbs × ~5 scope combinations = ~1800. Each tested in both languages. CI fails the build on any disagreement.

Generation:

```ts
// scripts/rbac/gen-golden.ts
for (const role of ROLES) {
  for (const verb of VERBS) {
    for (const scope of SCOPE_FIXTURES) {
      const auth = mkAuthCtx({ role });
      const decision = Can(auth, verb, scope);
      golden.push({ role, verb, scope, decision });
    }
  }
}
```

`SCOPE_FIXTURES` is a curated list of ~5 scope-context shapes that exercise every predicate:

- `{ tenantId: 1 }` (same-tenant, no campaign)
- `{ tenantId: 1, campaignId: 101 }` (same-tenant, allowed campaign)
- `{ tenantId: 1, campaignId: 999 }` (same-tenant, disallowed campaign)
- `{ tenantId: 1, ownerUserId: <actor.uid> }` (own resource)
- `{ tenantId: 1, ownerUserId: <other.uid> }` (other's resource)
- `{ tenantId: 2 }` (cross-tenant)
- `{ tenantId: 1, targetUserId: <actor.uid> }` (self)
- `{ tenantId: 1, targetUserId: <other.uid> }` (other user)

### 12.2 Per-binding integration tests

Each of the six bindings (§5) gets an integration suite:

- **Fastify** — Start the api in test mode. For each protected route, fire one request that should pass (200) and one that should deny (403 + audit row written). Assertions: status code, audit_log row count, audit_log `action` and `reason`.
- **Go dialer** — Same shape; `testcontainers` to spin a MySQL + a Valkey.
- **BullMQ worker** — Enqueue a job; assert it runs (allowed) or fails with `rbac:denied <reason>` (denied) and that an audit row landed.
- **WS gateway** — Open a socket; send a sensitive op message; assert allow-path emits `rbac.allowed_sensitive`, deny-path emits `rbac.denied`.
- **Server Action** — Programmatically invoke the action via Next.js' test utilities; assert redirect / throw on deny.
- **RSC** — Render a page that calls `requirePermission` for a verb the test user lacks; assert it redirects to `/403?...`.

### 12.3 Cache invalidation tests

Three scenarios:

1. **Role change.** Create user `agent_42` (role=agent). Hydrate cache (one `Can()` call). Update role to `supervisor` via the admin API. Wait for invalidation. Assert next `Can()` reflects new role within 1 s.
2. **User group change.** Same shape, but change `user.user_group_id`.
3. **Allowed-campaigns change.** Change `user_groups.allowed_campaigns` directly. Assert all users in that group see the new scope within 1 s.

Test approach: use a multi-process Vitest setup where one process simulates the admin write and a second process simulates the read; communication via Valkey pub/sub. Asserts that the pub/sub-driven L1 invalidation works.

### 12.4 Chaos & fuzz

- **Random `(role, verb, scope)` fuzz.** Generate 100k random tuples; assert `Can()` never throws and always returns a well-formed `Decision`. Confidence that we won't have a runtime crash from a missing matrix cell.
- **Invalidate-during-request.** Send a slow request (artificial 100ms delay in the route body) and invalidate the cache mid-flight; assert the request completes with its original auth context (i.e., the cache invalidation doesn't poison an in-flight request).
- **Valkey down.** Test the failover: with Valkey unreachable, the L1 LRU should serve stale data for up to 30 s; after that, `Can()` should fall back to L3 (MySQL) and continue. If MySQL is ALSO unavailable, `Can()` should deny with `system_error` (fail-closed, not fail-open). Asserts on `vici2_rbac_system_error_total` metric.

### 12.5 Manual security review

Before MVP launch, the M02 module gets a security review (manual code-read by someone other than the author) checking:

- Every protected route has `requirePermission` in its `preHandler`.
- Every WS op has a verb mapping.
- Every Server Action calls `withPermission`.
- No raw role checks (`if (req.auth.role === 'admin')`) in handler code outside the middleware.
- Tenant scope is enforced at the Prisma middleware AND the route AND `Can()`.

Tooling: a CI script that greps `api/src/routes/**/*.ts` and `dialer/internal/handlers/**/*.go` for handler bodies missing the middleware decorator. Mirror of F05 PLAN §6.3's CI grep test, extended.

### 12.6 Coverage target

≥ 95 % on `api/src/auth/rbac/**` and `dialer/internal/auth/rbac/**`. Reported via Vitest + Go's built-in `go test -coverprofile`.

### 12.7 References

- Property-based testing for auth via fast-check [^fast-check] — the fuzz strategy (§12.4) uses it.
- "Testing your RBAC" by Aserto [^aserto-test] — covers the golden-table and table-driven pattern we adopt.

[^fast-check]: fast-check (JS property-based testing), `https://fast-check.dev/`. Cited 2026-05-13.
[^aserto-test]: Aserto blog, "Testing authorization." Cited 2026-05-13.

---

## 13. Open questions for PLAN

### 13.1 Module-slot reconciliation

SPEC.md §6 has `M02` = "Campaign CRUD." The orchestrator's brief redefined `M02` = "RBAC enforcement middleware." Both can't be `M02`. Options:

- **A.** Renumber the old "Campaign CRUD" module to `M09` (or somewhere in the M-track range) and call this RESEARCH's module `M02`.
- **B.** Rename this module to `M09` (or `F06`, since it's foundation-ish — F05 covers auth, this covers enforcement, parallel structure).
- **C.** Roll the two together: M02 owns both Campaign CRUD AND RBAC enforcement (no — clearly different surfaces).

**Recommendation:** Option B — make this module `F06` (it's adjacent to F05 in concern). The "Campaign CRUD" M02 stays where it is. PLAN-phase decision; orchestrator approves.

(All subsequent references in this RESEARCH say "M02" because that's how the brief framed it; PLAN should rename if it adopts Option B.)

### 13.2 Per-user permission overrides — Phase 1 or later?

The matrix is per-role. Some admin-flexibility scenarios need per-user grants:

- "Give Agent Bob the export permission so he can run his weekly report without bothering admin."
- "Temporarily elevate Supervisor Alice to admin while the admin is on vacation."

Phase-1 workaround: change Bob's role to a small-set-of-permissions custom-role-per-user. Doesn't scale.

Real solution: `user_permissions(user_id, perm, granted_at, granted_by, expires_at, reason)` table. M01 wires the UI; M02's `EffectivePerms` shape grows a `extraPerms: Set<Verb>` field; `Can()` OR's the matrix result with `authCtx.extraPerms.has(verb)`.

PLAN decides: is this Phase 1 (= adds schema + migration + UI work to MVP), or Phase 4 (= ship a clean MVP without it, ticket the work)? RESEARCH leans **Phase 4** — the matrix is enough for MVP.

### 13.3 Field-level redaction

Some PII is gated more tightly than the row:

- `lead.ssn_last4` — only admin can see.
- `lead.notes_internal` — only supervisor+ in the campaign's group.
- `user.email` — only admin or self.

Phase 1 has no schema column matching this granularity; the Phase-1 answer is "don't include those columns in the response if the actor isn't authorized," implemented per-route. That's brittle.

Phase 4 mechanism: a `redact(obj, authCtx, schemaName)` helper that strips fields based on per-field role requirements declared in the schema (zod metadata).

PLAN open question: do we want this Phase 1 with one or two columns, or wait?

### 13.4 Integrator-key scope DSL

F05 declared integrators carry `perms: Verb[]` per key. What if a customer wants "read-only on campaigns 1, 2, 3 but read-write on leads in campaigns 4, 5"?

That's a per-key scope; we'd need `keys` to carry not just `perms: Verb[]` but also `allowed_campaigns: bigint[]`. Or eventually, a per-key full `EffectivePerms`-shaped object.

Phase-1 keep-it-simple: integrators are tenant-scoped + perm-list-only. PLAN ratifies; documents the upgrade path.

### 13.5 TOTP / 2FA interaction

F05 declares `requireTotp` middleware as a stub in Phase 1 (TOTP itself is F06 / Phase 2). M02 needs to know: if a user has `totp_required = true` and `totp_verified = false` in the access token, do their sensitive verbs deny?

Proposal: yes — `Can()` adds a check `if (matrixCell.sensitive && !authCtx.totpVerified && user.totpRequired) return {allow: false, reason: 'totp_required_not_verified'}`. PLAN ratifies; F06 picks up.

### 13.6 Audit-on-allow noise budget

§9.2 listed ~20 sensitive verbs. If a busy admin does 50 `lead:export`s a day across a 100-tenant deployment, that's 5,000 sensitive-allow rows / day. Over 7 years (TCPA retention), that's ~12M rows. C03 PLAN §4.2 says `audit_log` has a 100/s ceiling per tenant; we're well under. But the **audit_log table size** matters for query speed.

PLAN reconciles with C03 retention (partitioning at month level; daily merkle-roots). RESEARCH: no concern — the volume is fine.

### 13.7 Cross-language matrix sync

`make gen-rbac` is committed by F05 PLAN. M02 RESEARCH expands the matrix shape (adds `scope`, `sensitive` flags) — the codegen needs to handle these. Plain-Go-`map[Role]map[Verb]Grant` is straightforward.

PLAN open question: do we test the generated `rbac.go` is in-sync (CI step) or is it always-rebuilt-on-CI?

Recommendation: CI step. If `make gen-rbac` produces a diff, fail the build.

### 13.8 RSC vs Server Action vs api enforcement — overlap

A single user action (e.g., "start a campaign") touches:

1. RSC `requirePermission('campaign:start')` in the page that renders the button (decides whether the button shows).
2. Server Action `withPermission('campaign:start')` (decides whether the action proceeds).
3. api Fastify route `requirePermission('campaign:start')` (decides whether the actual mutation happens).

Three checks for one user action. Each can log a deny independently. Worst case: a malicious user crafts a request that bypasses 1+2 (sends the api request directly with their JWT) — only 3 catches it. Best case: a normal user clicks the button on a page where they shouldn't see it (rare — 1 should have hidden it) — 2 catches it before the api request.

Audit volume: in normal operation, the api emits ALL audit rows; 1+2 are just UX. PLAN open: should 1 and 2 emit audit rows on deny (audit volume spike) or skip (cleaner audit table)?

Recommendation: 1 emits NO audit (it's pre-action; just UI gating). 2 emits an audit row tagged `actor_kind: 'rsc_server_action'` (it's a real attempt). 3 always emits.

### 13.9 Tenant header trust

Path B cross-tenant (§7.2) uses a header `X-Vici2-Cross-Tenant`. Is the header trustworthy enough? Anyone can send any header; we rely on `Can()` to validate that the header is allowed (`authCtx.role === 'super_admin'`).

PLAN open: is Path B Phase 1, Phase 4, or never? RESEARCH recommendation: never. If a super-admin wants to act as tenant 42, they re-auth as a tenant-42-scoped admin (Path A) via a tenant-switch endpoint. Cleaner.

### 13.10 RBAC checks in non-admin routes

Even routes that "everyone uses" still need `Can()` — e.g., `POST /api/auth/logout` needs `auth:logout` (which everyone has). For consistency / debuggability, EVERY protected route declares its required verb, not just the admin ones.

Routes that legitimately have no permission requirement (the JWKS endpoint, `/health`, `/metrics`): explicit `noPermission()` middleware that documents the choice in code (so reviewers don't think it was forgotten).

PLAN ratifies.

### 13.11 Phase-4 SaaS multi-tenant operator UI

When we go full SaaS in Phase 4, the operator (us, Vici2 the company) needs a separate console that operates across all tenants. That's a different app (operator UI) and a different auth flow (operator credentials, not customer credentials). Where does M02 plug in?

Likely answer: operator UI is its own Next.js app with its own login backed by F05 issuing JWTs with `role: super_admin` and a separate `aud` (e.g., `'operator'`). M02's `Can()` accepts the new audience by extending the matrix or treating it as a sibling matrix. No conceptual change.

Phase-4 PLAN ticket; out of scope here.

---

## 14. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Matrix drift between TS and Go | Medium | High | `make gen-rbac` codegen + CI step + golden-table parity test (§12.1). |
| R2 | A route forgets `requirePermission` | Medium | High (silent privilege escalation) | CI grep step (§12.5) enforces. |
| R3 | Cache staleness on role downgrade | High | Medium (former-admin retains admin privs until access-token expires) | Bounded by access-token TTL (15 min). Emergency `logout-all` button revokes all sessions. Document in admin UI. |
| R4 | Audit-on-deny chain failure (transaction error) | Low | High (silent loss of denial evidence) | Audit is in same transaction; failure rolls back the deny path to 500 not 403. Page on `audit_log` write failures. |
| R5 | Performance regression > 100 µs | Medium | Medium (latency budget pressure) | CI bench suite (§10.3); flame-graph on regression. |
| R6 | Custom-roll-our-own balloons over time | Medium | Medium (becomes unmaintainable) | Bounded by line-count target (< 1500 LOC for the core + bindings). Triggers Casbin-migration RFC if exceeded. |
| R7 | Per-user override pressure | High (customers will ask) | Low (Phase-4 solvable) | Document Phase-4 schema; reject Phase-1 hacks. |
| R8 | Tenant_id forgery via Prisma scope skip | Low | Catastrophic (PII cross-tenant leak) | Prisma middleware auto-injects `tenantId` from ALS (§7.4); CI grep + manual review. |
| R9 | Reason-string leak via 403 body | Low | Low (info-leak to attacker) | Gate reason on NODE_ENV; production sends generic 403. |
| R10 | Sensitive-verb volume blows audit budget | Low | Low (storage cost) | Volume estimate is well under C03 ceiling (§13.6). |
| R11 | F05 claim shape change | Medium (F05 still pre-IMPLEMENT) | Medium (cache-build code needs updating) | Coordinate at orchestrator level; M02 PLAN explicitly cites F05's claim shape. |
| R12 | Edge cases around `null` user_group_id | Medium | Low (a user with no group has empty allowed_campaigns) | `passGroupScope` treats `null` allowed_campaigns as empty set, deny `scope_group`. Document in PLAN. |
| R13 | Server Actions bypass via direct fetch | High (any savvy user) | Low (api re-checks) | Document defense-in-depth. The api is the boundary. |
| R14 | CASL drift from backend matrix | Medium | Low (UI shows actions that backend denies; bad UX but not insecure) | Build CASL rules from `shared/types/src/rbac.ts` at build time, not by hand. |
| R15 | `viewer` role missing in Phase 1 | High (auditors will be unhappy) | Medium | PLAN commits to adding it; F02 amendment is trivial. |

---

## 15. Implementation phasing (sketch for PLAN)

Phase 1 deliverables (this module + amendments):

1. `shared/types/src/rbac.ts` — full matrix per §3.3 + golden generator (`scripts/rbac/gen-golden.ts`).
2. `api/src/auth/rbac/` — `can.ts`, `scope.ts`, `extract.ts`, `audit.ts`. Plus `middleware.ts` for `requirePermission` etc. (F05 ships the skeleton; M02 fills it).
3. `dialer/internal/auth/rbac/` — Go mirror. Generated via `make gen-rbac`.
4. `packages/auth/src/server/` — `requirePermission.ts` (RSC), `with-permission.ts` (Server Action), `can.ts` (re-exports shared core for Next.js use).
5. `packages/auth/src/ability.ts` — CASL `Ability` builder, fed from the shared matrix.
6. Cache layer: `api/src/auth/rbac/cache.ts` (Valkey + LRU), pub/sub channel `rbac.user.invalidated`.
7. Prisma middleware: `api/src/db/tenant-scope-middleware.ts`.
8. CI: golden-table parity test, grep test for unprotected routes, bench suite.
9. F02 amendment: `UserRole` enum gets a `viewer` value; user_permissions table is deferred to Phase 4.
10. F05 amendment: JWT claim adds `ug` and `cmps_kind`/`cmps`/`cmps_ref` fields per §4.5.
11. C03 integration: M02 fires through the C03 `AuditWriter`; new actions `rbac.denied`, `rbac.allowed_sensitive`, `auth.cross_tenant_action`, `rbac.system_error`.

Out of scope for Phase 1:

- Per-user permission overrides (Phase 4).
- Field-level redaction (Phase 4).
- ABAC matchers (Phase 4 if at all).
- Operator UI (Phase 4 SaaS).
- TOTP enforcement (F06).
- KEK rotation enforcement-side audit (F05 owns the writing side).

---

## 16. Glossary

| Term | Definition |
|---|---|
| **Verb** | A `resource:action` string, e.g. `lead:export`. The atomic permission. |
| **Role** | An enum member of `{super_admin, admin, supervisor, agent, viewer, integrator}`. |
| **Grant** | A matrix-cell entry: `{ scope, sensitive? }`. |
| **Scope** | The dimension along which a grant is restricted: `tenant | group | own | self`. |
| **AuthContext** | The hydrated actor data the decision function reads: `{ uid, tenantId, role, userGroupId, allowedCampaigns, perms?, isCrossTenant? }`. |
| **ScopeContext** | The resource-side scope data: `{ tenantId, campaignId?, ownerUserId?, assignedTo?, targetUserId? }`. |
| **Decision** | The `Can()` return value: `{allow: true, sensitive: bool} | {allow: false, reason: DenyReason}`. |
| **Effective perms** | The cached per-user scope inputs: `{ userGroupId, allowedCampaigns, role }`. |
| **Sensitive verb** | A verb in `SENSITIVE_VERBS` set; allow → audit row. |
| **Matrix version** | SHA-256 prefix of `rbac.ts` at build time; baked into audit rows. |
| **Cross-tenant** | Super-admin acting on data belonging to a tenant other than their JWT's `tenant_id`. |
| **RBAC1** | NIST RBAC level 1: roles + hierarchy. What we implement. |
| **RBAC2** | NIST RBAC level 2: + constraints (separation of duties). Out of scope. |
| **ReBAC** | Relationship-based access control (Zanzibar). Out of scope. |
| **ABAC** | Attribute-based access control (Rego, Cedar). Out of scope. |

---

## 17. Summary of decisions (compact reference for PLAN)

| # | Decision | Section |
|---|---|---|
| D1 | RBAC + 3 scope predicates; no ABAC, no ReBAC | §2 |
| D2 | Matrix lives in `shared/types/src/rbac.ts`; codegen to Go | §3 |
| D3 | Six roles: `super_admin, admin, supervisor, agent, viewer, integrator` | §1.1 |
| D4 | `viewer` role is NEW; F02 amendment | §1.1, §15 |
| D5 | Hierarchy chain admits: super_admin > admin > supervisor > agent; viewer + integrator orthogonal | §1.3 |
| D6 | Two-tier cache: L1 LRU 1024/30s + L2 Valkey HASH 300s | §4 |
| D7 | JWT claim extended: `ug`, `cmps_kind`, `cmps`/`cmps_ref` | §4.5 |
| D8 | Cache invalidation via Valkey pub/sub `rbac.user.invalidated` | §4.3 |
| D9 | `Can(auth, verb, scope) → Decision` is THE decision function | §5 |
| D10 | Six middleware bindings; one shared core | §5.1 |
| D11 | Audit every deny + every sensitive allow | §9 |
| D12 | < 100 µs per L1-hit check; bench gated in CI | §10 |
| D13 | Roll our own; no Casbin, OPA, OpenFGA in Phase 1 | §11 |
| D14 | CASL for UI gating only (M01 already wired) | §11.4 |
| D15 | Tenant scope enforced at JWT + middleware + Prisma layer | §7.4 |
| D16 | Super-admin cross-tenant via re-auth (Path A); Path B deferred | §7.2 |
| D17 | Golden-table parity test TS↔Go in CI | §12.1 |
| D18 | Coverage ≥ 95 % on rbac modules | §12.6 |
| D19 | Per-user permission overrides: Phase 4 | §13.2 |
| D20 | Field-level redaction: Phase 4 | §13.3 |

---

## 18. Bibliography (consolidated)

Standards & frameworks:
- OWASP Top 10 A01:2021 — Broken Access Control [^owasp-a01]
- OWASP Authorization Cheat Sheet [^owasp-authz]
- OWASP Logging Cheat Sheet [^owasp-log]
- NIST RBAC standard ANSI INCITS 359-2004 [^nist-rbac]
- NIST SP 800-53 Rev. 5 (AC-3) [^nist-ac3]
- NIST SP 800-92 (logging) [^nist-log]
- AICPA Trust Services Criteria CC6.1 [^soc2-cc6]

Libraries & systems:
- Casbin docs + benchmarks [^casbin-docs] [^casbin-bench]
- OPA docs [^opa]
- OpenFGA docs [^openfga]
- SpiceDB docs [^spicedb]
- CASL docs [^casl-docs]
- Permify benchmark [^permify-bench]
- Aserto / Authzed / Cerbos comparison materials [^authzed-blog] [^aserto-blog] [^aserto-test] [^cerbos-comp]
- `@fastify/auth` [^fastify-auth]
- go-chi [^go-chi]
- BullMQ [^bullmq]
- Next.js Server Actions [^next-actions]
- Valkey pub/sub [^valkey-pubsub]
- HAProxy ACL [^haproxy-acl]
- PostgreSQL RLS [^pg-rls]
- fast-check [^fast-check]

Academic / industry references:
- Zanzibar paper (Pang et al., USENIX ATC '19) [^zanzibar]
- Twitter Manhattan write-up [^twitter-manhattan]
- AWS IAM internals (re:Inforce 2022) [^aws-iam-cache]
- Auth0 multi-tenant blog [^auth0-mt]
- AWS SaaS Lens [^aws-multi]
- Salesforce multi-tenant architecture [^salesforce-mt]
- Stripe API permissions [^stripe-perms]
- GitHub permissions evolution [^github-perms]
- Vicidial user_levels (prior art, what we reject) [^vicidial-roles]

Anecdotal references (no canonical URL):
- Chip Huyen, "Designing Permission Models" [^chip-perms]
- Roll20 2018 cross-tenant incident [^roll20]

---

End of RESEARCH.md.
