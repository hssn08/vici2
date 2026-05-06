# Module A01 — Next.js Skeleton + Auth — PLAN

**Module:** A01 (Agent UI track, Phase 1)
**Author:** A01 PLAN sub-agent
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting human/orchestrator review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 46 citations behind every choice.
**Blocked on (impl):** F05 (Auth API). PLAN itself can proceed; IMPLEMENT waits.

This document turns the A01 spec + RESEARCH findings into the exact stack,
file layout, store boundaries, auth flow, perf budgets, and hand-off
contracts that IMPLEMENT will deliver. **No `.tsx` is produced here**; every
file is described in prose. Once approved, the public interface (route map,
store names, hooks) is FROZEN.

---

## 0. TL;DR (10 bullets)

1. **Stack:** Next.js **15.x** (App Router, RSC), React 19, TypeScript 5.6+
   `strict`, Tailwind **v4**, **shadcn/ui** on Radix primitives, **Zustand**
   (slices + `subscribeWithSelector`; `persist` only on `ui` slice),
   **TanStack Query v5** (server state) + **TanStack Table v8 / Virtual** for
   future lists, **react-hook-form** + **zod** (`zodResolver`), **date-fns
   v4**, **libphonenumber-js** lazy-imported.
2. **Project location:** `web/` at the repo root, exactly as F01 PLAN §2 and
   §3 (`web/Dockerfile`, `develop.watch` on `./web/src`, `PORT=4000`,
   `NEXT_PUBLIC_API_URL=http://localhost:3000`). No monorepo path change. The
   pnpm workspace already lists `web` (F01 PLAN §4.3).
3. **Routes (App Router groups):** `(public)/login`, `(public)/forgot-password`,
   protected `(agent)/{dashboard,dial,call,leads,settings}`, `(admin)/*` and
   `(sup)/*` shells (one placeholder page each so layouts compile), plus
   `middleware.ts` for cookie-based role gating.
4. **RSC/CC split:** layouts + login shell + admin landing = Server
   Components; the entire `(agent)/` subtree is one client island (it owns
   SIP.js, MediaStream, the WebSocket, hotkeys). Lead detail in admin is
   hybrid — SSR initial fetch, CC for live updates.
5. **Auth (custom thin layer, no NextAuth):** access JWT in memory in
   `useAuthStore` (never persisted, never in a JS-readable cookie); refresh
   token in `httpOnly Secure SameSite=Strict` cookie set by F05; a parallel
   `sx_user` HttpOnly cookie carries a slim `{uid, role, exp}` JWT so RSC
   layouts and `middleware.ts` (Edge runtime, `jose.jwtVerify`) can do role
   gating without re-fetching the user.
6. **Single-flight refresh:** one shared in-flight promise dedups concurrent
   401s; proactive background refresh at `iat + 13min`; on refresh failure →
   logout cascade (clear stores → close WS → end SIP UA → push `/login`).
7. **WebSocket wrapper (`lib/ws.ts`, ~150 LOC):** single full-duplex socket
   to the F05/T01 gateway; auth via `?token=<short-TTL ws-scoped JWT>`
   query param; exponential backoff with ±25 % jitter (1 s → 30 s cap);
   25 s ping / 10 s pong-deadline heartbeat; 100-item outbound ring buffer;
   `{op:"resume", from:lastSeq}` cursor on reconnect; instance held in
   `useRef`, events fanned into Zustand stores via subscriber callbacks.
8. **State stores:** `auth`, `call`, `agent`, `ws`, `ui` — five files under
   `web/lib/stores/`. `subscribeWithSelector` middleware on `call` and
   `agent` (event-driven, fine-grained). `persist` middleware **only on
   `ui`** (volume, density, sidebar, last-used dispo). JWTs and SIP creds
   are session-only.
9. **Performance budget (gated in CI):** Lighthouse ≥ 90 (acceptance
   criterion), TTI ≤ 1.5 s on cable, real-time event paint < 100 ms p95
   (instrumented with `performance.mark`/`measure` per RESEARCH §7.3),
   agent route bundle ≤ 250 KB gzipped (tracked with
   `@next/bundle-analyzer`). Lighthouse-CI runs in GitHub Actions; PR
   blocked on regression.
10. **Hand-off:** A02 reuses `(agent)/layout.tsx` providers and exposes
    `useSipPhone()` from `lib/sip/`; A03 reuses `lib/ws.ts` + `useWebSocket()`;
    A04 fills `(agent)/dial/page.tsx`; A05 fills `(agent)/call/page.tsx`;
    A06 plugs into the global `KeyboardListenerProvider`; A07 mounts a
    transfer modal slot in the call panel; A08 fills callbacks page; A09
    plugs into `useAgentStore`. M01 reuses `web/lib/auth.ts`,
    `web/lib/api.ts`, and the shadcn `components/ui/*` set.

**Project path confirmed from F01 PLAN:** `web/` (see F01 PLAN §2 directory
tree, §3 `web` service, §4.3 `pnpm-workspace.yaml`). `PORT=4000`,
`NEXT_PUBLIC_API_URL=http://localhost:3000`, `WATCHPACK_POLLING=true`,
Compose `develop.watch` syncs `./web/src` → `/app/src`.

---

## 1. Stack confirmation

### 1.1 Versions (pinned in `web/package.json`)

| Layer | Pinned | Why (citation in RESEARCH §) |
|---|---|---|
| Next.js | `^15.4.0` (latest 15.x; allow patch range, NOT 16) | §2, RESEARCH [1][2][3] |
| React | `^19.0.0` (peer of Next 15) | §2, RESEARCH [24] |
| TypeScript | `^5.6.3` (matches F01 PLAN §1) | F01 PLAN |
| Tailwind | `^4.0.0` (CSS-first, Oxide engine) | §3.1, RESEARCH [4][5] |
| `@tailwindcss/postcss` | `^4.0.0` | RESEARCH [4] |
| shadcn/ui | CLI `latest` (copy-paste, no runtime dep version) | §3.2, RESEARCH [6][7] |
| Radix primitives | individual `@radix-ui/react-*` per component generated | §3.2 |
| Zustand | `^5.0.0` (slices + `subscribeWithSelector`, `persist`) | §3.3, RESEARCH [8][10] |
| TanStack Query | `^5.59.0` | §3.4, RESEARCH [11][12] |
| TanStack Table | `^8.20.0` (only when first list lands; A01 *installs* dep, no usage yet) | §3.5, RESEARCH [13] |
| TanStack Virtual | `^3.10.0` (same — installed, used downstream) | §3.5, RESEARCH [13] |
| react-hook-form | `^7.53.0` | §3.6, RESEARCH [25] |
| zod | `^3.23.0` | §3.6, RESEARCH [26] |
| `@hookform/resolvers` | `^3.9.0` (zodResolver) | RESEARCH [25] |
| date-fns | `^4.1.0` | §3.7, RESEARCH [27] |
| date-fns-tz | `^3.2.0` (only if locale tz needed) | §3.7 |
| libphonenumber-js | `^1.11.0` (lazy `dynamic()` import, never top-level) | §3.8, RESEARCH [29][30] |
| `jose` | `^5.9.0` (Edge-runtime JWT verify in middleware) | §5.5 |
| `openapi-fetch` | `^0.13.0` (typed REST client over the OpenAPI spec) | §10 Q4, RESEARCH [46] |
| `openapi-typescript` | `^7.4.0` (devDep; generates types) | §10 Q4, RESEARCH [46] |
| Sonner (via shadcn `toast`) | `^1.7.0` | §10 Q6 |
| `@next/bundle-analyzer` | `^15.4.0` | §7.2, RESEARCH [22] |
| `web-vitals` | `^4.2.0` (with `useReportWebVitals`) | RESEARCH [37] |
| Vitest | `^2.1.0` (devDep) | §15 |
| `@testing-library/react` | `^16.0.0` (devDep) | §15 |
| Playwright | `^1.48.0` (devDep) | §15 |
| `@axe-core/playwright` | `^4.10.0` (devDep) | §15, RESEARCH §8.7 |
| `axe-playwright` (alt) | (decision: pick `@axe-core/playwright`, single dep) | — |
| MSW | `^2.4.0` (devDep) | §15 |
| `@lhci/cli` | `^0.14.0` (devDep, used by Lighthouse-CI workflow) | §7.1, RESEARCH [22] |
| ESLint, Prettier, TS-ESLint | inherited from F01 PLAN root config | F01 PLAN §4.7 |

