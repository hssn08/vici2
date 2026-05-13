# A08 — Callback Scheduling UI: HANDOFF

> Status: IMPLEMENTED
> Implemented by: IMPLEMENT agent (Claude Sonnet 4.6)
> Commit: a4bbaa0
> Branch: worktree-agent-a1a792bc696afca2a (target: feat/A08-implement)
> Date: 2026-05-13

---

## What was built

Five surface areas implemented per PLAN.md:

1. **CallbackPicker modal** — `web/src/components/call/CallbackPicker.tsx`
   - Uses `Dialog` + `useCallbackPicker` hook
   - Native `<input type="datetime-local">`, no external date picker
   - TCPA advisory banner (amber, non-blocking) using `isOutsideTcpaWindow()`
   - Scope fieldset (Me only / Anyone), 255-char comments textarea
   - Client-side validation: ≥5 min, ≤1 year, required field
   - Displays lead's local time preview using `formatLeadLocalTime()`

2. **CallbackList / CallbackRow / SnoozeMenu** — `/callbacks` page
   - `web/src/components/call/CallbackList.tsx` — self-contained, uses `useCallbacks()`
   - `web/src/components/call/CallbackRow.tsx` — status badge, TCPA badge, Dial/Snooze/Cancel
   - `web/src/components/call/SnoozeMenu.tsx` — 30m/1h/3h/Tomorrow-9am/Custom presets
   - Cancel uses inline confirm (no modal), with optimistic removal + revert on error

3. **DueCallbackToast** — `web/src/components/call/CallbackToast.tsx`
   - `useCallbackToast()` hook pushes persistent toast with Dial/Snooze/Dismiss actions
   - Actions array extension to Toast type (backward-compatible)

4. **useCallbacksDue** — `web/src/lib/hooks/useCallbacksDue.ts`
   - WS subscription to `callback_due` events via `createReconnectingWs`
   - 30s poll fallback: checks LIVE callbacks not in `dueShown`
   - BroadcastChannel `"vici2-callbacks"` for multi-tab dedup
   - `CallbackDueWatcher` component mounted in `AgentShell`

5. **Shared hooks and types**
   - `web/src/lib/hooks/useCallbacks.ts` — list, snooze, cancel with optimistic updates
   - `web/src/lib/hooks/useCallbackPicker.ts` — form state + submit to `POST /api/agent/callbacks`
   - `web/src/lib/types/callbacks.ts` — `Callback` interface, TCPA utilities, formatters
   - `web/src/lib/stores/callbacks.ts` — in-memory Zustand store (no persist, PII safe)

---

## Files changed (16 total)

### New files (11)

| File | Purpose |
|---|---|
| `web/src/lib/types/callbacks.ts` | Types + TCPA utilities + formatters |
| `web/src/lib/stores/callbacks.ts` | Zustand dueShown store (in-memory) |
| `web/src/lib/hooks/useCallbacks.ts` | List fetch + optimistic snooze/cancel |
| `web/src/lib/hooks/useCallbackPicker.ts` | Picker form state + submit |
| `web/src/lib/hooks/useCallbacksDue.ts` | WS + poll + BroadcastChannel watcher |
| `web/src/components/call/CallbackPicker.tsx` | Schedule modal |
| `web/src/components/call/CallbackList.tsx` | /callbacks page client component |
| `web/src/components/call/CallbackRow.tsx` | Single callback row |
| `web/src/components/call/SnoozeMenu.tsx` | Snooze preset dropdown |
| `web/src/components/call/CallbackToast.tsx` | useCallbackToast hook |
| `web/src/test/unit/callback.test.ts` | 18 Vitest unit tests |

### Modified files (5)

| File | Change |
|---|---|
| `web/src/app/(agent)/callbacks/page.tsx` | Replace stub → `<CallbackListClient />` |
| `web/src/components/ui/toast.tsx` | Add optional `actions?: ToastAction[]` to Toast type |
| `web/src/components/call/DispositionPicker.tsx` | Replace inline checkbox block with `<CallbackPicker>` button |
| `web/src/components/call/__tests__/DispositionPicker.test.tsx` | Update test for A08 changes |
| `web/src/app/(agent)/AgentShell.tsx` | Mount `<CallbackDueWatcher>` |

---

## Test results

```
Test Files  41 passed (41)
Tests       349 passed (349)   (+18 new A08 tests)
Lint        0 errors, 44 warnings (all pre-existing warnings)
TypeCheck   0 errors in A08 files (pre-existing errors in unrelated files)
```

---

## Key design decisions

- `leadTzIana` is passed as `null` from DispositionPicker (the `LeadSnapshot` has
  `tzOffsetMin` not IANA string). TCPA check is still client-side advisory using
  the `null` guard in `isOutsideTcpaWindow()`. Phase 2 can add IANA mapping.
- `CallbackDueWatcher` creates its own WS connection (separate from A03's
  `useAgentStateSync` connection). This is consistent with how AutoDialShell does it.
  A future cleanup could share a single WS connection.
- The `useCallbackToast` hook calls `useCallbacks()` internally to get `snooze()`.
  This means the toast's snooze action operates on a separate hook instance from
  the list page. Both will eventually sync via the 30s poll or page refresh.
- BroadcastChannel guard: `typeof BroadcastChannel !== "undefined"` protects SSR.

---

## Follow-ups for future modules

- **M02**: Import `<CallbackPicker>` from `web/src/components/call/CallbackPicker.tsx`.
  The `CallbackPickerProps` interface is exported and stable.
- **C04**: When TCPA gate is wired, the API will return `tcpa_warning` in the POST
  response; the `CallbackPicker` already reads `response.tcpa_warning` and displays
  the banner.
- **Phase 2**: Add `leadTzIana` to `LeadSnapshot` in `web/src/lib/stores/call.ts`
  to enable real TCPA warnings in the picker. Currently passes `null`.
- **Phase 2**: Wire `onScheduleCallback` in `ReservationOverlay.tsx` to open
  `<CallbackPicker>` for preview-mode pre-call scheduling.
- **I04**: Inbound callback queue integration is out of scope for A08.
- **Shared WS**: Consider single reconnecting WS instance shared across A03 agent
  sync and A08 callback due watcher hooks.
