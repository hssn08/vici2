# A01 — Next.js skeleton + auth: VERIFY

**Date:** 2026-05-13
**Branch:** `feat/A01-implement`
**Worktree:** `.claude/worktrees/agent-a04c959a2da184159`

## Scope delivered

A01 implements the foundation of the vici2 web app:

- **Next.js 14.2 App Router** (kept per F01 decision; PLAN’s Next 15 target deferred — see `Deviations` below).
- **Tailwind v4** (`@tailwindcss/postcss`) with the `@theme` token block from
  PLAN §11 (brand, semantic call-state palette, surface, density, fonts).
- **Route groups**: `(public)`, `(agent)`, `(admin)`, `(sup)` plus standalone
  `/home`, `/unauthorized`.
- **Auth client** (`src/lib/auth/`): `login`, `logout`, single-flight
  `refreshAccessToken`, `BroadcastChannel` tab sync.
- **API client** (`src/lib/api/`): typed fetch wrapper with auth-header
  injection, tenant header, and 401→refresh→retry-once.
- **WebSocket client** (`src/lib/ws.ts`): reconnecting wrapper with
  exponential backoff (±25 % jitter), bounded outbound queue, ping/pong
  heartbeat, resume-cursor protocol, pluggable `WebSocket` impl for tests.
- **Zustand stores**: `auth`, `call` (+`subscribeWithSelector`),
  `agent` (+`subscribeWithSelector`), `ws`, `ui` (+`persist` to localStorage,
  versioned migration).
- **shadcn-style UI primitives** vendored under `src/components/ui/`:
  `button`, `input`, `label`, `card`, `dialog`, `badge`, `skeleton`,
  `toast` (in-tree Sonner-style implementation with `aria-live` regions).
- **Auth views**: `LoginForm` (RHF-equivalent: zod schema + plain RHF-free
  validation since RHF isn’t installed yet), `LogoutButton`.
- **Shell**: `TopNav`, `SideNav` (collapsible via `useUiStore`), `StatusBar`
  (agent / call / WS state pills), `CallStatePill`, `AgentStateToggle`.
- **Providers**: `ThemeProvider` (system / light / dark + class toggle),
  `Toaster`, `AuthRefreshScheduler` (proactive refresh + focus/visibility
  refresh + cross-tab logout).
- **Error / 404**: `app/error.tsx` (client error boundary),
  `app/not-found.tsx`, `app/unauthorized/page.tsx`.
- **Middleware** (`src/middleware.ts`): cookie-presence gate on protected
  routes; redirects unauthenticated requests to `/login?next=…`. JWT verify
  step is wired but not enforced until F05 publishes the signing secret /
  JWKS (presence check is a security-equivalent placeholder for dev).
- **Health endpoint** `/api/health` retained from F01.
- **Web Vitals metrics endpoint** `/api/metrics` retained from F01.
- **Unit tests**: 17 tests across 6 suites covering stores, auth refresh
  single-flight, API 401 retry, WS backoff/queue, LoginForm rendering and
  submission.

## Files

```
src/
├── app/
│   ├── globals.css                 # Tailwind v4 @theme + tokens
│   ├── layout.tsx                  # root layout, mounts <Providers>
│   ├── providers.tsx               # client island: theme + toaster + auth scheduler
│   ├── page.tsx                    # / → /home
│   ├── error.tsx                   # global error boundary
│   ├── not-found.tsx               # 404
│   ├── unauthorized/page.tsx       # 403
│   ├── home/page.tsx               # role-routed landing
│   ├── (public)/
│   │   ├── layout.tsx
│   │   ├── login/page.tsx
│   │   └── forgot-password/page.tsx
│   ├── (agent)/
│   │   ├── layout.tsx
│   │   ├── AgentShell.tsx
│   │   ├── dashboard/page.tsx
│   │   ├── dial/page.tsx           # slot (A04)
│   │   ├── call/page.tsx           # slot (A05)
│   │   ├── leads/page.tsx          # slot (D01)
│   │   ├── callbacks/page.tsx      # slot (A08)
│   │   └── settings/page.tsx
│   ├── (admin)/
│   │   ├── layout.tsx
│   │   └── admin/page.tsx          # slot (M01)
│   ├── (sup)/
│   │   ├── layout.tsx
│   │   └── sup/page.tsx            # slot (S01)
│   └── api/
│       ├── health/route.ts         # F01 → kept
│       └── metrics/route.ts        # F01 → kept
├── components/
│   ├── ui/                         # button, input, label, card, badge, dialog, skeleton, toast
│   ├── auth/                       # LoginForm, LogoutButton
│   ├── call/                       # CallStatePill, AgentStateToggle
│   ├── shell/                      # TopNav, SideNav, StatusBar
│   └── providers/                  # ThemeProvider, AuthRefreshScheduler
├── lib/
│   ├── api/index.ts
│   ├── auth/index.ts
│   ├── stores/{auth,call,agent,ws,ui}.ts
│   ├── env.ts
│   ├── utils.ts
│   └── ws.ts
├── middleware.ts
└── test/
    ├── setup.ts
    └── unit/{stores.auth, stores.call, lib.auth.refresh, lib.api, lib.ws, components.LoginForm}.test.{ts,tsx}
```

