# A08 — Callback Scheduling UI: Research Notes

> Status: PLAN-PHASE research (May 2026)
> Researcher: PLAN agent (Sonnet 4.6)
> Codebase snapshot: branch `feat/N02-implement`

---

## 1. Existing Patterns in `web/src/app/(agent)/`

### 1.1 Route layout and shell

Agent routes live under `web/src/app/(agent)/` and share a single layout at
`web/src/app/(agent)/layout.tsx` which simply wraps children in `<AgentShell>`.

`AgentShell` (`web/src/app/(agent)/AgentShell.tsx`) does three things:

1. Bootstraps the auth session from an httpOnly cookie (`refreshAccessToken`)
   before routing to `/login`. This means every `(agent)` page is
   server-side-rendered as a shell stub and hydrated client-side — the page
   component must be `"use client"` or a pure Server Component that delegates
   to a `"use client"` child.

2. Wraps children in `<SipProvider>` so that SIP.js hooks (via `useSoftphone`)
   are available everywhere inside the agent shell.

3. Mounts `<AgentShellInner>` which calls `useAgentStateSync()` (A03 WS sync),
   then renders `<TopNav> / <SideNav> / <main> / <StatusBar> / <HotkeyHelpOverlay>`.

**Pattern for new agent pages:** The page file at
`web/src/app/(agent)/<route>/page.tsx` should be a **Server Component** exporting
`metadata` and delegating to a `"use client"` child component. See
`web/src/app/(agent)/leads/page.tsx` for the stub pattern, or
`web/src/app/(agent)/callbacks/page.tsx` which is the current placeholder:

```tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
export const metadata = { title: "Callbacks" };
export default function CallbacksPage(): React.ReactElement {
  return (
    <Card><CardHeader><CardTitle>Callbacks</CardTitle></CardHeader>
      <CardContent><p>…</p></CardContent>
    </Card>
  );
}
```

A08 replaces this stub with the real `CallbackList` client component.

### 1.2 The SideNav already links to `/callbacks`

`web/src/components/shell/SideNav.tsx` already includes
`{ label: "Callbacks", href: "/callbacks" }` in `AGENT_LINKS`, so the nav entry
is already wired — A08 only needs to implement the page.

### 1.3 Auto-dial page as the richest agent-page pattern

`web/src/app/(agent)/auto/_components/AutoDialShell.tsx` is the most complete
agent-page example in the codebase. Key patterns to copy:

- **`createReconnectingWs`** is called in a `useEffect` keyed to `wsToken`.
  It returns a `ReconnectingWs` object with `.subscribe(eventType, handler)`.
  WS events arrive as `{ type, seq, ts, data }`.
- Reducers use `React.useReducer` with a pure discriminated-union state machine.
- Hotkeys are registered via `useHotkeys` from `web/src/lib/hotkeys/useHotkeys.ts`.
- Multi-tab dedup uses `BroadcastChannel`.

For A08 the WS subscribe pattern is simpler (no per-tab arbitration needed —
callback due events are per-agent, not per-tab). The A03 multi-tab strategy
already deduplicates reservation events via `BroadcastChannel`; A08 follows
the same convention for the `callback_due` event.

### 1.4 DispositionPicker — the trigger point for CallbackPicker

`web/src/components/call/DispositionPicker.tsx` already has an inline
datetime-local callback section gated on a checkbox. A08 replaces this with a
proper `<CallbackPicker>` modal. The dispo picker currently calls
`useDispositionPicker().submit({ callbackAt })` which posts the callback_at to
`/api/agent/dispo` and lets the server-side dispo handler schedule the callback
(not the D06 route directly). **A08's `<CallbackPicker>` is an independent
modal that calls the D06 route directly** (`POST /api/agent/callbacks`) and is
triggered from the dispo screen when the agent selects a "CALLBK" status.

The existing `CallbackScheduler` component
(`web/src/components/call/CallbackScheduler.tsx`) is a simpler predecessor. It:
- Uses `apiFetch` with a wrong path (`/api/agent/lead/:id/callbacks` does not
  exist in D06 — the real path is `POST /api/agent/callbacks`).
