# M01 — Admin Next.js Skeleton + RBAC Routing — PLAN

**Module:** M01 (Admin UI track, Phase 1)
**Author:** M01 PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 36 citations behind every choice.
**Depends on (PLANs already FROZEN):** F01, F02, F03, F04, F05, A01.
**Blocks:** M02, M03, M04, M05, M06, M07, M08, S01, S02, S03, S04, R03 (all admin/supervisor surfaces).

This plan turns the M01 spec + RESEARCH §§1–10 + the F05 + A01 contracts
into the exact monorepo restructure, route map, package boundaries, store
contracts, RBAC integration, table/form patterns, and hand-off interfaces
that IMPLEMENT will deliver. **No `.tsx` is produced here**; every file is
described in prose. Once approved, the public interface (workspace
membership, route map, store names, hooks, RBAC matrix consumption,
shared-package exports) is FROZEN. Internal helper layout, tailwind class
phrasing, and shadcn primitive variants may change without RFC.

---

## 0. TL;DR (10-bullet decision summary)

1. **Mono-repo restructure: split into `web/` (agent, A01-owned) +
   `admin/` (admin, M01-owned) + `packages/{ui,api-client,auth}` (shared).**
   Promotes A01's existing `web/` to a **shared-package consumer** without
   touching its internals; introduces a **second Next.js 15 app** at
   `admin/` mirroring `web/`'s stack 1:1; lifts cross-cutting code
   (shadcn primitives, openapi-fetch client + zod schemas, CASL ability +
   tenant context) into private workspace packages so neither app depends
   on the other (RESEARCH §2.4 hard rule). **F01 amendment requested in
   §15.1** — additive (new `admin` workspace member, new compose service
   on port 4001, three `packages/*` workspace members); zero edits to
   `web/`'s public surface.
2. **Stack mirrors A01 PLAN exactly.** Next.js 15.x App Router (RSC),
   React 19, TS 5.6+ strict (same flags as A01 §1.2), Tailwind v4 with
   `@theme` tokens identical to `web/src/app/globals.css`, shadcn/ui
   `style: new-york`, Zustand 5 with the same slice pattern, TanStack
   Query v5, react-hook-form + zod, date-fns 4, `jose` (Edge-runtime JWT),
   `openapi-fetch` + `openapi-typescript`, Sonner via shadcn. **Adds**
   TanStack Table v8 + TanStack Virtual 3 (admin-only data grids),
   **Tremor v3** (charts; Apache-2.0 confirmed at PLAN time), `@casl/ability`
   + `@casl/react` (RBAC), `@wavesurfer/react` v7 (S04 recording playback),
   `tus-js-client` v4 (M02/D02 CSV upload), `react-dropzone`. **Same
   strictness gates** (Lighthouse ≥ 90, axe a11y zero AA violations).
3. **Two Next.js apps, one cookie domain.** `web` at `:4000` (agent),
   `admin` at `:4001` (admin/sup). Shared session via `Domain=.vici2.example`
   on the F05-issued cookies (`__Host-vici2_refresh`, `sx_user`); both
   apps' `middleware.ts` honors the same `sx_user` cookie + redirects
   role-mismatched users to the right app. **Single login surface
   recommendation:** the `web/` `(public)/login` page handles both roles
   and 302s `admin`/`sup` to `https://admin.vici2.example/...`; `admin/`
   ships its own `(public)/login` mirror so it works standalone in dev
   (where everything is `localhost`). Both forms POST to the same
   F05 endpoint.
4. **App routing structure (admin/src/app/):** `(public)/login`,
   `(public)/forgot-password`, `(admin)/{dashboard, campaigns/*, lists/*,
   leads, users/*, user-groups/*, carriers/*, dids/*, dnc, statuses,
   pause-codes, scripts/*, recordings, reports/*}`, `(sup)/{wallboard,
   recordings, eavesdrop, callbacks}`, `api/{health, metrics/web}`,
   `middleware.ts` (Edge). Layout guards: `(admin)/layout.tsx` requires
   role ∈ {admin, super_admin}; `(sup)/layout.tsx` requires role ∈
   {supervisor, admin, super_admin}. Per-section pages stub today; M02–M08
   + S01–S04 fill in the leaf pages without touching the shell.
5. **Heavy data tables: TanStack Table v8 + TanStack Virtual 3, hybrid
   pagination.** Two archetypes per RESEARCH §4.1: **stream tables**
   (leads, call_log, agent_log, recording_log, drop_log, audit_log) use
   **cursor pagination** + `useInfiniteQuery` + `useVirtualizer`
   (estimateSize 33, overscan 5, container `onScroll` triggers
   `fetchNextPage` at 500 px from bottom); **browse tables** (campaigns,
   lists, users, user_groups, carriers, dids, statuses, pause_codes,
   scripts) use **offset pagination** with classic numbered pager and
   total count. Both share a single `<DataTable>` shell from
   `packages/ui/src/data-table` parameterized by `mode: 'cursor' | 'offset'`.
   Bulk operations (`POST /api/admin/<resource>/bulk`) always materialize
   server-side ID sets and report progress via WS, never re-paginate.
6. **Forms with shared zod schemas as the single source of truth.** Zod
   schemas live in `packages/api-client/src/schemas/` (one file per
   resource: `campaigns.ts`, `lists.ts`, `leads.ts`, `users.ts`, …).
   `api/` Fastify imports the same schemas via
   `fastify-zod-openapi` — the OpenAPI spec is *emitted* from those
   schemas, eliminating drift. `admin/` (and `web/`) consume them via
   `zodResolver` in react-hook-form. Three consumers, one file. Wizards
   (campaign create, lead import) keep one root `useForm` + per-step
   `form.trigger([...])` per RESEARCH §5.4.
7. **CSV upload (M02 lists / D02 leads): tus protocol end-to-end.**
   Client: `tus-js-client` v4 with chunkSize 8 MiB, retryDelays
   `[0, 1000, 3000, 5000, 10000]`, `findPreviousUploads()` for cross-
   session resume. Server: `@tus/server` mounted in api/ Fastify under
   `/api/admin/uploads/leads` with `@tus/file-store` in dev,
   `@tus/s3-store` in prod (chunks land in MinIO/S3; D02 worker reads
   on completion). UX wizard: react-dropzone → preview (api `/peek` of
   first 100 rows) → column-map → compliance gate (TZ + consent
   assertion) → tus upload with progress → background D02 worker → WS
   progress events. Tenant-bound via tus metadata; cross-tenant chunks
   rejected at the server.
8. **Charts: Tremor primary, Recharts escape hatch.** Tremor v3.x
   (`AreaChart`, `BarChart`, `LineChart`, `DonutChart`, `BarList`,
   `Tracker`, `Metric`/`Card`) covers M08 reports (call summary,
   productivity, drop% TCPA), S01 wallboard tiles, and admin home
   dashboard. **Recharts directly** for the only Tremor-doesn't-expose
   case: TCPA drop% chart needs a `ReferenceLine y={3}` for the 3% legal
   cap; Tremor uses Recharts under the hood, so dropping down is a
   one-component swap, not a stack change. Tremor's Apache-2.0 license
   is confirmed compatible with O04's planned denylist (Apache-2.0 is on
   the allowlist; risk #5 from RESEARCH §10 closed).
9. **RBAC: CASL `Ability` built from F05's `/api/auth/me` perms,
   three-layer enforcement.** (a) **Edge middleware** decodes
   `sx_user` cookie via `jose.jwtVerify`, redirects unauth → `/login`,
   role-mismatched → other-app or other-section; (b) **server-component
   layouts** call `requireRole('admin' | 'supervisor' | 'super_admin')`
   and `requirePermission(verb, subject)` (re-reads cookie, no DB
   round-trip); (c) **client `<Can>`** from `@casl/react` hides UI
   affordances. **The CASL Ability is built from F05's `perms` array on
   the access token + role hierarchy** — not invented in M01. Static
   role→permission matrix lives at `shared/types/src/rbac.ts` (F05's
   single source of truth); `packages/auth` only exposes the CASL
   wrapper. Backend always re-checks via F05's `requirePermission` Fastify
   middleware (defense in depth).
10. **Tenant scoping plumbed day 1, switcher hidden until Phase 4.**
    `TenantProvider` (server-side from `cookies()` + `me.tenant`) exposes
    `useTenant()` returning `{ id, name, slug, plan }`. The
    `packages/api-client` fetch wrapper auto-injects `X-Tenant-Id` from
    `useTenant()` on every API call. **TanStack Query keys always
    include `tenantId`** (e.g., `['campaigns', tenantId, ...]`); WS
    channel names always include `t:{tid}:...`. In Phase 1, only
    tenant_id=1 exists and the switcher is hidden; in Phase 4, the
    `super_admin` role unlocks a top-bar `<TenantSwitcher>` that POSTs
    `/api/auth/switch-tenant` and triggers `router.refresh()`. **No URL
    refactor needed** — same code path Phase 1 → Phase 4.

---

## 1. Mono-repo restructure (FROZEN)

### 1.1 Why split now (vs. shoehorn admin into `web/`)

A01 PLAN deliberately scoped `web/` to the agent UI. M01 owns 50+ admin
screens across M02–M08 + S01–S04 + R03. Coupling means:
- Every M02–M08 PR rebuilds the agent app (slower CI, more `next build`
  time per merge).
- Agent's tight perf budget (≤ 250 KB gzipped per route) is at risk of
  pollution from admin chunks via Next's tree-shaker gaps on shared
  imports.
- Agent UI is operationally critical and rarely changes once stable;
  admin iterates fast. Coupling release cycles costs more than the
  marginal monorepo overhead. **Decision per RESEARCH §2.1: separate
  apps + shared packages.**

### 1.2 Final layout (additive to F01's tree; no destructive moves)

