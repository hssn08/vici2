# M01 — Admin Next.js Skeleton + RBAC Routing — RESEARCH

> Research-only artifact. No PLAN, no implementation. Blocked on F01 (repo skeleton) and F05 (auth + RBAC + SIP creds).
>
> Companion brief: agent UI A01 already pinned Next.js 14 App Router + Tailwind + Zustand + httpOnly-cookie auth. M01 inherits that stack and adds heavy admin surfaces (campaigns, lists, leads, carriers, DIDs, users, DNC, statuses, scripts, reports, recordings, wallboard).

---

## 1. Executive summary (10 bullets)

1. **Frontend layout: separate apps, shared packages.** Two Next.js 14 apps (`apps/agent-ui`, `apps/admin-ui`) under a pnpm workspace with `packages/ui` (shadcn primitives), `packages/api-client` (typed REST client + zod schemas generated from Fastify OpenAPI), `packages/auth` (JWT + cookie hooks + RBAC `useHasPermission`), `packages/config` (tsconfig, eslint, tailwind preset). Recommendation pattern is consistent with the 2026 monorepo consensus (pnpm workspaces + Turborepo; separate apps when ownership/release cadence differ but code overlap is real).
2. **Stack mirror of A01.** Next.js 14 (App Router, RSC + Server Actions where pragmatic, otherwise client islands), TypeScript strict, Tailwind v4 with `@custom-variant dark`, shadcn/ui (Radix-based), Zustand for global UI state, TanStack Query for server state, TanStack Table v8 for grids, react-hook-form + zod for forms. No design-system invention; conform to A01 tokens.
3. **Heavy data tables: server-side ops + virtualization.** TanStack Table v8 with `manualPagination`/`manualSorting`/`manualFiltering` driving server queries via TanStack Query. For 100k-row leads: TanStack Virtual `useVirtualizer` over the row model, `estimateSize: () => 33`, `overscan: 5`, container-scroll listener with `fetchNextPage` when scroll-bottom threshold reached (`useInfiniteQuery` + `keepPreviousData` to avoid empty-flashes).
4. **Pagination strategy: hybrid.** **Cursor (keyset) pagination** as the default for streaming/scrolling lists (leads, call_log, agent_log, recording_log) — stable under writes, O(1) deep-page cost. **Offset pagination** as an opt-in for admin browse screens that genuinely need "page X of Y" + total count (smaller catalogs: campaigns, lists, carriers, DIDs, users, statuses). Bulk operations always materialize ID sets via a snapshot endpoint, never re-paginate.
5. **Forms.** react-hook-form + `@hookform/resolvers/zod` everywhere; the **same zod schemas** are generated (or hand-imported) from `packages/api-client` so backend validation and frontend validation are identical. Recommend Fastify-side `fastify-zod-openapi` (or `fastify-type-provider-zod`) so the OpenAPI spec, Fastify request validation, and frontend zod are one source of truth.
6. **CSV upload.** Use **tus** (`tus-js-client` + `@tus/server` mounted under `/api/uploads/leads`) for D02 lead import: resumable on flaky/large uploads, chunked (8MB chunks, retry delays `[0, 1000, 3000, 5000]`), progress events plumbed to a Zustand upload store. UX wraps tus in react-dropzone for drag-drop and gives a column-mapping wizard before the worker kicks off (CSV header → `leads.custom_data` JSON keys).
7. **Charts.** **Tremor** (built on Recharts) is the recommended primary because it lands shadcn-aligned dashboards in 15-line components — perfect for M08 (call summary, agent productivity, drop% TCPA) and S01 wallboard tiles. Drop to **raw Recharts** for any one-off custom viz Tremor doesn't expose (e.g., a stacked drop-rate histogram with reference lines for the 3% TCPA threshold). Avoid visx (too low-level for this scope) and Nivo (heavier, overlaps Tremor coverage).
8. **Permission gating: CASL + thin hooks.** `packages/auth` exposes `useAbility()` (from `@casl/react`), a contextual `<Can do="manage" on="Campaign">` component, and `useRequireRole('admin')` for route-level guards. Three layers: (a) Next.js middleware/proxy at the edge redirects unauthenticated requests, (b) Server Component layout reads cookie session and 403s on role mismatch, (c) Client `<Can>` hides UI affordances. **Backend always re-checks**; UI gating is defense in depth + UX, not security.
9. **Multi-tenant UI.** Tenant ID lives in the JWT (`tid` claim) per F05 design; super-admins additionally get a tenant-switcher in the top bar. Approach: keep the active tenant in a `__tenant` httpOnly cookie that admin-ui's middleware injects as the `X-Tenant-Id` header on every API call; for super-admin override, the dropdown writes to that cookie and triggers a router refresh. URL-based slug routing (`/(admin)/[tenant]/...`) is overkill for Phase 1 single-tenant (`tenant_id DEFAULT 1`); design the abstraction so we can swap in subdomain/Edge proxy resolution in Phase 4 without a refactor.
10. **Real-time wallboard (S01) + recording browser (S04).** Wallboard uses the WS gateway from A03 (existing `useAgentEvents` hook generalized to `useChannel('wallboard')`); high-frequency updates (100ms+ event bursts on a 50-agent floor) must be **batched in a `requestAnimationFrame` loop** before committing to React state, otherwise grid re-renders thrash. Recording browser uses `@wavesurfer/react` (v7 TS rewrite) with pre-decoded peaks served from the API alongside the signed S3 URL — full WAV decode on a 10-minute call kills mobile.