- Has no TCPA warning display, no snooze, no validation error messages.

**A08 replaces `CallbackScheduler` with `CallbackPicker`** (more capable modal)
and the old component is left for backward compat or deleted.

### 1.5 Notifications page pattern

`web/src/components/notifications/NotificationsPage.tsx` and its supporting
hook `web/src/lib/hooks/useNotifications.ts` show how the A07 notification
system works:

- The hook does an initial fetch from `/api/notifications?limit=20`.
- It attaches a `message` event listener to the raw `wsRef` for
  `notifications.new` events.
- `useNotify` (`web/src/lib/hooks/useNotify.ts`) wraps `useToast` from
  `web/src/components/ui/toast.tsx` and exposes typed `success/warning/danger/info`
  helpers.

A08's due-callback toast uses `useNotify().warning()` for the toast body, with
`duration: 0` so it stays until dismissed or clicked.

---

## 2. Existing shadcn/ui Components Available

All components are custom-built to match the project's Tailwind CSS v4 design
tokens. No Radix primitives are used directly. Available at
`web/src/components/ui/`:

| File | What it provides |
|---|---|
| `button.tsx` | `<Button>` with variants: `primary/secondary/ghost/destructive/link`, sizes: `sm/md/lg/icon` |
| `input.tsx` | `<Input>` styled form input |
| `label.tsx` | `<Label>` form label |
| `dialog.tsx` | `<Dialog open onOpenChange>`, `<DialogContent>`, `<DialogHeader>`, `<DialogTitle>`, `<DialogDescription>` |
| `card.tsx` | `<Card>`, `<CardHeader>`, `<CardTitle>`, `<CardContent>` |
| `badge.tsx` | `<Badge>` with tones: `neutral/brand/success/warning/danger` |
| `skeleton.tsx` | `<Skeleton>` loading placeholder |
| `toast.tsx` | `<Toaster>` provider + `useToast()` hook + `Toast` type |

`<Dialog>` is particularly important: it uses a context-based open/close pattern
and renders a `role="dialog" aria-modal="true"` overlay. The dialog backdrop
dismisses on click, but we need to prevent that for the "are you sure?" cancel
confirmation.

**No react-day-picker, no date-fns, no dayjs in the package.json.** The project
uses native `<input type="datetime-local">` in all existing components
(`CallbackScheduler`, `DispositionPicker`). A08 **must follow the same pattern**
and avoid new library dependencies.

---

## 3. D06 Callbacks API Surface

### 3.1 Route map (from `api/src/callbacks/index.ts`)

```
POST   /api/agent/callbacks                  create (agent)
GET    /api/agent/callbacks/mine             list own pending/live
POST   /api/agent/callbacks/:id/snooze       re-schedule
POST   /api/agent/callbacks/:id/cancel       cancel own
POST   /api/agent/callbacks/:id/claim        GLOBAL → AGENT pin

GET    /api/admin/callbacks                  list (supervisor+)
GET    /api/admin/callbacks/aggregate        counts
POST   /api/admin/callbacks/:id/reassign     single reassign
POST   /api/admin/callbacks/bulk-reassign    bulk reassign
POST   /api/admin/callbacks/bulk-cancel      bulk cancel
GET    /api/admin/callbacks/export           CSV
```

### 3.2 Response shape (from `serializeCallback` in service.ts)

```ts
{
  id: string,              // bigint as string
  tenant_id: string,
  lead_id: string,
  campaign_id: string,
  user_id: string | null,  // null = GLOBAL scope
  scope: "AGENT" | "GLOBAL",
  callback_at: string,     // ISO-8601
  status: "PENDING" | "LIVE" | "DONE" | "DEAD",
  comments: string | null,
  lead_tz_iana: string | null,    // from lead.knownTimezone
  created_at: string,
  updated_at: string,
  // GET /mine also includes firstName, lastName, phoneE164 in lead join
}
```

The `listMineCallbacks` query includes lead relation:
`select: { knownTimezone, firstName, lastName, phoneE164 }` — these will be
included in the serialized shape.

### 3.3 Create request body