```
vici2/
├── web/                              ← UNCHANGED (A01-owned, agent UI)
│   └── ... (per A01 PLAN §3.1)
│
├── admin/                            ← NEW (M01-owned, admin UI)
│   ├── package.json                  ← workspace:*; depends on @vici2/{ui,api-client,auth,types}
│   ├── tsconfig.json                 ← extends tsconfig.base.json + same strict flags as web/
│   ├── next.config.mjs               ← output:'standalone', typedRoutes, transpilePackages
│   ├── postcss.config.mjs            ← @tailwindcss/postcss
│   ├── components.json               ← shadcn config (style: new-york, rsc: true)
│   ├── Dockerfile                    ← mirror of web/Dockerfile, EXPOSE 4001
│   ├── playwright.config.ts
│   ├── vitest.config.ts
│   ├── lighthouserc.json
│   ├── public/
│   │   ├── favicon.ico
│   │   └── logo.svg
│   └── src/
│       ├── middleware.ts             ← Edge: verify sx_user, role-gate (admin|sup), tenant header
│       ├── app/
│       │   ├── layout.tsx            ← Server: <html>, fonts, <Providers>
│       │   ├── globals.css           ← Tailwind v4 entry; tokens identical to web/
│       │   ├── providers.tsx         ← 'use client': QueryClient, TenantProvider, AbilityProvider, Toaster, ThemeProvider
│       │   ├── error.tsx
│       │   ├── not-found.tsx
│       │   ├── (public)/
│       │   │   ├── layout.tsx
│       │   │   ├── login/{page.tsx, LoginForm.tsx}
│       │   │   └── forgot-password/{page.tsx, ForgotForm.tsx}
│       │   ├── (admin)/
│       │   │   ├── layout.tsx        ← Server: requireRole('admin'); renders <AdminShell> (CC)
│       │   │   ├── AdminShell.tsx    ← 'use client': <AdminSidebar>+<AdminTopBar>+children
│       │   │   ├── dashboard/page.tsx
│       │   │   ├── campaigns/
│       │   │   │   ├── page.tsx              ← list (offset table)
│       │   │   │   ├── new/page.tsx          ← wizard (M02 fills)
│       │   │   │   ├── [id]/page.tsx         ← detail/edit (M02 fills)
│       │   │   │   └── [id]/edit/page.tsx    ← (M02 fills)
│       │   │   ├── lists/
│       │   │   │   ├── page.tsx              ← list
│       │   │   │   ├── new/page.tsx          ← (M02 fills)
│       │   │   │   ├── [id]/page.tsx         ← detail (M02 fills)
│       │   │   │   └── [id]/import/page.tsx  ← CSV upload wizard (D02 fills)
│       │   │   ├── leads/
│       │   │   │   ├── page.tsx              ← stream table (cursor + virtualizer)
│       │   │   │   └── [id]/page.tsx         ← lead detail (D04 fills)
│       │   │   ├── users/
│       │   │   │   ├── page.tsx              ← list (M05 fills)
│       │   │   │   ├── new/page.tsx          ← (M05 fills)
│       │   │   │   └── [id]/page.tsx         ← (M05 fills)
│       │   │   ├── user-groups/{page.tsx, new/page.tsx, [id]/page.tsx}   ← (M05 fills)
│       │   │   ├── carriers/{page.tsx, new/page.tsx, [id]/page.tsx}      ← (M04 fills)
│       │   │   ├── dids/{page.tsx, new/page.tsx, [id]/page.tsx}          ← (M04 fills)
│       │   │   ├── dnc/page.tsx              ← (M06 fills)
│       │   │   ├── statuses/page.tsx         ← (M07 fills)
│       │   │   ├── pause-codes/page.tsx      ← (M07 fills)
│       │   │   ├── scripts/{page.tsx, new/page.tsx, [id]/page.tsx}       ← (M07 fills)
│       │   │   ├── recordings/page.tsx       ← admin browser (R03 fills)
│       │   │   └── reports/
│       │   │       ├── page.tsx              ← report index
│       │   │       ├── call-summary/page.tsx ← (M08 fills)
│       │   │       ├── productivity/page.tsx ← (M08 fills)
│       │   │       ├── tcpa/page.tsx         ← (M08 fills; Recharts ReferenceLine)
│       │   │       └── exports/page.tsx      ← (M08 fills)
│       │   ├── (sup)/
│       │   │   ├── layout.tsx        ← Server: requireRole('supervisor'); renders <SupShell> (CC)
│       │   │   ├── SupShell.tsx      ← 'use client'
│       │   │   ├── wallboard/page.tsx        ← (S01 fills)
│       │   │   ├── recordings/page.tsx       ← (S04 fills)
│       │   │   ├── eavesdrop/page.tsx        ← (S02 fills)
│       │   │   └── callbacks/page.tsx        ← (S03 fills)
│       │   └── api/
│       │       ├── health/route.ts           ← Docker HEALTHCHECK target
│       │       └── metrics/web/route.ts      ← Web Vitals sink (forwarded to F-API)
│       ├── components/
│       │   ├── shell/
│       │   │   ├── AdminSidebar.tsx          ← nav config + ability filter
│       │   │   ├── AdminTopBar.tsx           ← user menu + tenant switcher (hidden Phase 1)
│       │   │   ├── SupSidebar.tsx
│       │   │   ├── PageHeader.tsx            ← page title + breadcrumb + actions slot
│       │   │   ├── EmptyState.tsx
│       │   │   ├── BulkProgressToast.tsx     ← sonner-backed bulk job progress
│       │   │   └── TenantSwitcher.tsx        ← Phase-4 component, Phase-1 hidden via <Can>
│       │   ├── auth/
│       │   │   ├── LoginForm.tsx
│       │   │   ├── ForgotForm.tsx
│       │   │   └── LogoutButton.tsx
│       │   ├── tables/
│       │   │   ├── CursorTable.tsx           ← <DataTable mode="cursor"> wrapper helper
│       │   │   ├── OffsetTable.tsx           ← <DataTable mode="offset"> wrapper helper
│       │   │   ├── ColumnFilters.tsx
│       │   │   └── BulkActionBar.tsx
│       │   ├── forms/
│       │   │   └── (one .tsx per shared composite form widget; M02–M08 expand)
│       │   ├── upload/
│       │   │   ├── TusUploader.tsx           ← react-dropzone + tus-js-client
│       │   │   ├── ColumnMapper.tsx
│       │   │   └── ComplianceGate.tsx
│       │   ├── recording/
│       │   │   └── WaveformPlayer.tsx        ← @wavesurfer/react v7 wrapper
│       │   └── charts/
│       │       └── TcpaDropChart.tsx         ← Recharts ReferenceLine y=3 (the one escape hatch)
│       ├── lib/
│       │   ├── env.ts                        ← zod-validated NEXT_PUBLIC_* + SX_USER_COOKIE_SECRET
│       │   ├── nav-config.ts                 ← typed array {key, label, href, icon, requires:{action,subject}}
│       │   ├── server-auth.ts                ← server-only helpers: requireRole, requirePermission (RSC)
│       │   ├── stores/
│       │   │   ├── ui.ts                     ← persisted: sidebarCollapsed, theme, density
│       │   │   ├── upload.ts                 ← active tus uploads, progress
│       │   │   └── bulk-jobs.ts              ← in-flight bulk job IDs + status
│       │   ├── queries/                      ← TanStack Query hook factories per resource (M02–M08 fill leaves)
│       │   ├── hooks/
│       │   │   ├── useReportVitals.ts
│       │   │   └── useDebouncedValue.ts
│       │   └── utils.ts                      ← cn() + small helpers
│       ├── styles/                           ← (empty placeholder; tokens live in globals.css @theme)
│       └── test/
│           ├── unit/
│           │   ├── nav-filter.test.ts
│           │   ├── server-auth.test.ts
│           │   ├── stores.ui.test.ts
│           │   └── stores.bulk-jobs.test.ts
│           ├── e2e/
│           │   ├── admin-shell.spec.ts        ← acceptance crit: layout + nav
│           │   ├── role-protection.spec.ts    ← acceptance crit: agent → /admin redirect
│           │   ├── responsive.spec.ts         ← 375/768/1280
│           │   ├── a11y.spec.ts               ← @axe-core/playwright AA
│           │   └── tenant-header.spec.ts      ← X-Tenant-Id present on every API call
│           └── msw/handlers.ts
│
├── packages/                         ← NEW (private, never published)
│   ├── ui/
│   │   ├── package.json              ← name: @vici2/ui; private:true; main: src/index.ts
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts              ← barrel
│   │       ├── primitives/           ← shadcn-generated (button, card, dialog, input, label,
│   │       │                            select, sheet, sonner, tooltip, dropdown-menu, badge,
│   │       │                            scroll-area, form, skeleton, tabs, command, separator,
│   │       │                            popover, calendar, date-picker, table, toggle,
│   │       │                            radio-group, checkbox, switch, alert, alert-dialog,
│   │       │                            avatar, breadcrumb, navigation-menu, accordion)
│   │       ├── data-table/
│   │       │   ├── DataTable.tsx     ← TanStack Table shell (cursor/offset)
│   │       │   ├── DataTableToolbar.tsx
│   │       │   ├── DataTablePagination.tsx
│   │       │   └── DataTableColumnHeader.tsx
│   │       ├── form/
│   │       │   └── (shadcn Form + RHF wrappers re-exported)
│   │       ├── empty-state.tsx
│   │       ├── page-header.tsx
│   │       └── tokens/                ← tailwind-config preset (consumed by both apps)
│   │           ├── colors.css
│   │           └── theme.css
│   ├── api-client/
│   │   ├── package.json              ← name: @vici2/api-client; deps: openapi-fetch, zod
│   │   ├── tsconfig.json
│   │   ├── codegen.ts                ← script: openapi-typescript → src/types/openapi.d.ts
│   │   └── src/
│   │       ├── index.ts              ← barrel
│   │       ├── client.ts             ← createClient<paths>; injects Authorization + X-Tenant-Id
│   │       ├── 401-retry.ts          ← single-flight refresh + retry once
│   │       ├── types/openapi.d.ts    ← generated; gitignored; built in CI
│   │       ├── schemas/
│   │       │   ├── auth.ts           ← LoginRequest, LoginResponse, MeResponse
│   │       │   ├── campaigns.ts
│   │       │   ├── lists.ts
│   │       │   ├── leads.ts          ← LeadImportRowSchema lives here
│   │       │   ├── users.ts
│   │       │   ├── user-groups.ts
│   │       │   ├── carriers.ts
│   │       │   ├── dids.ts
│   │       │   ├── dnc.ts
│   │       │   ├── statuses.ts
│   │       │   ├── pause-codes.ts
│   │       │   ├── scripts.ts
│   │       │   ├── recordings.ts
│   │       │   ├── reports.ts
│   │       │   ├── pagination.ts     ← CursorPageSchema, OffsetPageSchema
│   │       │   └── ws-envelope.ts
│   │       └── react-query/
│   │           ├── keys.ts           ← typed query-key factory (always tenant-scoped)
│   │           └── hooks/            ← (M02–M08 add per-resource hooks)
│   └── auth/
│       ├── package.json              ← name: @vici2/auth; deps: @casl/ability, @casl/react, jose
│       ├── tsconfig.json
│       └── src/
│           ├── index.ts              ← barrel
│           ├── ability.ts            ← abilityFromUser(MeResponse) → AppAbility
│           ├── AbilityProvider.tsx   ← 'use client' context wrapper around CASL
│           ├── use-ability.ts        ← useAbility() hook
│           ├── use-can.ts            ← useCan(action, subject) → boolean
│           ├── Can.tsx               ← <Can do="..." on="..." /> wrapper
│           ├── use-require-role.ts   ← client-side guard hook
│           ├── tenant/
│           │   ├── TenantProvider.tsx ← server- and client-component variants
│           │   ├── use-tenant.ts
│           │   └── types.ts
│           ├── auth-store.ts         ← Zustand: accessToken, wsToken, user (in memory only)
│           ├── refresh.ts            ← single-flight refresh; mirrors A01 lib/auth.ts pattern
│           ├── tab-sync.ts           ← BroadcastChannel('vici2.auth')
│           └── server/
│               ├── verify-cookie.ts  ← jose.jwtVerify(sx_user); used by server components + middleware
│               ├── require-role.ts   ← RSC helper: throws/redirects
│               └── require-permission.ts
│
├── pnpm-workspace.yaml               ← AMENDMENT: add 'admin', 'packages/*' (see §15.1)
├── docker-compose.dev.yml            ← AMENDMENT: add 'admin' service on :4001 (see §15.1)
└── (everything else unchanged)
```

### 1.3 Workspace dependency graph