---

## 2. Mono-repo layout (recommended: separate apps + shared packages)

### 2.1 Why separate apps

| Consideration | Single Next.js app, route segments | Two Next.js apps + shared packages |
|---|---|---|
| Code reuse | All shared by default | Explicit via `packages/*` (forces clean boundaries) |
| Build time | Whole app rebuilds on any change | `turbo run build --filter=admin-ui` only rebuilds admin |
| Deploy cadence | Coupled — agent change ships admin too | Decoupled — agent floor can stay stable while admin iterates |
| Bundle size | Risk of agent UI shipping admin chunks (Next splits but tree-shaking has gaps) | Each app ships its own code only |
| Auth/session sharing | Trivial (same origin, same cookies) | Requires both apps on same domain or subdomains; cookies shared by `Domain=.example.com` |
| Ownership | One team owns everything | Agent vs admin teams can split cleanly |
| 50-screen admin ergonomics | Sidebar/topbar wraps half the routes | Admin-only layout; cleaner mental model |
| Phase 4 multi-tenant | Subdomain-per-tenant easier on app boundary | Same |

**Decision: separate apps.** The agent UI is operationally critical, latency-sensitive, and rarely changes once stable; the admin UI is feature-heavy, iterates fast, and has 12+ M-track modules adding screens. Coupling their release cycles costs more than the marginal monorepo overhead.

### 2.2 Layout