```ts
{
  lead_id: bigint,         // required
  campaign_id: string,     // required, max 32 chars
  callback_at: string,     // ISO-8601 UTC, must be ≥5 min in future, ≤1 year
  agent_only: boolean,     // default false
  user_id?: bigint,        // only if supervisor assigning to specific agent
  comments?: string,       // max 255 chars
}
```

Response on 201:
```ts
{ ...callback, tcpa_warning?: { outcome, nextOpen?, reason? } }
```

### 3.4 Snooze request body

```ts
{ callback_at: string, comments?: string }
```

Same validation: `callback_at` must be ≥5 min future, ≤1 year.

### 3.5 Cancel — no body, returns `{ cancelled: true }`

### 3.6 Mine list query params

`GET /api/agent/callbacks/mine?cursor=<bigint>&limit=<1-200>`

Response:
```ts
{ callbacks: Callback[], next_cursor: string | null }
```

Sorted by `status asc, callbackAt asc` (LIVE before PENDING alphabetically).

### 3.7 TCPA validation stub (important for UI)

The service currently returns `ALLOW` for all TCPA checks (C01 not yet
implemented). The response includes `tcpa_warning` only when outcome is not
`ALLOW`. The UI must handle `tcpa_warning` gracefully even though Phase 1 will
never show it — this is forward-proofing for when C01 ships.

TCPA window is 8am–9pm called-party local time. The UI should display the
called-party's local time alongside the scheduled time so the agent can
self-check, and show a yellow warning banner if the scheduled time falls outside
8am–9pm in `lead_tz_iana`.

### 3.8 State machine (from `api/src/callbacks/state-machine.ts`)

Transitions: `PENDING → LIVE → DONE`, `PENDING → DEAD`, `LIVE → DEAD`,
`PENDING → PENDING` (snooze). The agent-facing UI only ever sees `PENDING` and
`LIVE` (the mine list filters for those). `LIVE` means a worker has "fired" the
callback and is actively trying to connect. DONE/DEAD are terminal.

---

## 4. A07 Notification System — How It Works

### 4.1 Toast infrastructure

`web/src/components/ui/toast.tsx` — custom `<Toaster>` provider that maintains
a `Toast[]` array in local state. `useToast()` returns `{ toast, dismiss }`.

`web/src/lib/hooks/useNotify.ts` — typed wrapper: `.success/.warning/.danger/.info`.

`<Toaster>` is mounted at root in `web/src/app/providers.tsx` inside `<Providers>`.
Any component inside the app can call `useToast()` or `useNotify()`.

The toast component renders `role="status"` (or `role="alert"` for danger),
`aria-live="polite"` at region level.

**Default duration is 4 seconds.** Persistent toasts need `duration: 0` and
must be manually dismissed.

### 4.2 WebSocket event flow

The `createReconnectingWs` utility (`web/src/lib/ws.ts`) creates a singleton
WebSocket with:
- Auto-reconnect with jitter backoff (1s base, 30s max)
- Heartbeat ping/pong (25s interval, 35s watchdog)
- Resume-from-seq on reconnect (`op: "resume", payload: { from: lastSeq }`)
- Subscribe by event type: `ws.subscribe("callback_due", handler)`
- Wildcard subscription: `ws.subscribe("*", handler)`

The WS token is from `useAuthStore(s => s.wsToken)`.

### 4.3 Per-agent WS channel for callbacks

`api/src/callbacks/events.ts` shows `notifyAgent(redis, tenantId, userId, payload)`
which publishes to `t:{tenantId}:ws:user:{userId}`. The WS gateway (not in this
codebase tree) subscribes and fans out to the agent's active WebSocket
connection. A08 subscribes to `callback_due` events on the shared WS connection.

The WS event type for callback firing is **`callback_due`** (the worker will
emit this when it transitions a callback to LIVE). The exact event data shape
should be:

```ts
{
  type: "callback_due",
  data: {
    callback_id: string,
    lead_id: string,
    lead_name: string,    // firstName + lastName
    phone: string,        // phoneE164
    callback_at: string,  // ISO
    comments: string | null
  }
}
```