```
admin → @vici2/ui, @vici2/api-client, @vici2/auth, @vici2/types
web   → @vici2/ui, @vici2/api-client, @vici2/auth, @vici2/types  ← A01 amendment (non-breaking; stack already matches)
api   → @vici2/api-client (schemas only), @vici2/types          ← F05 amendment (uses shared zod for fastify-zod-openapi)

@vici2/ui          → react, react-dom, @radix-ui/*, lucide-react, @tanstack/react-table, @tanstack/react-virtual, tailwind-merge, clsx
@vici2/api-client  → openapi-fetch, zod
@vici2/auth        → @casl/ability, @casl/react, zustand, jose, @vici2/types
@vici2/types       → zod (for rbac.ts schema)

NO app → app dependency (RESEARCH §2.4 hard rule, enforced by ESLint
boundaries plugin).
```

### 1.4 Tooling

- **pnpm workspaces** — already adopted by F01 (RFC-001). New members
  added via §15.1 amendment.
- **Turborepo** — *deferred.* F01 PLAN §0 didn't pin Turbo; M01 ships
  without it and lets `pnpm -r run build` orchestrate. If CI build time
  becomes a problem (>5 min on the admin app), file an O04 ticket to
  add Turbo with remote cache. No code change required to adopt later.
- **TypeScript project references** — `tsconfig.base.json` (F01)
  already exists; each new package extends it; `paths` aliasing
  `@vici2/ui`, `@vici2/api-client`, `@vici2/auth` to source files (not
  `dist/`). Both Next apps set
  `transpilePackages: ['@vici2/ui', '@vici2/api-client', '@vici2/auth']`
  so packages stay source-only — no `tsup`/`tsc -b` build step needed.
- **ESLint boundaries** — `eslint-plugin-boundaries` rule prevents
  `apps/* → apps/*` and `packages/* → apps/*` imports. CI fails the
  build on violation.

### 1.5 Risks called out (and addressed)

| Risk | Mitigation |
|---|---|
| Cookie sharing between `web.vici2.example` and `admin.vici2.example` | F05 sets cookies with `Domain=.vici2.example`; both apps read same `sx_user`. PLAN §15.4 amendment to F05 captures this — F05 PLAN §7.1 was silent on Domain attr; M01 needs it. |
| Two `next dev` processes on dev box | F01 amendment §15.1 maps web→4000, admin→4001; `make dev` brings both up. |
| Package reload time during admin dev | `transpilePackages` makes Next compile shared code on demand — adds ~200 ms cold but avoids stale `dist/` pain. Acceptable. |
| `web/` accidentally importing from `admin/` | ESLint boundaries plugin (§1.4); CI gate. |
| A01 tests breaking when `web/` adopts `@vici2/api-client` | Non-breaking: `web/`'s existing `lib/api.ts` becomes a thin re-export of `packages/api-client/src/client.ts`. Same surface, same behavior. Migration is one PR per amendment phase, not in scope of M01 IMPLEMENT. |

---

## 2. F01 amendment request (additive; non-controversial)

### 2.1 `pnpm-workspace.yaml`

Add `admin` and `packages/*` to the existing list:

```yaml
packages:
  - 'api'
  - 'web'
  - 'admin'        # ← new
  - 'workers'
  - 'shared/types'
  - 'packages/*'   # ← new (covers ui, api-client, auth)
```

### 2.2 `docker-compose.dev.yml`

Add a new `admin` service mirroring the existing `web` service shape:

```yaml
admin:
  build:
    context: ./admin
    target: dev
  image: vici2/admin:dev
  ports:
    - "4001:4001"
  environment:
    NODE_ENV: development
    PORT: 4001
    NEXT_PUBLIC_API_URL: http://localhost:3000
    NEXT_PUBLIC_WS_URL: ws://localhost:3000
    NEXT_PUBLIC_WEB_ORIGIN: http://localhost:4000
    SX_USER_COOKIE_SECRET: ${SX_USER_COOKIE_SECRET}
    WATCHPACK_POLLING: "true"
  develop:
    watch:
      - path: ./admin/src
        target: /app/src
        action: sync
      - path: ./admin/package.json
        action: rebuild
  depends_on:
    api:
      condition: service_healthy
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://localhost:4001/api/health"]
    interval: 10s
    timeout: 3s
    retries: 5
```

Plus a parallel mention in `docker-compose.macos.yml` overlay if Mac
needs port-mapping tweaks (likely no change needed since admin is
HTTP-only, no SIP/RTP).

### 2.3 `.env.example`

Add (no new secrets, just declarations):

```bash
# === M01 Admin UI ===
NEXT_PUBLIC_WEB_ORIGIN=http://localhost:4000     # for cross-app redirects in dev
ADMIN_PORT=4001                                  # bind port for admin container
# SX_USER_COOKIE_SECRET reused from F05 (admin verifies same cookie web does)
```

### 2.4 `.github/workflows/ci.yml`

Add a build step (or rely on `pnpm -r run build` already iterating).
Adding the `admin` workspace to the existing job is a one-line change
in the test matrix; F01 already runs `make test` which `pnpm -r`'s.

### 2.5 Package skeletons

Create stub `package.json` files for `packages/ui`, `packages/api-client`,
`packages/auth`, `admin/` so `pnpm install` succeeds after the workspace
amendment. Stubs ship with a single `index.ts` `export {}` so types
resolve.

**Estimated F01 amendment LOC:** < 60 lines across 4 files. Submit as
single amendment PR; M01 IMPLEMENT branches off post-merge.

### 2.6 F05 amendment (also requested)

F05 PLAN §7.1 says the `sx_user` cookie is `httpOnly Secure
SameSite=Strict`. M01 needs a fourth attribute: **`Domain=.vici2.example`**
(in prod) or **no Domain** (in dev where everything is localhost). F05
should add an env-driven `SX_USER_COOKIE_DOMAIN` (empty in dev, set in
prod) and emit it on every Set-Cookie. **Mechanical change; coordinate
at orchestrator level. No RFC.**

---

## 3. Stack confirmation (mirror A01 PLAN §1)

### 3.1 Versions (pinned in `admin/package.json`)

