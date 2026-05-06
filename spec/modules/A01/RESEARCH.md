# Module A01 — RESEARCH

**Module:** A01 — Next.js Skeleton + Auth (Agent UI foundation)
**Status:** RESEARCH
**Author:** sub-agent A01
**Date:** 2026-05-06
**Blocked on:** F05 (Auth API). Research can proceed; implementation must wait.

This document is the research inventory used to drive the A01 PLAN. It captures
recommendations and citations only — no `tsx`, no concrete file scaffolds. Final
file structure is decided in PLAN.md.

---

## 1. Executive summary (10 bullets)

1. **Use Next.js 15.x** (not 14, not 16). 15 is GA since Oct 2024, has run for ~18
   months, App Router is the maintained surface, Turbopack dev is stable. Next.js
   16 (Oct 2025) ships PPR stable + Turbopack-by-default-in-dev, but production
   builds on 16 still use Webpack and several APIs (cookies/headers/params)
   became *strictly* async with no sync fallback — too churny for a Q2 2026
   greenfield where we want stability over latest. Re-evaluate at Next 16.x once
   Turbopack-prod GAs (expected late-2026). [1][2][3]
2. **Tailwind v4.x stable** (CSS-first config + Oxide engine). The upgrade tool
   automates v3→v4 migration; v4's 5× build speed and 100× incremental rebuild
   matter for the agent screen which we'll touch a lot. Browser floor (Safari
   16.4+/Chrome 111+/Firefox 128+) is fine for a B2B agent app. [4][5]
3. **shadcn/ui** as the component layer (copy-paste, owns the source, Radix
   primitives + Tailwind). Better fit than Mantine/Radix-Themes for a highly
   custom call-center UI where we need tight control over micro-interactions
   (call-state transitions, hotkey overlays). [6][7]
4. **Zustand** for client state — single softphone+call store, ~100-line file,
   minimal re-renders on event-driven updates. Cited in DESIGN.md §1.2 already.
   Jotai (atoms) and Valtio (proxy) are great for other shapes; we don't need
   them. Redux Toolkit is overkill and adds bundle. [8][9][10]
5. **TanStack Query v5** for server state (REST cache + invalidations) +
   **TanStack Table v8** + **TanStack Virtual** for any list >200 rows
   (call history, lead browser, recordings list). Mutually exclusive with
   `getPaginatedRowModel` — for big lists, virtualize, don't paginate. [11][12][13]