**Pin policy:** caret ranges on minor; exact pin on Next.js patch is OK after
the first stable patch we land on (Renovate PRs handle bumps). Tailwind v4
risk is called out in §17.

### 1.2 TypeScript strictness (decision per RESEARCH §10 Q9)

`web/tsconfig.json` extends `tsconfig.base.json` (F01) and additionally sets:

- `"strict": true`
- `"noUncheckedIndexedAccess": true`
- `"exactOptionalPropertyTypes": true`
- `"noImplicitOverride": true`
- `"noFallthroughCasesInSwitch": true`
- `"forceConsistentCasingInFileNames": true`
- `"verbatimModuleSyntax": true`
- `"moduleResolution": "Bundler"`, `"module": "ESNext"`
- `"jsx": "preserve"`, `"plugins": [{ "name": "next" }]`
- Path alias `"@/*": ["./src/*"]` (Next 15 default with `src/` layout)

### 1.3 Why each rejected option stays rejected

Verbatim per RESEARCH §3 — Next 14 (EOL risk), Next 16 (churn, sync APIs
removed), Mantine (bundle + opinionation), Radix Themes (own DS conflicts
with Tailwind tokens), MUI (Emotion runtime kills TTI), Headless UI
(catalog), Jotai/Valtio/RTK (fit and bundle), SWR (no event-based
invalidation), `partysocket` / `react-use-websocket` (extra abstraction),
NextAuth (no OAuth providers needed), `partysocket` reconnect lib (vestigial
PartyKit vocabulary), Storybook/Ladle (defer per §10 Q10).

---

## 2. Project location (confirmed from F01 PLAN)

`web/` at the repo root, single Next.js app. Confirmation:

- F01 PLAN §2 directory tree shows `web/{package.json, tsconfig.json,
  next.config.mjs, Dockerfile, src/app/{layout.tsx,page.tsx}}`.
- F01 PLAN §3 docker-compose `web` service: `build.context: ./web`,
  `target: dev`, `image: vici2/web:dev`, port `4000:4000`, `NEXT_PUBLIC_API_URL:
  http://localhost:3000`, `WATCHPACK_POLLING: "true"`, `develop.watch` syncs
  `./web/src → /app/src` and rebuilds on `web/package.json`.
- F01 PLAN §4.3 pnpm workspace lists `web` alongside `api`, `workers`,
  `shared/types`.
- F01 PLAN §4.4 root `package.json` declares `pnpm@9.15.0` and Node engine
  `>=20.18.1 <21`.

A01 honors all of those without modification. We do **not** introduce
`apps/agent-ui/` or any other monorepo path. The web app uses the App
Router with a `src/` layout (`web/src/app/...`) — F01 PLAN §2 already
anchors `src/app/` (so the previous A01 spec sketch of `web/app/...` is
updated here to `web/src/app/...` to stay consistent with F01).

---

## 3. App Router routing structure

### 3.1 File tree (under `web/src/`)

```
web/
├── package.json
├── tsconfig.json
├── next.config.mjs                  ← output:'standalone', typedRoutes:true, bundle-analyzer wired
├── postcss.config.mjs               ← @tailwindcss/postcss
├── components.json                  ← shadcn/ui config (style:new-york, rsc:true, tsx:true, alias '@/components')
├── Dockerfile                       ← (F01 owns; A01 only modifies if needed)
├── playwright.config.ts             ← E2E
├── vitest.config.ts                 ← unit
├── lighthouserc.json                ← Lighthouse-CI assertions
├── public/
│   ├── favicon.ico
│   └── logo.svg                     ← placeholder; M01 swaps brand asset
└── src/
    ├── middleware.ts                ← Edge: verify sx_user cookie, role-gate route groups
    ├── app/
    │   ├── layout.tsx               ← Root server layout: <html>, fonts, Providers island
    │   ├── globals.css              ← Tailwind v4 entry: @import "tailwindcss"; @theme; @custom-variant dark
    │   ├── providers.tsx            ← 'use client' — QueryClientProvider, Zustand bootstrap, WSProvider, SipProvider stub, Toaster, KeyboardListenerProvider
    │   ├── error.tsx                ← root error boundary (CC)
    │   ├── not-found.tsx            ← 404 (server)
    │   ├── (public)/
    │   │   ├── layout.tsx           ← server; minimal centered shell
    │   │   ├── login/
    │   │   │   ├── page.tsx         ← server shell; renders <LoginForm/> (CC)
    │   │   │   └── LoginForm.tsx    ← 'use client' — RHF + zod, calls /api/auth/login
    │   │   └── forgot-password/
    │   │       ├── page.tsx
    │   │       └── ForgotForm.tsx
    │   ├── (agent)/
    │   │   ├── layout.tsx           ← server; reads sx_user cookie, renders <AgentShell/> (CC)
    │   │   ├── AgentShell.tsx       ← 'use client'; SIP.js boot stub, WS bootstrap, top nav, status bar
    │   │   ├── dashboard/page.tsx   ← agent home (status, stats, callbacks summary)
    │   │   ├── dial/page.tsx        ← manual-dial slot (A04 fills)
    │   │   ├── call/page.tsx        ← live-call panel slot (A05 fills)
    │   │   ├── leads/page.tsx       ← lead list slot (D01 + table later)
    │   │   ├── callbacks/page.tsx   ← callbacks list slot (A08 fills)
    │   │   └── settings/page.tsx    ← per-agent prefs (volume, hotkeys, audio test)
    │   ├── (admin)/
    │   │   ├── layout.tsx           ← server; M01 expands later
    │   │   └── page.tsx             ← placeholder "Admin — coming soon" so middleware target exists
    │   ├── (sup)/
    │   │   ├── layout.tsx
    │   │   └── page.tsx             ← placeholder; S01 fills wallboard later
    │   └── api/
    │       ├── health/route.ts      ← GET → {status:'ok'}; used by Docker HEALTHCHECK
    │       └── metrics/web/route.ts ← POST sink for useReportWebVitals payloads (forwards to F-API)
    ├── components/
    │   ├── ui/                      ← shadcn-generated primitives (button, card, dialog, …)
    │   ├── auth/
    │   │   ├── LoginForm.tsx        (re-exported by app/(public)/login)
    │   │   └── LogoutButton.tsx
    │   ├── shell/
    │   │   ├── TopNav.tsx
    │   │   ├── SideNav.tsx
    │   │   └── StatusBar.tsx
    │   ├── call/
    │   │   ├── CallStatePill.tsx    ← state-aware pill (idle/ringing/active/wrap)
    │   │   └── AgentStateToggle.tsx ← ready/paused (A09 fleshes)
    │   └── providers/
    │       ├── QueryProvider.tsx
    │       ├── WSProvider.tsx
    │       ├── SipProvider.tsx      ← stub for A02
    │       ├── KeyboardListenerProvider.tsx  ← stub for A06
    │       └── ToasterProvider.tsx
    ├── lib/
    │   ├── env.ts                   ← typed access to NEXT_PUBLIC_*; throws at boot if missing
    │   ├── api.ts                   ← openapi-fetch client + auth header injector + 401 retry
    │   ├── auth.ts                  ← login/logout/refresh; single-flight refresh promise; tab-sync
    │   ├── ws.ts                    ← reconnecting WebSocket wrapper (~150 LOC)
    │   ├── hooks/
    │   │   ├── useWebSocket.ts      ← public hook (state, sendCommand, subscribe)
    │   │   ├── useSession.ts        ← reads useAuthStore + ensures token freshness
    │   │   └── useReportVitals.ts   ← thin wrapper around useReportWebVitals
    │   ├── stores/
    │   │   ├── auth.ts              ← useAuthStore
    │   │   ├── call.ts              ← useCallStore (+ subscribeWithSelector)
    │   │   ├── agent.ts             ← useAgentStore (+ subscribeWithSelector)
    │   │   ├── ws.ts                ← useWsStore
    │   │   └── ui.ts                ← useUiStore (+ persist)
    │   ├── schemas/                 ← zod schemas (login, refresh response, ws envelope)
    │   ├── tab-sync.ts              ← BroadcastChannel('vici2.auth')
    │   └── utils.ts                 ← cn() (clsx + tailwind-merge), small helpers
    ├── styles/                      ← (empty placeholder; tokens live in globals.css @theme)
    └── test/
        ├── unit/
        │   ├── stores.auth.test.ts
        │   ├── stores.call.test.ts
        │   ├── lib.auth.refresh.test.ts
        │   └── lib.ws.reconnect.test.ts
        ├── e2e/
        │   ├── login.spec.ts
        │   ├── route-protection.spec.ts
        │   └── a11y.spec.ts        ← axe-playwright across (public) + (agent) shells
        └── msw/
            └── handlers.ts          ← mock /api/auth/* + /api/agent/* for unit + Playwright dev
```