(This is the expected contract from the D06 events module; the WS gateway is
responsible for relaying Redis pub/sub to the browser WS. The exact event data
fields should be confirmed with the D06/gateway team but the above is consistent
with `serializeCallback`.)

**Note on poll fallback:** Because `useNotifications.ts` shows WS subscription
has some fragility (it attaches to `wsRef.current` which may be null), A08's
`useCallbacksDue` hook should also implement a 30-second poll fallback: if no
WS event has been received within 30s of a callback's `callback_at`, re-fetch
the mine list to detect newly-LIVE callbacks. This avoids missed toasts on
reconnect gaps.

### 4.4 Multi-tab dedup

A08 uses `BroadcastChannel("vici2-callbacks")` to deduplicate
`callback_due` toasts across tabs. The tab that first fires the toast posts
`{ event: "callback_due_shown", callback_id }` to the channel; other tabs
suppress the toast if they receive this message.

---

## 5. Date/Time Picker — Library Decision

**Decision: use native `<input type="datetime-local">` — no new library.**

Rationale:
- No date-picker library is in `web/package.json`. The codebase (`CallbackScheduler`,
  `DispositionPicker`) uses `<input type="datetime-local">` universally.
- Adding `react-day-picker` would require a new package install, adds ~30KB
  gzipped, and the project spec says "trust existing patterns."
- `datetime-local` has adequate browser support (all modern browsers) and is
  accessible via the native date-picker widget with keyboard support.
- A custom time-only input alongside a date selector is unnecessary complexity.

**Time display format:** `Intl.DateTimeFormat` with the agent's local timezone
(from `Intl.DateTimeFormat().resolvedOptions().timeZone`) for the list view,
plus a secondary display in the called-party's timezone (`lead_tz_iana`). Both
are computed client-side without a library.

**TCPA check:** Compute whether the selected `datetime-local` value falls
outside 8am–9pm in `lead_tz_iana`. This is done with:

```ts
function isOutsideTcpaWindow(isoUtc: string, leadTzIana: string | null): boolean {
  if (!leadTzIana) return false;
  const d = new Date(isoUtc);
  const hour = parseInt(
    new Intl.DateTimeFormat("en-US", {
      timeZone: leadTzIana,
      hour: "numeric",
      hour12: false,
    }).format(d),
    10,
  );
  return hour < 8 || hour >= 21; // before 8am or at/after 9pm
}
```

No date-fns or dayjs needed.

---

## 6. Timezone Display Strategy

### 6.1 Agent's local timezone

Used for all time display on the list page and in the modal default value.
Obtained via `Intl.DateTimeFormat().resolvedOptions().timeZone`.

Format: `"h:mm a, MMM d"` equivalent via `Intl.DateTimeFormat` with `{ hour, minute, month, day }`.

### 6.2 Called-party local timezone

Each `Callback` object includes `lead_tz_iana` (from `lead.knownTimezone`). This
is an IANA timezone string (e.g., `"America/Chicago"`). When non-null, the UI
should show a secondary "Lead's local time: 3:00 PM CDT" note below the
primary agent-local time.

### 6.3 TCPA warning display

If `isOutsideTcpaWindow(callbackAt, lead_tz_iana)` is true, show a yellow
`<Badge tone="warning">Outside TCPA window</Badge>` on the `CallbackRow` and a
prominent amber banner in the `CallbackPicker` modal below the time input.

The server currently always returns `ALLOW` for TCPA (C04 stub), but the API
may return `tcpa_warning` in the create response. If present, display a yellow
banner after successful submission: "Note: this callback may fall outside
8am-9pm for the lead's timezone."

---

## 7. Accessibility (WCAG 2.2 AA)

### 7.1 Modal (CallbackPicker)

- `role="dialog"` with `aria-modal="true"` (already in `DialogContent`).
- `aria-labelledby` pointing to the `<DialogTitle>` id.
- Focus trap: on mount, focus first focusable element (datetime input); on
  close, return focus to the trigger button.
- Escape key closes the modal (matches existing `NotificationBell` behavior).
- Tab order follows visual order: datetime input → scope radio → comments →
  cancel → submit.
- Error messages use `role="alert"` so screen readers announce them immediately.
- TCPA warning uses `role="status"` (informational, not blocking).