```
vici2/
├── apps/
│   ├── agent-ui/                 # was web/(agent) in F01 stub — split out
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx          # login
│   │   │   └── (agent)/...
│   │   ├── middleware.ts
│   │   ├── next.config.ts
│   │   └── package.json          # depends on @vici2/ui, @vici2/api-client, @vici2/auth
│   └── admin-ui/                 # M01–M08 + S01–S04 home
│       ├── app/
│       │   ├── layout.tsx
│       │   ├── page.tsx          # login (or shared SSO redirect)
│       │   ├── (admin)/
│       │   │   ├── layout.tsx    # AdminSidebar + AdminTopBar
│       │   │   ├── page.tsx      # admin dashboard
│       │   │   ├── campaigns/
│       │   │   ├── lists/
│       │   │   ├── leads/
│       │   │   ├── carriers/
│       │   │   ├── dids/
│       │   │   ├── users/
│       │   │   ├── user-groups/
│       │   │   ├── dnc/
│       │   │   ├── statuses/
│       │   │   ├── pause-codes/
│       │   │   ├── scripts/
│       │   │   ├── recordings/
│       │   │   └── reports/
│       │   └── (sup)/
│       │       ├── wallboard/
│       │       └── recordings/
│       ├── middleware.ts
│       ├── next.config.ts
│       └── package.json
├── packages/
│   ├── ui/                       # shadcn primitives + DataTable + Form + PageHeader
│   │   ├── src/
│   │   │   ├── button.tsx
│   │   │   ├── data-table.tsx
│   │   │   ├── form.tsx
│   │   │   └── ... (sonner, dialog, etc.)
│   │   ├── package.json          # exports "./src/index.ts" — Next transpilePackages handles
│   │   └── tsconfig.json
│   ├── api-client/               # generated from shared/openapi/openapi.yaml
│   │   ├── src/
│   │   │   ├── schemas.ts        # zod schemas (input + output)
│   │   │   ├── client.ts         # typed fetch wrapper, openapi-fetch or hey-api
│   │   │   └── react-query.ts    # generated TanStack Query hooks (optional)
│   │   ├── codegen.ts            # script: openapi-typescript || hey-api
│   │   └── package.json
│   ├── auth/                     # client-side hooks; server cookie helpers
│   │   ├── src/
│   │   │   ├── ability.ts        # CASL ability builder per role+permission DTO
│   │   │   ├── use-ability.ts
│   │   │   ├── can.tsx
│   │   │   ├── use-require-role.ts
│   │   │   ├── tenant-context.tsx
│   │   │   └── auth-store.ts     # Zustand: user, accessToken, sipCreds (agent only)
│   │   └── package.json
│   ├── tsconfig/                 # base.json, nextjs.json
│   ├── eslint-config/
│   └── tailwind-config/          # tokens, dark variant, shared theme.css
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

### 2.3 Tooling

- **pnpm workspaces** — content-addressable, strict isolation, `workspace:*` protocol.
- **Turborepo** — task pipeline (`turbo run dev --parallel`, `turbo run build --filter=admin-ui...`), remote cache hooked into CI later (O04 territory).
- **TypeScript project references** — `tsconfig.base.json` with `paths` aliasing `@vici2/ui`, `@vici2/api-client`, `@vici2/auth` to source files (not `dist/`); each Next app uses `transpilePackages: ['@vici2/ui', '@vici2/api-client', '@vici2/auth']` so packages stay source-only.
- **No Changesets needed** — packages are private (`"private": true`), never published.

### 2.4 Apps don't import apps

The hard rule from the 2026 monorepo consensus: `apps/admin-ui` cannot import from `apps/agent-ui`. If both need it, it goes in `packages/`. This is what keeps `--filter` builds correct and CI caching honest.

### 2.5 Risks called out

- **Cookie sharing across apps.** If agent-ui runs at `agent.vici2.example` and admin-ui at `admin.vici2.example`, the auth cookie must be set with `Domain=.vici2.example` and `SameSite=Lax`. F05 PLAN must commit to this.
- **CSRF surface widens** with cookie auth on multiple subdomains; add a `__csrf` double-submit token for any state-changing route, or require an `X-Vici2-CSRF` header that JS reads from a non-httpOnly cookie (the standard double-submit pattern).
- **Mac/Linux dev parity for two `next dev` processes.** F01 docker-compose must expose `agent-ui:4000` and `admin-ui:4001`; document the localhost ports.

---

## 3. Stack confirmation (mirror A01)

| Layer | A01 pick | M01 confirms | Notes |
|---|---|---|---|
| Framework | Next.js 14 App Router | ✅ same; consider Next.js 15 if stable at F01 cut-time | Server Components for data-heavy admin reads, Client Components for interactive grids/forms |
| Language | TypeScript strict | ✅ |
| CSS | Tailwind v4 | ✅ | `@custom-variant dark (&:where(.dark, .dark *))`; tokens in `packages/tailwind-config` |
| Components | shadcn/ui (Radix) | ✅ | Re-exported from `packages/ui` so both apps style-share |
| Global state | Zustand | ✅ | `auth-store`, `upload-store`, `wallboard-store` (per-feature slices, not one mega-store) |
| Server state | TanStack Query | ✅ | `placeholderData: keepPreviousData` for paginated grids; `staleTime: 30_000` default; per-list overrides |
| Tables | TanStack Table v8 | ✅ | `manualPagination`, `manualSorting`, `manualFiltering` always on for admin grids |
| Virtualization | TanStack Virtual | ✅ | Wraps `getRowModel().rows` for 1k+ row lists |
| Forms | react-hook-form + zod | ✅ | `zodResolver`; shared schemas from `packages/api-client` |
| Charts | (none in A01) | **Tremor** primary, **Recharts** escape hatch | TCPA drop% gauge, productivity bars, time-series |
| Audio | (none in A01) | `@wavesurfer/react` | Recording playback (R03 admin, S04 supervisor) |
| Date/time | date-fns + `Intl.DateTimeFormat` | ✅ | Tz-aware display; user's tz from JWT or browser; campaign-tz for compliance contexts |
| RBAC | (basic role check in A01) | **CASL** (`@casl/ability` + `@casl/react`) | Role + per-resource ability rules from `/me` permissions DTO |
| Auth transport | httpOnly cookie | ✅ | Plus `X-Tenant-Id` header injected by middleware |
| Theming | Tailwind dark + CSS vars | ✅ | `next-themes` with `attribute="class"` `defaultTheme="system"` `enableSystem` |
| i18n | n/a (Phase 1) | English only; **architecture-ready** with `next-intl` | Wrap children in `NextIntlClientProvider`; copy in `messages/en.json` from day 1; add `[locale]` segment in Phase 3 without refactor |
| Test | vitest + Playwright | ✅ | Playwright for RBAC + nav + responsive checks |

No deviations from A01. M01 introduces additions, not replacements.

---

## 4. Heavy-data-table strategy

### 4.1 The shape of the problem

| Screen | Expected row count | Filter dim | Sort dim | UX pattern |
|---|---|---|---|---|
| Leads list (M03) | 100k–1M per tenant | status, list, campaign, phone-prefix, dispo, dialed-since | status, called_count, last_call, created_at | Infinite scroll with virtualization; "jump to lead" via search |
| Call log (M08 source) | 1M–10M per tenant per month | campaign, agent, date-range, status, is_drop | start_time, talk_seconds | Date-bounded views; pagination per day; infinite within day |
| Agent log (M08 source) | 1M–10M / month | agent, event_type, date-range | created_at | Same as call log |
| Recording log (S04) | 1M / month | campaign, agent, lead, date | recorded_at, duration | Scroll-and-flag; player inline |
| Campaigns (M02) | <100 | name, status | name | Simple table, paginated 50/page |
| Lists (M03) | <500 | campaign | name | Simple table |
| Users (M05) | <500 | group, role, active | username | Simple table |
| DNC (M06) | 1M federal + 100k internal | source, phone | added_at | Search-first, no scroll-the-list UX |

**Two table archetypes:**
- **Browse tables** (campaigns, lists, users, carriers, DIDs, statuses, pause-codes, scripts) — bounded, low write volume → offset pagination, classic numbered pager with total count, no virtualization needed.
- **Stream tables** (leads, call_log, agent_log, recording_log) — large, write-active → cursor pagination, infinite scroll, virtualization mandatory.

### 4.2 Cursor-pagination wire format

```
GET /api/admin/leads?
    list_id=42&
    status=NEW&
    cursor=eyJjcmVhdGVkX2F0IjoiMjAyNi0wNS0wNlQxMzowMDowMFoiLCJpZCI6MTAwMDAwfQ&
    limit=200

→ {
    "data": [ ...200 leads ],
    "next_cursor": "eyJjcmVhdGVkX2F0IjoiMjAyNi0wNS0wNlQxMjo1OTo1OFoiLCJpZCI6OTk4MDB9",
    "has_more": true
  }