### 3.2 Notes on the layout

- We keep the `'use client'` boundary deep: only `Providers`, `AgentShell`,
  and the leaf forms/panels are CC. Layouts under `(admin)` and `(sup)`
  remain server components so M01/S01 inherit a clean cacheable shell.
- The two `app/api/` routes are intentional: `health` for the Docker
  HEALTHCHECK F01 wires (`curl -fsS http://localhost:4000/api/health`), and
  `metrics/web` so Web Vitals don't pollute the F-API access logs.
- `LoginForm` lives once in `components/auth/` and is re-rendered from
  `(public)/login/page.tsx` — keeps the test target stable.

---

## 4. RSC vs Client-Component split

Per RESEARCH §6 with one tightening: every interactive island is a *named*
component file (`AgentShell.tsx`, `LoginForm.tsx`) rather than `'use client'`
on the route segment, so server-rendered chrome stays cacheable.

| Route / file | Render | Notes |
|---|---|---|
| `app/layout.tsx` | Server | `<html>`, fonts, `<Providers>` mount |
| `app/providers.tsx` | Client | All providers (Query, WS, SIP-stub, Toaster, Keyboard) |
| `(public)/layout.tsx` | Server | Static centered shell |
| `(public)/login/page.tsx` | Server shell | Renders `<LoginForm/>` (CC) |
| `(public)/login/LoginForm.tsx` | Client | RHF + zod, fetch `/api/auth/login` |
| `(public)/forgot-password/page.tsx` | Server shell + CC form | Same pattern |
| `(agent)/layout.tsx` | Server | Reads `sx_user` cookie, renders `<AgentShell/>` (CC) |
| `(agent)/AgentShell.tsx` | Client | Top nav, side nav, status bar, mounts SIP+WS providers |
| `(agent)/dashboard/page.tsx` | Server with CC widgets | Stats cards SSR, live counters CC |
| `(agent)/dial/page.tsx` | Client | A04 fills; needs phone validation, dialpad |
| `(agent)/call/page.tsx` | Client | A05 fills; entirely CC (MediaStream, timers) |
| `(agent)/leads/page.tsx` | Hybrid | Server fetches first page, CC table for live edits |
| `(agent)/settings/page.tsx` | Client | Audio test, volume slider, hotkey rebind preview |
| `(admin)/layout.tsx` | Server | M01 expands |
| `(admin)/page.tsx` | Server | placeholder |
| `(sup)/layout.tsx` | Server | S01 expands |
| `(sup)/page.tsx` | Server | placeholder |
| `lib/ws.ts`, `lib/sip/*` | Client only | Module side-effects assume `window`, never imported by RSC |

**Pattern:** Server components pass server-fetched data as props to client
islands to avoid duplicate fetches (RESEARCH §6.2). Suspense boundaries are
added on heavier server fetches (lead history) once those modules ship.

---

## 5. Zustand stores

### 5.1 File-by-file contract

All stores live in `web/src/lib/stores/`. Each exports a `useXStore` hook
plus typed `selectors` for hot-path subscriptions.

#### `auth.ts` → `useAuthStore`

State (in memory, **never persisted**):

| Field | Type | Notes |
|---|---|---|
| `accessToken` | `string \| null` | JWT, ~15-min TTL |
| `accessExp` | `number \| null` | Unix sec, used to schedule proactive refresh |
| `user` | `{ id: string; email: string; role: 'agent'\|'admin'\|'sup'; tenantId: number; displayName: string } \| null` | |
| `sipCreds` | `{ wsUri: string; sipUri: string; authUser: string; authPass: string; iceServers: RTCIceServer[] } \| null` | |
| `status` | `'unauthenticated' \| 'authenticated' \| 'refreshing' \| 'logging-out'` | |
| `lastError` | `{ code: string; message: string } \| null` | |

Actions: `login(email, password)`, `logout()`, `setSession(payload)`,
`clearSession()`, `setRefreshing(boolean)`. The actual refresh transport
lives in `lib/auth.ts` (single-flight); the store only mirrors state. No
middleware (no `persist`, no `subscribeWithSelector` — state is consulted by
React render, not by external pushers).

#### `call.ts` → `useCallStore` (+ `subscribeWithSelector`)

| Field | Type | Notes |
|---|---|---|
| `callUuid` | `string \| null` | FreeSWITCH UUID of customer leg |
| `lead` | `Lead \| null` | snapshot at call start (REST) |
| `phase` | `'idle' \| 'ringing' \| 'active' \| 'hold' \| 'wrapup' \| 'transferring'` | |
| `direction` | `'outbound' \| 'inbound' \| null` | |
| `startedAt` | `number \| null` | epoch ms; timer derives from this |
| `muted` | `boolean` | |
| `recording` | `'on' \| 'off' \| 'paused'` | |
| `lastEventSeq` | `number` | for WS resume cursor |

Actions: `setActiveCall(...)`, `endCall(...)`, `setPhase(p)`, `toggleMute()`,
`patchFromEvent(event)`. `subscribeWithSelector` lets `lib/ws.ts` push event
patches without re-rendering subscribers that don't read those fields.