### 7.2 List page (CallbackList)

- Use a `<table>` or `role="list"` / `role="listitem"` for the callback rows.
- Column headers with `scope="col"`.
- Action buttons in each row: `aria-label="Cancel callback for {leadName}"` and
  `aria-label="Snooze callback for {leadName}"`.
- Loading skeleton: `aria-busy="true"` on the list container.
- Empty state: plain text message in a `<p>`.

### 7.3 Toast / DueCallbackToast

- Rendered in `role="alert"` (urgent) with `aria-live="assertive"`.
- Two action buttons: "Dial now" and "Snooze".
- Must be keyboard-reachable (not just a floating overlay with pointer events).
- Dismiss on Escape (follows `NotificationBell` pattern).

### 7.4 SnoozeMenu

- Rendered as a `<ul role="menu">` dropdown anchored below the Snooze button.
- Menu items: `role="menuitem"`, arrow-key navigation.
- Closes on outside click or Escape.

### 7.5 Color contrast

Use existing design tokens: `--color-state-error` for danger, `--color-state-hold`
for warning (amber), `--color-state-idle` for info (blue). All token values have
been verified against WCAG AA contrast ratios in the design system.

---

## 8. Mobile / Responsive Considerations

The agent shell uses a collapsible sidebar (`SideNav`) that collapses to 48px
(`w-12`) on toggle. The main content area is `flex-1 overflow-auto p-6`.

For A08 the page needs to handle narrow viewports (1024px+ is the target, but
tablet support at 768px is desirable):

- **CallbackList:** Table layout on ≥768px; on narrower breakpoints, collapse
  to a card-per-row layout using responsive Tailwind classes.
- **CallbackPicker modal:** Fixed-width `max-w-md` (448px), centered — same as
  existing `DialogContent`. On narrow viewports this auto-sizes to `w-full` with
  `mx-4` padding.
- **DueCallbackToast:** Fixed to bottom-center, `max-w-sm` — same as existing
  toast region. On mobile, expands to `w-full px-4`.
- **SnoozeMenu:** Positioned absolute below the trigger. On narrow viewports,
  may need to flip upward if near screen bottom (use CSS `position: relative` +
  overflow check).

Touch targets: all interactive elements must be ≥44×44px per WCAG 2.5.5.
Existing `<Button size="md">` is `h-9` (36px) — A08 should use `size="lg"`
(`h-10`, 40px) for the toast action buttons, or add explicit padding.

---

## 9. D06 API Response — PII Fields

The following fields in the callback response are considered PII:

| Field | PII type |
|---|---|
| `lead_id` | Indirect identifier |
| `lead.firstName`, `lead.lastName` | Direct PII |
| `lead.phoneE164` | Direct PII (phone number) |
| `comments` | May contain PII if agent typed caller details |

**Frontend handling:**
- Do not log these fields to the browser console.
- Do not store in `localStorage` or `sessionStorage` (Zustand stores used for
  callbacks should use in-memory state only, no `persist` middleware).
- Display lead name as `{firstName} {lastName}` — avoid concatenating with
  lead_id in URLs (use `id` for the callback id, not lead_id, in route params).

---

## 10. How the Existing `CallbackScheduler` Relates to A08

`web/src/components/call/CallbackScheduler.tsx` is an early stub that:
- Posts to a non-existent route (`/api/agent/lead/${lead.id}/callbacks`).
- Has no TCPA display, no scope picker, no validation beyond the input itself.
- Is not used from the DispositionPicker (which has its own inline datetime-local).

**A08's `CallbackPicker` replaces this component.** The old component should be
either:
1. Deleted and references in the dispo screen updated to `<CallbackPicker>`, or
2. Left as a stub and `DispositionPicker` updated to use `<CallbackPicker>`.

Option 2 is lower risk during initial implementation.

---

## 11. How D06 Redis Events Reach the Browser WS

The event flow is:

```
D06 service.ts
  → publishCallbackEvent(redis, { type: "callback_scheduled", ... })
      → redis.xadd("events:vici2.callback.callback_scheduled", ...)
  → notifyAgent(redis, tenantId, userId, payload)
      → redis.publish("t:{tenantId}:ws:user:{userId}", JSON.stringify(payload))
```

