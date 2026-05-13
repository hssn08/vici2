# A08 — Callback Scheduling UI: Implementation Plan

> Status: PLAN (ready for IMPLEMENT agent)
> Branch target: `feat/A08-implement`
> Based on: D06 callbacks API, A02-A07 agent shell, F05 RBAC
> Date: May 2026

---

## 0. Executive Summary

A08 implements the agent-facing UI for scheduling, viewing, snoozing, and
canceling outbound callbacks. It consists of five surface areas:

1. **`CallbackPicker` modal** — triggered from the dispo screen (A04) when an
   agent selects the "CALLBK" disposition or explicitly clicks "Schedule
   Callback". Posts to `POST /api/agent/callbacks`.

2. **`/callbacks` list page** — shows the agent's own PENDING and LIVE
   callbacks, sorted by urgency. Supports snooze and cancel inline.

3. **`DueCallbackToast`** — a persistent, urgent toast triggered when a callback
   transitions to LIVE status (WS event or poll). Contains "Dial now" and
   "Snooze" actions.

4. **`SnoozeMenu`** — dropdown with preset snooze durations (30min, 1h, 3h,
   Tomorrow 9am) and a custom datetime picker option.

5. **`useCallbacks` hook** — shared state management: list fetching, WS
   subscription, optimistic updates.

**No new npm packages required.** The implementation uses existing primitives:
Zustand (^5.0.1), `apiFetch`, `createReconnectingWs`, shadcn/ui components
(`Dialog`, `Button`, `Badge`, `Card`, `Skeleton`, `Toast`), and native
`<input type="datetime-local">`.

Estimated total LOC: ~1,050 lines (excluding tests).

---

## 1. File Inventory

### 1.1 Web pages

| File | Purpose |
|---|---|
| `web/src/app/(agent)/callbacks/page.tsx` | Replace stub → renders `<CallbackListClient>` |

### 1.2 New components

| File | Purpose | LOC est. |
|---|---|---|
| `web/src/components/call/CallbackPicker.tsx` | Modal: schedule callback | ~200 |
| `web/src/components/call/CallbackList.tsx` | Agent's callback list (client component) | ~180 |
| `web/src/components/call/CallbackRow.tsx` | Single row in the list | ~120 |
| `web/src/components/call/SnoozeMenu.tsx` | Dropdown with preset snooze options | ~100 |
| `web/src/components/call/CallbackToast.tsx` | Persistent toast for due callbacks | ~120 |

### 1.3 New hooks

| File | Purpose | LOC est. |
|---|---|---|
| `web/src/lib/hooks/useCallbacks.ts` | List fetch, WS subscription, mutations | ~180 |
| `web/src/lib/hooks/useCallbackPicker.ts` | Form state + submit logic for picker modal | ~100 |
| `web/src/lib/hooks/useCallbacksDue.ts` | WS subscribe for due events + poll fallback | ~80 |

### 1.4 Shared types

| File | Purpose | LOC est. |
|---|---|---|
| `web/src/lib/types/callbacks.ts` | `Callback`, `CallbackStatus`, `CallbackScope` frontend types | ~40 |

### 1.5 Test file

| File | Purpose | LOC est. |
|---|---|---|
| `web/src/test/callback.spec.ts` | Vitest unit tests for hooks + Playwright E2E stub | ~150 |

### 1.6 Modified files

| File | Change |
|---|---|
| `web/src/app/(agent)/callbacks/page.tsx` | Replace stub with `<CallbackListClient>` import |
| `web/src/components/call/DispositionPicker.tsx` | Replace inline datetime-local with `<CallbackPicker>` modal trigger |
| `web/src/app/(agent)/auto/_components/ReservationOverlay.tsx` | Wire `onScheduleCallback` to open `<CallbackPicker>` |

---

## 2. Component Tree