#### `agent.ts` → `useAgentStore` (+ `subscribeWithSelector`)

| Field | Type | Notes |
|---|---|---|
| `status` | `'logged-out' \| 'ready' \| 'paused' \| 'busy' \| 'wrapup'` | |
| `pauseCode` | `string \| null` | M07/A09 |
| `pausedSince` | `number \| null` | epoch ms |
| `currentCampaignId` | `number \| null` | |
| `inboundGroupIds` | `number[]` | |

Actions: `setStatus(s)`, `setPause(code)`, `clearPause()`, `joinCampaign(id)`,
`patchFromEvent(event)`.

#### `ws.ts` → `useWsStore`

| Field | Type | Notes |
|---|---|---|
| `connection` | `'idle' \| 'connecting' \| 'open' \| 'reconnecting' \| 'closed'` | |
| `lastPongAt` | `number \| null` | epoch ms |
| `lastSeq` | `number` | server-assigned monotonically increasing |
| `pendingOutbound` | `number` | size of internal ring buffer (read-only proxy) |

Actions: `setConnection(s)`, `noteSeq(n)`, `noteOutboundSize(n)`. The store
is purely status display; the actual socket lives in `lib/ws.ts` `useRef`.

#### `ui.ts` → `useUiStore` (+ `persist` to `localStorage`, key `vici2.ui`)

| Field | Type | Persisted | Notes |
|---|---|---|---|
| `sidebarCollapsed` | `boolean` | yes | |
| `theme` | `'system' \| 'light' \| 'dark'` | yes | applied via `class="dark"` on `<html>` |
| `density` | `'comfortable' \| 'compact'` | yes | shadcn variant gate |
| `volume` | `number` (0–1) | yes | ringtone + bridged audio gain |
| `lastUsedDispoCode` | `string \| null` | yes | A06 quality-of-life |

`persist` migration version starts at `1`. We define a `migrate` callback
even if empty so future shape changes don't blow up old localStorage.

### 5.2 Why the split

Five small slices > one giant store: each subscriber reads narrowly, the
SIP wrapper writes to `call`, the WS wrapper writes to `call`+`agent`+`ws`,
the API client writes to `auth`. `subscribeWithSelector` is added only
where external (non-React) code is the writer (`call`, `agent`).

### 5.3 What is **not** in any store

JWT access token is in `auth.ts` (in memory). SIP creds are in `auth.ts`
(in memory). Refresh token never touches JS — it's an HttpOnly cookie. No
PII goes to localStorage.

---

## 6. WebSocket client wrapper (`lib/ws.ts`)

### 6.1 Surface (~150 LOC)

```
// Public API (described, not coded):
export type WsConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';
export interface WsCommand<T = unknown> { op: string; payload?: T }
export interface WsEvent<T = unknown> { type: string; seq: number; ts: number; data: T }

export function useWebSocket(): {
  state: WsConnectionState;
  sendCommand: (cmd: WsCommand) => void;          // queues if not open
  subscribe: <T>(eventType: string, handler: (e: WsEvent<T>) => void) => () => void; // returns unsubscribe
};

// Internal singleton manager (module-scoped, instantiated by WSProvider):
//  - WebSocket instance held in a useRef inside WSProvider.
//  - On open: send {op:'resume', from:lastSeq} if lastSeq>0; otherwise {op:'subscribe', channels:[…]}.
//  - On message: parse JSON, validate via zod schema (lib/schemas/ws.ts),
//    update useWsStore.lastSeq, dispatch to registered subscribers.
//    Also call store.patchFromEvent for built-in event types (call_*, agent_*).
//  - Heartbeat: setInterval 25 000 ms → sendCommand({op:'ping'}). On pong update lastPongAt.
//    Watchdog: setInterval 5 000 ms → if Date.now() - lastPongAt > 35 000 ms → close → reconnect.
//  - Reconnect: exponential backoff min(1000 * 2^attempt, 30000) ± 25% jitter; capped at 30 s.
//  - Outbound queue: bounded ring buffer of 100 commands; drop oldest with warn log on overflow.
```

### 6.2 Auth and URL

- URL constructed from `NEXT_PUBLIC_API_URL` → swap protocol to `ws`/`wss`
  → append path `/ws`. Configurable separately via `NEXT_PUBLIC_WS_URL` for
  the rare case the WS gateway lives at a different host (T01 may colocate
  or split).
- Auth token is the **WS-scoped JWT** issued by F05 at login (separate from
  the API access token: `aud=ws`, ~15-min TTL). Passed as
  `?token=<jwt>` on the initial WebSocket open. Per RESEARCH §4.3 the
  `Sec-WebSocket-Protocol` subprotocol approach mentioned in the brief is
  rejected in favor of the query-param approach because Fastify's
  `@fastify/websocket` reads query params trivially and the brief's
  `vici2.jwt.<token>` subprotocol form is non-standard for Sec-WebSocket-Protocol
  values that contain `.` and `<>` characters. We use `?token=`. Decision
  recorded here for T01 to honor.

### 6.3 Refresh-rotation race coordination (per §17 risk)

When `lib/auth.ts` rotates the access JWT, it also asks F05 for a fresh
ws-scoped JWT in the same response (`/api/auth/refresh` returns
`{access_token, ws_token, sx_user_set:true}`). On rotation:

1. `useAuthStore.setSession(...)` is called.
2. `WSProvider` listens via `useAuthStore.subscribe(s => s.accessToken)`;
   when token changes, schedule a **graceful** WS rotation: send
   `{op:'auth-rotate', token: newWsToken}` (T01 honors and ack-rotates
   without dropping the connection). If gateway returns
   `{op:'auth-rotate-failed'}` (e.g., gateway predates the op), close the
   socket; the reconnect loop opens a new one with the new token in the
   query string. Either way, no missed events because of the resume cursor.

### 6.4 Why custom (decision)

Per RESEARCH §4.2 — `partysocket` carries vestigial vocabulary,
`react-use-websocket` adds hidden state, `reconnecting-websocket` doesn't
help with React lifecycles. Custom is ~150 LOC, fully testable in Vitest
with a mocked `WebSocket` global, and integrates directly with our stores.

### 6.5 SSE rejected (per RESEARCH §4.4)

One-way; doesn't multiplex client→server commands; doesn't HTTP/2-Upgrade
cleanly behind nginx. Stick with WS.

---

## 7. Auth integration (`lib/auth.ts`)

### 7.1 Token strategy (decision per RESEARCH §5.2 and §10 Q1)

- **Access JWT (15-min TTL):** in `useAuthStore.accessToken` (memory only).
  Sent as `Authorization: Bearer <token>` on every REST call by the
  `lib/api.ts` interceptor.
- **Refresh token (opaque, 30-day TTL, F05 Redis-backed):** in
  `httpOnly Secure SameSite=Strict` cookie set by F05 on `/api/auth/login`.
  Cookie path `/api/auth`. Browser JS cannot read it.
- **`sx_user` cookie (slim signed JWT, 15-min TTL, refreshed alongside
  access):** in `httpOnly Secure SameSite=Strict` cookie set by F05.
  Payload: `{ sub: userId, role, tenantId, exp }`. Path `/`. Read by
  `middleware.ts` (Edge, `jose.jwtVerify`) and `(agent)/layout.tsx`
  (server-side `cookies()`). Decision: this is a **separate** signed JWT
  signed with `SX_USER_COOKIE_SECRET` (HMAC HS256), **not** the access
  token verbatim — the access token is for API auth, the slim cookie is
  for SSR identity. Different audiences (`aud=ssr`), different rotation
  granularity, smaller payload (no email/displayName).