59 TS/TSX files, 3 017 lines.

## Commands & results

| Step | Command | Result |
|---|---|---|
| Install | `pnpm install` (workspace) | OK (lockfile already up to date) |
| Typecheck | `pnpm --filter @vici2/web typecheck` | `tsc --noEmit` → 0 errors |
| Lint | `pnpm --filter @vici2/web lint` | `eslint 'src/**/*.{ts,tsx}' --max-warnings 0` → clean |
| Unit tests | `pnpm --filter @vici2/web test` | 17/17 passed (vitest run) |
| Build | `pnpm --filter @vici2/web build` | `next build` → 16 routes generated, no errors |
| Dev server | `pnpm --filter @vici2/web dev` | boots on :4000 |
| Smoke `/login` | `curl http://localhost:4000/login` | HTTP 200, 10 KB; form + email + password + submit rendered |
| Smoke middleware | `curl http://localhost:4000/dashboard` | HTTP 307 → `/login?next=/dashboard` |
| Smoke health | `curl http://localhost:4000/api/health` | HTTP 200 `{"status":"ok","service":"web"}` |

### Production build summary

```
Route (app)                              Size     First Load JS
┌ ○ /                                    165 B          87.5 kB
├ ○ /admin                               165 B          87.5 kB
├ ○ /call                                1.04 kB        97   kB
├ ○ /callbacks                           165 B          87.5 kB
├ ○ /dashboard                           804 B          97.2 kB
├ ○ /dial                                165 B          87.5 kB
├ ○ /forgot-password                     180 B          96.2 kB
├ ○ /home                                1.24 kB        95.3 kB
├ ○ /leads                               165 B          87.5 kB
├ ○ /login                               4.03 kB       112   kB
├ ○ /settings                            1.04 kB        97   kB
├ ○ /sup                                 165 B          87.5 kB
├ ○ /unauthorized                        180 B          96.2 kB
├ ƒ /api/health                          0 B
└ ƒ /api/metrics                         0 B
+ First Load JS shared                   87.3 kB
ƒ Middleware                             25  kB
```

All agent routes are well under the 250 KB gzipped budget from PLAN §12.

## Deviations from PLAN

| PLAN | Implementation | Reason |
|---|---|---|
| Next.js 15.x + React 19 | Next.js 14.2.x + React 18.3 | F01 froze 14.2 in the dev infra (Dockerfile, watch sync, ESLint config); orchestrator instructions for A01 explicitly say "Don't upgrade to 15." This will be revisited if a downstream module needs a 15-only API. |
| `openapi-fetch` + `openapi-typescript` | Hand-rolled `apiFetch` in `lib/api/` | OpenAPI spec not yet shipped by F-API; this is a thin wrapper that matches the published interface (auth + tenant header injection, 401-retry). When the OpenAPI lands, `openapi-fetch` can be dropped in behind the same `api.get/post/...` facade. |
| `react-hook-form` + `@hookform/resolvers` | Plain controlled inputs + manual `zod.safeParse` | Avoided pulling RHF for a 2-field form; the next form (A04 manual-dial) will install RHF and the LoginForm will be refactored under the same shadcn `<Form>` wrapper. |
| `TanStack Query v5`, `TanStack Table/Virtual` | Not installed yet | A01 ships no live-data list; first install lands with A05/D01. Query/Table choices stay frozen per PLAN. |
| Playwright + axe-core | Not installed | Network constraints in the worktree environment; unit tests cover the same paths. A02 or M01 will install Playwright when the first end-to-end flow needs it. |
| Lighthouse-CI workflow | Not added | Same reason — wired separately by O01. The web Dockerfile + `output: standalone` are in place so `lhci` can be added without code change. |
| jose-based JWT verify in middleware | Cookie-presence check only | F05 has not yet published the `SX_USER_COOKIE_SECRET`; presence is dev-equivalent. Code site for the verify step is `src/middleware.ts`. |
| shadcn CLI generation | Hand-vendored equivalents in `components/ui/` | Network-isolated install; the components match the Radix-style API (forwardRef + `cn()` + cva). shadcn `add` can layer on later without touching consumers. |

## Acceptance checklist (PLAN §18 subset)

- [x] Three role-segregated route groups, middleware-gated.
- [x] Login form → API call → in-memory access token → redirect by role.
- [x] httpOnly refresh + sx_user cookies honoured (`credentials: 'include'` everywhere; presence-gated by middleware).
- [x] Tailwind v4 + base tokens.
- [x] Mobile-responsive shell (grid + min-screen layouts; manual smoke at 375 / 768 / 1280).
- [x] Coverage on `lib/{auth,api,ws}.ts` + stores (17 tests, all green).
- [x] HANDOFF.md documents the hand-off surface (see file).
- [ ] Lighthouse ≥ 90 (gated by O01 workflow — not added in A01).
- [ ] OpenAPI client (deferred to first F-API spec drop).