| Layer | Pin | Source |
|---|---|---|
| Next.js | `^15.4.0` | A01 PLAN §1.1 |
| React / React-DOM | `^19.0.0` | A01 |
| TypeScript | `^5.6.3` | A01 |
| Tailwind | `^4.0.0` | A01 |
| `@tailwindcss/postcss` | `^4.0.0` | A01 |
| shadcn/ui | CLI `latest`; tracked via `components.json` | A01 |
| Radix primitives | per-component `@radix-ui/react-*` | A01 |
| Zustand | `^5.0.0` | A01 |
| TanStack Query | `^5.59.0` | A01 |
| **TanStack Table** | `^8.20.0` | M01 (admin grids; A01 only declared dep) |
| **TanStack Virtual** | `^3.10.0` | M01 |
| react-hook-form | `^7.53.0` | A01 |
| zod | `^3.23.0` | A01 |
| `@hookform/resolvers` | `^3.9.0` | A01 |
| date-fns | `^4.1.0` | A01 |
| date-fns-tz | `^3.2.0` | A01 |
| `jose` | `^5.9.0` | A01 |
| `openapi-fetch` | `^0.13.0` | A01 |
| `openapi-typescript` | `^7.4.0` | A01 |
| Sonner (via shadcn `sonner`) | `^1.7.0` | A01 |
| `@next/bundle-analyzer` | `^15.4.0` | A01 |
| `web-vitals` | `^4.2.0` | A01 |
| **`@casl/ability`** | `^6.7.0` | M01 (RBAC) |
| **`@casl/react`** | `^4.0.0` | M01 |
| **Tremor** (`@tremor/react`) | `^3.18.0` | M01 (charts; Apache-2.0 confirmed) |
| **Recharts** | `^2.13.0` | M01 (escape hatch + Tremor's transitive dep) |
| **`@wavesurfer/react`** | `^1.0.0` (v7-line) | M01 (S04 player) |
| **wavesurfer.js** | `^7.8.0` | M01 (peer of @wavesurfer/react) |
| **`tus-js-client`** | `^4.1.0` | M01 (CSV upload) |
| **`react-dropzone`** | `^14.2.0` | M01 |
| **`@tanstack/react-query-devtools`** | `^5.59.0` | M01 (dev only) |
| Vitest | `^2.1.0` | A01 |
| `@testing-library/react` | `^16.0.0` | A01 |
| Playwright | `^1.48.0` | A01 |
| `@axe-core/playwright` | `^4.10.0` | A01 |
| MSW | `^2.4.0` | A01 |
| `@lhci/cli` | `^0.14.0` | A01 |

**Pin policy:** identical to A01 — caret on minor; Renovate handles
patches. Tremor risk reviewed in §17.

### 3.2 TypeScript strictness

`admin/tsconfig.json` extends `tsconfig.base.json` (F01) and sets the
exact same flags as A01 PLAN §1.2:

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noImplicitOverride`, `noFallthroughCasesInSwitch`,
  `forceConsistentCasingInFileNames`, `verbatimModuleSyntax`,
  `moduleResolution: "Bundler"`, `module: "ESNext"`,
  `jsx: "preserve"`, `plugins: [{ "name": "next" }]`,
  paths `@/*: ["./src/*"]`.

### 3.3 Why each rejected option stays rejected (per A01 + new ones)

- **Mantine, Radix Themes, MUI, Headless UI** — same rejection as A01.
- **Nivo, visx, Chart.js** — per RESEARCH §7.3.
- **`react-table` v7, AG Grid Community, MUI DataGrid** — TanStack Table
  v8 already adopted by A01; AG Grid license risk; MUI brings Emotion
  runtime.
- **NextAuth, Auth.js, Clerk, Auth0** — F05 owns auth; no third-party
  IdP in Phase 1. M01 reuses F05's tokens.
- **`react-admin`, `refine`, `Admin.js`** — opinionated, hide too much;
  RESEARCH §1 + M01 spec §"Research phase" explicitly states "we're
  rolling our own to keep stack tight."
- **`next-intl`** — Phase 1 English-only per RESEARCH §3.1; deferred
  with clean upgrade path documented.
- **Storybook/Ladle** — same deferral as A01 §15.5; revisit when
  primitives count > 25.

---

## 4. App routing structure (FROZEN)

### 4.1 Route map (admin/src/app/)

| Path (under `admin.vici2.example`) | Group | Layout role guard | Owner | Notes |
|---|---|---|---|---|
| `/login` | (public) | none | M01 | Mirror of `web/`'s login; same F05 endpoint |
| `/forgot-password` | (public) | none | M01 | |
| `/dashboard` | (admin) | admin+ | M01 | KPIs (Tremor `Metric` + `BarList`) |
| `/campaigns` | (admin) | admin+ | M02 | offset table; M01 ships shell |
| `/campaigns/new` | (admin) | admin+ | M02 | wizard |
| `/campaigns/[id]` | (admin) | admin+ | M02 | detail view |
| `/campaigns/[id]/edit` | (admin) | admin+ | M02 | edit form |
| `/lists` | (admin) | admin+ | M02 | offset table |
| `/lists/new` | (admin) | admin+ | M02 | |
| `/lists/[id]` | (admin) | admin+ | M02 | detail + member count |
| `/lists/[id]/import` | (admin) | admin+ | D02 | tus-based CSV wizard |
| `/leads` | (admin) | admin+ | M03+D04 | **stream table** (cursor + virtualizer) |
| `/leads/[id]` | (admin) | admin+ | D04 | lead detail |
| `/users` | (admin) | admin+ | M05 | offset table |
| `/users/new` | (admin) | admin+ | M05 | |
| `/users/[id]` | (admin) | admin+ | M05 | edit + sip rotate button |
| `/user-groups` | (admin) | admin+ | M05 | |
| `/user-groups/new` | (admin) | admin+ | M05 | |
| `/user-groups/[id]` | (admin) | admin+ | M05 | |
| `/carriers` | (admin) | admin+ | M04 | |
| `/carriers/new` | (admin) | admin+ | M04 | |
| `/carriers/[id]` | (admin) | admin+ | M04 | |
| `/dids` | (admin) | admin+ | M04 | |
| `/dids/new` | (admin) | admin+ | M04 | |
| `/dids/[id]` | (admin) | admin+ | M04 | |
| `/dnc` | (admin) | admin+ | M06 | search-first; no infinite scroll |
| `/statuses` | (admin) | admin+ | M07 | offset table |
| `/pause-codes` | (admin) | admin+ | M07 | offset table |
| `/scripts` | (admin) | admin+ | M07 | offset table |
| `/scripts/new` | (admin) | admin+ | M07 | |
| `/scripts/[id]` | (admin) | admin+ | M07 | |
| `/recordings` | (admin) | admin+ | R03 | stream table + player |
| `/reports` | (admin) | admin+ | M08 | report index |
| `/reports/call-summary` | (admin) | admin+ | M08 | Tremor charts |
| `/reports/productivity` | (admin) | admin+ | M08 | Tremor charts |
| `/reports/tcpa` | (admin) | admin+ | M08 | Recharts ReferenceLine y=3 |
| `/reports/exports` | (admin) | admin+ | M08 | export job list |
| `/sup/wallboard` | (sup) | sup+ | S01 | WS-driven grid |
| `/sup/recordings` | (sup) | sup+ | S04 | wavesurfer player |
| `/sup/eavesdrop` | (sup) | sup+ | S02 | live agent monitor |
| `/sup/callbacks` | (sup) | sup+ | S03 | callback queue |
| `/api/health` | (root) | none | M01 | Docker HEALTHCHECK |
| `/api/metrics/web` | (root) | none | M01 | Web Vitals POST sink |

**`admin+` = role ∈ {admin, super_admin}**;
**`sup+` = role ∈ {supervisor, admin, super_admin}**.
F05 `requireRole` is hierarchical (super_admin > admin > supervisor >
agent); guards use the lowest-allowed role.

### 4.2 Route group conventions

- `(public)` — no auth required; logged-in users redirected to their
  default landing per role.
- `(admin)` — `(admin)/layout.tsx` server-component reads `sx_user`
  cookie via `lib/server-auth.ts`; calls `requireRole('admin')` (which
  admits `super_admin` via hierarchy); on fail → redirects to
  `/login?next=...` if unauth, or to `/sup/wallboard` if supervisor, or
  to `${NEXT_PUBLIC_WEB_ORIGIN}/dashboard` if agent.
- `(sup)` — `(sup)/layout.tsx` requires `requireRole('supervisor')`
  (admits admin + super_admin). Cross-section navigation between admin
  and sup is allowed for elevated roles; a top-bar nav switch lets
  admins jump between admin and sup contexts.

### 4.3 RSC vs CC split (mirror A01 §4)

| Route / file | Render | Notes |
|---|---|---|
| `app/layout.tsx` | Server | `<html>`, fonts, `<Providers>` mount |
| `app/providers.tsx` | Client | QueryClient, AbilityProvider, TenantProvider, Toaster, ThemeProvider |
| `(public)/layout.tsx` | Server | static centered shell |
| `(public)/login/page.tsx` | Server shell | `<LoginForm/>` (CC) |
| `(public)/login/LoginForm.tsx` | Client | RHF + zod + F05 `/api/auth/login` |
| `(admin)/layout.tsx` | Server | `requireRole('admin')`; renders `<AdminShell/>` (CC) |
| `(admin)/AdminShell.tsx` | Client | Sidebar + topbar + content slot |
| `(admin)/dashboard/page.tsx` | Server with CC widgets | Tremor cards SSR-prefetched, live tile updates CC |
| `(admin)/<resource>/page.tsx` | Server shell + CC table | List view: server fetches first page, table CC for live updates |
| `(admin)/<resource>/[id]/page.tsx` | Server | Detail view: SSR full record, CC edit affordances |
| `(admin)/<resource>/new/page.tsx` | Client | Forms are RHF-backed; entirely CC |
| `(sup)/layout.tsx` | Server | `requireRole('supervisor')` |
| `(sup)/wallboard/page.tsx` | Client | WS-driven, full CC |
| `(sup)/recordings/page.tsx` | Client | wavesurfer needs `window` |
| `middleware.ts` | Edge | role gating + tenant header injection |

### 4.4 `middleware.ts` (Edge)

- Match: every path except `/_next/*`, `/favicon.ico`, `/api/health`,
  `/api/metrics/web`, `/api/auth/*` (Edge → web/admin both have same
  cookie path), `/login`, `/forgot-password`.
- Reads `sx_user` cookie via `jose.jwtVerify(SX_USER_COOKIE_SECRET)`.
- Absent / invalid → redirect `/login?next=<pathname>`.
- Role mismatch:
  - `agent` → redirect to `${NEXT_PUBLIC_WEB_ORIGIN}/dashboard` (cross-app
    302).
  - `supervisor` accessing `/(admin)/*` → redirect to `/sup/wallboard`.
  - `admin` / `super_admin` accessing `/(sup)/*` → allowed (elevated
    roles can view supervisor surfaces).
- Sets `x-vici2-user` request header (verified principal) for downstream
  RSC to read via `headers().get(...)` without re-verifying.
- Sets `x-vici2-tenant-id` from cookie's `tenantId` claim; api-client
  reads it on the server side as a fallback when no `useTenant()` is
  available.

---

## 5. Heavy data tables (TanStack Table v8 + Virtual)

### 5.1 Two archetypes (per RESEARCH §4.1)

| Archetype | Resources | Pagination | Virtualization | Query hook |
|---|---|---|---|---|
| **Stream** | leads, call_log, agent_log, recording_log, drop_log, audit_log | **cursor** (keyset) | **mandatory** (`useVirtualizer`) | `useInfiniteQuery` |
| **Browse** | campaigns, lists, users, user_groups, carriers, dids, statuses, pause_codes, scripts | **offset** (numbered pager + count) | optional (only > 200 rows) | `useQuery` |

DNC is special: search-first, never list — uses a `<Search>` component
backed by `useQuery` keyed on the search term.

### 5.2 Cursor-pagination wire format (FROZEN; matches RESEARCH §4.2)

```
GET /api/admin/leads?
    list_id=42&
    status=NEW&
    cursor=<base64url(JSON{sort_key, id})>&
    limit=200

→ {
    "data": [ ...200 leads ],
    "next_cursor": "<base64url>",
    "has_more": true
  }
```

- Cursor encodes `(sort_key, id)` tuple base64url'd.
- **No `total_count`** on the streaming path. UI shows "X rows loaded
  (more available)" until `has_more === false`.
- Schema: `packages/api-client/src/schemas/pagination.ts` exports
  `CursorPageSchema<T>` and `CursorRequestSchema`.

### 5.3 Offset-pagination wire format (FROZEN)

```
GET /api/admin/campaigns?page=1&pageSize=50&sort=name:asc&filter[status]=active

→ {
    "data": [ ...50 campaigns ],
    "page": 1,
    "pageSize": 50,
    "totalCount": 87,
    "totalPages": 2
  }
```

- `OffsetPageSchema<T>` / `OffsetRequestSchema` in same schemas file.
- `pageSize` capped at 200 server-side.
- For tables that need only "is there a next page" semantics (without
  `COUNT(*)` cost), backend can return `totalCount: null` and UI
  shows "Page X" without "of N".

### 5.4 `<DataTable>` shell (`packages/ui/src/data-table/DataTable.tsx`)

Single component, two modes via discriminated `mode` prop:

```ts
// public type only; no implementation here
export type DataTableProps<TData> =
  | {
      mode: 'cursor';
      query: ReturnType<typeof useInfiniteQuery>;       // typed via api-client
      columns: ColumnDef<TData>[];
      rowEstimateSize?: number;                          // default 33
      overscan?: number;                                 // default 5
      onRowClick?: (row: TData) => void;
      bulkActions?: BulkActionConfig<TData>[];
      emptyState?: ReactNode;
    }
  | {
      mode: 'offset';
      query: ReturnType<typeof useQuery>;
      pageState: { page: number; pageSize: number };
      onPageChange: (next: { page: number; pageSize: number }) => void;
      sortState: SortingState;
      onSortChange: (next: SortingState) => void;
      filterState: ColumnFiltersState;
      onFilterChange: (next: ColumnFiltersState) => void;
      columns: ColumnDef<TData>[];
      onRowClick?: (row: TData) => void;
      bulkActions?: BulkActionConfig<TData>[];
      emptyState?: ReactNode;
    };
```

- `manualPagination`, `manualSorting`, `manualFiltering` always on.
- Cursor mode wires `getNextPageParam: lp => lp.next_cursor`,
  `placeholderData: keepPreviousData`.
- Cursor mode renders virtualizer over `pages.flatMap(p => p.data)`;
  `onScroll` fires `fetchNextPage()` when
  `scrollHeight - scrollTop - clientHeight < 500 && !isFetching && hasNextPage`.
- Column resize, sort indicators, per-column filter dropdowns, density
  toggle (compact / comfortable; reads `useUiStore.density`).
- Bulk action bar appears when `Object.keys(rowSelection).length > 0`;
  rows selected via shadcn `<Checkbox>` cell. Bulk submission goes to
  the backend `/bulk` endpoint with either an explicit ID array or a
  filter snapshot (see §5.6).

### 5.5 Virtualization (RESEARCH §4.4)

```ts
const rowVirtualizer = useVirtualizer({
  count: rows.length,
  estimateSize: () => 33,
  getScrollElement: () => containerRef.current,
  overscan: 5,
});
```

- Container has `overflow: auto`.
- Table renders via `display: grid` so dynamic row heights work.
- Skip `measureElement` on Firefox (border-height bug).
- `data-list-end` sentinel + IntersectionObserver fallback for
  `scrollHeight` browsers.

### 5.6 Bulk operations (RESEARCH §4.5)

```
POST /api/admin/<resource>/bulk
{
  "selection": { "kind": "ids", "ids": [1,2,...] }      // explicit selection
  | { "kind": "filter", "filter": {...}, "estimatedRows": 87432 }   // "select all matching"
  "action": "set_status",
  "payload": { "status": "NEW" }
}

→ 202 Accepted
{
  "job_id": "lj_abc",
  "estimated_rows": 87432,
  "status_url": "/api/admin/jobs/lj_abc"
}

WS push: vici2.bulk_job.progress { job_id, processed, total, error_count, state }
```

- Backend (E04 / D02 / D04 territory) materializes ID set into a Redis
  Streams snapshot, then a worker chunks through.
- UI wires `useMutation` → on `202` insert into
  `useBulkJobsStore.add({jobId, ...})` → `<BulkProgressToast>` (sonner)
  shows progress bar; click opens a dedicated `/jobs/[id]` page (M01
  ships placeholder; M02–M08 wire actual jobs).
- **Never re-paginate during bulk** — the snapshot freezes the row set
  even if writes land mid-job.

### 5.7 Per-screen mapping

| Screen | Mode | Default pageSize | Columns (initial; M02–M08 expand) |
|---|---|---|---|
| `/campaigns` | offset | 50 | name, status, lists count, drop% (last 30d), updated_at, actions |
| `/lists` | offset | 50 | name, campaign, lead count, updated_at, actions |
| `/leads` | cursor | 200 | phone_e164, first_name, last_name, status, list, called_count, last_call, actions |
| `/users` | offset | 50 | username, email, role, group, active, last_login, actions |
| `/user-groups` | offset | 50 | name, member count, actions |
| `/carriers` | offset | 50 | name, registration state, gw count, last error, actions |
| `/dids` | offset | 50 | did_e164, label, carrier, campaign, actions |
| `/dnc` | search | n/a | search box → results list |
| `/statuses` | offset | 50 | code, label, category, sale_flag, actions |
| `/pause-codes` | offset | 50 | code, label, paid, max_seconds, actions |
| `/scripts` | offset | 50 | name, version, updated_at, actions |
| `/recordings` | cursor | 100 | recorded_at, agent, lead, duration, has_transcript, play, actions |
| `/reports/exports` | cursor | 50 | created_at, type, status, size, download |

---

## 6. Forms with shared zod schemas

### 6.1 Single source of truth (RESEARCH §5.1)

- Zod schemas live in `packages/api-client/src/schemas/<resource>.ts`.
- `api/` Fastify imports the same schemas and registers routes via
  `fastify-zod-openapi`. The OpenAPI doc is **emitted from these
  schemas**, eliminating manual openapi.yaml drift.
- `admin/` (and `web/`) import via `zodResolver` in react-hook-form.
- **Three consumers, one file** — backend validation, OpenAPI emission,
  frontend validation.

### 6.2 Schema authoring conventions

- One file per resource (`campaigns.ts`, `lists.ts`, …).
- Each file exports request and response schemas with explicit suffixes:
  `CampaignCreateRequestSchema`, `CampaignCreateResponseSchema`,
  `CampaignUpdateRequestSchema`, `CampaignSchema` (the resource shape),
  `CampaignListItemSchema` (slim shape for tables).
- Discriminated unions for action types
  (`LeadBulkActionSchema = z.discriminatedUnion('action', [...])`).
- Branded types for sensitive fields (`Phone = z.string().brand<'Phone'>()`)
  with regex validation (`/^\+[1-9]\d{6,14}$/`).
- Compliance fields enforced in zod: `dropRatePct ≤ 3` (TCPA),
  `callTimes` 09:00–21:00 with state overrides.
- Shared utility: `tenantId: z.coerce.bigint().positive()` reused via
  `BaseEntitySchema` mixin (`{tenantId, id, createdAt, updatedAt}`).

### 6.3 RHF pattern (FROZEN)

```ts
const form = useForm<z.infer<typeof CampaignCreateRequestSchema>>({
  resolver: zodResolver(CampaignCreateRequestSchema),
  defaultValues: {/* ... */},
});