```
AgentShell (web/src/app/(agent)/AgentShell.tsx)
├── TopNav
│   └── NotificationBell (existing, A07)
├── SideNav  [Callbacks link already exists]
├── main#main-content
│   └── CallbacksPage  (web/src/app/(agent)/callbacks/page.tsx)
│       └── CallbackList  (web/src/components/call/CallbackList.tsx)
│           ├── [loading] → Skeleton ×3
│           ├── [empty]   → empty state paragraph
│           └── [rows]    → CallbackRow ×N
│               ├── lead name + phone (masked)
│               ├── callback_at (agent TZ) + lead TZ secondary
│               ├── Badge (status: PENDING/LIVE, TCPA warning)
│               ├── Button "Dial now" (LIVE only)
│               ├── SnoozeMenu trigger → SnoozeMenu
│               └── Button "Cancel" → confirm inline
└── StatusBar

─────────── Floating / portal surfaces ───────────

Providers (web/src/app/providers.tsx)
└── Toaster
    └── DueCallbackToast (rendered when callback_due event fires)
        ├── lead name + scheduled time
        ├── Button "Dial now"
        ├── Button "Snooze 30 min"
        └── Button "Dismiss"

Dialog (via CallbackPicker, mounted inside DispositionPicker or dispo screen)
└── CallbackPicker (web/src/components/call/CallbackPicker.tsx)
    ├── DialogHeader → "Schedule Callback"
    ├── lead name display (read-only)
    ├── datetime-local input  "Date & Time (your timezone: America/Chicago)"
    ├── Lead's local time display  (computed, secondary)
    ├── TCPA warning banner (amber, conditional)
    ├── Scope fieldset ("Me only" | "Anyone")
    ├── Comments textarea
    ├── tcpa_warning response banner (amber, post-submit)
    ├── error role="alert"
    └── Footer: [Cancel] [Schedule]

SnoozeMenu (web/src/components/call/SnoozeMenu.tsx)
└── ul role="menu"
    ├── li role="menuitem" "30 minutes"
    ├── li role="menuitem" "1 hour"
    ├── li role="menuitem" "3 hours"
    ├── li role="menuitem" "Tomorrow 9am"
    └── li role="menuitem" "Custom…" → opens mini date picker
```

---

## 3. State Management

### 3.1 Approach: hook-local state + shared Zustand slice

The callback list state is **not** persisted to localStorage (PII data). It is
managed by `useCallbacks` hook using React `useState` + `useEffect`, following
the same pattern as `useNotifications`.

A small Zustand slice `useCallbackStore` is added for the due-callback toast
deduplication (so `DueCallbackToast` and `useCallbacksDue` can share the set of
"already toasted" callback IDs across tab renders):

```ts
// web/src/lib/stores/callbacks.ts
interface CallbackStore {
  dueShown: Set<string>;    // callback IDs whose toast has been shown
  addDueShown: (id: string) => void;
  clearDueShown: () => void;
}
```

This store is **not** persisted (no `persist` middleware). It is in-memory only.

### 3.2 `useCallbacks` hook

```ts
export function useCallbacks(): {
  callbacks: Callback[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => void;
  refresh: () => void;
  snooze: (id: string, callbackAt: string, comments?: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
  error: string | null;
}
```

Internals:
- `useState<Callback[]>` for the list.
- `useState<string | null>` for next_cursor (pagination).
- `useState<boolean>` for loading.
- `useEffect` on mount: `fetchCallbacks()`.
- `snooze()` and `cancel()` do **optimistic updates**: immediately update local
  state, then call API; revert on error.
- `refresh()` is exposed for WS-triggered re-fetches.

### 3.3 `useCallbackPicker` hook

```ts
export function useCallbackPicker(opts: {
  leadId: string;
  campaignId: string;
  leadTzIana: string | null;
  leadName: string;
  onSuccess: (callback: Callback) => void;
}): {
  dateTime: string;            // datetime-local value
  setDateTime: (v: string) => void;
  scope: "me" | "anyone";
  setScope: (s: "me" | "anyone") => void;
  comments: string;
  setComments: (v: string) => void;
  tcpaWarning: boolean;        // computed from dateTime + leadTzIana
  tcpaResponse: TcpaResult | null;  // from API response
  loading: boolean;
  error: string | null;
  submit: () => Promise<void>;
  reset: () => void;
}
```

`tcpaWarning` is computed synchronously in the hook:

```ts
const tcpaWarning = React.useMemo(
  () => isOutsideTcpaWindow(new Date(dateTime).toISOString(), leadTzIana),
  [dateTime, leadTzIana],
);
```

### 3.4 `useCallbacksDue` hook

```ts
export function useCallbacksDue(): void
```

Mounts once inside `AgentShell` (or a new `CallbackDueWatcher` component
mounted alongside `HotkeyHelpOverlay`). Internally:

1. Subscribes to WS events of type `callback_due` via `createReconnectingWs`.
2. On event received, checks `useCallbackStore.getState().dueShown` — if not
   seen, shows toast and adds to `dueShown`.
3. BroadcastChannel dedup: posts `{ event: "callback_due_shown", callback_id }`
   on show; suppresses on receive.
4. Poll fallback: every 30s, calls `GET /api/agent/callbacks/mine` and checks
   for any `status === "LIVE"` callbacks with `callbackAt <= now + 60s`. If
   found and not in `dueShown`, shows toast.

---

## 4. API Endpoints Consumed — Exact Paths