6. **Single full-duplex WebSocket** for the agent control plane (commands +
   events) — confirmed by DESIGN.md §7.6 and SPEC.md §3.9. Build a thin
   reconnect wrapper (~150 LOC) with exponential backoff + jitter, not
   `partysocket` (PartyKit-coupled defaults), not `react-use-websocket`
   (extra abstraction we don't need). The pattern: `useRef` for the socket,
   custom hook surface, event bus over Zustand store actions. [14][15][16]
7. **Custom thin auth context** (NOT NextAuth/Auth.js v5). We have our own
   Fastify backend issuing access+refresh tokens; NextAuth's value is OAuth
   provider plumbing we don't use. Pattern: refresh token in `httpOnly Secure
   SameSite=Strict` cookie set by the backend on `/api/auth/login`, access
   token in memory (Zustand, non-persisted slice), single-flight refresh
   promise to avoid races. [17][18][19][20]
8. **RSC/CC split:** layouts + nav + login page = Server Components; everything
   under `(agent)/` is a client subtree (the softphone needs `useEffect`,
   `MediaStream`, the SIP.js UA, and the WS). Lead detail in admin can be
   hybrid: SSR initial fetch → client island for live updates. Keep the
   `'use client'` boundary as deep as possible to keep nav/layouts cacheable. [21]
9. **Performance budget:** TTI ≤ 1.5 s on cable for the agent screen, render
   p95 ≤ 100 ms for incoming call-event paint (`startTransition` for non-urgent
   updates, `useDeferredValue` for derived counters, virtualize anything >200
   rows). Lighthouse-CI in CI as a hard gate per A01 acceptance criterion
   (Lighthouse ≥ 90). [22][23]
10. **Build/deploy:** `output: 'standalone'`, multi-stage Dockerfile (deps →
    build → runner with `node server.js`), 4-core/8GB box per DESIGN.md §16.
    Cold-start is fine for SSR pages we'll have (login + admin reports);
    agent screen is mostly client and rehydrates on F5.

---

## 2. Next.js version recommendation: **15 (latest 15.x)**

### Decision matrix

| Criterion | Next 14 | **Next 15** | Next 16 |
|---|---|---|---|
| GA | Oct 2023 | **Oct 2024** | Oct 2025 |
| Maturity at Q2-2026 build start | 2.5 y old, in maintenance | **~18 mo, fully battle-tested** | 6 mo, churn |
| App Router | stable | **stable + tightened APIs** | stable + PPR-stable |
| Server Actions | stable | **stable** | stable |
| Turbopack dev | beta (`--turbo`) | **stable (`--turbo`, opt-in)** | default; *no* opt-out |
| Turbopack build | no | **alpha** | beta (still Webpack default in 16) |
| React peer | 18 | **19** (required) | 19.2 canary |
| Async cookies/headers | optional | **opt-in deprecation** | required, sync removed |
| Caching defaults | aggressive | **opt-in (`fetch` no longer auto-cached)** | unchanged |
| Risk for greenfield Q2-2026 | Old; will EoL during our build | **Lowest combined risk** | Latest, edges still moving |

15 is the right anchor: long enough to hit a stable patch series (15.4+), short
enough that we're still on a maintained branch through 2027. 16 is "wait one
release" — we revisit when Turbopack production GAs (Vercel says late 2026). [1][2][3]

### React 19 implications (since 15 requires 19)

- `useOptimistic` is built-in → use directly for transfer/dispo button feedback
  without rolling our own optimistic-store layer. [24]
- New `<form action={...}>` works with React-Hook-Form via the integration
  pattern documented in [25].
- `useFormStatus` for in-flight UI (mute spinner during transfer originate).

### What's NOT used despite being available

- **Server Actions for hot agent paths.** Manual-dial and disposition go through
  the Fastify `/api/agent/*` REST surface (DESIGN.md §7) so the dialer engine,
  dialplan, and ESL flow are owned by one codebase. Server Actions are fine for
  admin CRUD where there's no real-time coupling, but we mostly already have
  REST endpoints there too — not worth the split-brain.
- **Partial Prerendering (PPR).** Login + agent dashboard are mostly dynamic;
  PPR's win is on mostly-static-with-a-dynamic-island pages. Nothing to gain
  for A01.

---

## 3. Stack confirmation

### 3.1 Tailwind: v4.x

Adopt v4 from the start. Reasons:

- Oxide + Lightning CSS = 5× full builds, 100× incremental — measurable in
  dev-loop friction, especially with `next dev --turbo`. [4]
- `@theme` CSS-first config = our design tokens (call-state colors, dispo
  pills, urgency badges) live in one CSS file alongside other tokens, no JS
  config indirection.
- Drop autoprefixer + postcss-import (Lightning CSS handles both). One fewer
  dependency tree.
- v3→v4 codemod runs in a few minutes; we don't have legacy.

Browser floor: Safari 16.4+/Chrome 111+/Firefox 128+. We're shipping Chrome-only
de facto (WebRTC SimpleUser quirks, agent-app context) so this is fine. We'll
document a Chrome 120+ recommended baseline in HANDOFF. [5]

### 3.2 Component library: shadcn/ui

Picked over alternatives:

| Lib | Why considered | Why rejected for A01 |
|---|---|---|
| **shadcn/ui** | Copy-paste components on Radix primitives, Tailwind-native, owns the source | **Picked** — gives us a production-ready Button/Dialog/Toast/Form set without locking us into their styling decisions. The Feb-2026 visual-builder + Base UI/Radix dual-primitive support helps when we customize. [6][7] |
| Radix Themes | Same primitives + a theming layer | The theming layer wants its own design system; we want our own with Tailwind tokens |
| Mantine | Full DS (forms, tables, dates, notifications) | Too opinionated for a heavily custom UX; bundle size worse; harder to deviate from defaults [6] |
| Headless UI | Tailwind-team primitives | Smaller catalog than Radix; less momentum |
| MUI | Mature DS | Emotion runtime + size budget bad for our TTI target |

**Components we'll generate via `shadcn add`:** Button, Input, Card, Dialog,
DropdownMenu, Toast (sonner), Tooltip, Tabs, Select, Form (with RHF wiring),
Sheet, Command (for hotkey palette later in A06). The list is finalized in PLAN.

### 3.3 Client state: Zustand

Already in DESIGN.md. Sticking. Rationale (cite [8][9]):

- Single store with slices: `auth`, `call`, `agent`, `ws`, `ui`. Action methods
  on the store rather than action creators.
- `subscribeWithSelector` middleware lets the SIP wrapper and the WS wrapper
  push events into the store without re-rendering all subscribers.
- `persist` middleware for *only* the user prefs slice (volume, last-used
  dispo) — never JWTs, never SIP creds.
- Zustand benchmark: ~12 ms single-update render, 2.1 MB for 1000-subscribed
  components — well within the agent screen's component count. [10]

Why not the others:

- **Jotai (atoms):** good for spreadsheet-like granular subscriptions, but our
  dominant data shape is "the current call", not 5000 cells. Adds mental
  overhead for the team.
- **Valtio (proxy):** subscriptions are automatic — fine — but TS ergonomics
  on nested mutations are worse, and we don't get a noticeable win.
- **Redux Toolkit:** we don't need time-travel, devtools-replay isn't a
  requirement, RTK Query overlaps TanStack Query. Bigger bundle, more code.
- **Signals (preact-signals or React 19 experimental):** too early for a
  production agent app.

### 3.4 Server state: TanStack Query v5

REST endpoints (`/api/agent/*`, `/api/leads/*`, `/api/dispositions`) are
classic GET/POST. Picked TanStack Query over SWR because:

- We need fine-grained `invalidateQueries(['lead', leadId])` after a dispo POST
  so the lead-detail panel recomputes. SWR's strategy is time-based revalidate;
  ours is event-based. [11][12]
- `useMutation` + `onMutate`/`onError` rollback is the cleanest fit for
  optimistic dispo submit.
- DevTools panel is a meaningful debugging aid given the WS+REST coupling.
- SWR is 4 KB lighter; not material.

### 3.5 Tables: TanStack Table v8 + TanStack Virtual

Anywhere a list can exceed ~200 rows (call history, lead browser in admin
M03, recordings browser in S04). For A01 itself we don't yet have a table —
this is the *standard* established for downstream A* / M* modules to inherit.

**Constraint to remember:** virtualization and `getPaginatedRowModel()` are
mutually exclusive. For >1k rows we virtualize; for ≤200 rows we paginate. [13]

### 3.6 Forms: react-hook-form + zod

- `useForm({ resolver: zodResolver(schema) })`, `mode: 'onBlur'` for login
  (no need to validate every keystroke), `mode: 'onChange'` for the dispo
  picker (instant feedback). [25][26]
- Reuse zod schemas across client and server (publish from
  `shared/openapi` → derived zod, or hand-mirror small ones).

### 3.7 Date/time: date-fns v4

- 13 KB tree-shaken; we need only ~8 functions (`format`, `formatDistance`,
  `formatInTimeZone`, `parseISO`, etc.). [27]
- Phase-1 tz handling is via D03 (server-side phone-code → tz_offset_min). UI
  only formats the agent's own timezone; pair with `date-fns-tz` if needed.
- Temporal: not yet — Stage 4 in March 2026, polyfill is 60 KB which kills our
  TTI budget. Revisit Phase 4 once Chrome+Firefox baseline support holds. [28]

### 3.8 Phone numbers: libphonenumber-js (lazy-loaded)

- 145 KB raw, but lazy-load via `dynamic(() => import(...))` so it lands in
  a separate chunk fetched only when the manual-dial modal opens. [29][30]
- Format: store and POST in **E.164**, display in user's locale. Validate with
  `parsePhoneNumberFromString` + check `isValid()`.

---

## 4. WebSocket client architecture

### 4.1 Why one full-duplex socket

DESIGN.md §7.6 already commits us: agent state changes broadcast to
`broadcast:agent:{user_id}` Redis pub/sub, the Fastify WS gateway (T01) fans
out per connected agent. Same socket carries:

- **Server → client:** `call_started`, `call_ended`, `dispo_required`,
  `agent_state_changed`, `transfer_complete`, `eavesdrop_started`, etc.
- **Client → server:** lightweight commands like `{ op: 'subscribe', channel:
  'campaign:42' }` or `{ op: 'heartbeat' }`. Note: the *real* call commands
  (mute, hangup, transfer, dispo) are still POSTed to `/api/agent/*` REST so
  they can be audit-logged transactionally and so the dialer/T04 owns
  originate. The WS is for control-plane subscriptions and event push, not
  command dispatch for telephony actions.

### 4.2 Library decision: thin custom wrapper, not a third-party hook lib

Inventory of options:

| Option | Pros | Cons |
|---|---|---|
| **Custom (~150 LOC)** | Owns reconnect strategy, integrates directly with Zustand store, no hidden behavior | We write & test it — but the surface is small |
| `partysocket` (PartyKit) | Auto-reconnect, exp backoff, multi-platform, dependency-free | API designed around PartyKit servers; carries vestigial vocabulary; minor overhead [14][15] |
| `reconnecting-websocket` | Drop-in replacement for `WebSocket`, auto-reconnect | Last meaningful update old; doesn't help with React lifecycle |
| `react-use-websocket` | React hook, multiple components share a connection | Extra abstraction; we already share via Zustand; hidden state in hook lib makes debugging harder [16] |
| `sockette` | Tiny | Same as `reconnecting-websocket`, no React story |

**Decision:** custom. Pattern is well-known (we found a representative example
in the wild — see citation [31] for the `useReconnectingWebSocket` hook style).
That confirms ~150 LOC is realistic and idiomatic.

### 4.3 Reconnect strategy

- **Backoff:** exponential, `min(1000 * 2^attempt, 30000)`, with **jitter** of
  ±25 % to prevent thundering-herd reconnect after FreeSWITCH/API restart. [16][32]
- **Auth:** initial WS open includes `?token=<short-lived-WS-token>` query
  param OR an `Authorization` upgrade header (Fastify supports both). The WS
  token is a separate short-TTL JWT issued at login by F05 (15-min, scoped
  `aud=ws`). Don't reuse the API access token — different audience, different
  rotation cadence.
- **Heartbeat:** client sends `{ op: 'ping' }` every 25 s; server pongs.
  Missed pong → close locally → trigger reconnect. Mirrors the standard
  intermediary-keepalive pattern. [16]
- **Buffering:** outbound messages while disconnected enqueue into a 100-item
  ring buffer; flushed on `onopen`. Drop with `warn` log if buffer overflows
  (means the agent has been offline too long; UI should already be showing
  reconnect overlay).
- **Resume cursor:** server tags every event with a monotonically increasing
  `seq`. On reconnect, client sends `{ op: 'resume', from: lastSeq }`. T01
  gateway holds a 60-s replay buffer per agent in Redis. (This is finalized in
  T01's spec; A01 just needs to honor the protocol.)
- **`useRef` for the WS instance**, not `useState` — the socket is a mutable
  side-channel object that should not participate in React's render cycle. [16]

### 4.4 SSE alternative — rejected

SSE is one-way; we'd need a second channel for client→server commands anyway.
SSE also doesn't multiplex cleanly with a `Connection: Upgrade` HTTP/2 setup
behind nginx. WS is cleaner and matches DESIGN.md.

### 4.5 Optimistic UI patterns

Two patterns coexist:

1. **Optimistic action via `useOptimistic` + REST POST + WS confirmation.**
   Example — Mute button: user clicks → React optimistically sets
   `state.call.muted = true` and updates the icon → POSTs `/api/agent/mute` →
   awaits 204 → WS will deliver `mute_confirmed` to *also* update the canonical
   store. If the POST 4xx's, `useOptimistic` reverts. If POST 200's but WS
   never confirms within 2 s, we fall back to assuming success but log a
   warning. [33][34]
2. **WS-only updates for things the user didn't initiate** (e.g., a 3-way leg
   answered, a supervisor whisper started). No optimism needed — just store
   patch.

For long-latency actions like a transfer-originate, show a `useFormStatus`
spinner on the transfer modal until either WS `transfer_complete` arrives or
a 10-s timeout. Optimistic UI is a no-op here because the customer doesn't
hear the transfer until FS actually does it.

---

## 5. Auth integration design (custom thin layer, no NextAuth)

### 5.1 Why not NextAuth/Auth.js v5

Auth.js v5 is excellent when you want OAuth providers (Google, GitHub,
Discord, etc.) with their pre-built provider plumbing, or when you want a
session adapter against your DB. We have neither requirement: F05 already
issues access + refresh tokens with sip_creds in one POST. Adopting Auth.js
means writing a `Credentials` provider that wraps our backend, then bending
its session shape (which calls itself a JWT but isn't *our* JWT) to carry our
backend's tokens. That's more code and more abstraction, not less. [17][18][19]

### 5.2 Token strategy

- **Access token (JWT, 15-min TTL)**: in **memory** (Zustand `auth` slice,
  *not* persisted). Sent as `Authorization: Bearer <token>` on every REST
  call by an `apiClient` interceptor.
- **Refresh token (opaque, 30-day TTL, Redis-backed in F05)**: in
  `httpOnly Secure SameSite=Strict` cookie, set by the F05 `/api/auth/login`
  response. Cookie path = `/api/auth`. Browser JS literally cannot read it.
- **SIP creds**: returned in login response body. Stored in a separate Zustand
  slice (in memory, not persisted). Passed once to SIP.js SimpleUser. We do
  *not* persist them and *do not* re-fetch on tab restore — A02 will handle
  re-fetch via `POST /api/auth/me?include=sip_creds` if needed.
- **Why not access token in a cookie?** Cookies travel on every request to the
  origin, including static asset requests; adds bytes. Memory + Bearer header
  is the standard SPA pattern, and we control all API calls so injecting the
  header is trivial.

### 5.3 Refresh strategy and the race condition

The well-known race: multiple in-flight requests hit a 401 simultaneously, all
try to refresh, all use the same refresh-token cookie, only the first wins
(refresh-token rotation invalidates it on use), the rest 401-loop. [20][35]

**Solution: single-flight refresh promise.**

```
let refreshInFlight: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = fetch('/api/auth/refresh', {
    method: 'POST', credentials: 'include'
  })
    .then(r => r.ok ? r.json() : Promise.reject(...))
    .then(({ access_token }) => { setStoreToken(access_token); return access_token; })
    .finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}
```

Every fetch interceptor that gets a 401 awaits `refreshAccessToken()` and
retries once with the new token. Subsequent in-flight 401s reuse the same
promise, get the same new token, and proceed.

A second mitigation: refresh proactively at `iat + 13min` (2 min before
expiry), as a background timer in the auth store. This makes 401-on-call
extremely rare in practice. [35]

### 5.4 Login + redirect flow

```
1.  GET /        → server-rendered login page (Server Component shell + client form)
2.  POST submit  → client-side fetch('/api/auth/login') (so we can read the body
                   for sip_creds in JS); server sets refresh-cookie; we get
                   {access_token, sip_creds, user} in body.
3.  store.login(...) → put access+sip+user in memory.
4.  router.push(role-target)  // where role-target is /dashboard or /admin or /sup
5.  An RSC layout for /(agent)/* re-runs; cookie present + access cookie absent
    means we don't have an SSR-side identity for that layout. So we either:
     a) store the access token also in a SHORT-TTL HttpOnly cookie just for
        SSR identity (`sx_user`), set on login. Path=/, SameSite=Strict.
        Server Components read it via `cookies()`.
     b) rely entirely on client-side guard: layout is "use client", checks
        Zustand, redirects if no token.
   Recommendation: (a). It costs one cookie but lets the layout be a Server
   Component (cleaner SEO/perf for nav chrome). The cookie payload is just
   `{ uid, role, exp }`, refreshed alongside the access token.
```

### 5.5 `middleware.ts` for route protection

`/middleware.ts` runs on the Edge runtime (or Node.js runtime in Next 15+
optionally). Reads the `sx_user` cookie, verifies signature with
`jose.jwtVerify`, and redirects:

- No cookie → `/`
- Cookie role=agent on `/(admin)/*` → 302 `/dashboard` or 403 page
- Cookie role=admin on `/(agent)/*` → 302 `/admin`

Public matcher: `/`, `/api/auth/*`, `/_next/*`, `/healthz`.

`middleware.ts` only does *role* checks, not *permission* checks. Fine-grain
RBAC is enforced by F05 `requireAuth(...roles)` on the API. Keep middleware
fast — no DB calls.

### 5.6 Logout

`POST /api/auth/logout` → backend revokes refresh token in Redis + clears
cookies. Client clears the Zustand auth slice + closes WS + ends SIP UA.
`router.push('/')`.

### 5.7 Tab sync

If user logs out in tab A, tab B should detect it. Use `BroadcastChannel('auth')`
(supported in all current Chromium/Firefox/Safari) — broadcast `{ event:
'logout' }` on logout; subscribers reset state. `localStorage` `storage` event
is a fallback. We don't otherwise sync state cross-tab; each tab has its own
SIP UA and its own WS.

---

## 6. RSC / Client-Component split strategy

Goal: keep `'use client'` boundaries deep so that layout chrome, nav, and
mostly-static pages stay server-rendered (smaller client bundle, better
streaming). [21][36]

### 6.1 Per-route classification

| Route | Render | Notes |
|---|---|---|
| `/` (login) | Server shell + Client form island | Form needs `useState`, RHF |
| `/(agent)/layout.tsx` | Server Component | Reads `sx_user` cookie via `cookies()`; renders top nav |
| `/(agent)/dashboard/page.tsx` | Server shell + Client island for the call panel | The whole call screen is one big CC; lead detail tabs may be server-rendered initially with hydration |
| `/(admin)/layout.tsx` | Server Component | Same pattern |
| `/(admin)/leads/page.tsx` | Server Component (initial table) → Client island for inline edit | TanStack Table is client; SSR can pre-render the first page of HTML |
| `/(admin)/recordings/[id]/page.tsx` | Server Component for metadata + Client `<AudioPlayer/>` | |
| `/(sup)/wallboard/page.tsx` | Mostly Client | Real-time grid; SSR shell + suspense |
| WS gateway client | Module under `/lib/ws.ts` (CC dependency) | Lives only in CC tree |
| SIP.js wrapper | Client | Cannot SSR — uses `MediaStream`/`AudioContext` |

### 6.2 Patterns

- **Pass server-fetched data to a CC via props** (e.g., initial lead) to avoid
  duplicate fetches. The CC then takes over for live updates.
- **Suspense boundaries** for slower data fetches (call history loaded
  separately from lead identity).
- **Global providers** (`QueryClientProvider`, `ZustandProvider`,
  `WSProvider`, `Toaster`) live in a single `app/providers.tsx` CC,
  rendered from the root server layout. Standard pattern. [21]

### 6.3 Streaming

Use `loading.tsx` for route-level loading skeletons (especially the agent
dashboard, where we want first paint < 500 ms even before data). Skeleton
matches the call-panel layout to avoid layout shift.

---

## 7. Performance budgets and how to hit them

### 7.1 Targets (per A01 spec § acceptance + DESIGN.md §7)

| Metric | Target | Where it matters |
|---|---|---|
| LCP | ≤ 1.5 s on cable | Login page + agent shell first paint |
| INP | ≤ 200 ms | Hotkey press → UI response |
| CLS | ≤ 0.1 | Avoid jumping when call card transitions |
| TTI | ≤ 1.5 s | Agent screen ready to interact |
| Real-time event paint | < 100 ms p95 | `call_started` arrives → call card visible |
| JS bundle (agent route) | ≤ 250 KB gzipped | Mostly shadcn/ui + Zustand + RHF + SIP.js core |
| Lighthouse score | ≥ 90 | A01 acceptance criterion |

### 7.2 How

- **Code-splitting:** dynamically import heavy stuff: `libphonenumber-js`,
  `tanstack-virtual` (admin), `audio-recorder-ui` (R03 module). Use Next.js
  `dynamic(() => import(...), { ssr: false })` for browser-only modules.
- **Tree-shaking:** import individual `date-fns` functions; never `import *`.
- **Image optimization:** `next/image` with explicit `sizes` for the company
  logo + agent avatar.
- **Font loading:** `next/font` for self-hosted Inter or similar; preconnect
  + display swap.
- **Avoid waterfall fetches:** use `Promise.all` in server components for
  multi-source initial data.
- **Memoize aggressively:** `useMemo` for derived call timer formatting,
  `React.memo` on call-card subtree so dispo-picker re-render doesn't push
  the whole panel.
- **`startTransition` for non-urgent state updates** (e.g., updating the
  ready-agents counter in the bottom bar when 200 events/s arrive — coalesce
  via a transition). [33]
- **`useDeferredValue`** for the lead-search typeahead to keep keystrokes
  responsive while the result list updates.
- **`React.lazy` on the disposition list** if it gets big.
- **Lighthouse CI** in GitHub Actions: `lighthouse-ci` against a built
  production server, fail PR if score drops below 90 or LCP > 2 s.
- **Bundle analyzer** (`@next/bundle-analyzer`) gated behind `ANALYZE=1` env
  in dev. [22][23][37]

### 7.3 Real-time event render budget

For the < 100 ms paint target on `call_started`:

- Path: WS message → handler → `store.setActiveCall(...)` → React subscribed
  components re-render → DOM patch.
- Instrument: `performance.mark('ws:call_started')` on receive,
  `performance.measure('call_started_paint', mark, 'after-render')` via a
  `useLayoutEffect` on the call-card. Aggregate to a `web-vitals`-style
  internal metric reported via `useReportWebVitals` to our `/api/metrics/web`
  endpoint. Track p95 during dev; alert if regresses. [37][38]
- Budget allocation: 5 ms parse, 5 ms store update, 60 ms React render
  (including any hydration), 30 ms paint = 100 ms. With 100 components, only
  the call-card subtree (~20 components) re-renders.

---

## 8. Accessibility plan (WCAG 2.1 AA target)

### 8.1 Live regions

- **Incoming call:** `<div aria-live="assertive" aria-atomic="true"
  role="alert">Incoming call from {caller_id_name} {caller_id_e164}</div>`.
  Assertive interrupts current speech, appropriate for time-sensitive
  notifications. [39][40]
- **Disposition required:** `aria-live="polite"` so it doesn't interrupt
  if the agent is mid-typing notes.
- **Call timer:** *not* a live region — would spam the screen reader. Make
  it focusable so the agent can read it on demand.

### 8.2 Buttons and call states

- All call-control buttons get `aria-label` (e.g., the icon-only mute button
  is `aria-label="Mute microphone"` and toggles to `aria-label="Unmute
  microphone"`).
- Toggle buttons use `aria-pressed`.
- Disabled buttons: `aria-disabled="true"` instead of `disabled` so they
  remain focusable + announce the disabled reason.
- Ensure focus rings are visible (Tailwind `focus-visible:ring-2`).

### 8.3 Keyboard navigation

- Tab order matches visual order top-to-bottom, left-to-right.
- Hotkeys (A06's responsibility but A01 lays ground):
  - 0–9 for dispos in WRAPUP state
  - F1=hold, F3=hangup, Ctrl+T=transfer menu, Ctrl+P=pause
- Avoid stealing native keys (Ctrl+R, Ctrl+W, etc.).
- Visible kbd hints: `<kbd>F3</kbd> to hang up` shown next to each control.
- `roving-tabindex` for the dispo grid.

### 8.4 Color contrast

- Tailwind palette tuned for AA on agent UI. Specifically: red call-state
  not solely conveying state — pair with icon + label.
- 4.5:1 contrast for body text; 3:1 for large text and UI components.
- Don't use color alone for state (e.g., the muted indicator must include
  a slashed-mic icon).

### 8.5 Forms

- `<label for>` linking, never placeholder-as-label.
- Errors via `aria-invalid` + `aria-describedby` pointing to the error span.
- RHF + zod resolver auto-wires this with shadcn/ui's `<Form>` wrapper.

### 8.6 Audio

- WebRTC autoplay policy: agent has interacted with the page (logged in),
  AND the SIP UA has an active capture session, so ringtone audio will
  autoplay. [41][42] Still, defensive: catch `play()` rejection and show a
  "Click to enable audio" overlay.
- Provide a "Test ringtone" button in settings.
- Volume slider per agent, persisted via Zustand `persist` middleware.

### 8.7 Testing

- `axe-core` in Playwright tests: `await injectAxe(page); const violations =
  await checkA11y(page)`. Fail PR on violations.
- Manual VoiceOver/NVDA pass per release.

---

## 9. Build/deploy output

### 9.1 `output: 'standalone'`

`next.config.mjs`:

```
{ output: 'standalone', experimental: { typedRoutes: true } }
```

`.next/standalone/server.js` is the entrypoint. We copy:

- `.next/standalone/` (server + a pruned `node_modules`)
- `.next/static/` → `/.next/static/`
- `public/` → `/public/`

Resulting Docker image ~150–200 MB on `node:20-alpine` vs ~700 MB+ for full
node_modules, and faster cold starts. [43][44][45]

### 9.2 Multi-stage Dockerfile pattern

```
# stage: deps  → npm ci --omit=dev=false (we need devDeps for build)
# stage: build → next build
# stage: runner → node:20-alpine, copy standalone+static+public, USER nextjs,
#                 EXPOSE 4000, CMD ["node", "server.js"]
```

PORT 4000 (matches A01 verification step).

### 9.3 Env strategy

- Public: `NEXT_PUBLIC_API_BASE`, `NEXT_PUBLIC_WS_URL`, `NEXT_PUBLIC_FS_WSS`
  (SIP), `NEXT_PUBLIC_TELEMETRY_ENDPOINT`.
- Private (server-only, used in API routes / middleware): `SX_USER_COOKIE_SECRET`
  (HMAC for the slim user cookie if we sign instead of just JWT-verifying), etc.

### 9.4 Health checks

- `/healthz` returns 200 if Next.js server up. Behind the standalone server
  it's a tiny route handler.
- Liveness vs readiness: Next.js doesn't need a special readiness check — if
  it's serving 200 it's ready.

### 9.5 CDN/static

In the host-bound deployment (DESIGN.md), put nginx in front, serve
`/.next/static/*` and `/public/*` with `Cache-Control: public,
max-age=31536000, immutable`. SSR responses pass through.

---

## 10. Open questions for PLAN

1. **`sx_user` slim-cookie design.** Is it a separate signed JWT (different
   from access token)? Or is it the access token itself, also placed in an
   HttpOnly cookie to allow Server-Component identity? We'll align with F05's
   PLAN — proposed default: access token *also* set as `sx_user` HttpOnly
   cookie at the same time, same TTL, same value, refreshed alongside.
   Decision in PLAN.
2. **Theme tokens.** Tailwind v4 `@theme` block — we need to enumerate exact
   call-state colors (idle/ringing/active/wrap/disposition-required/transfer)
   so component code can reference `bg-state-active` etc. Lift from DESIGN.md
   §7.1 plus a few additions. Decision in PLAN.
3. **Middleware runtime.** Edge runtime is faster cold-start but lacks Node
   APIs (e.g., `crypto` module nuances). For us, `jose.jwtVerify` is
   Edge-compatible. Stick with Edge. Decision in PLAN.
4. **Where the `apiClient` lives** (lib/api-client.ts vs `lib/api/index.ts`)
   and whether it wraps `fetch` directly or `ofetch`/`ky`. Lean: `fetch` +
   `openapi-fetch` (~4 KB, type-safe against the OpenAPI spec). [46]
5. **Hotkey infrastructure.** Implemented in A06, but A01 establishes the
   global `KeyboardListenerProvider` slot. Decide: `useHotkeys` (`react-hotkeys-hook`)
   vs custom event listener. Custom is fine and has been done in <100 LOC.
6. **Toast lib choice.** shadcn/ui ships with `sonner` adapter. Adopt sonner.
7. **Persistence boundary.** Define exactly which Zustand slices use
   `persist`. Lean: only `ui` (volume, theme, last-used dispo). Auth, call,
   agent, ws are session-only.
8. **CSS approach for call-state animations.** Tailwind utility classes vs a
   small `@keyframes` block in `globals.css`. Decision in PLAN.
9. **TypeScript strictness.** Recommend `"strict": true`,
   `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`,
   `"noImplicitOverride": true`. Decision in PLAN.
10. **Testing libs.** Vitest + React Testing Library + Playwright are
    referenced in A01 spec. Decide on Storybook vs Ladle for component dev.
    Lean: skip both for Phase 1; revisit if component complexity grows.

---

## 11. Citations

[1] [Next.js 15 release blog (Vercel)](https://nextjs.org/blog/next-15)
[2] [Next.js 16 release blog (Vercel)](https://nextjs.org/blog/next-16)
[3] [Upgrading: Version 16 (Next.js docs)](https://nextjs.org/docs/app/guides/upgrading/version-16)
[4] [Tailwind CSS v4.0 announcement (Tailwind Labs)](https://tailwindcss.com/blog/tailwindcss-v4)
[5] [Tailwind CSS v4 Upgrade Guide (Tailwind Labs)](https://tailwindcss.com/docs/upgrade-guide)
[6] [Mantine vs shadcn/ui — Complete Developer Comparison 2026 (SaaSIndie)](https://saasindie.com/blog/mantine-vs-shadcn-ui-comparison)
[7] [shadcn vs Radix vs Base UI: Which One Should a Junior Pick in 2026? (DEV)](https://dev.to/edriso/shadcn-vs-radix-vs-base-ui-which-one-should-a-junior-pick-in-2026-1jml)
[8] [Zustand Comparison docs (pmndrs)](https://zustand.docs.pmnd.rs/learn/getting-started/comparison)
[9] [Jotai Comparison docs](https://jotai.org/docs/basics/comparison)
[10] [State Management in 2026: Zustand vs Jotai vs Redux Toolkit vs Signals (DEV)](https://dev.to/jsgurujobs/state-management-in-2026-zustand-vs-jotai-vs-redux-toolkit-vs-signals-2gge)
[11] [TanStack Query Comparison docs](https://tanstack.dev/query/v5/docs/framework/react/comparison)
[12] [TanStack Query Invalidation guide](https://tanstack.com/query/v5/docs/framework/react/guides/query-invalidation)
[13] [TanStack Table Virtualization guide](https://tanstack.com/table/v8/docs/guide/virtualization)
[14] [PartySocket reference](https://docs.partykit.io/reference/partysocket-api/)
[15] [partysocket on npm](https://www.npmjs.com/package/partysocket)
[16] [WebSockets in React: Hooks, Lifecycle, and Pitfalls (websocket.org)](https://websocket.org/guides/frameworks/react/)
[17] [Auth.js v5 with Next.js 16 — Complete Authentication Guide 2026 (DEV)](https://dev.to/huangyongshan46a11y/authjs-v5-with-nextjs-16-the-complete-authentication-guide-2026-2lg)
[18] [Auth.js Migrating to v5 docs](https://authjs.dev/getting-started/migrating-to-v5)
[19] [Next-Auth with a custom authentication backend (Medium)](https://sourcehawk.medium.com/next-auth-with-a-custom-authentication-backend-12c8f54ed4ce)
[20] [Race Conditions in JWT Refresh Token Rotation (DEV)](https://dev.to/silentwatcher_95/race-conditions-in-jwt-refresh-token-rotation-3j5k)
[21] [Server and Client Components (Next.js docs)](https://nextjs.org/docs/app/getting-started/server-and-client-components)
[22] [Next.js Core Web Vitals Optimization (BetterLink)](https://eastondev.com/blog/en/posts/dev/20251219-nextjs-core-web-vitals/)
[23] [Optimizing Core Web Vitals in 2024 (Vercel)](https://vercel.com/kb/guide/optimizing-core-web-vitals-in-2024)
[24] [useOptimistic — React docs](https://react.dev/reference/react/useOptimistic)
[25] [React Hook Form with Next.js 14 Server Actions (Aurora Scharff)](https://aurorascharff.no/posts/implementing-react-hook-form-with-nextjs-14-server-actions/)
[26] [react-hook-form Form Validation, Zod and Server Actions discussion](https://github.com/orgs/react-hook-form/discussions/11209)
[27] [date-fns v4 vs Temporal API vs Day.js (PkgPulse)](https://www.pkgpulse.com/guides/date-fns-v4-vs-temporal-api-vs-dayjs-date-handling-2026)
[28] [Temporal API: Replace Moment.js and date-fns 2026 (PkgPulse)](https://www.pkgpulse.com/guides/temporal-api-replace-momentjs-date-fns-2026)
[29] [libphonenumber-js npm](https://www.npmjs.com/package/libphonenumber-js)
[30] [libphonenumber-js bundle-size optimization issue (GitHub)](https://github.com/catamphetamine/libphonenumber-js/issues/344)
[31] [`useReconnectingWebSocket` reference implementation (JackLuguibin/OpenPawlet)](https://github.com/JackLuguibin/OpenPawlet/blob/main/src/console/web/src/hooks/useReconnectingWebSocket.ts)
[32] [How to Implement Reconnection Logic for WebSockets (oneuptime)](https://oneuptime.com/blog/post/2026-01-27-websocket-reconnection/view)
[33] [Optimizing React Apps: useTransition / useDeferredValue / useOptimistic (Medium)](https://medium.com/@an.chmelev/optimizing-react-apps-using-usetransition-usedeferredvalue-and-useoptimistic-for-smooth-ui-7b156ce9ea5f)
[34] [`useOptimistic` to Make Your App Feel Instant (Epic React)](https://www.epicreact.dev/use-optimistic-to-make-your-app-feel-instant-zvyuv)
[35] [Defeat race condition with next-auth jwt token refresh (gist)](https://gist.github.com/Daanieeel/6e4d07bb797de96e469d2a1129bd3891)
[36] [Rendering: Server Components (Next.js docs)](https://nextjs.org/docs/14/app/building-your-application/rendering/server-components)
[37] [useReportWebVitals (Next.js docs)](https://nextjs.org/docs/pages/api-reference/functions/use-report-web-vitals)
[38] [How to Optimize Core Web Vitals in NextJS App Router for 2025 (Makers' Den)](https://makersden.io/blog/optimize-web-vitals-in-nextjs-2025)
[39] [ARIA live regions (MDN)](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Guides/Live_regions)
[40] [Accessible notifications with ARIA Live Regions (Sara Soueidan)](https://www.sarasoueidan.com/blog/accessible-notifications-with-aria-live-regions-part-1/)
[41] [Autoplay restrictions and WebRTC (webrtcHacks)](https://webrtchacks.com/autoplay-restrictions-and-webrtc/)
[42] [Autoplay guide for media and Web Audio APIs (MDN)](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)
[43] [Optimizing Next.js Docker Images with Standalone Mode (DEV)](https://dev.to/angojay/optimizing-nextjs-docker-images-with-standalone-mode-2nnh)
[44] [Next.js Docker Example — Standalone Mode (vercel/next.js)](https://github.com/vercel/next.js/blob/canary/examples/with-docker/README.md)
[45] [next.config.js — output (Next.js docs)](https://nextjs.org/docs/pages/api-reference/config/next-config-js/output)
[46] [openapi-typescript GitHub repo](https://github.com/openapi-ts/openapi-typescript)

---

End of A01 RESEARCH. Next phase: PLAN (blocked on F05 HANDOFF).