```

Cursor encodes `(sort_key, id)` tuple base64'd. No `total_count` on the streaming path. For grids that show "X of N" the screen calls a separate cached `/count` endpoint or accepts an approximate count.

### 4.3 TanStack Table wiring (server-side)

```ts
const table = useReactTable({
  data: flatData,
  columns,
  rowCount,                      // optional; only when offset mode
  manualPagination: true,
  manualSorting: true,
  manualFiltering: true,
  getCoreRowModel: getCoreRowModel(),
  state: { sorting, columnFilters, pagination },
  onSortingChange: setSorting,
  onColumnFiltersChange: setFilters,
  onPaginationChange: setPagination,
});
```

`flatData` for streaming tables comes from `useInfiniteQuery({ getNextPageParam: lp => lp.next_cursor, refetchOnWindowFocus: false, placeholderData: keepPreviousData }).data.pages.flatMap(p => p.data)`.

### 4.4 Virtualization

```ts
const rowVirtualizer = useVirtualizer({
  count: rows.length,
  estimateSize: () => 33,
  getScrollElement: () => containerRef.current,
  overscan: 5,
});
```

Container has `overflow: auto`, table renders via `display: grid` so dynamic row heights work; on Firefox, skip `measureElement` (border-height bug). Call `fetchMoreOnBottomReached` from the container's `onScroll` when `scrollHeight - scrollTop - clientHeight < 500 && !isFetching && totalFetched < totalDBRowCount`.

### 4.5 Bulk operations

Vici2's "mass status change" (M03), "push to hopper" (M03), "DNC bulk import" (M06), "recycle leads" (E04), and TCPA export (M08) are bulk operations. These never reuse the paginated browse contract. Pattern:

```
POST /api/admin/leads/bulk    { filter: {...}, action: 'set_status', payload: { status: 'NEW' } }
→ 202 Accepted
   { job_id: 'lj_abc', estimated_rows: 87432, status_url: '/api/admin/jobs/lj_abc' }

Polled or WS-pushed status: progress=0.42, error_count=3
```

Server materializes the matching ID set into a snapshot table or Redis Streams, then a worker chunks through. UI shows a progress toast (sonner) with link to a job-detail page.

---

## 5. Forms + validation

### 5.1 Single source of truth: zod schemas

The Fastify backend (per F05 + downstream module specs) registers routes with `fastify-zod-openapi` (or `fastify-type-provider-zod`). Result: a single zod schema validates the request body, types Fastify's `req.body`, types the response shape, and emits OpenAPI 3.1.

`packages/api-client/codegen.ts` runs in CI/dev: reads `shared/openapi/openapi.yaml`, generates either:
- **Option A (preferred):** Hand-written zod schemas in `packages/api-client/src/schemas.ts` that the OpenAPI is generated *from* (Fastify is source of truth → backend imports the shared schemas → frontend imports the same).
- **Option B:** Generate zod from OpenAPI via hey-api/openapi-ts Zod plugin (works for non-TS backends, less relevant here since both sides are TS).

Recommend **Option A**. The shared zod lives in `packages/api-client/src/schemas.ts`. Fastify imports it for route schemas. Frontend imports it for `react-hook-form` resolvers. One file, two consumers.

### 5.2 React Hook Form pattern

```ts
const form = useForm<z.infer<typeof CampaignCreateSchema>>({
  resolver: zodResolver(CampaignCreateSchema),
  defaultValues: { /* ... */ },
});

