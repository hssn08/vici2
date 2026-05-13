# A01 — Next.js skeleton + auth: HANDOFF

**Date:** 2026-05-13
**Status:** ready for downstream consumption (A02–A09, M01, S01).

This document is the *frozen public surface* of module A01. Downstream
modules import from these paths and rely on these contracts; A01 will
not change them without an RFC.

---

## 1. Route map

| Route | Group | Render | Owner |
|---|---|---|---|
| `/` | root | redirect → `/home` | A01 |
| `/home` | root | role-routed bouncer (client) | A01 |
| `/login` | `(public)` | server shell + `<LoginForm/>` (client) | A01 |
| `/forgot-password` | `(public)` | static shell | A01 |
| `/unauthorized` | root | static | A01 |
| `/dashboard` | `(agent)` | server (rendered by `<AgentShell/>`) | A01 → A02–A09 widgets |
| `/dial` | `(agent)` | server placeholder | **A04** |
| `/call` | `(agent)` | client placeholder | **A05** |
| `/leads` | `(agent)` | server placeholder | **D01** |
| `/callbacks` | `(agent)` | server placeholder | **A08** |
| `/settings` | `(agent)` | client (UI prefs) | A01 → A06 / A09 enrich |
| `/admin` | `(admin)` | placeholder | **M01** |
| `/sup` | `(sup)` | placeholder | **S01** |
| `/api/health` | api | `{status,service}` | A01 (kept from F01) |
| `/api/metrics` | api | Prometheus text | F01 |

Middleware (`src/middleware.ts`) gates every non-public path on the
`sx_user` cookie (presence today; F05-signed JWT verification once the
secret/JWKS lands).

---

## 2. Auth contract (the only side the rest of the app sees)

Imports from `@/lib/auth`:

```ts
import {
  login,
  logout,
  refreshAccessToken,
  subscribeAuthEvents,
  AuthError,
} from "@/lib/auth";

login(email: string, password: string): Promise<SessionUser>
logout(): Promise<void>
refreshAccessToken(): Promise<RefreshResponse | null>   // single-flight
subscribeAuthEvents(handler: (msg: AuthEvent) => void): () => void
```

Backed by `useAuthStore`:

```ts
import { useAuthStore } from "@/lib/stores/auth";

interface AuthState {
  accessToken: string | null;     // JWT in memory, never persisted
  accessExp: number | null;       // unix seconds
  wsToken: string | null;         // aud=ws JWT for lib/ws.ts
  user: SessionUser | null;
  sipCreds: SipCreds | null;
  status: "unauthenticated" | "authenticated" | "refreshing" | "logging-out";
  lastError: { code: string; message: string } | null;
  setSession, setRefreshing, setError, clearSession
}
```

Endpoints expected from F05 (paths under `NEXT_PUBLIC_API_URL`):

- `POST /api/auth/login` → `{ access_token, access_exp?, ws_token?, ws_exp?, user, sip_creds? }` + `Set-Cookie: refresh_token`, `Set-Cookie: sx_user`.
- `POST /api/auth/refresh` → `{ access_token, access_exp?, ws_token?, ws_exp? }` + rotates cookies.
- `POST /api/auth/logout` → 204; clears all three cookies.

All requests go out with `credentials: 'include'`. Both snake_case and
camelCase keys in `sip_creds` are accepted (see `_internal.normalizeSipCreds`).

Cross-tab sync uses `BroadcastChannel('vici2.auth')` with messages
`{event:'login', userId}` or `{event:'logout'}`. Browsers without BC
fall back silently (handled in the channel factory).

---

## 3. API client

```ts
import { api, apiFetch, ApiError } from "@/lib/api";

api.get<T>(path, opts?): Promise<T>
api.post<T>(path, body?, opts?): Promise<T>
api.put<T>(path, body?, opts?): Promise<T>
api.patch<T>(path, body?, opts?): Promise<T>
api.delete<T>(path, opts?): Promise<T>

apiFetch<T>(path: string, options?: ApiRequestOptions): Promise<T>
```

Behaviour:

- Auto-prefixes `NEXT_PUBLIC_API_URL` when `path` starts with `/`.
- Injects `Authorization: Bearer <accessToken>` from `useAuthStore`.
- Injects `X-Vici2-Tenant: <user.tenantId>`.
- `credentials: 'include'` always.
- On 401 → calls `refreshAccessToken()` → retries once with the new
  token. A second 401 triggers `clearSession()` and propagates the
  error.