const create = useCreateCampaignMutation();   // from @vici2/api-client/react-query/hooks

const onSubmit = form.handleSubmit(async (values) => {
  await create.mutateAsync(values);
  toast.success('Campaign created');
  router.push(`/campaigns/${result.id}`);
});
```

- shadcn `<Form>` + `<FormField>` + `<FormControl>` + `<FormMessage>`
  re-exported from `packages/ui` so admin and web consume the same
  styled form components.
- **Anti-patterns (per RESEARCH §5.3) banned:**
  - No parallel zod schema in admin.
  - No HTML5 validation for compliance fields.
  - No mass field rendering without `<Controller>`.

### 6.4 Wizard pattern (M02 campaign create, D02 lead import)

- One root `useForm` with the union schema covering all steps.
- Per-step gating via `await form.trigger([...stepFields])`.
- `nextStep()` only on validate success; `prevStep()` never resets.
- Step state stored in `useWizardStep` slice of local component state
  (not Zustand — wizard scope is single page).
- "Save draft" persists to Valkey via api endpoint (`POST /api/admin/<resource>/drafts`),
  not localStorage (compliance: drafts must be tenant-scoped + audited).

### 6.5 Files M01 ships in `components/forms/`

M01 itself ships **no** resource forms (they belong to M02–M08). M01
ships only the **shared form patterns**:

- `components/forms/PhoneInputField.tsx` — wraps `libphonenumber-js`
  lazily-loaded; reusable in M02 (carrier reg phone), M03 (lead create),
  M05 (user create), M06 (DNC add).
- `components/forms/TimezoneSelect.tsx` — IANA tz list, used by
  campaign create + carrier create.
- `components/forms/StateMultiSelect.tsx` — US states checkbox list for
  call_times overrides.
- `components/forms/ConfirmDialog.tsx` — destructive action confirmation
  with typed-name verification.

---

## 7. CSV upload (M02 lists, D02 leads)

### 7.1 Why tus (RESEARCH §6.1)

Lead imports are 50k–500k rows / 10–200 MB; resumable + chunked +
cross-session = no lost progress on Wi-Fi blip / laptop sleep / browser
crash.

### 7.2 Client side (M01 ships in `components/upload/`)

- **`<TusUploader>`** — wraps `react-dropzone` (accepts `.csv`, max 1
  file, max 500 MB) and `tus-js-client` v4.x with:
  - `chunkSize: 8 * 1024 * 1024` (8 MiB)
  - `retryDelays: [0, 1000, 3000, 5000, 10000]`
  - `metadata: { filename, filetype, tenant_id, list_id, column_map_id, intent }`
  - `endpoint: '/api/admin/uploads/leads'`
  - `headers: { Authorization: 'Bearer <token>' }` (injected by api-client)
  - Progress bound to `useUploadStore.upsert({uploadId, progress})`.
  - `findPreviousUploads()` on mount → "Resume" button if pending.
  - Pause / resume / cancel buttons.
- **`<ColumnMapper>`** — table of CSV columns × `leads.*` fields with
  dropdowns; submits map to `POST /api/admin/uploads/leads/columnmap`
  (returns `column_map_id`).
- **`<ComplianceGate>`** — three required checkboxes:
  1. "I confirm prior express written consent for these numbers."
  2. "I have scrubbed against my own internal DNC."
  3. "I confirm the time-zone column is accurate (or default to
     campaign tz)."
  Form submission to upload step is gated on all three.

### 7.3 Server side (api ships under `/api/admin/uploads/leads`)

`@tus/server` mounted in api/ Fastify per RESEARCH §6.1:

- Storage: `@tus/file-store` in dev (writes to `./uploads/`),
  `@tus/s3-store` in prod (chunks land in MinIO/S3; D02 worker reads
  on `onUploadFinish`).
- `onUploadCreate` validates JWT tenant matches `metadata.tenant_id`;
  rejects mismatch with `403`.
- `onUploadFinish` enqueues `leads-import` BullMQ job → D02 worker:
  streams CSV through `csv-parse`, validates rows against
  `LeadImportRowSchema` (zod, in `packages/api-client/src/schemas/leads.ts`),
  inserts in batches of 1000 with dedupe on `(list_id, phone_e164)`,
  writes errors to `lead_import_errors` table, emits WS events on
  `vici2.bulk_job.progress` channel.
- M01 ships the **client** (admin/) + the upload Fastify mount-point
  contract (api/). D02 owns the actual worker.

### 7.4 UX flow (FROZEN; mirrors RESEARCH §6.2)

1. **Drop zone** — react-dropzone; shows file name + size; "Continue".
2. **Preview + column map** — `POST /api/admin/uploads/leads/peek` reads
   first 100 rows (no full upload yet); UI renders inferred columns +
   column-map UI. "Save mapping & Continue".
3. **Compliance gate** — three checkboxes (§7.2); "Continue".
4. **Upload** — tus starts; progress bar bound to
   `onProgress(bytesUploaded, bytesTotal)`. Pause/resume buttons.
5. **Processing** — when tus finishes, UI flips to "Processing 87,432
   rows" with WS-pushed progress on
   `vici2.bulk_job.progress?job_id=...`. Fallback: poll
   `/api/admin/uploads/leads/:upload_id/status` every 2s.
6. **Result** — counts: imported, skipped (duplicate phone),
   DNC-rejected, validation-error. Errors downloadable as CSV with row
   number + reason.

### 7.5 Resumability across sessions (RESEARCH §6.3)

- `tus-js-client` stores upload URL in `localStorage`.
- On revisit, `findPreviousUploads()` recovers in-flight uploads;
  user clicks "Resume".
- Survives accidental tab close + laptop reboot.

### 7.6 Risks (RESEARCH §6.4)

- Tenant boundary enforced server-side at `onUploadCreate`.
- 500 MB upload cap per role.
- Worker dedupes on `(list_id, phone_e164)` — partial re-import doesn't
  duplicate.

---

## 8. Charts (Tremor primary, Recharts escape hatch)

### 8.1 Library decision (RESEARCH §7.2)

- **Tremor v3.18+** for all admin home, M08 reports, S01 wallboard
  tiles. License: **Apache-2.0** (confirmed at PLAN time; see §17).
- **Recharts v2.13** for the one Tremor-doesn't-expose case: TCPA drop%
  needs `<ReferenceLine y={3}/>` for the 3% legal cap. Tremor uses
  Recharts under the hood, so dropping down is a one-component swap.

### 8.2 Per-screen mapping (FROZEN; per RESEARCH §7.3)

| Screen | Library | Components |
|---|---|---|
| `/dashboard` (admin home) | Tremor | `<BarList>` (today's calls per campaign), `<Metric>` cards (active agents, calls/sec, drop%), `<LineChart>` (last-7-day call volume) |
| `/reports/call-summary` (M08) | Tremor | `<LineChart>` (calls/day per status, stacked), `<DonutChart>` (status breakdown) |
| `/reports/productivity` (M08) | Tremor | `<BarChart>` (per agent calls; stacked talk/wrap/pause) |
| `/reports/tcpa` (M08) | **Recharts** | `<AreaChart>` + `<ReferenceLine y={3}/>` (the only Tremor-doesn't-expose) |
| `/sup/wallboard` (S01) | Tremor | `<Tracker>` (per-agent state ribbon), `<Metric>` cards, `<DonutChart>` (campaign mix) |
| `/sup/recordings` (S04) | Tremor | `<BarChart>` (duration histogram) for header chart; player below |

M01 ships **no chart pages** (M08 / S01 own them). M01 ships:
- The Tremor + Recharts dep pinning + bundle-analyzer entry.
- A single `components/charts/TcpaDropChart.tsx` exemplar (Recharts
  with ReferenceLine) so M08 has a concrete pattern to copy.
- Tailwind `@theme` tokens used by Tremor's color system (Tremor reads
  CSS vars; we publish via `packages/ui/tokens/colors.css`).

### 8.3 Bundle implication

Tremor (~70 KB gz) + Recharts (~50 KB gz; transitive of Tremor anyway)
land only on routes that import them. Next code-splits per route.
Lighthouse budget for admin allows 350 KB gz per route (looser than
agent's 250 KB) per §13.

---

## 9. RBAC integration (CASL + 3 layers)

### 9.1 Source of truth

F05 PLAN §6.2 declares the role → permission matrix in
**`shared/types/src/rbac.ts`**. M01 does **not** invent permissions.
`packages/auth` imports from `@vici2/types` and wraps in CASL.

### 9.2 CASL Ability builder (`packages/auth/src/ability.ts`)

- `abilityFromUser(me: MeResponse): AppAbility` — converts F05's
  `/api/auth/me` response (which includes `role` and `perms: string[]`)
  into a CASL `Ability<[Action, Subject]>`.
- Action enum union of F05 verbs (`'manage' | 'create' | 'read' |
  'update' | 'delete' | 'eavesdrop' | 'whisper' | 'barge' | 'export' |
  'rotate_sip' | ...`). Verbs come from F05 PLAN §6.2 table.
- Subject enum union of F05 subjects (`'Campaign' | 'List' | 'Lead' |
  'Carrier' | 'DID' | 'User' | 'UserGroup' | 'DNC' | 'Status' |
  'PauseCode' | 'Script' | 'Recording' | 'Report' | 'Wallboard' |
  'AgentSession' | 'Tenant' | 'all'`).
- Hierarchy: `super_admin` gets `can('manage', 'all')`; `admin` gets
  `can('manage', [...all-tenant-resources])` + `can('read',
  'Wallboard')`; `supervisor` gets read on most + `('eavesdrop',
  'whisper', 'barge')` on `'AgentSession'`; `agent` gets nothing in
  admin (middleware redirects).
- **Fail-closed:** `abilityFromUser(undefined)` returns an empty
  Ability. Every component defaults to "no permission."

### 9.3 Three-layer enforcement

**Layer 1 — Edge middleware (`admin/src/middleware.ts`):**
- Decodes `sx_user` cookie (`jose.jwtVerify`).
- Coarse role gate: agent → cross-app redirect; supervisor accessing
  `/(admin)/*` → redirect.
- Sets `x-vici2-user` request header.

**Layer 2 — Server-component layout (`admin/src/lib/server-auth.ts`):**
```ts
// public surface only:
export async function getMe(): Promise<MeResponse>;       // RSC: reads cookie, calls /api/auth/me
export async function requireRole(role: Role): Promise<MeResponse>;  // throws redirect
export async function requirePermission(action, subject): Promise<MeResponse>;
```
- `(admin)/layout.tsx` does `const me = await requireRole('admin')`
  before rendering children.
- Specific section layouts can additionally call
  `requirePermission('manage', 'Campaign')` etc.

**Layer 3 — Client `<Can>` (`packages/auth/src/Can.tsx`):**
- `<Can do="update" on="Campaign"><Button>Edit</Button></Can>` —
  conditionally renders.
- `<Can do="..." on="..." not><Banner>...</Banner></Can>` for inverse.
- `useCan(action, subject)` boolean hook for inline expressions.
- Backed by `useAbility()` which reads from `AbilityProvider` (built
  once on `me` fetch + rebuilt on `me` invalidation).

### 9.4 Sidebar nav filtered by ability

`admin/src/lib/nav-config.ts` is a const array of typed entries:

```ts
type NavItem = {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  requires: { action: Action; subject: Subject };
  section?: 'admin' | 'sup';
  badge?: () => string | null;          // dynamic badge (e.g., DNC pending count)
};
```

`<AdminSidebar>` filters via `useAbility().can(item.requires.action,
item.requires.subject)` before rendering. Agent never sees Reports
because (a) they're redirected by middleware, but (b) defense in depth
— if the redirect is bypassed, the link still doesn't render.

### 9.5 Backend re-check (defense in depth)

Per F05 PLAN §6/§7, every API route registers
`requirePermission('campaign:edit')` etc. as Fastify `preHandler`.
**M01 frontend is never the security boundary** — the backend is.

---

## 10. Multi-tenant UI (build now, hide until Phase 4)

### 10.1 Phase-1 reality (RESEARCH §9.1)

- DESIGN.md commits to "tenant_id everywhere from day 1, default 1,
  single-tenant in Phase 1."
- F05 JWT carries `tenant_id`. Every API call carries the tenant
  implicitly via the JWT.
- **No tenant switcher visible in Phase 1** (only one tenant exists).
- Header injection plumbing built so Phase 4 flips on cleanly.

### 10.2 `TenantProvider` (`packages/auth/src/tenant/TenantProvider.tsx`)

Server-component variant:
```tsx
// admin/src/app/(admin)/layout.tsx
const me = await requireRole('admin');
return (
  <TenantProvider tenant={me.tenant}>
    <AbilityProvider me={me}>
      <AdminShell>{children}</AdminShell>
    </AbilityProvider>
  </TenantProvider>
);
```

Client variant: pure context provider, hydrates from server-passed prop.

`useTenant()` returns `{ id: bigint, name, slug, plan }`.

### 10.3 API client auto-injection

`packages/api-client/src/client.ts` middleware:

```ts
api.use({
  onRequest(ctx) {
    const token = useAuthStore.getState().accessToken;
    const tenantId = currentTenantIdRef.current;     // hydrated by TenantProvider via setTenantId(...)
    ctx.headers.set('Authorization', `Bearer ${token}`);
    if (tenantId) ctx.headers.set('X-Tenant-Id', String(tenantId));
  },
});
```

The current tenant ID is held in a module-scope ref updated by
`TenantProvider` on mount and on switch. JWT also carries it
(belt-and-braces for clear logging and audit).

### 10.4 TanStack Query keys

**Convention (FROZEN):** every query key starts with
`[resource, tenantId, ...]`. The `react-query/keys.ts` factory enforces
this:

```ts
// public surface only
export const queryKeys = {
  campaigns: {
    list: (tenantId: bigint, filters: CampaignFilters) =>
      ['campaigns', String(tenantId), 'list', filters] as const,
    detail: (tenantId: bigint, id: bigint) =>
      ['campaigns', String(tenantId), 'detail', String(id)] as const,
  },
  // ... per resource
};
```

Tenant switch invalidates cache by exact prefix:
`qc.invalidateQueries({ queryKey: [resource, oldTenantId] })` per
resource, or full reset on `__tenant` cookie change.

### 10.5 WS channels

S01 / S04 / A03 pattern — channel names always
`t:{tid}:broadcast:wallboard`, never plain `wallboard`. Hard-enforced
in `packages/auth`'s `useChannel(name)` helper (rejects unprefixed).

### 10.6 Phase-4 enabling steps (no refactor)

1. Backend (F05): add `/api/auth/switch-tenant` endpoint that re-signs
   JWT with new `tid` + sets `__tenant` cookie + returns `{ ok: true }`.
2. M01: render `<TenantSwitcher>` in `<AdminTopBar>` gated by
   `<Can do="manage" on="Tenant">`. Clicking writes cookie via API +
   `router.refresh()`.
3. Subdomain / path routing: deferred to Phase 4 only if needed; the
   cookie-based approach is sufficient for many SaaS deployments.

---

## 11. Real-time wallboard (S01) and recordings (S04) hooks

### 11.1 WS hook reused from A01 / A03

A01 PLAN §6 owns `lib/ws.ts` + `useWebSocket()`. M01 lifts it into
`packages/auth/src/ws/` with a thin generalization:

- `useChannel<T>(channel: string, eventTypes: string[])` — convenience
  wrapper around `useWebSocket().subscribe(eventType, handler)` that
  binds multiple event types and tenant-scopes the channel name.
- The actual WebSocket transport stays exactly as A01 designed it
  (single full-duplex socket; query-param token; exponential backoff;
  heartbeat; resume cursor).

### 11.2 S01 wallboard (M01 ships scaffolding only)

`(sup)/wallboard/page.tsx` is a placeholder for S01. M01 ships:

- `lib/hooks/useThrottledRaf.ts` — generic helper:
  `useThrottledRaf(callback, throttleMs = 100)`. Schedules callback in
  `requestAnimationFrame` if not already pending; coalesces bursts.
- `lib/hooks/useDiffUpdate.ts` — generic helper that takes
  `(current: T, patches: Patch<T>[])` → applies patches via Immer
  produce, returns next state. Used by S01 to apply diff payloads
  without storing full wallboard state at every event.

S01 PLAN consumes both. M01 just provides the primitives.

### 11.3 S04 recording browser (M01 ships scaffolding only)

`(sup)/recordings/page.tsx` is a placeholder for S04. M01 ships:

- `components/recording/WaveformPlayer.tsx` — wrapper around
  `@wavesurfer/react` v7 with:
  - `peaks` prop (pre-decoded peaks served by recording API alongside
    signed S3 URL — full WAV decode kills mobile).
  - `regions` plugin enabled (S04 marks talk/silence segments).
  - Plays via HTML5 audio backend (default in v7).
  - Memoized plugins per @wavesurfer/react v7 contract (RESEARCH §10).
  - Backend-agnostic: `url` accepts either `/api/recordings/:id/audio`
    (auth-proxy) or signed S3 URL — R03 PLAN decides.
- `lib/hooks/useWaveformPeaks.ts` — fetches peaks JSON via TanStack
  Query (cached aggressively; peaks are immutable once recording is
  finalized).

S04 PLAN consumes both. M01 just provides the primitives + contract.

---

## 12. Auth integration (mirror A01 §7)

### 12.1 Token strategy (FROZEN; identical to A01 §7.1)

- **Access JWT (15-min TTL):** `useAuthStore.accessToken` (memory only,
  in `packages/auth`).
- **Refresh token:** F05-issued, in `httpOnly Secure SameSite=Strict
  Domain=.vici2.example` cookie (path `/api/auth`).
- **`sx_user` cookie:** F05-issued slim JWT (HMAC HS256, `aud=ssr`),
  `httpOnly Secure SameSite=Strict Domain=.vici2.example` (path `/`).
  Read by middleware + RSC.
- **WS-scoped JWT:** F05-issued (`aud=ws`, 15-min TTL), in
  `useAuthStore.wsToken` (memory only).

### 12.2 Cross-app session

Both `web.vici2.example` and `admin.vici2.example` share the same
cookies via `Domain=.vici2.example`. Single login at either app sets
cookies; the other app reads them transparently on next request.

In dev (`localhost:4000` and `localhost:4001`), browsers do not share
cookies across ports by default (cookies are scoped by host:port for
non-`__Host-` cookies actually they ARE shared by host without the
port distinction — but `SameSite=Strict` will block cross-port
top-level redirects unless explicitly handled). **Dev mitigation:**
both apps post to a shared `localhost:3000/api/auth/login` endpoint;
each app verifies the cookie locally; documented in
`spec/conventions.md` amendment.

### 12.3 Single-flight refresh

`packages/auth/src/refresh.ts` — module-scoped
`let refreshInFlight: Promise<RefreshResult> | null`. Identical pattern
to A01 §7.2. On 401 the api-client calls
`refreshAccessToken()`; concurrent callers dedup. On failure → logout
cascade (clear stores → close WS → push `/login`).

### 12.4 Login flow (per-role redirect)

```
1. Browser GET admin.vici2.example/login
2. User submits LoginForm
   → fetch('/api/auth/login', {credentials:'include'}) with {email, password}
   → F05 sets refresh + sx_user cookies (Domain=.vici2.example), returns
     {access_token, access_exp, ws_token, ws_exp, user}
3. useAuthStore.setSession(...) puts non-cookie data in memory
4. router.push by role:
     admin / super_admin → /dashboard       (current app)
     supervisor          → /sup/wallboard   (current app)
     agent               → ${NEXT_PUBLIC_WEB_ORIGIN}/dashboard  (cross-app)
```

If a tab is opened directly to `/dashboard` (no in-memory session), the
RSC layout still has `sx_user` and renders, but the CC island sees
`useAuthStore.accessToken === null` and immediately calls
`refreshAccessToken()` to recover.

### 12.5 Tab sync

`packages/auth/src/tab-sync.ts` — `BroadcastChannel('vici2.auth')`.
Login pushes `{event:'login', userId}`; logout pushes
`{event:'logout'}`. Subscribers in `Providers` reset state and force
navigation. Fallback to `storage` event for browsers without
BroadcastChannel.

### 12.6 What M01 does NOT own

- Issuing tokens (F05).
- Setting cookies (F05).
- Verifying access tokens server-side at API routes (F05).
- The actual `/api/auth/*` endpoints (F05).
- The SIP credential bundle in login response (only relevant to web/,
  not admin/ — admin has no SIP.js).

---

## 13. Build / deploy

### 13.1 `next.config.mjs` (admin/)

```js
import bundleAnalyzer from '@next/bundle-analyzer';
const withAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === '1' });
export default withAnalyzer({
  output: 'standalone',
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  poweredByHeader: false,
  compress: true,
  transpilePackages: ['@vici2/ui', '@vici2/api-client', '@vici2/auth'],
});
```

### 13.2 Dockerfile (admin/Dockerfile, mirror of web/Dockerfile)

Multi-stage `node:20.18.1-alpine`:
- `deps` stage — copies workspace lockfile + all `package.json`s; runs
  `pnpm install --frozen-lockfile --filter admin... --filter @vici2/ui... --filter @vici2/api-client... --filter @vici2/auth...`.
- `builder` stage — copies source + ran `pnpm --filter admin build`.
- `runner` stage — `next start` from `.next/standalone/admin/server.js`,
  `EXPOSE 4001`, `ENV PORT=4001`, `USER nextjs (uid 1001)`,
  `HEALTHCHECK CMD wget -qO- http://localhost:4001/api/health || exit 1`,
  `CMD ["node", "admin/server.js"]`.

Final image: ~150–200 MB.

### 13.3 Health check

`/api/health` route handler returns
`{ status: 'ok', service: 'admin', commit: process.env.GIT_COMMIT, ts: Date.now() }`
with `Cache-Control: no-store`.

### 13.4 Performance budget (looser than agent)

| Budget | Mechanism |
|---|---|
| Lighthouse ≥ 90 | `@lhci/cli` PR gate on `/login`, `/dashboard`, `/campaigns` |
| LCP ≤ 2.0 s | `useReportWebVitals` → `/api/metrics/web` |
| INP ≤ 200 ms | Web Vitals report |
| Admin route bundle ≤ 350 KB gzipped | `@next/bundle-analyzer`; CI `size-limit` check (looser than agent's 250 KB because admin loads heavier libs: TanStack Table+Virtual, Tremor, wavesurfer per route) |
| Tremor + Recharts only on chart routes | `next/dynamic` for chart components on dashboard; full Tremor only loaded on `/dashboard` and `/reports/*` |
| `wavesurfer.js`, `tus-js-client` lazy via `next/dynamic` | Verified in bundle analyzer — must not appear in `/dashboard` chunk |

### 13.5 Env strategy

`admin/lib/env.ts` validates with zod at module load:

| Var | Public/Private | Source | Notes |
|---|---|---|---|
| `NEXT_PUBLIC_API_URL` | public | F01 | `http://localhost:3000` in dev |
| `NEXT_PUBLIC_WS_URL` | public | F01 | derived from API URL by default |
| `NEXT_PUBLIC_WEB_ORIGIN` | public | M01 amendment | for cross-app redirects |
| `NEXT_PUBLIC_TELEMETRY_ENDPOINT` | public | F01 | defaults to `/api/metrics/web` |
| `SX_USER_COOKIE_SECRET` | private | F05 | shared with web; both apps verify same cookie |
| `PORT` | private | M01 | 4001 |

---

## 14. Testing

### 14.1 Unit (Vitest + RTL + jsdom)

| File | What |
|---|---|
| `test/unit/nav-filter.test.ts` | `<AdminSidebar>` filters items by ability — every (role × nav-item) cell |
| `test/unit/server-auth.test.ts` | `requireRole`, `requirePermission` behavior + redirect targets |
| `test/unit/stores.ui.test.ts` | persisted slice round-trips through hydrate; migration version 1 |
| `test/unit/stores.bulk-jobs.test.ts` | add/update/remove job; WS event reducer |
| `packages/ui/test/data-table.test.tsx` | cursor mode reaches bottom triggers fetchNextPage; offset mode pagination state changes; sort/filter handlers |
| `packages/ui/test/data-table-bulk.test.tsx` | row select state; bulk action button enabled when selection > 0 |
| `packages/auth/test/ability.test.ts` | every (role × verb × subject) cell against F05 matrix |
| `packages/auth/test/Can.test.tsx` | renders/hides children correctly under each role |
| `packages/auth/test/use-tenant.test.ts` | provider hydrates, switcher updates context |
| `packages/api-client/test/client.test.ts` | injects Authorization + X-Tenant-Id; 401 → refresh → retry |
| `packages/api-client/test/schemas.test.ts` | zod parse round-trips for every resource schema |

Coverage target: ≥ 70% on `admin/src/lib/**`, `packages/ui/src/data-table/**`,
`packages/auth/src/**`, `packages/api-client/src/**`.

### 14.2 E2E (Playwright)

| File | What | Acceptance crit covered |
|---|---|---|
| `test/e2e/admin-shell.spec.ts` | login as admin → admin home renders with nav; sidebar nav highlights current section | crit 1, 3 |
| `test/e2e/role-protection.spec.ts` | login as agent → cannot access `/(admin)/...` (cross-app redirect); login as supervisor → can access /sup but not /campaigns | crit 2 |
| `test/e2e/responsive.spec.ts` | viewports 375 / 768 / 1280; sidebar collapses to hamburger on 375 | crit 4 (mobile) |
| `test/e2e/a11y.spec.ts` | `injectAxe` + `checkA11y` against `/login`, `/dashboard`, `/campaigns`, `/leads`, `/reports/tcpa` — zero AA violations | a11y |
| `test/e2e/tenant-header.spec.ts` | every API request observed by MSW carries `X-Tenant-Id: 1` | tenant plumbing |
| `test/e2e/bulk-job.spec.ts` | trigger bulk action → see progress toast → see completion (mocked WS) | bulk pattern |
| `test/e2e/csv-upload.spec.ts` | drop file → preview → column-map → compliance gate → upload completes (tus mock) | upload pattern |
| `test/e2e/recording-player.spec.ts` | wavesurfer mounts + plays (mocked audio) | S04 prep |

### 14.3 MSW

`test/msw/handlers.ts` mocks:
- `/api/auth/login`, `/api/auth/refresh`, `/api/auth/logout`,
  `/api/auth/me`
- `/api/admin/campaigns` (offset pagination)
- `/api/admin/leads` (cursor pagination)
- `/api/admin/<resource>/bulk` (returns 202 + job_id)
- `/api/admin/uploads/leads/peek`, `/api/admin/uploads/leads/columnmap`
- `/api/admin/jobs/:id` (job status)
- WebSocket mock for bulk-job progress events

Used by both Vitest (via `setupServer`) and Playwright (via
`page.route` shim).

### 14.4 Lighthouse CI

`lighthouserc.json`:
```json
{
  "ci": {
    "collect": {
      "url": ["http://localhost:4001/login","http://localhost:4001/dashboard","http://localhost:4001/campaigns"],
      "numberOfRuns": 3
    },
    "assert": {
      "preset": "lighthouse:recommended",
      "assertions": {
        "categories:performance": ["error", {"minScore": 0.9}],
        "categories:accessibility": ["error", {"minScore": 0.9}],
        "largest-contentful-paint": ["error", {"maxNumericValue": 2500}],
        "interactive": ["error", {"maxNumericValue": 2500}]
      }
    }
  }
}
```

GitHub Actions: extend the `lhci.yml` workflow A01 introduces to
include `admin/`; PR-blocking.

### 14.5 Run commands

```
make test-admin                                  # all admin unit + e2e
pnpm --filter admin exec vitest run
pnpm --filter @vici2/ui exec vitest run
pnpm --filter @vici2/api-client exec vitest run
pnpm --filter @vici2/auth exec vitest run
pnpm --filter admin exec playwright test
pnpm --filter admin exec lhci autorun
```

---

## 15. Hand-off interfaces (FROZEN)

### 15.1 Amendment to F01 (workspace + compose; recapitulated here)

See §2.1–§2.5. **Not optional — F01 must merge the additive changes
before M01 IMPLEMENT can install deps.**

### 15.2 To M02 (campaigns admin)

- **Routes already scaffolded:** `/campaigns`, `/campaigns/new`,
  `/campaigns/[id]`, `/campaigns/[id]/edit`. M02 fills `page.tsx`
  contents.
- **Table pattern:** `<DataTable mode="offset" />` from
  `@vici2/ui/data-table`; pre-built columns helper in
  `components/tables/CampaignColumns.tsx` (M02 creates).
- **Form pattern:** `CampaignCreateRequestSchema` lives in
  `@vici2/api-client/schemas/campaigns.ts` (M02 creates the schema).
  RHF + zodResolver per §6.3.
- **Mutation pattern:** `useCreateCampaignMutation`,
  `useUpdateCampaignMutation`, `useDeleteCampaignMutation` in
  `@vici2/api-client/react-query/hooks/campaigns.ts` (M02 creates).
- **Wizard pattern:** §6.4.

### 15.3 To M03 (lists admin)

- Same patterns as M02 for offset table + form.
- **CSV upload integration:** `<TusUploader>` from
  `admin/src/components/upload/`; UX flow §7.4. M03 wires the upload
  wizard at `/lists/[id]/import`.

### 15.4 To M04 (carriers + DIDs admin)

- Same patterns as M02.
- **Encrypted-field UX:** carrier passwords are write-only (admin
  enters, never sees again); F05 `encryption.ts` handles storage. UI
  shows masked field + "Reset" button.

### 15.5 To M05 (users + groups admin)

- Same patterns as M02.
- **Role-change UX:** dropdown gated by `<Can do="manage" on="User">`;
  super_admin can promote to admin; admin can promote up to supervisor
  but not admin (per F05 hierarchy).
- **SIP rotate button:** triggers `POST /api/auth/sip/rotate` for that
  user (admin+ permission per F05). Toast confirms rotation.

### 15.6 To M06 (DNC admin)

- **Search-first UX:** no infinite scroll. `<DncSearch>` component
  (M06 creates) fronts a `useQuery({ queryKey: ['dnc', tenantId,
  searchTerm], enabled: searchTerm.length > 6 })`.
- Bulk import via tus (same `<TusUploader>` as M03).

### 15.7 To M07 (statuses + pause codes + scripts)

- Offset tables for all three. M07 creates schemas + columns.
- Scripts editor: defer to M07 to choose Monaco vs CodeMirror; M01
  doesn't pre-pin.

### 15.8 To M08 (reports)

- **Chart pattern:** Tremor for everything except TCPA drop%.
- **TCPA chart exemplar:** `components/charts/TcpaDropChart.tsx`
  shipped by M01 with Recharts `<ReferenceLine y={3}/>` — M08 copies
  this pattern.
- **Export pattern:** report exports use the bulk-job pattern
  (§5.6 + §6.4) — kick off `POST /api/admin/reports/exports`, get
  job_id, show progress, download CSV when done.

### 15.9 To S01 (wallboard)

- **WS hook:** `useChannel('wallboard', [...eventTypes])` from
  `@vici2/auth`.
- **Throttle helper:** `useThrottledRaf(callback, 100)` from
  `admin/src/lib/hooks/`.
- **Diff-update helper:** `useDiffUpdate(state, patches)` from same.
- **Tile components:** Tremor `<Metric>`, `<DonutChart>`, `<Tracker>`
  available; S01 composes the wallboard layout.

### 15.10 To S02 (eavesdrop)

- M01 ships placeholder route. S02 fills with live agent monitor.
  Backend WS channels already tenant-scoped via `useChannel`.

### 15.11 To S03 (callbacks)

- M01 ships placeholder route. S03 reuses `<DataTable mode="cursor" />`
  (callbacks are timeline-ordered).

### 15.12 To S04 (recordings supervisor)

- **Player:** `<WaveformPlayer url={...} peaks={...} regions={...} />`
  from `admin/src/components/recording/`.
- **Peaks fetch:** `useWaveformPeaks(recordingId)` hook from
  `admin/src/lib/hooks/`.
- **Browse table:** `<DataTable mode="cursor" />` listing recordings.

### 15.13 To R03 (admin recordings)

- Admin variant of S04 player; same component.
- Adds delete + bulk-export affordances (gated on
  `<Can do="delete" on="Recording" />`).

### 15.14 To F05 (admin amendments)

- **`SX_USER_COOKIE_DOMAIN` env var** added (per §2.6).
- F05's `/api/auth/me` response **must include `tenant: {id, name,
  slug, plan}`** (M01 needs this for `TenantProvider`). F05 PLAN
  doesn't currently spell this out — coordination note for F05
  IMPLEMENT.
- F05's `/api/auth/me` response **must include `perms: string[]`**
  (verb:resource strings) for CASL `abilityFromUser`. F05 PLAN §1.3
  shows `perms` in the access token JWT; the `/me` endpoint should
  echo the same array.

### 15.15 To O04 (CI/CD)

- New CI matrix entries: `admin` workspace + `packages/{ui,api-client,auth}`.
- `@axe-core/playwright` AA gate on admin E2E.
- Tremor/Apache-2.0 added to license allowlist.
- ESLint boundaries plugin added; PR-blocking.

### 15.16 To O01 (observability)

- Web Vitals sink at `admin/api/metrics/web` forwards to F-API
  `POST /api/metrics/web` (same endpoint as web/, with `service: 'admin'`
  tag in payload).

### 15.17 To O05 (security baseline)

- `Domain=.vici2.example` cookies + same `SameSite=Strict` posture as
  F05.
- Reverse proxy must terminate TLS for both `web.vici2.example` and
  `admin.vici2.example`.

---

## 16. Open questions (resolved)

All RESEARCH §10 questions resolved by this PLAN:

1. **Single shared login vs per-app?** → **Recommend SHARED** (one SSO
   login at the cookie-domain root serves both); per-app `/login` page
   shipped in each app for dev parity (where cross-port cookies are
   awkward).
2. **Cookie domain.** → `Domain=.vici2.example` in prod, no `Domain` in
   dev (localhost). F05 amendment §2.6 + §15.14.
3. **CSRF strategy.** → **Bearer-only**, per F05 PLAN §12. No CSRF
   risk; cookies are HttpOnly and used only by middleware/RSC, not by
   client-side fetches.
4. **OpenAPI generation direction.** → **Source of truth = shared zod
   schemas in `@vici2/api-client`.** Fastify imports → emits OpenAPI →
   `openapi-typescript` re-derives types for the typed fetch client.
   One file, three consumers.
5. **Tremor licensing.** → **Apache-2.0 confirmed** (verified at PLAN
   time via Tremor's GitHub LICENSE file). Risk #5 from RESEARCH §10
   closed.
6. **TanStack Query v5 vs v4.** → **v5** per A01 PLAN §1.1.
7. **Server Actions vs API routes.** → **REST (Fastify) for everything
   except `/api/health` and `/api/metrics/web` (Next route handlers
   only)**. Per RESEARCH §10 Q7.
8. **Wallboard refresh cadence.** → S01 PLAN owns; M01 ships the
   primitives (`useThrottledRaf`, `useDiffUpdate`). Default cadence
   recommended: ~10 Hz batched via RAF, diff payloads only.
9. **Recording playback backend.** → R03 / S04 PLAN owns the choice
   (signed S3 URL vs `/api/recordings/:id/audio` proxy). M01's
   `<WaveformPlayer>` is agnostic — `url` prop accepts either.
10. **Mobile responsiveness floor.** → M01 spec acceptance: mobile
    responsive at 375 / 768 / 1280. For grids with 12+ columns, mobile
    falls back to a card-list layout via CSS container queries
    (Tailwind v4 `@container` syntax). One universal approach: tables
    on `≥md`, card list on `<md`. Documented in `<DataTable>` API.
11. **Empty state library.** → **Hand-roll in
    `@vici2/ui/empty-state.tsx`**. shadcn doesn't ship empty states;
    M01 implements once for all admin tables.
12. **Toast/notification.** → Sonner via shadcn (matches A01).
13. **Date picker.** → shadcn `<Calendar>` + react-day-picker; date-range
    via shadcn `<DateRangePicker>` recipe.
14. **Audit-log surface.** → No dedicated screen in M01. M08 may add
    an `/reports/audit` view; defer to M08 PLAN.

---

## 17. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Tailwind v4 instability (shared with A01) | Low–Med | Med | Same as A01 §17 — pin known-good patch; revert path to v3 exists |
| Tremor v3.x maintenance pace | Med | Med | Tremor v3 is actively maintained as of PLAN date; if maintenance stalls, Recharts directly is a 1-week migration since Tremor's chart components are thin Recharts wrappers. License risk closed (Apache-2.0). |
| `transpilePackages` cold-start cost | Low | Low | ~200 ms cold; trade-off accepted vs. stale `dist/` from `tsc -b` |
| Cross-app cookie sharing in dev (localhost ports) | Med | Low | Each app ships own `/login`; dev users sign in twice if testing both apps. Production fixes itself via shared cookie domain. |
| ESLint boundaries false-positives | Low | Low | Allowlist marker comment + ticket if frequent |
| Bundle bloat from Tremor on non-chart routes | Low | Med | `next/dynamic` for chart components; bundle-analyzer assertion in CI |
| Tus client + server upgrade desync (`@tus/server` vs `tus-js-client`) | Med | Low | Pin both; Renovate PRs explicit |
| RBAC matrix drift between F05 (TS) and CASL (TS) | Low | High | Both import from `@vici2/types/rbac.ts`; same source. CASL is a wrapper, not a parallel definition. |
| `/api/auth/me` response shape changes mid-IMPLEMENT | Low | Med | Schema in `@vici2/api-client/schemas/auth.ts` is frozen by §6 + §15.14 |
| TanStack Table v8 perf at 100k+ virtualized rows | Low | Med | RESEARCH §4 confirms pattern works to ~1M rows with virtualizer; benchmark in test suite at 100k synthetic leads |
| Tenant switcher (Phase 4) introduces TanStack cache thrash | Low | Low | Cache keys already prefixed; switch invalidates by prefix only — no full reset needed |
| Wavesurfer v7 mobile audio decode hang on long recordings | Med | Med | Pre-decoded peaks (R03 backend); HTML5 audio backend (default in v7) handles streaming |
| F05 `Domain=...` cookie attribute coordination | Low | Med | §2.6 amendment to F05 PLAN — mechanical change |
| Lighthouse CI flake on admin (heavier routes than agent) | Med | Low | `numberOfRuns: 3`; LCP threshold 2500 ms (looser than agent's 2000) |
| `@wavesurfer/react` v7 breaking change vs v6 | Low | Low | Pin to v1.x of @wavesurfer/react (v7-line); migration documented |
| `@casl/react` API change | Low | Low | Pin to v4.x; CASL is mature and stable |

---

## 18. RFCs filed

**Zero RFCs filed by this PLAN.** All decisions derive from RESEARCH +
upstream PLAN constraints (F01–F05 + A01). The PLAN explicitly:

- **Amends F01** (additive workspace + compose) — §2.1–§2.5; mechanical.
- **Amends F05** (`SX_USER_COOKIE_DOMAIN` env + `me` response shape) —
  §2.6 + §15.14; mechanical.
- **Mirrors A01 stack 1:1** — no divergence; lifts shared code into
  `packages/*` without breaking A01's `web/` surface.

If during IMPLEMENT any of these amendments meets pushback from an
upstream module owner, RFC-004 (workspace restructure for multi-app +
shared packages) is pre-flagged as the natural landing spot — but it
isn't required to start IMPLEMENT.

---

## 19. Acceptance criteria (from M01.md, restated against this PLAN)

- [ ] **Layout + nav.** `(admin)/layout.tsx` renders `<AdminSidebar/>`
      + `<AdminTopBar/>` + content area; nav items derived from
      `nav-config.ts` and filtered by ability (§9.4). Section pages
      stub at every route (§4.1).
- [ ] **RBAC enforced.** Three layers (§9.3): Edge middleware
      role-gates; server layouts call `requireRole`; client `<Can>`
      hides UI affordances. Backend re-checks (F05).
- [ ] **Reusable DataTable + Form components for downstream M*.**
      `@vici2/ui/data-table` ships cursor + offset modes; shadcn
      `<Form>` wrappers re-exported (§5.4 + §6.3).
- [ ] **Mobile responsive.** Sidebar collapses to hamburger at < md
      (375 viewport); tested in `responsive.spec.ts` (§14.2).
- [ ] **Two-app monorepo lands.** F01 amendment merged; both `web` and
      `admin` build and run via `make dev`.
- [ ] **Shared packages compile and resolve in both apps.**
      `@vici2/{ui, api-client, auth}` consumed via `transpilePackages`.
- [ ] **CI gates pass.** Lighthouse ≥ 90, axe AA zero violations,
      ESLint boundaries no violations, coverage ≥ 70% on
      `admin/src/lib/**` + `packages/*/src/**`.
- [ ] **HANDOFF.md** documents every interface in §15.

---

## 20. File list to be created in IMPLEMENT (summary)

Approximately 100–120 files, split across:

- `admin/` — ~50 files (route stubs + shell + middleware + tests)
- `packages/ui/` — ~40 files (shadcn primitives + DataTable + Form)
- `packages/api-client/` — ~25 files (client + schemas/<resource>.ts +
  query keys)
- `packages/auth/` — ~15 files (CASL + tenant context + auth-store +
  refresh + tab-sync + WS hook)
- F01 amendment files — ~5 (workspace, compose, env example, ci, README)

Load-bearing files:

- `admin/src/middleware.ts` (route protection + tenant header)
- `admin/src/app/(admin)/layout.tsx` + `AdminShell.tsx` (admin gate +
  shell)
- `admin/src/lib/nav-config.ts` (nav source of truth)
- `admin/src/lib/server-auth.ts` (RSC auth helpers)
- `packages/ui/src/data-table/DataTable.tsx` (THE shared table)
- `packages/api-client/src/client.ts` + `schemas/*.ts` (typed client +
  zod source of truth)
- `packages/auth/src/ability.ts` + `Can.tsx` + `tenant/TenantProvider.tsx`
  (RBAC + tenant)

Everything else is convention plumbing.

End of M01 PLAN.md. Awaiting checkpoint approval; IMPLEMENT additionally
gated on F01 amendment merge + F05 PLAN §15.14 amendments accepted.