const onSubmit = form.handleSubmit(async (values) => {
  await api.campaigns.create(values);     // typed; values are exactly what the server validates
});
```

Use shadcn's `<Form>` + `<FormField>` + `<FormControl>` + `<FormMessage>` adapters so validation errors render uniformly. Re-export from `packages/ui`.

### 5.3 Anti-patterns to avoid

- **Don't** maintain a parallel zod schema in admin-ui — drift = silent compliance bugs (e.g., a campaign saved with `drop_pct=10` because frontend doesn't enforce the 3% TCPA cap).
- **Don't** rely on browser HTML5 validation for compliance fields (call_times, recording consent toggles); always zod.
- **Don't** mass-render 50 react-hook-form fields without `<Controller>` for inputs that aren't spread-friendly (TanStack Table cells, shadcn Select, date picker).

### 5.4 Wizard pattern (M02 campaign create, D02 lead import)

For multi-step forms, keep one root `useForm` with the union schema; gate each step on `form.trigger(['fieldA', 'fieldB'])` to validate just that slice. Don't reset between steps.

---

## 6. CSV upload UX

### 6.1 Why tus

Vicidial-equivalent imports are 50k–500k row CSVs (10–200 MB). Lead imports are valuable, low-frequency operations — they must not lose progress on a Wi-Fi blip or laptop sleep. tus protocol (HTTP-based, resumable, chunked) solves this.

- **Client:** `tus-js-client` v4.x in the upload component; chunkSize 8 MB; retryDelays `[0, 1000, 3000, 5000, 10000]`; metadata includes `filename`, `filetype`, `tenant_id`, `list_id`, `column_map_id`.
- **Server:** `@tus/server` mounted in Fastify under `/api/admin/uploads/leads`. Storage plugin is `@tus/file-store` for local dev, `@tus/s3-store` for prod (chunks land directly in S3/MinIO; D02 worker reads them on completion).
- **Completion hook:** `onUploadFinish` triggers a background job (`leads-import` BullMQ queue) that streams the CSV through `csv-parse`, validates rows against `LeadImportRowSchema` (zod), inserts in batches of 1000, writes errors to a `lead_import_errors` table, and emits WS events to the upload UI.

### 6.2 UX flow

1. **Drop zone (react-dropzone)** — accepts `.csv`, max 1 file, shows file name + size.
2. **Preview + column map** — backend `POST /uploads/leads/peek` reads first 100 rows (no full upload yet), returns inferred columns. UI renders a column-mapping table: each CSV column → either a known `leads.*` field (`phone_e164`, `first_name`, `last_name`, `state`, `email`) or a `custom_data.<key>` slot or `IGNORE`. Map saved server-side as `column_map_id`.
3. **Compliance gate** — checkboxes confirm: (a) you have prior express written consent for these numbers, (b) you have scrubbed against your own internal DNC. Required by C03 + the campaign's policy.
4. **Upload** — tus starts; progress bar bound to `onProgress(bytesUploaded, bytesTotal)`. Pause/resume buttons available.
5. **Processing** — when tus finishes, UI flips to "Processing 87,432 rows" with a poll to `/uploads/leads/:upload_id/status`. WS push preferred.
6. **Result** — counts: imported, skipped (duplicate phone), DNC-rejected, validation-error. Errors downloadable as CSV with row number + reason.

### 6.3 Resumability across sessions

`tus-js-client` stores the upload URL in `localStorage` (Web Storage API). On the next visit, `findPreviousUploads()` recovers in-flight uploads, the user clicks "Resume." This survives accidental tab close and laptop reboots.

### 6.4 Risks

- **Tenant boundary** — the upload URL must encode the tenant; reject any chunk whose tenant doesn't match the JWT's `tid`.
- **CSV size DoS** — cap upload size per role (e.g., admin=500MB, supervisor=N/A).
- **Worker idempotency** — D02 must dedupe on `(list_id, phone_e164)` so a partial re-import doesn't duplicate.

---

## 7. Charts/visualization choice

### 7.1 Comparison

| Library | npm DLs / wk | Bundle (gz) | Chart types | Tailwind/shadcn fit | Best for |
|---|---|---|---|---|---|
| **Tremor** | ~250k | ~70 kB | 6 (line, bar, area, donut, scatter, tracker) + lists/cards | Native | SaaS dashboards, fast-iterate, dark mode default |
| **Recharts v3** | ~2.4M | ~50 kB | 9 | Manual | Custom interactions, reference lines, animations |
| **Nivo** | ~380k | 30–80kB/chart | 30+ (heatmap, sankey, geo) | Manual | Specialty visualizations, Canvas at 100k+ pts |
| **visx** | ~70k | small per pkg | primitives only | Manual | Bespoke chart with full SVG control |
| **Chart.js + react-chartjs-2** | ~1M | ~150 kB + canvas | 8 | Manual | Mature, but Canvas-first and not a pure React API |

### 7.2 Decision

**Primary: Tremor.** Justifications:
- M08 (call summary, agent productivity, drop% TCPA) is exactly the "internal metrics dashboard" use case Tremor was built for.
- Phase 1 Acceptance criterion is "ship reports that look professional" — Tremor's Recharts-based opinionated layer hits that without design budget.
- Built-in dark mode, Tailwind-native, ListTable + MetricCard + Tracker all reusable for the admin home.
- Bundle ~70 kB gzipped is acceptable for admin-only routes (already lazy via Next dynamic import).

**Secondary: Recharts directly.** Whenever Tremor doesn't expose a knob (custom tooltips with lead links, reference lines for the 3% TCPA threshold, brushed time-range zoom on call_log time-series), drop down to raw Recharts. Tremor uses Recharts under the hood, so the data shapes line up.

**Rejected:**
- **Nivo** — overlap with Tremor scope; Canvas variants useful only for the wallboard at >50 agents (defer; if needed in S01, add Nivo Canvas for the agent grid).
- **visx** — too low-level for Phase 1 timeline; adds development time without a clear feature win.
- **Chart.js** — Canvas-first, awkward inside React tree.
- **TanStack Charts** — too new/unstable for a compliance-touching surface.

### 7.3 Specific chart-by-screen mapping

| Screen | Chart |
|---|---|
| Admin home / dashboard | `<BarList>` (today's calls per campaign), `<MetricCard>` (active agents, calls/sec, drop%), `<LineChart>` (last-7-day call volume) |
| Reports → Call Summary (M08) | `<LineChart>` (calls/day per status, stacked), `<DonutChart>` (status breakdown) |
| Reports → Agent Productivity (M08) | `<BarChart>` (per agent calls, talk vs wrap vs pause stacked) |
| Reports → Drop% TCPA (M08) | `<AreaChart>` with **Recharts ReferenceLine at y=3** for the legal cap (Tremor doesn't expose it; drop to Recharts) |
| Wallboard (S01) | `<Tracker>` (per-agent state ribbon), `<MetricCard>` (drop%, calls/sec, hopper depth), `<DonutChart>` (campaign mix) |
| Recording browser (S04) | `<Histogram>` (duration distribution); waveform from wavesurfer, not a chart |

---

## 8. Permission gating pattern

### 8.1 Three layers (defense in depth)

1. **Edge / middleware** (Next.js 14 `middleware.ts`, or `proxy.ts` if we move to Next 16). Reads the auth cookie, decodes JWT (no remote call, public-key verify), checks `user.role`. Redirects unauthenticated to `/`; redirects role-mismatched to `/(agent)/dashboard` or `/(admin)`.
2. **Server-side layout** (`app/(admin)/layout.tsx`). Re-reads `cookies()` and calls `requireRole('admin' | 'supervisor' | 'superadmin')`. If JWT is expired/missing/role-mismatch → `redirect('/')`. Embeds a typed `AdminUser` into the React tree via context.
3. **Client-side `<Can>`** — the CASL `<Can do="manage" on="Campaign">` wrapper hides UI affordances. Backed by an `Ability` instance built from the `/api/auth/me` permissions DTO.

**Rule: every API route also checks.** UI gating is UX, not security. F05's `requireAuth(role)` Fastify middleware is the only thing that matters for trust.

### 8.2 CASL ability shape

```ts
// packages/auth/src/ability.ts
import { defineAbility, Ability } from '@casl/ability';

