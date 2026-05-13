# A08 — Callback Scheduling UI: HANDOFF

> For: IMPLEMENT agent
> Prerequisite reading: RESEARCH.md + PLAN.md in this directory

---

## What you are building

Five deliverables for the agent-facing callback UI:
1. `CallbackPicker` modal (schedule callback from dispo screen)
2. `CallbackList` / `CallbackRow` (view, snooze, cancel on `/callbacks` page)
3. `SnoozeMenu` (preset snooze options dropdown)
4. `DueCallbackToast` (urgent WS-triggered toast with Dial / Snooze actions)
5. Shared hooks: `useCallbacks`, `useCallbackPicker`, `useCallbacksDue`

---

## Files to read first (in order)

1. `/root/vici2/api/src/callbacks/index.ts` — exact API routes
2. `/root/vici2/api/src/callbacks/schemas.ts` — request/response shapes + `validateCallbackAt`
3. `/root/vici2/api/src/callbacks/service.ts` — `serializeCallback` response shape
4. `/root/vici2/web/src/components/call/CallbackScheduler.tsx` — the existing stub to replace
5. `/root/vici2/web/src/components/call/DispositionPicker.tsx` — where CallbackPicker is triggered from (lines 167-188 are the inline block to replace)
6. `/root/vici2/web/src/components/ui/dialog.tsx` — Dialog primitives to use
7. `/root/vici2/web/src/components/ui/toast.tsx` — Toaster to extend with `actions`
8. `/root/vici2/web/src/lib/hooks/useNotifications.ts` — exact pattern for hook with WS + fetch
9. `/root/vici2/web/src/app/(agent)/auto/_components/AutoDialShell.tsx` — WS subscribe pattern
10. `/root/vici2/web/src/lib/ws.ts` — `createReconnectingWs` API

---

## Implementation sequence

**Step 1 — Types and utilities**
- Create `web/src/lib/types/callbacks.ts`
- Include: `Callback` interface, `isOutsideTcpaWindow()`, `formatCallbackTime()`, `formatLeadLocalTime()`

**Step 2 — Zustand store**
- Create `web/src/lib/stores/callbacks.ts`
- In-memory only (no `persist`): `{ dueShown: Set<string>, addDueShown, clearDueShown }`

**Step 3 — Extend Toast**
- Edit `web/src/components/ui/toast.tsx`
- Add optional `actions?: Array<{ label: string; onClick: () => void; variant?: "primary" | "secondary" }>` to `Toast` interface
- Update Toaster render to show action buttons if present

**Step 4 — `useCallbacks` hook**
- Create `web/src/lib/hooks/useCallbacks.ts`
- Fetches `GET /api/agent/callbacks/mine`
- Exposes: `callbacks`, `loading`, `hasMore`, `refresh`, `snooze(id, callbackAt)`, `cancel(id)`
- Snooze and cancel use optimistic updates, revert on error

**Step 5 — `useCallbackPicker` hook**
- Create `web/src/lib/hooks/useCallbackPicker.ts`
- Manages form state for the picker modal
- Calls `POST /api/agent/callbacks`
- Computes `tcpaWarning` via `isOutsideTcpaWindow`

**Step 6 — `CallbackRow` and `SnoozeMenu`**
- Create `web/src/components/call/CallbackRow.tsx`
- Create `web/src/components/call/SnoozeMenu.tsx` (presets: 30min, 1h, 3h, Tomorrow 9am, Custom)

**Step 7 — `CallbackList` and page**
- Create `web/src/components/call/CallbackList.tsx` — uses `useCallbacks()`
- Replace stub in `web/src/app/(agent)/callbacks/page.tsx` with `<CallbackListClient />`

**Step 8 — `CallbackPicker` modal**
- Create `web/src/components/call/CallbackPicker.tsx`
- Uses `<Dialog>`, `<DialogContent>`, `<DialogHeader>`, `<DialogTitle>` from `web/src/components/ui/dialog.tsx`
- Uses `useCallbackPicker` hook internally

**Step 9 — Wire CallbackPicker into DispositionPicker**
- Edit `web/src/components/call/DispositionPicker.tsx`
- Remove inline datetime-local block (lines ~167-188)
- Add `callbackOpen` state, `<Button>Schedule Callback</Button>`, and `<CallbackPicker ...>`

**Step 10 — `useCallbacksDue` and toast**
- Create `web/src/lib/hooks/useCallbacksDue.ts`
- WS subscribe to `"callback_due"` + 30s poll fallback
- Create `web/src/components/call/CallbackToast.tsx` (the `useCallbackToast` hook)
- Mount `<CallbackDueWatcher>` in `web/src/app/(agent)/AgentShell.tsx` alongside `<HotkeyHelpOverlay>`

**Step 11 — Tests**
- Create `web/src/test/callback.spec.ts`
- Vitest unit tests for utility functions and hook mock behavior
- Playwright E2E stubs for the four golden paths

---

## API paths (exact)

| Action | Path |
|---|---|
| List mine | `GET /api/agent/callbacks/mine` |
| Create | `POST /api/agent/callbacks` |
| Snooze | `POST /api/agent/callbacks/:id/snooze` |
| Cancel | `POST /api/agent/callbacks/:id/cancel` |

Use `apiFetch` from `web/src/lib/api/index.ts` for all calls.

---

## WS event to handle

Event type: `"callback_due"`

Expected data shape:
```ts
{
  callback_id: string;
  lead_id: string;
  lead_name: string;
  phone: string;
  callback_at: string;
  comments: string | null;
}
```

Subscribe pattern (from AutoDialShell):
```ts
const ws = createReconnectingWs({ url: () => getWsUrl(), token: () => useAuthStore.getState().wsToken });
const unsub = ws.subscribe("callback_due", (event) => { ... });
ws.start();
return () => { unsub(); ws.stop(); };
```

---

## Where M02 surfaces the campaign toggle

PLAN.md §12 (Non-Goals) — M02 will import `<CallbackPicker>` from this module.
The public interface to export from `CallbackPicker.tsx` is:
```tsx
export { CallbackPicker } from "./CallbackPicker";
export type { CallbackPickerProps } from "./CallbackPicker";
```

M02 mounts `<CallbackPicker>` in the campaign settings form to test the
"scheduled callbacks enabled" toggle. No additional work needed in A08 for M02;
just ensure the props interface is stable.

---

## Critical constraints

- **No new npm packages.** Use `datetime-local` input, `Intl.DateTimeFormat`, existing components.
- **No PII in localStorage or Zustand persist.** All callback data is in-memory only.
- **Optimistic updates must revert on error.** Always call `refresh()` on API failure.
- **`callback_at` must be ISO-8601 UTC** before posting. Convert with `new Date(datetimeLocalValue).toISOString()`.
- **TCPA warning is advisory.** Never block submission; only show a yellow banner.
- **Minimum callback time is 5 minutes** (server enforced, validate client-side too with same threshold).