- Throws typed `ApiError(code, message, status, details)` for non-2xx
  responses. The contract follows SPEC.md §3.5: server returns
  `{code, message, details?}`.

Downstream modules wrap their feature endpoints around `api.*`. When
the OpenAPI spec is published (after F05 ships), `lib/api/` will be
re-implemented behind the same facade using `openapi-fetch`; no caller
changes will be required.

---

## 4. WebSocket client

```ts
import { createReconnectingWs } from "@/lib/ws";
import { useWsStore } from "@/lib/stores/ws";

const ws = createReconnectingWs({
  url: () => getWsUrl(),                       // from @/lib/env
  token: () => useAuthStore.getState().wsToken,
});

ws.start();
const off = ws.subscribe<CallEvent>("call.update", (e) => {...});
ws.send({ op: "subscribe", payload: { channels: ["agent.events"] } });
ws.stop();
```

Behaviour:

- Auth via `?token=<wsToken>` query param (per PLAN §6.2; subprotocol
  rejected).
- Exponential backoff `1 s → 30 s` with ±25 % jitter.
- 25-second `ping`/`pong` heartbeat; pong watchdog at 35 s forces
  reconnect.
- Bounded outbound queue (default 100, drops oldest on overflow).
- Resume cursor: on reconnect sends `{op:"resume", from:lastSeq}` if
  the store has a non-zero `lastSeq`.
- Test-friendly: pass `webSocketImpl: typeof WebSocket` to swap in a
  mock; `_backoffFor`, `_state`, `_queueSize` are exposed for unit
  tests.

`useWsStore` exposes connection state for UI (`connecting`, `open`,
`reconnecting`, …) and `lastSeq`, `pendingOutbound`, `lastPongAt`.

---

## 5. Stores

| Store | File | Middleware | Notes |
|---|---|---|---|
| `useAuthStore` | `lib/stores/auth.ts` | — | session-only, never persisted |
| `useCallStore` | `lib/stores/call.ts` | `subscribeWithSelector` | call phase, mute, recording, lastEventSeq |
| `useAgentStore` | `lib/stores/agent.ts` | `subscribeWithSelector` | ready/paused/busy/wrapup |
| `useWsStore` | `lib/stores/ws.ts` | — | WS connection status |
| `useUiStore` | `lib/stores/ui.ts` | `persist` (`vici2.ui`, v1) | theme, density, sidebar, volume, lastUsedDispoCode |

A02 writes to `useCallStore` from SIP.js callbacks. A03 writes to
`useCallStore` and `useAgentStore` from WebSocket events via
`patchFromEvent`. A09 writes to `useAgentStore.setPause`/`clearPause`.
A06 writes `useUiStore.lastUsedDispoCode`.

---

## 6. Design system / components

UI primitives under `@/components/ui/`:

- `Button` (variants: primary, secondary, ghost, destructive, link; sizes sm/md/lg/icon; `loading` prop)
- `Input`, `Label`
- `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`
- `Badge` (tones: neutral, brand, success, warning, danger)
- `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogDescription`
- `Skeleton`
- `Toaster` + `useToast()` hook (Sonner-style, `aria-live` region)

Auth components under `@/components/auth/`:

- `<LoginForm />` (already mounted on `/login`)
- `<LogoutButton />`

Call components under `@/components/call/`:

- `<CallStatePill phase={CallPhase} />`
- `<AgentStateToggle />` (A09 will swap the simple toggle for a pause-code picker)

Shell components under `@/components/shell/`:

- `<TopNav />` — top bar with brand, theme toggle, logout, user
- `<SideNav />` — collapsible left nav driven by `useUiStore.sidebarCollapsed`
- `<StatusBar />` — bottom bar showing agent / call / WS state

Providers under `@/components/providers/`:

- `<ThemeProvider />` — applies `class="dark"` to `<html>` based on
  `useUiStore.theme` (`system` follows `prefers-color-scheme`)
- `<AuthRefreshScheduler />` — proactive refresh 60 s before expiry,
  focus/visibility/online opportunistic refresh, cross-tab logout
  listener.

Root client island is `<Providers>` in `src/app/providers.tsx`. Wrap
new client islands inside it; do not add `'use client'` to layouts.

---

## 7. Design tokens (Tailwind v4 `@theme`)

Defined in `src/app/globals.css`:

```
--color-brand-{50,100,200,300,400,500,600,700,800,900}
--color-state-{idle,ringing,active,hold,wrap,dispo,transfer,error}
--color-surface, --color-surface-muted, --color-surface-elevated, --color-surface-border
--color-fg, --color-fg-muted
--radius-pill, --radius-card
--font-sans, --font-mono
```

Use via Tailwind arbitrary-value classes: `bg-[var(--color-brand-600)]`,
`text-[var(--color-fg-muted)]`. Dark mode is `@custom-variant dark`;
toggled via the `dark` class on `<html>` by `ThemeProvider`.

Animations: `.animate-ringing-pulse`, `.animate-dispo-bounce`,
`.animate-spin-slow`. Add new motion utilities to `globals.css` `@layer
utilities`.

---

## 8. Environment

Public env (validated by `src/lib/env.ts` at boot):

| Var | Default | Used by |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | `lib/api`, `lib/auth` |
| `NEXT_PUBLIC_WS_URL` | derived `ws[s]://<api host>/ws` | `lib/ws` (`getWsUrl`) |
| `NEXT_PUBLIC_FS_WSS` | unset (consumed by A02) | A02 SIP.js |

Server env (Edge middleware will consume once F05 publishes it):

| Var | Notes |
|---|---|
| `SX_USER_COOKIE_SECRET` | HMAC HS256 secret minted by F05; A01 middleware will verify via `jose.jwtVerify` once available. Today middleware does presence-only. |

---

## 9. Testing entrypoints for downstream

- Vitest config: `vitest.config.ts`. Tests live under
  `src/test/unit/`. Run with `pnpm --filter @vici2/web test`.
- jsdom `setupFiles`: `src/test/setup.ts` injects `BroadcastChannel`
  and `fetch` polyfills.
- Mock fetch by stubbing `globalThis.fetch` with a `vi.fn()` — see
  `src/test/unit/lib.api.test.ts` for the pattern.
- Mock `next/navigation` by `vi.mock(...)` (see
  `src/test/unit/components.LoginForm.test.tsx`).

E2E (Playwright) is **not** installed by A01; the first module that
needs end-to-end coverage installs it.

---

## 10. Hand-off summary by module

| Downstream | Surface A01 hands over |
|---|---|
| **A02 SIP.js** | `useAuthStore.sipCreds`, slot under `/call`, `<AgentShell/>` mount point in `(agent)/layout.tsx`. A02 creates `src/lib/sip/` and exports `useSipPhone()`. |
| **A03 WebSocket events** | `lib/ws.ts` + `useWsStore`. A03 adds typed event schemas and registers protocol-versioned subscriptions. |
| **A04 Manual dial** | `(agent)/dial/page.tsx` is an empty card; A04 fills it. RHF + zod arrives with A04. |
| **A05 Live call panel** | `(agent)/call/page.tsx` skeleton + `<CallStatePill/>`. A05 fills the panel; A02 plugs in audio. |
| **A06 Dispo + hotkeys** | `useUiStore.lastUsedDispoCode` is reserved. A06 adds a `<KeyboardListenerProvider/>` under `<Providers/>`. |
| **A07 Transfers** | UI slot inside `(agent)/call/page.tsx`; WS command pattern via `ws.send({op:'transfer'})`. |
| **A08 Callbacks** | `(agent)/callbacks/page.tsx` placeholder; TanStack Query arrives with A08. |
| **A09 Pause codes** | `<AgentStateToggle/>` ships with a simple toggle; A09 swaps in the pause-code picker and wires `useAgentStore.setPause`. |
| **M01 Admin UI** | `(admin)/admin/page.tsx` placeholder + reuse of `lib/{auth,api}`, all `components/ui/*`, `middleware.ts`. |
| **S01 Wallboard** | `(sup)/sup/page.tsx` placeholder + `lib/ws.ts`. |

---

## 11. What is *not* in A01 (deferred)

- TanStack Query, TanStack Table/Virtual (lands with the first
  data-list module).
- `react-hook-form` (lands with A04 manual-dial; LoginForm refactors to
  shadcn `<Form>` then).
- shadcn CLI generation — current primitives are hand-vendored,
  drop-in compatible with shadcn upgrades.
- `openapi-fetch` + `openapi-typescript` — waiting on the F-API
  OpenAPI document.
- Playwright + axe-core + Lighthouse-CI — first PR that needs
  end-to-end coverage installs them.
- jose-based JWT verify in `middleware.ts` — waiting on F05’s
  `SX_USER_COOKIE_SECRET` publish.

All of these are non-blocking: every place they will plug in has a
named slot or facade today.