| Action | Method | Path | Request Body | Response |
|---|---|---|---|---|
| List own | GET | `/api/agent/callbacks/mine` | `?cursor=&limit=` | `{ callbacks: Callback[], next_cursor: string\|null }` |
| Schedule | POST | `/api/agent/callbacks` | `{ lead_id, campaign_id, callback_at, agent_only, comments? }` | `{ ...callback, tcpa_warning? }` |
| Snooze | POST | `/api/agent/callbacks/:id/snooze` | `{ callback_at, comments? }` | `Callback` |
| Cancel | POST | `/api/agent/callbacks/:id/cancel` | (none) | `{ cancelled: true }` |

All requests use `apiFetch` from `web/src/lib/api/index.ts` which:
- Injects `Authorization: Bearer {accessToken}` header.
- Injects `x-vici2-tenant: {tenantId}` header.
- Auto-retries on 401 with silent token refresh.

The `lead_id` and `campaign_id` are bigints on the server but transported as
strings. The frontend uses `string` types throughout.

---

## 5. Form Validation Rules

### 5.1 CallbackPicker validation (client-side, before submit)

| Field | Rule | Error message |
|---|---|---|
| `callback_at` | Required | "Please select a date and time" |
| `callback_at` | Must be ≥5 min in future | "Callback must be at least 5 minutes from now" |
| `callback_at` | Must be ≤1 year in future | "Callback cannot be more than 1 year out" |
| `callback_at` (advisory) | Outside 8am-9pm lead's local TZ | Yellow warning: "Outside TCPA calling window (8am–9pm lead time)" |
| `comments` | Max 255 chars | "Comments must be 255 characters or fewer" |

Server-side validation returns `400` with `{ error: "callback_too_soon" }` or
`{ error: "callback_too_far" }`. These are mapped to human-readable messages in
the hook's error state.

### 5.2 SnoozeMenu validation

Preset options always produce valid times (30min = now + 30min, etc.).
"Tomorrow 9am" computes the next 9am in the agent's local timezone.

Custom snooze: same rules as CallbackPicker (≥5 min, ≤1 year).

### 5.3 Server error → UI error mapping

```ts
const ERROR_MESSAGES: Record<string, string> = {
  callback_too_soon: "Callback must be at least 5 minutes from now",
  callback_too_far: "Callback cannot be more than 1 year in the future",
  callback_not_found: "This callback no longer exists",
  callback_terminal: "This callback has already been completed or cancelled",
  permission_denied: "You don't have permission to modify this callback",
  lead_not_found: "Lead not found",
  already_claimed: "This callback has already been claimed by another agent",
};
```

---

## 6. Notification Flow — When Callback Comes Due

### 6.1 Full event sequence

```
1. D06 callback worker detects callbackAt ≤ now
   → updates callback status: PENDING → LIVE
   → calls publishCallbackEvent(redis, { type: "callback_fired_agent", ... })
   → calls notifyAgent(redis, tenantId, userId, { type: "callback_due", data: {...} })

2. WS gateway reads Redis pub/sub channel t:{tenantId}:ws:user:{userId}
   → forwards as WsEvent to agent's browser WebSocket

3. useCallbacksDue hook (browser) receives WsEvent { type: "callback_due", data }
   → checks BroadcastChannel: is this tab the "primary"?
   → checks dueShown set: has this callback_id already been shown?

4. If not shown:
   → useCallbacksDue dispatches to DueCallbackToast renderer
   → DueCallbackToast calls useToast().toast({
       title: "Callback Due: {leadName}",
       description: "{phone} — scheduled {formattedTime}",
       tone: "warning",
       duration: 0,  // persistent
     })
   → adds callback_id to dueShown
   → BroadcastChannel.postMessage({ event: "callback_due_shown", callback_id })

5. Agent clicks "Dial now":
   → toast dismissed
   → navigate to /call?lead_id={leadId}&phone={phoneE164}&callback_id={callbackId}
   → manual dial triggered (existing /api/agent/manual_dial flow)

6. Agent clicks "Snooze 30 min":
   → calls POST /api/agent/callbacks/{callbackId}/snooze with callback_at = now + 30min
   → toast dismissed
   → callback re-appears in list with new time

7. Agent clicks "Dismiss":
   → toast dismissed
   → callback remains LIVE in list (agent must handle from list page)
```

### 6.2 Poll fallback (WS gap protection)

If WS is disconnected and reconnects after a callback fires:
- The WS `resume` mechanism (from `web/src/lib/ws.ts`) replays missed events
  if the gateway supports sequence numbers. If not, the poll fallback catches it.
- Every 30s, `useCallbacksDue` checks `GET /api/agent/callbacks/mine` for LIVE
  entries not in `dueShown`.

### 6.3 Multi-tab dedup

BroadcastChannel `"vici2-callbacks"`:
- Tab A receives `callback_due` WS event → shows toast → posts
  `{ event: "callback_due_shown", callback_id: "123" }`.
- Tab B receives the BC message → adds "123" to `dueShown` without showing toast.
- Tab B later receives same WS event → already in `dueShown` → skip.

---