- **WS-scoped JWT (`aud=ws`, 15-min TTL):** returned in login + refresh
  response body alongside `access_token`. Held in `useAuthStore.wsToken`
  (memory only). Used by `lib/ws.ts` only.
- **SIP creds (`sipCreds`):** returned in login response body once. Held in
  `useAuthStore.sipCreds` in memory. Re-fetched on tab restore via
  `GET /api/auth/me?include=sip_creds` if `sipCreds === null` after a
  hydration. Never persisted.

### 7.2 Single-flight refresh

Module-scoped `let refreshInFlight: Promise<RefreshResult> | null`. On 401
the API client calls `refreshAccessToken()`; if a refresh is in flight, the
caller awaits the same promise. On success, retry the original request
once. On failure, `useAuthStore.clearSession()` + close WS + end SIP UA
(stub callback that A02 wires) + `router.push('/login?reason=expired')`.

`RefreshResult = { access_token, access_exp, ws_token, ws_exp }`. Backend
also rotates the `sx_user` cookie via Set-Cookie on the same response.

### 7.3 Proactive refresh

In `WSProvider` (or a sibling `AuthRefreshScheduler` CC mounted in
`Providers`), schedule a `setTimeout` for `accessExp - 120 s` (== 13 min
after issuance for a 15-min TTL). On fire, call `refreshAccessToken()`. On
window focus + visibility change, also opportunistically refresh if exp <
60 s away. On `online` event after offline, refresh immediately.

### 7.4 Login + redirect flow (decision per RESEARCH §5.4)

```
1. Browser GET /login                          ← server-rendered shell
2. User submits LoginForm
   → fetch('/api/auth/login', {credentials:'include'}) with {email, password}
   → F05 sets refresh cookie + sx_user cookie, returns
     {access_token, access_exp, ws_token, ws_exp, sip_creds, user}
3. useAuthStore.setSession(...) puts everything in memory
4. router.push by role:
     agent → /dashboard       (under (agent) group)
     admin → /admin           (under (admin) group)
     sup   → /sup             (under (sup) group)
5. Target layout is a Server Component; it reads sx_user via cookies(),
   verifies with jose.jwtVerify (SX_USER_COOKIE_SECRET), and renders.
   The CC island then re-hydrates with useAuthStore (already populated
   in step 3).
```

If a tab is opened directly to `/dashboard` (no in-memory session), the
server layout still has `sx_user` and renders, but the CC island sees
`useAuthStore.accessToken === null` and immediately calls
`refreshAccessToken()` to recover the access + ws tokens + sip creds via
`GET /api/auth/me?include=sip_creds`. While that resolves, the call panel
shows a "Reconnecting…" skeleton.

### 7.5 `middleware.ts` (Edge runtime, decision per §10 Q3)

Stays on the Edge runtime. `jose.jwtVerify` is Edge-compatible and we want
the cold-start win. Logic:

- Match: every path except `/_next/*`, `/favicon.ico`, `/api/health`,
  `/api/auth/*`, `/login`, `/forgot-password`.
- Read `sx_user` cookie. If absent or `jose.jwtVerify` rejects →
  `Response.redirect(new URL('/login?next=' + pathname, req.url))`.
- If role is `agent` and path starts with `/(admin)/` → redirect to
  `/dashboard`. Same for `sup` ↔ `admin` mismatches. Mismatches are 302
  redirects, not 403s — keeps deep-link UX kind. (RBAC fine-grain stays in
  F05 backend per A01 spec.)
- Set `x-vici2-user` header for downstream RSC to read via
  `headers().get(...)` if it wants the verified principal without
  re-verifying.

### 7.6 Logout

`POST /api/auth/logout` with `credentials: 'include'` → F05 revokes refresh
token, clears all three cookies. Client: `useAuthStore.clearSession()`,
close WS, call SIP `unregister()` (callback registered by A02; A01 ships a
no-op default), broadcast `{event:'logout'}` on `BroadcastChannel('vici2.auth')`,
`router.replace('/login')`.

### 7.7 Tab sync

`lib/tab-sync.ts` exports `authChannel: BroadcastChannel`. Login pushes
`{event:'login', userId}`; logout pushes `{event:'logout'}`. Subscribers
in `Providers` reset state and force navigation. Fallback to
`window.addEventListener('storage', ...)` on a sentinel `localStorage`
key for browsers without BroadcastChannel (vanishingly rare in our
target Chromium-on-Linux baseline, but defensive code is cheap).

---

## 8. API client (`lib/api.ts`)

- Uses `openapi-fetch` against types generated from
  `shared/openapi/openapi.yaml` (OpenAPI is owned downstream; A01 ships
  with a stub OpenAPI committed by F01 PLAN §2 + types regenerated on
  build via `pnpm run gen:api`).
- `createClient<paths>({ baseUrl: env.NEXT_PUBLIC_API_URL })` once,
  exported as `api`.
- Middleware (`api.use({ onRequest, onResponse })`):
  - `onRequest`: read `useAuthStore.getState().accessToken` and set
    `Authorization: Bearer ...`. Always set
    `X-Vici2-Tenant: <tenantId>` (from store).
  - `onResponse`: if status === 401 and request did not already include
    `X-Vici2-Retried: 1` header → call `refreshAccessToken()` → retry
    once with the new token. If the retry also 401s → trigger logout
    cascade.
  - `onResponse`: parse `error.code` per SPEC.md §3.5 contract; throw
    typed `ApiError` (`{ code, message, status, details? }`).
- Retry policy: only safe methods (GET) on **network** errors (not on
  HTTP errors). 3 retries with exponential backoff (200 ms, 600 ms,
  1800 ms) + jitter. Mutations never auto-retry — caller decides.
- Type-safety: every endpoint typed via OpenAPI types. Manual zod
  schemas only for things the OpenAPI doesn't yet describe (login
  response, ws envelope) and live in `lib/schemas/`.

---

## 9. TanStack Query setup