export type Action =
  | 'manage' | 'create' | 'read' | 'update' | 'delete'
  | 'eavesdrop' | 'whisper' | 'barge'
  | 'export'
  | 'rotate_sip';

export type Subject =
  | 'Campaign' | 'List' | 'Lead'
  | 'Carrier' | 'DID'
  | 'User' | 'UserGroup'
  | 'DNC' | 'Status' | 'PauseCode' | 'Script'
  | 'Recording' | 'Report'
  | 'Wallboard' | 'AgentSession'
  | 'all';

export type AppAbility = Ability<[Action, Subject]>;

export function abilityFromUser(u: MeResponse): AppAbility {
  return defineAbility((can) => {
    if (u.role === 'superadmin') {
      can('manage', 'all');
    } else if (u.role === 'admin') {
      can('manage', ['Campaign','List','Lead','Carrier','DID','User','UserGroup','DNC','Status','PauseCode','Script','Recording','Report']);
      can('read', 'Wallboard');
    } else if (u.role === 'supervisor') {
      can('read', ['Campaign','List','Lead','User','UserGroup','Recording','Report']);
      can(['eavesdrop','whisper','barge'], 'AgentSession');
      can('read', 'Wallboard');
      can(['update','create'], 'Recording'); // flag/tag (S04)
    } else {
      // agent: no admin UI access at all (middleware redirects)
    }
  });
}
```

`/api/auth/me` returns `{ user, permissions: [...] }`; for Phase 1 the `permissions` array is empty and the role drives the ability. Phase 4 we layer fine-grained per-resource grants on top without rewriting the gating layer.

### 8.3 Hook surface

```ts
// packages/auth
export function useAbility(): AppAbility;                                  // returns CASL Ability, re-renders on update
export function useHasPermission(action: Action, subject: Subject): boolean;
export function useRequireRole(role: 'admin' | 'supervisor' | 'superadmin'): void; // throws / redirects
export const Can: ComponentType<CanProps>;                                 // <Can do="..." on="..." />
```

`useRequireRole` for layout-level redirects, `useHasPermission` for inline guards, `<Can>` for declarative element hiding.

### 8.4 Sidebar nav filtered by ability

The sidebar nav config is a constant array of `{ key, label, href, requires: { action, subject } }`. The `<AdminSidebar>` filters on `useAbility().can(item.requires.action, item.requires.subject)` before rendering. This is what guarantees "agent → cannot see Reports link" even if they manually craft a URL (the layout still 403s them; this just hides the affordance).

### 8.5 Failure mode: fail-closed

`abilityFromUser(undefined)` returns an empty Ability. Every component defaults to "no permission." This is critical: a missed `/me` call must not grant access.

---

## 9. Multi-tenant UI

### 9.1 Phase-1 reality

DESIGN.md §4.5 of SPEC.md commits to "tenant_id everywhere from day 1, default 1, single-tenant in Phase 1." So:

- JWT carries `tid`. F05 issues it.
- Every API call carries the tenant implicitly via the JWT.
- No tenant switcher visible in Phase 1 (only one tenant exists).
- `__tenant` cookie not strictly needed yet, but the header injection plumbing is built so Phase 4 flips on cleanly.

### 9.2 Phase-4 design (build now, hide later)

**Tenant switcher in top nav** (super-admin role only):

- Dropdown shows `tenants` the user has access to (returned by `/api/auth/me`).
- Selecting a tenant writes to `__tenant` httpOnly cookie via `POST /api/auth/switch-tenant` (server validates the user is in that tenant, re-signs the JWT with the new `tid`, sets the cookie, returns `{ ok: true }`).
- Client triggers `router.refresh()` so RSC re-renders against new tenant.
- TanStack Query cache is keyed on `tenant_id` (`queryKey: ['campaigns', tenantId, ...]`) so swap is clean.

**URL strategies considered, deferred:**

- Subdomain (`acme.vici2.example`) — requires DNS wildcard + cert provisioning per tenant. Phase 4.
- Path slug (`/(admin)/[tenant]/...`) — clean, but invasive refactor of every M-track route. Phase 4.

For Phase 1–3, no URL change. Keeping the tenant in the cookie + JWT is enough.

### 9.3 Tenant context propagation

```tsx
// apps/admin-ui/app/(admin)/layout.tsx
import { TenantProvider } from '@vici2/auth';