## 7. RBAC: Which Verbs Apply

From `shared/types/src/rbac.ts`:

| Verb | Agent scope | Supervisor scope |
|---|---|---|
| `callback:read` | `own` | `group` |
| `callback:edit` | `own` | `group` |

**Frontend enforcement:**

A08 shows:
- "Mine" list (`GET /api/agent/callbacks/mine`) — available to all agents with
  `callback:read`.
- Schedule button — shown to agents with `callback:edit`.
- Cancel button — only on callbacks where `user_id === currentUserId` (own scope)
  or when user is supervisor. The list page only shows own callbacks, so cancel
  is always shown.
- Snooze button — same as cancel.

**No frontend-side RBAC check is needed beyond what the API enforces.** The API
returns 403 if the actor lacks permission; the UI maps this to an error message
and does not hide buttons (consistent with existing patterns in the codebase).

Supervisors/admins accessing `/callbacks` will see only their own callbacks
(same endpoint). A separate admin callbacks view is out of scope for A08.

---

## 8. Acceptance Criteria

### 8.1 Golden paths

**GP-1: Schedule callback from dispo screen**

```
Given: agent has just finished a call and is in wrapup phase
When:  agent selects "CALLBK" disposition, opens callback scheduler
And:   enters a time 2 hours in future, selects "Me only", adds comments
And:   clicks "Schedule"
Then:  API POST /api/agent/callbacks returns 201
And:   modal closes
And:   success toast "Callback scheduled" appears briefly
And:   navigating to /callbacks shows the new entry in "PENDING" state
```

**GP-2: Callback list and cancel**

```
Given: agent has ≥1 PENDING callback on /callbacks
When:  agent clicks "Cancel" on a row
And:   confirmation prompt is shown inline
And:   agent confirms
Then:  API POST /api/agent/callbacks/:id/cancel called
And:   row disappears (optimistic removal)
And:   success toast "Callback cancelled"
```

**GP-3: Snooze from list**

```
Given: agent has a PENDING callback on /callbacks
When:  agent clicks "Snooze" → selects "30 minutes"
Then:  API POST /api/agent/callbacks/:id/snooze called with callback_at = now+30min
And:   row updates with new time (optimistic)
And:   success toast "Snoozed until {newTime}"
```

**GP-4: Due callback toast**

```
Given: a callback transitions to LIVE (worker fires it)
And:   WS event "callback_due" arrives in browser
When:  DueCallbackToast renders
Then:  toast shows lead name and phone
And:   "Dial now" button is present
And:   clicking "Dial now" navigates to /call?lead_id=&phone=&callback_id=
And:   toast dismisses
```

**GP-5: TCPA warning on schedule**

```
Given: lead has lead_tz_iana = "America/Los_Angeles"
And:   agent schedules callback for 7am lead's local time
When:  agent enters datetime-local value that corresponds to 7am LA
Then:  TCPA warning banner appears in modal (amber, informational)
And:   agent can still submit (not blocked)
And:   after submit, if API returns tcpa_warning, banner appears again
```

### 8.2 Edge cases

**EC-1: WS disconnected when callback fires**

```
Given: agent's WS is reconnecting (status "reconnecting" in useWsStore)
When:  callback transitions to LIVE server-side
Then:  poll fallback at next 30s cycle detects LIVE status
And:   toast appears after reconnect or at next poll tick
```

**EC-2: Multi-tab — same callback fires in both tabs**

```
Given: agent has two browser tabs open
When:  callback_due WS event arrives in both tabs
Then:  first tab to process shows toast and posts to BroadcastChannel
And:   second tab receives BC message and suppresses its toast
And:   both tabs' dueShown sets include the callback_id
```

**EC-3: Snooze on a LIVE callback**

```
Given: callback is LIVE (being actively worked)
When:  agent tries to snooze from the list
Then:  API returns 200 (LIVE → PENDING transition is legal)
And:   row updates to PENDING with new callbackAt
```

**EC-4: Schedule with no campaign context**

```
Given: agent opens /callbacks page (not in a call)
And:   clicks "Schedule new callback" (future feature / manual trigger)
When:  CallbackPicker opens without call context
Then:  campaignId and leadId must be provided by parent (required props)
And:   if not available, Schedule button is disabled with "No active call"
Note:  Phase 1 — CallbackPicker is only opened from dispo screen where
       call context is always available. Stand-alone trigger is Phase 2.
```

**EC-5: Callback already cancelled (409)**

```
Given: two agents both see a GLOBAL callback (supervisors) and both cancel
When:  second cancel returns 409 "callback_terminal"
Then:  optimistic removal is reverted for second agent
And:   error toast "This callback has already been cancelled"
```

**EC-6: Pagination on /callbacks**