- `QueryClient` instantiated once in `QueryProvider`:
  - `defaultOptions.queries.staleTime = 30_000` (30 s)
  - `defaultOptions.queries.gcTime = 5 * 60_000` (5 min)
  - `defaultOptions.queries.refetchOnWindowFocus = true`
  - `defaultOptions.queries.retry = 1` (most failures are auth or 5xx; we
    don't want long retry storms)
  - `defaultOptions.mutations.retry = 0`
- Hook conventions:
  - One file per feature (`web/src/lib/queries/<feature>.ts`).
  - Export `useXQuery`, `useCreateXMutation`, etc.
  - Query keys: `['<feature>', ...args]`, e.g., `['lead', leadId]`.
- Optimistic patterns established for downstream:
  - `useMutation({ onMutate, onError, onSettled })` rolling back to a
    snapshot.
  - For React-19 `useOptimistic` paths (mute, dispo): per RESEARCH §4.5,
    pair `useOptimistic` with the REST mutation; reconcile with the WS
    confirmation event.
- Invalidation patterns documented in HANDOFF (after dispo POST →
  `qc.invalidateQueries({ queryKey: ['lead', leadId] })` and
  `['callbacks']` if a callback was scheduled). A01 only ships the
  `QueryClient` and one example query (`useMeQuery`) so that A02+ can
  copy the pattern.
- Devtools: `@tanstack/react-query-devtools` mounted only when
  `process.env.NODE_ENV === 'development'`.

---

## 10. shadcn/ui setup

### 10.1 `components.json`

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "new-york",
  "rsc": true,
  "tsx": true,
  "tailwind": {
    "config": "",
    "css": "src/app/globals.css",
    "baseColor": "slate",
    "cssVariables": true,
    "prefix": ""
  },
  "aliases": {
    "components": "@/components",
    "utils": "@/lib/utils",
    "ui": "@/components/ui",
    "lib": "@/lib",
    "hooks": "@/lib/hooks"
  },
  "iconLibrary": "lucide"
}
```

(Tailwind v4 doesn't use `tailwind.config.ts`; the empty `config: ""` is
the v4-correct value per shadcn's v4 support.)

### 10.2 Initial component set (one shadcn `add` per name)

Phase-1 acceptance: A01 generates `button`, `card`, `dialog`, `input`,
`label`, `separator`, `sheet`, `sonner` (toast), `tooltip`,
`dropdown-menu`, `badge`, `scroll-area`, `form` (RHF wrapper),
`skeleton`, `tabs`, `select`, `command` (for hotkey palette later).
This is deliberately a **superset** of what login + agent shell needs
so that downstream A* modules don't keep adding shadcn primitives one
PR at a time (the file diffs are noisy and each `add` re-templates
adjacent files).

### 10.3 Custom components shipped in A01

- `components/call/CallStatePill.tsx` — variant-aware status pill (idle /
  ringing / active / hold / wrap / dispatching). Uses Tailwind tokens
  `bg-state-*` / `text-state-*` from §11.
- `components/call/AgentStateToggle.tsx` — ready/paused toggle with code
  picker placeholder (A09 fills the picker; A01 ships the toggle).
- `components/auth/LoginForm.tsx` — RHF + zod, shadcn `<Form>` wrapper.
- `components/auth/LogoutButton.tsx`.
- `components/shell/{TopNav,SideNav,StatusBar}.tsx` — agent shell chrome.

---

## 11. Tailwind v4 setup

### 11.1 `app/globals.css`

```css
@import "tailwindcss";

@custom-variant dark (&:where(.dark, .dark *));

@theme {
  /* brand */
  --color-brand-50:  oklch(98% 0.02 245);
  --color-brand-500: oklch(60% 0.18 245);
  --color-brand-600: oklch(54% 0.18 245);
  --color-brand-700: oklch(48% 0.16 245);

  /* semantic call-state palette (decision per §10 Q2) */
  --color-state-idle:        oklch(80% 0 0);          /* neutral grey */
  --color-state-ringing:     oklch(75% 0.18 90);      /* amber */
  --color-state-active:      oklch(68% 0.18 145);     /* green */
  --color-state-hold:        oklch(75% 0.10 50);      /* warm tan */
  --color-state-wrap:        oklch(70% 0.18 280);     /* indigo */
  --color-state-dispo:       oklch(70% 0.20 30);      /* orange */
  --color-state-transfer:    oklch(72% 0.16 200);     /* teal */
  --color-state-error:       oklch(60% 0.22 25);      /* red */

  /* density & layout tokens */
  --spacing-call-pill-y: 0.25rem;
  --spacing-call-pill-x: 0.625rem;
  --radius-pill: 9999px;

  /* typography */
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, monospace;
}

/* Optional: small @keyframes block for ringing pulse + dispo bounce
   (decision per §10 Q8: keep call-state animations as utility classes
   that reference @keyframes here, not inline styles). */
@keyframes ringing-pulse {
  0%, 100% { box-shadow: 0 0 0 0 var(--color-state-ringing); }
  50%      { box-shadow: 0 0 0 8px transparent; }
}
@keyframes dispo-bounce {
  0%, 100% { transform: translateY(0); }
  50%      { transform: translateY(-2px); }
}

@layer utilities {
  .animate-ringing-pulse { animation: ringing-pulse 1.4s ease-in-out infinite; }
  .animate-dispo-bounce  { animation: dispo-bounce 1s ease-in-out infinite; }
}
```

### 11.2 Dark mode

`@custom-variant dark (.dark &)` plus a `data-theme` attribute on `<html>`
managed by `useUiStore.theme`. System preference detected via
`window.matchMedia('(prefers-color-scheme: dark)')` on first paint; user
override persists.

### 11.3 PostCSS

`postcss.config.mjs` imports `@tailwindcss/postcss` only — Lightning CSS
handles autoprefixing and `@import` resolution per RESEARCH §3.1, so we
drop `autoprefixer` and `postcss-import` from the dep tree.

---

## 12. Performance budget enforcement

| Budget | Mechanism | Where enforced |
|---|---|---|
| Lighthouse ≥ 90 | `@lhci/cli` against built `next start` server | GitHub Actions job; PR-blocking |
| TTI ≤ 1.5 s on cable | Lighthouse-CI assertion | Same workflow |
| LCP ≤ 1.5 s | `useReportWebVitals` → `/api/metrics/web` | Production telemetry; alert if p95 regresses |
| INP ≤ 200 ms | Web Vitals report | Same |
| Real-time event paint < 100 ms p95 | `performance.mark('ws:<type>')` on receive + `performance.measure(...)` in a `useLayoutEffect` on the consuming component → reported via Web Vitals sink | Dev + prod telemetry |
| Agent route bundle ≤ 250 KB gzipped | `@next/bundle-analyzer` (run via `ANALYZE=1 pnpm build`) and a `pnpm bundlesize` check | CI job using `size-limit` or a custom script that `du`s the route chunk |
| `libphonenumber-js`, `audio-recorder-ui`, `tanstack-virtual` lazy-loaded | `next/dynamic(() => import(...), { ssr: false })` for browser-only modules | Verified by inspecting the manual-dial chunk in bundle analyzer report |
| Use `startTransition` for non-urgent state updates (counters in status bar) | Pattern shipped in A01 `StatusBar.tsx` | — |
| Use `useDeferredValue` for typeaheads | Pattern documented in HANDOFF; no typeahead in A01 itself | — |

`next.config.mjs`:

```js
import bundleAnalyzer from '@next/bundle-analyzer';
const withAnalyzer = bundleAnalyzer({ enabled: process.env.ANALYZE === '1' });
export default withAnalyzer({
  output: 'standalone',
  reactStrictMode: true,
  experimental: { typedRoutes: true },
  poweredByHeader: false,
  compress: true,
});
```

---

## 13. Accessibility plan

Per RESEARCH §8. A01 commits the foundation:

- `aria-live="assertive"` `role="alert"` for the incoming-call toast (region
  rendered by `Providers` so all routes share it). The text is set
  imperatively via Sonner; it carries `caller_id_e164` and `caller_id_name`.
- `aria-live="polite"` for dispo-required announcement (set when phase
  transitions to `wrapup`).
- Call timer **not** a live region — use a `<time>` element with
  `aria-label="Call duration"` so screen readers can read it on demand.
- Icon-only buttons: `aria-label` mandatory; lint rule
  `jsx-a11y/no-icon-only-button` (custom) added to ESLint config.
- Toggle buttons use `aria-pressed`. Disabled buttons use `aria-disabled`
  not `disabled`, so they remain focusable + announce reason.
- Tailwind class baseline: every interactive element gets `focus-visible:
  ring-2 ring-brand-500 ring-offset-2 outline-none`.
- Keyboard: `KeyboardListenerProvider` (stub for A06) registers global
  listeners that **do not** preventDefault unless the user is in an
  agent-control context (avoid stealing native browser shortcuts and
  screen-reader keys).
- Color: never sole conveyance of state — pair color with icon + label
  (e.g., muted = slashed-mic icon + "Muted" badge + state color).
- Forms: shadcn `<Form>` already wires `aria-invalid` + `aria-describedby`.
- WebRTC autoplay: handled by A02; A01 ships a defensive "Click to enable
  audio" overlay component (`components/shell/AudioGate.tsx`) used if
  `audio.play()` rejects.
- Tests: `@axe-core/playwright` runs `injectAxe(page)` + `checkA11y(page)`
  in `test/e2e/a11y.spec.ts` against `/login` and `/dashboard`. PR fails on
  any AA violation.

---

## 14. Build / deploy

### 14.1 `next.config.mjs`

`output: 'standalone'` (already shown in §12). With this:
- Build emits `.next/standalone/server.js` + a pruned `node_modules` and
  `.next/static`.
- F01's `web/Dockerfile` (multi-stage) becomes a thin runner stage:
  - `FROM node:20.18.1-alpine AS runner`
  - `COPY --from=builder /app/.next/standalone ./`
  - `COPY --from=builder /app/.next/static ./.next/static`
  - `COPY --from=builder /app/public ./public`
  - `USER nextjs (uid 1001)`
  - `EXPOSE 4000`
  - `ENV PORT=4000`
  - `HEALTHCHECK CMD wget -qO- http://localhost:4000/api/health || exit 1`
  - `CMD ["node", "server.js"]`