export default async function AdminLayout({ children }) {
  const me = await getMe();              // RSC; reads cookie
  if (!['admin','supervisor','superadmin'].includes(me.role)) redirect('/');
  return (
    <TenantProvider tenant={me.tenant}>
      <AdminSidebar />
      <AdminTopBar user={me} />
      {children}
    </TenantProvider>
  );
}
```

`TenantProvider` exposes `useTenant()` returning `{ id, name, slug, plan }`. Client API calls hit a fetch wrapper in `packages/api-client` that auto-injects `X-Tenant-Id` from `useTenant()` (or just trusts the JWT — both are fine; the header is belt-and-braces for clear logging and audit traces).

### 9.4 What multi-tenant breaks if you forget

- WebSocket channels: must be `t:{tid}:broadcast:wallboard`, never plain `wallboard`.
- TanStack Query keys: must include tenant.
- File uploads: tus metadata `tenant_id` is checked server-side.
- Recordings: signed S3 URLs must encode tenant in path; admin can never request another tenant's recording.

These are mostly backend concerns but the frontend must consistently scope cache keys and channel names.

---

## 10. Open questions for PLAN

1. **One login page or two?** A01 already has `/`. Do admin-ui and agent-ui share a single login page (same origin → cookie shared, but UX coupling) or each have their own (cleaner, but role-detection logic on both)? Recommendation: single login at `vici2.example/login` that role-redirects after auth; both apps' middleware honors the cookie.
2. **Cookie domain.** `Domain=.vici2.example` for cross-subdomain sharing — confirm in F05 PLAN before M01 implementation.
3. **CSRF strategy.** Double-submit token vs origin-check vs `SameSite=Strict`? Current lean: `SameSite=Lax` cookie + double-submit `X-Vici2-CSRF` for mutations.
4. **OpenAPI generation direction.** Source-of-truth = Fastify zod schemas → OpenAPI emit (recommended), or = `shared/openapi/openapi.yaml` → generate zod (alternative). Decide so M01 PLAN can lock the codegen pipeline.
5. **Tremor licensing.** Tremor went through a license shift; confirm current MIT/Apache status of `@tremor/react` at PLAN time. If shifted to a paid tier, fall back to Recharts directly.
6. **TanStack Query v5 vs v4.** Pin one; v5 has the cleaner `placeholderData` + `keepPreviousData` API. Defer to A01's actual pin.
7. **Server Actions vs API routes.** Server Actions tempting for admin mutations (no client fetch boilerplate), but they don't cleanly compose with our typed `api-client`. Recommendation: stick to REST (Fastify) for everything; Next.js API routes only for the auth proxy / health.
8. **Wallboard refresh cadence.** S01 PLAN will pin throttle (16 ms RAF batch) and reconnection (exp backoff to 30s), but M01 must scaffold the WS client hook in `packages/auth` or `packages/api-client` so S01 isn't reinventing.
9. **Recording playback backend.** R03 spec — does the API return a presigned URL or proxy the file? Affects whether `<wavesurfer>` `url` is set to `/api/recordings/:id/audio` (proxy + auth) or directly to S3 (signed URL). M01 doesn't decide, but the player component should be agnostic.
10. **Mobile responsiveness floor.** Module spec says "mobile responsive at 375/768/1280." For grids with 12+ columns, mobile becomes a horizontal-scroll table or a card list. PLAN must specify the breakdown per screen or pick one universal approach.
11. **Empty state library.** shadcn doesn't ship empty states; hand-roll or use a small library like `@nextui/empty`? Likely hand-roll in `packages/ui/src/empty-state.tsx`.
12. **Toast/notification.** sonner is the shadcn-recommended pick; confirm in A01's actual setup.
13. **Date picker.** shadcn ships a Radix + react-day-picker combo. Confirm vs commercial picks.
14. **Audit-log surface.** F05 mentions audit logs for login/SIP rotate. M01 doesn't have its own audit screen, but reports may need an Audit tab — defer to M08 PLAN.

---

## 11. Citations

1. Hunchbite — *Setting Up a Next.js Monorepo with Turborepo: A Production-Ready Guide* (2026). https://hunchbite.com/guides/turborepo-nextjs-monorepo-setup
2. Palakorn Voramongkol — *Monorepo Strategy in 2026: pnpm, Turborepo, Nx, and Friends* (2026-02). https://palakorn.com/blog/monorepo-strategy-pnpm-turbo-nx/
3. PkgPulse — *How to Set Up a Monorepo with Turborepo in 2026* (2026-03). https://www.pkgpulse.com/blog/how-to-set-up-monorepo-turborepo-2026
4. pnpm — *Workspace docs* (2026-04). https://pnpm.io/next/workspaces
5. cpvdeveloper — *nextjs-sharing-code-monorepo* (uses `transpilePackages` for source-only shared packages). https://github.com/cpvdeveloper/nextjs-sharing-code-monorepo
6. TanStack Table — *Virtualization Guide*. https://tanstack.com/table/v8/docs/guide/virtualization
7. TanStack Table — *Virtualized Infinite Scrolling Example* (canonical pattern for cursor + virtualizer + React Query). https://tanstack.com/table/v8/docs/framework/react/examples/virtualized-infinite-scrolling
8. TanStack Table — *Pagination Guide* (`manualPagination`, `rowCount` semantics, when to virtualize vs paginate). https://tanstack.com/table/v8/docs/guide/pagination
9. TanStack Table — *Pagination Controlled Example (server-side)*. https://tanstack.com/table/v8/docs/framework/react/examples/pagination-controlled
10. APIScout — *API Pagination: Cursor vs Offset in 2026* (cursor as production default, never expose `COUNT(*)` by default). https://apiscout.dev/blog/api-pagination-patterns-cursor-vs-offset-2026
11. QCode — *Full Stack Pagination Patterns That Survive Exports, Search, and Admin Tools* (2026-04) — the offset-vs-cursor-vs-snapshot triad applied to admin tools. https://qcode.in/full-stack-pagination-patterns-that-survive-exports-search-and-admin-tools/
12. Finly Insights — *Pagination Strategies: Offset vs Cursor vs Keyset* (2026-03) — the moving-window problem and the offset performance cliff. https://finlyinsights.com/pagination-strategies-offset-vs-cursor-vs-keyset/
13. PkgPulse — *Recharts v3 vs Tremor vs Nivo: React Charts 2026*. https://www.pkgpulse.com/blog/recharts-v3-vs-tremor-vs-nivo-react-charting-2026
14. StarterPick — *Best Analytics Dashboard Boilerplates 2026* (Tremor for SaaS internal metrics). https://starterpick.com/guides/best-boilerplates-analytics-dashboards-2026
15. Tremor — *NPM landing*. https://npm.tremor.so/
16. Eric Howey — *Using Next.js and Tremor for charts, graphs, and data visualization*. https://erichowey.dev/writing/using-nextjs-tremor-for-charts-graphs-data-visualization
17. tus — *tus-js-client usage docs* (resumable, chunked, retry delays). https://github.com/tus/tus-js-client/blob/main/docs/usage.md
18. tus — *tus-node-server* (Fastify integration example via `app.all` + custom content-type parser). https://github.com/tus/tus-node-server
19. zacheryvaughn — *NextJS-TUS* — a production-ready resumable upload reference for Next.js 15. https://github.com/zacheryvaughn/NextJS-TUS
20. drudolf — *fastify-lor-zod* (Fastify type provider for Zod v4 + OpenAPI emit). https://github.com/drudolf/fastify-lor-zod
21. fastify-zod-openapi — npm. https://www.npmjs.com/package/fastify-zod-openapi
22. marcalexiei — *fastify-type-provider-zod examples* (request body validation, response serializer, Swagger transform). https://marcalexiei.github.io/fastify-type-provider-zod/examples.html
23. CASL — *@casl/react* (Can component, useAbility hook, contextual ability binding). https://www.npmjs.com/package/@casl/react
24. Ben Mukebo — *Production-Ready RBAC System in React with CASL* (2026-02) — three-layer enforcement: route guards + sidebar filter + element-level. https://medium.com/@benmukebo/how-i-built-a-production-ready-rbac-system-in-react-with-casl-fd5b16354e3d
25. learnreactui — *Dynamic Policy-Based Access Control in React* (CASL ability rebuilding from server permissions on login). https://learnreactui.dev/contents/ynamic-policy-based-access-control-in-react
26. Next.js Launchpad — *Next.js Multi-Tenant SaaS Guide (2026)* (proxy.ts/middleware tenant resolution, request headers, React `cache()` for per-request resolution). https://nextjslaunchpad.com/article/nextjs-multi-tenant-saas-subdomain-routing-custom-domains-app-router
27. Vidhya Sagar Thakur — *Multi-Tenant Architecture in Next.js: A Complete Blueprint* (2026-02). https://www.vidhyasagarthakur.engineer/blog/multi-tenant-architecture-in-nextjs-a-complete-blueprint
28. Next.js docs — *Multi-tenant guide* (official recommended architecture). https://nextjs.org/docs/app/guides/multi-tenant
29. WebSocket.org — *WebSockets with Next.js: SSR, App Router, and Vercel* (2026-03) — must run a separate WS process; client component + root-layout context provider for cross-route persistence. https://www.websocket.org/guides/frameworks/nextjs/
30. Slashdev — *Next.js Case Study: 10K Users, Real-Time WebSockets* — 10 Hz throttling, diff-not-full-payload pattern. https://slashdev.io/blog/nextjs-case-study-10k-users-real-time-websockets
31. HirendraKurche — *Data-Visualization-Dashboard* — `requestAnimationFrame` batching pattern for high-frequency real-time charts. https://github.com/HirendraKurche/Data-Visualization-Dashboard
32. wavesurfer.js — *docs* (HTML5 audio backend default in v7, pre-decoded peaks for large files, regions plugin for seek/markers). https://wavesurfer-js.org/docs
33. katspaugh — *@wavesurfer/react* (memoized plugins requirement, `useWavesurfer` hook). https://github.com/katspaugh/wavesurfer-react/
34. shadcn/ui — *Dark Mode (Next.js)* — `next-themes` `attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange`. https://v4.shadcn.com/docs/dark-mode/next
35. Tailwind CSS — *Dark Mode core concepts* (`@custom-variant dark` for class-driven dark, three-way toggle + `prefers-color-scheme` matcher). https://tailwindcss.com/docs/dark-mode
36. next-intl — *Setup locale-based routing* and *App Router internationalization*. https://next-intl.dev/docs/routing/setup ; https://next-intl.dev/docs/getting-started/app-router

---

*End of M01 RESEARCH.md. Awaits F01 + F05 unblock before PLAN.*