```
Given: agent has >50 callbacks
When:  list loads
Then:  first 50 are shown
And:   "Load more" button or infinite scroll triggers next page
And:   next_cursor is passed as cursor param
```

**EC-7: datetime-local timezone conversion**

```
Given: agent's browser is set to America/New_York (UTC-4)
When:  agent selects "2026-06-15T14:00" in the datetime-local input
Then:  hook converts to "2026-06-15T18:00:00.000Z" (UTC) before posting
And:   API accepts the UTC ISO string
And:   list displays "2:00 PM EDT" in agent's local time
```

### 8.3 Playwright E2E (stub — `web/src/test/callback.spec.ts`)

The test file should contain:
1. Schedule callback → appears in list
2. Toast appears on due → click "Dial now"
3. Snooze 30 min → new time in list
4. Cancel → removed from list

Run: `cd web && npm run test:e2e -- callback`

---

## 9. Detailed Component Specifications

### 9.1 `CallbackPicker` props

```tsx
interface CallbackPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  leadName: string;           // "First Last" from call store
  phoneE164: string;          // for display only
  campaignId: string;         // from call store
  leadTzIana: string | null;  // for TCPA check and local time display
  onSuccess?: (callback: Callback) => void;
}
```

Internal state managed by `useCallbackPicker` hook.

Key behaviors:
- On mount: set `dateTime` to next business day at 10am in agent's local tz
  (matching existing `CallbackScheduler.defaultCallbackTime()` pattern).
- Focus datetime input on dialog open.
- Escape key → `onOpenChange(false)`.
- Submit: `POST /api/agent/callbacks` with `agent_only: scope === "me"`.
- On 201: call `onSuccess(callback)`, show success toast, close modal.
- On error: map error code → human message, display `role="alert"`.

### 9.2 `CallbackList` props

```tsx
interface CallbackListProps {
  // No external props — self-contained. Uses useCallbacks() internally.
}
```

Renders:
- Page header: "My Callbacks" + `<Button variant="secondary" size="sm">Refresh</Button>`
- Stats bar: "N pending, M due soon" (computed from list)
- Table with columns: Lead, Scheduled (agent TZ), Lead TZ, Status, Actions
- On mobile (< md): collapses to card layout

### 9.3 `CallbackRow` props

```tsx
interface CallbackRowProps {
  callback: Callback;
  onSnooze: (id: string, callbackAt: string, comments?: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}
```

States:
- `confirming-cancel`: inline "Are you sure? [Yes, cancel] [No]" replaces actions.
- `snoozed`: row briefly turns amber then updates.
- `cancelled`: row fades out and removes (optimistic).

### 9.4 `SnoozeMenu` props

```tsx
interface SnoozeMenuProps {
  callbackId: string;
  comments: string | null;
  onSnooze: (callbackAt: string, comments?: string) => Promise<void>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

Preset computation:
```ts
const PRESETS = [
  { label: "30 minutes",    getAt: () => new Date(Date.now() + 30 * 60_000) },
  { label: "1 hour",        getAt: () => new Date(Date.now() + 60 * 60_000) },
  { label: "3 hours",       getAt: () => new Date(Date.now() + 3 * 3600_000) },
  { label: "Tomorrow 9am",  getAt: () => tomorrowAt9am() },
];
```

`tomorrowAt9am()` returns `new Date()` with +1 day, hours set to 9, minutes
and seconds to 0. No timezone library needed — this uses the agent's local timezone
implicitly, which is correct (agent schedules in their own local time, hook
converts to UTC via `.toISOString()`).

"Custom…" option opens an inline `<input type="datetime-local">` in the menu.

### 9.5 `DueCallbackToast` — internal implementation

`DueCallbackToast` is not a standalone component — it uses `useToast()` to push
a custom-rendered toast node. However, because the existing `Toaster` in
`web/src/components/ui/toast.tsx` only renders simple title+description, A08
needs to either:

**Option A** (recommended): Extend `Toast` type with an optional `actions` field
and update `Toaster` to render action buttons if present.

```ts
// Extended Toast type
export interface Toast {
  id: string;
  title: string;
  description?: string;
  tone?: ToastTone;
  duration?: number;
  actions?: Array<{ label: string; onClick: () => void; variant?: "primary" | "secondary" }>;
}
```

This is a backward-compatible extension: existing toasts without `actions` render
the same way.

**Option B**: Render a separate fixed-position container outside Toaster for
callback-due toasts specifically. This avoids modifying the shared Toaster.

**Decision: Option A.** Extending the Toast type is minimal (adds ~10 lines to
`toast.tsx`) and keeps the toast system unified. All existing callers remain
unaffected.

`CallbackToast` is the module that calls `useToast()` with `{ actions: [...] }`:

```ts
// web/src/components/call/CallbackToast.tsx
export function useCallbackToast() {
  const { toast, dismiss } = useToast();
  const router = useRouter();
  const { snooze } = useCallbacks(); // reuse from hook

  function showDueToast(cb: DueCallbackData): string {
    const id = toast({
      title: `Callback Due: ${cb.lead_name}`,
      description: `${formatPhone(cb.phone)} — ${formatAgentTime(cb.callback_at)}`,
      tone: "warning",
      duration: 0,
      actions: [
        {
          label: "Dial now",
          variant: "primary",
          onClick: () => {
            dismiss(id);
            router.push(
              `/call?lead_id=${cb.lead_id}&phone=${encodeURIComponent(cb.phone)}&callback_id=${cb.callback_id}`,
            );
          },
        },
        {
          label: "Snooze 30m",
          variant: "secondary",
          onClick: async () => {
            dismiss(id);
            await snooze(
              cb.callback_id,
              new Date(Date.now() + 30 * 60_000).toISOString(),
            );
          },
        },
        {
          label: "Dismiss",
          variant: "secondary",
          onClick: () => dismiss(id),
        },
      ],
    });
    return id;
  }

  return { showDueToast };
}
```

### 9.6 `useCallbacks` hook — full specification

```ts
// web/src/lib/hooks/useCallbacks.ts
"use client";