- Final image target: ~150–200 MB (RESEARCH §9.1; F01 PLAN §6 risk note
  about "image <500 MB except FreeSWITCH" comfortably met).

### 14.2 Health check

`/api/health` route handler returns
`{ status: 'ok', service: 'web', commit: process.env.GIT_COMMIT, ts: Date.now() }`
with `Cache-Control: no-store`. Used by Docker HEALTHCHECK and by O01
Prometheus blackbox exporter.

### 14.3 Web Vitals sink

`/api/metrics/web` route handler accepts a `web-vitals` payload (POST
JSON) and forwards to F-API `POST /api/metrics/web` with
`X-Forwarded-For` set. Rate-limited (Next 15 supports basic
middleware-level limiting; we fall back to a per-IP Redis limit in F-API
when that's wired). For A01 acceptance, the route just logs and returns
204 — actual forwarding lands when O01 ships.

### 14.4 Env strategy (per F01 PLAN §4.1)

Public env vars (`NEXT_PUBLIC_*`), accessed via `lib/env.ts`:
- `NEXT_PUBLIC_API_URL` (= `http://localhost:3000` in dev; F01 PLAN §3 sets
  this on the `web` service)
- `NEXT_PUBLIC_WS_URL` (defaults to derived from API URL; overridable)
- `NEXT_PUBLIC_FS_WSS` (SIP WSS endpoint for SIP.js — A02 consumes; A01
  declares the var)
- `NEXT_PUBLIC_TELEMETRY_ENDPOINT` (= `/api/metrics/web` by default)

Private env vars (Edge runtime + Node):
- `SX_USER_COOKIE_SECRET` (32+ random bytes base64; HMAC for the slim
  cookie verification). F05 owns minting; A01's `middleware.ts` only
  verifies. F01 PLAN `.env.example` adds this var (call-out for F01 to add
  in their next iteration; if F01 PLAN is already merged, A01 IMPLEMENT
  ships a `.env.example` patch).

`lib/env.ts` validates all of the above with zod at module load, so a
misconfigured env crashes the server at boot rather than at first request.

---

## 15. Testing

### 15.1 Unit (Vitest + RTL + jsdom)

- `test/unit/stores.auth.test.ts` — login/logout/clearSession state transitions.
- `test/unit/stores.call.test.ts` — `patchFromEvent` reducers, `subscribeWithSelector` fanout (via mocked subscriber).
- `test/unit/lib.auth.refresh.test.ts` — single-flight promise dedups
  concurrent refreshes; failure clears session.
- `test/unit/lib.ws.reconnect.test.ts` — backoff schedule (with fake
  timers), heartbeat watchdog, queue overflow drops oldest.
- `test/unit/lib.api.401.test.ts` — 401 → refresh → retry happy path; second 401 → logout.

Coverage target: ≥ 70% on `lib/auth.ts`, `lib/api.ts`, `lib/ws.ts`, and all
stores (per SPEC.md §3.10).

### 15.2 E2E (Playwright)

- `test/e2e/login.spec.ts` — submits credentials (MSW mocks `/api/auth/login`),
  asserts redirect to `/dashboard`, asserts cookie `sx_user` is set.
- `test/e2e/route-protection.spec.ts` — accessing `/admin` as agent
  redirects to `/dashboard`; accessing `/dashboard` unauthenticated
  redirects to `/login?next=/dashboard`.
- `test/e2e/refresh.spec.ts` — wait past mocked 13-min mark, observe
  refresh request is fired, no user-visible interruption.
- `test/e2e/a11y.spec.ts` — `injectAxe` + `checkA11y` against `/login`,
  `/dashboard`, `/settings`. Zero AA violations gate.
- `test/e2e/logout.spec.ts` — logout clears stores, navigates to `/login`,
  second tab observes via BroadcastChannel.

### 15.3 MSW

`test/msw/handlers.ts` mocks `/api/auth/login`, `/api/auth/refresh`,
`/api/auth/logout`, `/api/auth/me`. Used by both Vitest (via
`setupServer`) and Playwright (via `page.route(...)` shim that pipes to
the same handler array).

### 15.4 Lighthouse CI

`lighthouserc.json` asserts:
```
{
  "ci": {
    "collect": { "url": ["http://localhost:4000/login", "http://localhost:4000/dashboard"], "numberOfRuns": 3 },
    "assert": { "preset": "lighthouse:recommended",
                "assertions": {
                  "categories:performance": ["error", {"minScore": 0.9}],
                  "categories:accessibility": ["error", {"minScore": 0.9}],
                  "largest-contentful-paint": ["error", {"maxNumericValue": 2000}],
                  "interactive": ["error", {"maxNumericValue": 2000}]
                } }
  }
}
```

GitHub Actions: a `lhci.yml` workflow builds the standalone image, runs
`next start` against MSW, then `lhci autorun`. PR-blocking.

### 15.5 Storybook / Ladle

**Skipped for A01** per RESEARCH §10 Q10. Revisit if shadcn-derived
components grow beyond ~25 in count.

---

## 16. Hand-off interface (to other modules)

| Downstream | What A01 hands off | Where |
|---|---|---|
| **A02 SIP.js** | `(agent)/AgentShell.tsx` mounts `<SipProvider/>`; `SipProvider` is a stub today, A02 fills with SIP.js SimpleUser. Exposes `useSipPhone()` from `lib/sip/`. `useAuthStore.sipCreds` already populated by login. | `components/providers/SipProvider.tsx`, `lib/sip/index.ts` (placeholder) |
| **A03 WebSocket** | `lib/ws.ts` wrapper + `useWebSocket()` hook reused as-is. A03 just adds typed event handlers and protocol versioning. `useWsStore` already tracks state. | `lib/ws.ts`, `lib/hooks/useWebSocket.ts`, `lib/stores/ws.ts` |
| **A04 Manual dial** | `(agent)/dial/page.tsx` slot exists; A04 fills with form. Pattern: lazy `dynamic()` import of `libphonenumber-js`, RHF + zod, POST `/api/agent/originate` via `lib/api.ts`. | `app/(agent)/dial/page.tsx` |
| **A05 Live call panel** | `(agent)/call/page.tsx` slot + `CallStatePill` + `useCallStore`. A05 builds the actual panel, lead info, controls. | `app/(agent)/call/page.tsx`, `components/call/*` |
| **A06 Dispo + hotkeys** | `KeyboardListenerProvider` slot already mounted in `Providers`. A06 registers handlers via `provider.register({ key, scope, handler })` API. `useUiStore.lastUsedDispoCode` reserved. | `components/providers/KeyboardListenerProvider.tsx` |
| **A07 Transfers** | UI slot in call panel; WS command pattern (`sendCommand({op:'transfer', ...})`) via `useWebSocket()`; REST originate via `lib/api.ts`. | — |
| **A08 Callbacks** | `(agent)/callbacks/page.tsx` slot. TanStack Query pattern in `lib/queries/callbacks.ts` (A08 creates the file). | `app/(agent)/callbacks/page.tsx` |
| **A09 Pause codes** | `AgentStateToggle.tsx` ships in A01 with no-op picker. A09 fills the `<PauseCodePicker/>` slot and wires `useAgentStore.setPause`. | `components/call/AgentStateToggle.tsx` |
| **M01 Admin UI** | Reuses `lib/auth.ts`, `lib/api.ts`, `components/ui/*`, `lib/stores/{auth,ui}.ts`, `middleware.ts` role gating, `(admin)/layout.tsx` slot. M01 expands `(admin)/*` route tree. | `app/(admin)/*`, `lib/*` |
| **S01 Wallboard** | Reuses `lib/ws.ts`, `(sup)/layout.tsx` slot. | `app/(sup)/*` |

`HANDOFF.md` (written in HANDOFF phase, not now) will detail each
contract: env var names, hook signatures, store field names, ws event
shapes the wrapper expects.

---

## 17. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Tailwind v4 stability for a Q2-2026 build | Low–Med | Med | Pin to a known-good patch (v4.0.x latest at IMPLEMENT time); revert path to v3.4.x exists (the codemod is reversible because we use only `@theme` + utilities; no v4-only features like container queries via `@container` mid-stream). RFC-002 trigger if v4 churn appears. |
| Next.js 15 App Router edge cases (new caching defaults, async cookies) | Med | Low | Stick to documented patterns (RESEARCH §2). Avoid experimental flags except `typedRoutes`. Track Next 15 changelog in Renovate PRs. |
| WebSocket reconnect race with refresh-token rotation | Med | Med | `lib/ws.ts` subscribes to `useAuthStore.accessToken` changes and uses graceful `auth-rotate` op (§6.3). Resume cursor (`{op:'resume', from:lastSeq}`) ensures no missed events even on full reconnect. T01 must honor both. |
| `sx_user` cookie + access JWT divergence (cookie says you're authed, store says you're not) | Med | Low | On every navigation, `(agent)/layout.tsx` is server-rendered with the cookie value AND the CC island re-checks `useAuthStore.accessToken === null` → triggers `refreshAccessToken()` to recover. Refresh failure → logout cascade. |
| Edge runtime missing `crypto` features | Low | Low | `jose` is Edge-tested; we don't use Node `crypto`. Tested in CI matrix. |
| OpenAPI not yet stable when A01 IMPLEMENTs (per A01 spec Risks) | High | Low | Ship a stub OpenAPI that covers `/api/auth/*` only; types regenerated each PR. F-API modules expand the spec. |
| Concurrent-refresh race | Med | Med | Single-flight promise pattern (§7.2); covered by `lib.auth.refresh.test.ts`. |
| Mac dev WebRTC quirks (per F01 PLAN risk) | High on Mac | Low | Documented in HANDOFF; A01 does not depend on WebRTC, so dev unblocked — only A02+ feels it. |
| `libphonenumber-js` size regressing the bundle | Low | Med | Always lazy via `dynamic()`; bundle analyzer asserts it's in a separate chunk. |
| Lighthouse CI flake | Med | Low | `numberOfRuns: 3` smooths variance; assertions on min score not max. |
| BroadcastChannel unsupported in some test browsers | Low | Low | Fallback to `storage` event (RESEARCH §5.7). Both tested. |
| F05 changing the cookie names/paths after A01 PLAN freezes | Low | Med | Cookie names + paths committed in this PLAN; F05 PLAN must reference. If F05 deviates → RFC. |

---

## 18. Acceptance criteria (restated from A01.md, expanded)

- [ ] Three role-segregated route groups (`(agent)`, `(admin)`, `(sup)`) compile and gate by role via `middleware.ts`.
- [ ] Auth flow complete: login → use → proactive refresh → logout. E2E test green.
- [ ] HttpOnly cookie strategy (refresh + `sx_user`) per §7.1.
- [ ] Typed API client from OpenAPI (`openapi-fetch` + `openapi-typescript`).
- [ ] Tailwind v4 + base tokens (`@theme` block per §11) configured.
- [ ] Mobile responsive shell at viewports 375 / 768 / 1280 (verified via Playwright + Lighthouse mobile profile).
- [ ] Lighthouse score ≥ 90 on `/login` and `/dashboard` (LHCI gate).
- [ ] Bundle analyzer shows agent route ≤ 250 KB gzipped.
- [ ] Coverage ≥ 70% on `lib/{auth,api,ws}.ts` and all stores.
- [ ] HANDOFF.md documents every hand-off interface in §16.

---

## 19. Resolved open questions (from RESEARCH §10)

1. **`sx_user` cookie design** → Separate signed JWT (HS256, `aud=ssr`),
   not the access token verbatim. Signed with `SX_USER_COOKIE_SECRET`.
2. **Theme tokens** → Enumerated in §11 (`--color-state-{idle,ringing,
   active,hold,wrap,dispo,transfer,error}` + brand scale).
3. **Middleware runtime** → Edge runtime (`jose.jwtVerify`).
4. **API client** → `openapi-fetch` + `openapi-typescript`. File:
   `lib/api.ts`.
5. **Hotkey infrastructure** → Custom `KeyboardListenerProvider` (no
   `react-hotkeys-hook` dep). A06 fills handlers.
6. **Toast lib** → Sonner via shadcn.
7. **Persist boundary** → Only `ui` slice persisted to localStorage.
8. **Call-state animations** → Tailwind utilities backed by `@keyframes`
   in `globals.css` `@layer utilities`.
9. **TypeScript strictness** → Per §1.2 (the four strict flags + a few
   more).
10. **Storybook/Ladle** → Skipped for Phase 1.

---

## 20. File list to be created in IMPLEMENT (summary)

Approximately 60–70 files under `web/`, the bulk being shadcn-generated
primitives in `components/ui/` (~16 files) and one-line placeholder
pages for routes downstream modules will fill. The load-bearing files
are:

- `lib/auth.ts`, `lib/api.ts`, `lib/ws.ts` (the three runtime pillars)
- `lib/stores/{auth,call,agent,ws,ui}.ts` (state contract)
- `app/providers.tsx`, `app/(agent)/AgentShell.tsx` (the client islands)
- `middleware.ts` (route protection)
- `app/globals.css` (Tailwind v4 tokens)
- `lighthouserc.json` + `.github/workflows/lhci.yml` (perf gate)

Everything else is convention plumbing.

End of A01 PLAN.md. Awaiting checkpoint approval; IMPLEMENT additionally
gated on F05 HANDOFF.