The WS gateway (separate service, not in this repo) subscribes to the Redis
pub/sub channel and fans out to browser WebSocket connections. The browser WS
receives messages as `{ type, seq, ts, data }` matching `WsEvent<T>` from
`web/src/lib/ws.ts`.

For A08, the relevant event is the callback-due signal. When a callback worker
fires a callback (transitions `PENDING → LIVE`), it must emit a
`callback_due` event to the agent's WS channel. A08 expects:

```ts
{
  type: "callback_due",
  data: {
    callback_id: string,
    lead_id: string,
    lead_name: string,
    phone: string,
    callback_at: string,
    comments: string | null,
  }
}
```

If the worker does not yet emit `callback_due`, A08's hook can detect LIVE
callbacks by polling `GET /api/agent/callbacks/mine` and comparing against the
previously-known state.

---

## 12. Open Questions

1. **Does the D06 worker emit `callback_due` WS events?** The `events.ts` module
   shows `notifyAgent` and `publishCallbackEvent` helpers, but the worker (not in
   scope for A08) may or may not have been updated to call them at LIVE
   transition. A08 must implement poll-based fallback in case WS events are
   absent.

2. **Exact WS event data shape for `callback_due`?** Need confirmation from
   D06/gateway team. A08 assumes the shape listed in §11 above.

3. **Should `CallbackScheduler.tsx` be deleted?** It has an incorrect API path.
   Recommend deletion and updating the dispo screen to use `<CallbackPicker>`.

4. **Campaign ID for scheduling.** The D06 create endpoint requires `campaign_id`.
   When called from the dispo screen, `useCallStore(s => s.campaign?.id)` provides
   it. When called from the `/callbacks` list page (re-schedule), the campaign_id
   must come from the existing callback record (already present in the response).
   When called from outside a call context, the agent may need to select a campaign.

5. **`claim` action in the UI.** The D06 API has `POST /api/agent/callbacks/:id/claim`
   (GLOBAL → AGENT pin). Should the `/callbacks` list page show GLOBAL-scope
   callbacks and allow agents to claim them? The `listMineCallbacks` service only
   returns callbacks where `userId = actor.uid` — so GLOBAL callbacks are not
   shown to agents by default. Clarify whether agents should see claimable
   callbacks. For Phase 1, assume "mine only" (no claim UI needed).

6. **`lead_id` vs `callback_id` in the dial action.** When an agent clicks "Dial
   now" in the toast, should the system dial `lead.phoneE164` directly (via
   manual dial) or navigate to the lead's page? Recommend navigating to
   `/call?lead_id={lead_id}` and triggering manual dial from there, consistent
   with how existing manual dial works (`/api/agent/manual_dial`).

7. **Snooze maximum.** The spec says "snooze max". D06 `validateCallbackAt`
   accepts up to 1 year. Reasonable UX max for snooze is 24h with quick options
   of 30min / 1h / 3h / tomorrow 9am. No server-side snooze-specific limit;
   validation reuses the same ≥5min-future rule.

8. **Supervisor `callback:edit` vs agent `callback:edit`.** Both roles have
   `callback:edit` in the RBAC matrix, but at different scopes (`group` vs
   `own`). The A08 list page for supervisor/admin (if ever needed) would use
   `GET /api/admin/callbacks`. For Phase 1, A08 is agent-only; the admin view is
   out of scope.

9. **I04 inbound callback queue.** I04 (inbound IVR engine, being implemented in
   parallel) may add a separate callback queue table for inbound-requested
   callbacks. A08 does not consume I04 data in Phase 1 — it consumes only D06's
   outbound callback table.

10. **`datetime-local` input and timezone.** Native `datetime-local` inputs
    submit values in the **browser's local timezone** (no offset). The A08 hook
    must convert to UTC before posting to the API:
    `new Date(dateTimeLocalValue).toISOString()`. This is correct as long as the
    agent's browser is set to their correct local timezone. The UI should display
    a timezone label next to the input ("Your time: America/Chicago") to reduce
    confusion.