export interface Callback {
  id: string;
  lead_id: string;
  campaign_id: string;
  user_id: string | null;
  scope: "AGENT" | "GLOBAL";
  callback_at: string;           // ISO-8601
  status: "PENDING" | "LIVE" | "DONE" | "DEAD";
  comments: string | null;
  lead_tz_iana: string | null;
  lead_name?: string;            // synthesized: firstName + lastName
  lead_phone?: string;           // phoneE164
  created_at: string;
  updated_at: string;
}

export function useCallbacks(): {
  callbacks: Callback[];
  loading: boolean;
  hasMore: boolean;
  nextCursor: string | null;
  error: string | null;
  loadMore: () => void;
  refresh: () => void;
  snooze: (id: string, callbackAt: string, comments?: string) => Promise<void>;
  cancel: (id: string) => Promise<void>;
};
```

Fetch implementation:

```ts
async function fetchPage(cursor?: string): Promise<void> {
  setLoading(true);
  try {
    const params = new URLSearchParams({ limit: "50" });
    if (cursor) params.set("cursor", cursor);
    const data = await apiFetch<{ callbacks: Callback[]; next_cursor: string | null }>(
      `/api/agent/callbacks/mine?${params}`,
    );
    setCallbacks((prev) => cursor ? [...prev, ...data.callbacks] : data.callbacks);
    setNextCursor(data.next_cursor);
  } catch (err) {
    setError(err instanceof Error ? err.message : "Failed to load callbacks");
  } finally {
    setLoading(false);
  }
}
```

Snooze (optimistic):

```ts
async function snooze(id: string, callbackAt: string, comments?: string) {
  // Optimistic update
  setCallbacks((prev) =>
    prev.map((c) => c.id === id ? { ...c, callback_at: callbackAt } : c),
  );
  try {
    await apiFetch(`/api/agent/callbacks/${id}/snooze`, {
      method: "POST",
      body: { callback_at: callbackAt, ...(comments ? { comments } : {}) },
    });
  } catch (err) {
    // Revert
    void refresh();
    throw err;
  }
}
```

Cancel (optimistic):

```ts
async function cancel(id: string) {
  // Optimistic removal
  setCallbacks((prev) => prev.filter((c) => c.id !== id));
  try {
    await apiFetch(`/api/agent/callbacks/${id}/cancel`, { method: "POST" });
  } catch (err) {
    // Revert
    void refresh();
    throw err;
  }
}
```

### 9.7 TCPA window check utility

```ts
// In web/src/lib/types/callbacks.ts or a utils file

export function isOutsideTcpaWindow(
  isoUtc: string,
  leadTzIana: string | null,
): boolean {
  if (!leadTzIana) return false;
  try {
    const d = new Date(isoUtc);
    const hourStr = new Intl.DateTimeFormat("en-US", {
      timeZone: leadTzIana,
      hour: "numeric",
      hour12: false,
    }).format(d);
    const hour = parseInt(hourStr, 10);
    return hour < 8 || hour >= 21;
  } catch {
    return false;  // unknown timezone → don't warn
  }
}

export function formatCallbackTime(
  isoUtc: string,
  agentTz: string,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: agentTz,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(new Date(isoUtc));
}

export function formatLeadLocalTime(
  isoUtc: string,
  leadTzIana: string,
): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: leadTzIana,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).format(new Date(isoUtc));
}
```

---

## 10. Phase Breakdown

### Phase 1 — Foundations (0.5 day)

1. Create `web/src/lib/types/callbacks.ts` with `Callback` type and utilities
   (`isOutsideTcpaWindow`, `formatCallbackTime`, `formatLeadLocalTime`).
2. Create `web/src/lib/hooks/useCallbacks.ts` (list fetch, snooze, cancel).
3. Extend `web/src/components/ui/toast.tsx` with `actions` field.
4. Add `web/src/lib/stores/callbacks.ts` (dueShown Zustand slice).
5. Write Vitest unit tests for `isOutsideTcpaWindow` and `useCallbacks` mocks.

### Phase 2 — Callbacks List Page (0.5 day)

1. Create `web/src/components/call/CallbackRow.tsx`.
2. Create `web/src/components/call/SnoozeMenu.tsx`.
3. Create `web/src/components/call/CallbackList.tsx`.
4. Replace stub in `web/src/app/(agent)/callbacks/page.tsx` with
   `<CallbackListClient>` (client component wrapper).

### Phase 3 — CallbackPicker Modal (0.5 day)

1. Create `web/src/lib/hooks/useCallbackPicker.ts`.
2. Create `web/src/components/call/CallbackPicker.tsx`.
3. Update `web/src/components/call/DispositionPicker.tsx`:
   - Add `callbackOpen` state.
   - Replace inline datetime-local + checkbox with a "Schedule Callback" button
     that opens `<CallbackPicker open={callbackOpen} onOpenChange={...} />`.
4. Update `web/src/app/(agent)/auto/_components/ReservationOverlay.tsx`:
   - Wire `onScheduleCallback` prop to open `<CallbackPicker>`.

### Phase 4 — Due-Callback Toast (0.25 day)

1. Create `web/src/lib/hooks/useCallbacksDue.ts`.
2. Create `web/src/components/call/CallbackToast.tsx` (the `useCallbackToast` hook).
3. Mount `<CallbackDueWatcher>` (thin component that calls `useCallbacksDue`)
   inside `AgentShellInner` alongside `<HotkeyHelpOverlay>`.

### Phase 5 — Testing and Polish (0.25 day)

1. Write Playwright E2E stubs in `web/src/test/callback.spec.ts`.
2. Add keyboard focus trap to `<CallbackPicker>`.
3. Verify WCAG AA: contrast, labels, focus order.
4. Verify responsive layout at 768px.
5. Test multi-tab BroadcastChannel dedup manually.

---

## 11. Detailed File Contents — Key Sections

### 11.1 `web/src/app/(agent)/callbacks/page.tsx` — final

```tsx
import { CallbackListClient } from "@/components/call/CallbackList";

export const metadata = { title: "Callbacks" };

export default function CallbacksPage(): React.ReactElement {
  return <CallbackListClient />;
}
```

(`CallbackListClient` is the `"use client"` component exported from `CallbackList.tsx`.)

### 11.2 Dispo screen integration

In `DispositionPicker.tsx`, replace the current inline block:

```tsx
{/* CURRENT — remove this block */}
<div>
  <label className="flex items-center gap-2 text-sm cursor-pointer">
    <input type="checkbox" checked={callbackChecked} ... />
    Schedule callback
  </label>
  {callbackChecked && (
    <input type="datetime-local" ... />
  )}
</div>
```

With:

```tsx
{/* A08 — new */}
<div>
  <Button
    type="button"
    variant="secondary"
    size="sm"
    onClick={() => setCallbackOpen(true)}
  >
    Schedule Callback
  </Button>
  {lead && campaign && (
    <CallbackPicker
      open={callbackOpen}
      onOpenChange={setCallbackOpen}
      leadId={String(lead.id)}
      leadName={`${lead.firstName ?? ""} ${lead.lastName ?? ""}`.trim()}
      phoneE164={lead.phoneE164}
      campaignId={String(campaign.id)}
      leadTzIana={lead.tzOffsetMin != null
        ? offsetToIana(lead.tzOffsetMin)  // helper to approximate IANA from offset
        : null}
      onSuccess={() => {
        // Optionally auto-select CALLBK disposition
        select("CALLBK");
      }}
    />
  )}
</div>
```

Note: `lead.tzOffsetMin` is available in `LeadSnapshot` but `lead_tz_iana` is
not directly stored in the call store. For Phase 1, pass `null` for `leadTzIana`
in the dispo context (TCPA check is advisory only). The `leadTzIana` is available
from the `Callback` object returned after save, so Phase 2 can show the TCPA
banner retroactively.

**Alternative:** Add `leadTzIana` to `LeadSnapshot` in `web/src/lib/stores/call.ts`
during A08 implementation (requires a small store update).

### 11.3 `CallbackRow` layout structure

```tsx
<tr className="border-b border-[var(--color-surface-border)] hover:bg-[var(--color-surface-muted)]">
  <td className="py-3 px-4">
    <p className="text-sm font-medium">{callback.lead_name ?? "Unknown"}</p>
    <p className="text-xs text-[var(--color-fg-muted)]">{maskPhone(callback.lead_phone)}</p>
  </td>
  <td className="py-3 px-4">
    <p className="text-sm">{formatCallbackTime(callback.callback_at, agentTz)}</p>
    {callback.lead_tz_iana && (
      <p className="text-xs text-[var(--color-fg-muted)]">
        Lead: {formatLeadLocalTime(callback.callback_at, callback.lead_tz_iana)}
      </p>
    )}
  </td>
  <td className="py-3 px-4">
    <Badge tone={statusTone(callback.status)}>{callback.status}</Badge>
    {tcpaWarn && <Badge tone="warning" className="ml-1">TCPA</Badge>}
  </td>
  <td className="py-3 px-4 flex gap-2">
    {callback.status === "LIVE" && (
      <Button size="sm" variant="primary" onClick={handleDialNow}>Dial now</Button>
    )}
    <SnoozeMenu ... />
    {!confirming
      ? <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>Cancel</Button>
      : <>
          <Button size="sm" variant="destructive" onClick={handleCancel} loading={cancelling}>
            Confirm
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>No</Button>
        </>
    }
  </td>
</tr>
```

`maskPhone` shows the last 4 digits: `•••-••••-${phone.slice(-4)}` for display.
Full phone is shown in the due toast (since the agent is actively working that callback).

---

## 12. Non-Goals (Phase 1)

The following are explicitly **not** in scope for A08 Phase 1:

- Admin/supervisor view of all tenant callbacks (uses `GET /api/admin/callbacks`).
- Claim UI for GLOBAL-scope callbacks (needs separate design).
- Bulk cancel/reassign from the agent's list.
- Callback history (DONE/DEAD callbacks).
- Campaign-level callback scheduling from a lead page without call context.
- CSV export.
- I04 inbound callback queue integration.
- M02 campaign scheduled-callbacks toggle (M02 consumes A08's component, not vice versa).

---

## 13. Estimated LOC Summary

| File | Est. LOC |
|---|---|
| `web/src/lib/types/callbacks.ts` | 45 |
| `web/src/lib/stores/callbacks.ts` | 30 |
| `web/src/lib/hooks/useCallbacks.ts` | 185 |
| `web/src/lib/hooks/useCallbackPicker.ts` | 105 |
| `web/src/lib/hooks/useCallbacksDue.ts` | 90 |
| `web/src/components/call/CallbackPicker.tsx` | 205 |
| `web/src/components/call/CallbackList.tsx` | 165 |
| `web/src/components/call/CallbackRow.tsx` | 130 |
| `web/src/components/call/SnoozeMenu.tsx` | 110 |
| `web/src/components/call/CallbackToast.tsx` | 95 |
| `web/src/app/(agent)/callbacks/page.tsx` | 12 |
| Modified: `DispositionPicker.tsx` (+) | +30 |
| Modified: `toast.tsx` (+) | +15 |
| Modified: `AgentShellInner` (+) | +5 |
| Modified: `ReservationOverlay` (+) | +10 |
| `web/src/test/callback.spec.ts` | 155 |
| **Total** | **~1,387** |

---

## 14. Risks and Mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| `callback_due` WS event not emitted by worker | Medium | Poll fallback in `useCallbacksDue` every 30s |
| `datetime-local` timezone confusion | Medium | Display agent TZ label; convert to UTC in hook |
| Multi-tab toast dedup BroadcastChannel unavailable (SSR) | Low | Guard with `typeof BroadcastChannel !== "undefined"` |
| TCPA check in Phase 1 always returns ALLOW | Low (by design) | UI still shows client-side TCPA banner; C04 wires real gate later |
| `lead_tz_iana` not in call store `LeadSnapshot` | Medium | Accepts `null` gracefully; Phase 2 adds it to store |
| Toast `actions` extension breaks existing tests | Low | Backward compatible (optional field) |
| Optimistic cancel/snooze out of sync on 409 | Low | Full refresh on error; error toast shown |

---

## 15. Dependencies and Prerequisites

Before implementing A08, ensure:

1. **D06 is merged** — `api/src/callbacks/` routes must be in the build.
   Status: D06 is in the working tree (merged, see git status).

2. **Prisma migration `20260513250000_n02_email_templates`** has run. The
   `Callback` model must exist in the schema. Verify:
   `api/prisma/schema.prisma` has `model Callback { ... }`.

3. **WS gateway emits `callback_due`** — coordinate with the gateway team to
   confirm the event type and data shape.

4. **`pnpm-lock.yaml`** — no new packages are being added, so no lockfile
   changes are needed.

5. **A07 `useNotify` and `Toaster`** must be in place — both are already
   implemented.

6. **A04 / DispositionPicker** — existing component is already in the codebase.
   A08 makes a targeted edit only.
