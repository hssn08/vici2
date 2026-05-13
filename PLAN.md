# A07 — Agent UX Enhancements: PLAN

## Overview
Three polished UX pieces bolted onto the existing agent shell:
1. **Hotkey Help Overlay** — F1 globally opens a searchable modal of all registered hotkeys
2. **Notifications Full-Page Drawer** — `/agent/notifications` page with filters + cursor pagination
3. **Agent Stats Widget** — compact top-bar widget showing today's call metrics, 30s auto-refresh

---

## 1. Hotkey Help Overlay

### Registry Extension
File: `web/src/lib/hotkeys/registry.ts`
- Add `getAll(): HotkeyBinding[]` method returning a snapshot of all registered bindings (no handler ref — strip it for display)
- Add `HotkeyDescriptor` type: `{ id, scope, key, ctrl?, meta?, shift?, alt?, description? }`
- Extend `HotkeyBinding` to accept optional `description?: string` for display in the overlay
- Extend `HotkeyDef` in `useHotkeys.ts` similarly

### HotkeyHelpOverlay component
File: `web/src/components/shell/HotkeyHelpOverlay.tsx`
- `"use client"` component
- Registers F1 globally (`ignoreInputFocus: true, priority: 100`) via `useHotkeys`
- State: `open` boolean, `query` string filter
- Renders `<Dialog open={open}>` (uses existing `dialog.tsx`) with `aria-label="Keyboard shortcuts"`
- Filter input auto-focused on open (`autoFocus`)
- Table rows: Key Combo | Description | Scope
  - Key combo formatted as `kbd` element(s) with accessible styling
  - Scope rendered as a subtle badge
- Live-filter: match on `key`, `description`, `scope` (case-insensitive)
- Sorted: global first, then by scope alpha, then by key
- Esc closes (handled by F1-toggle binding + dialog overlay click)
- WCAG: `role="dialog"`, `aria-modal="true"`, focus trap on open, return focus on close
- Groups by scope with `<thead>` sections or `<section>` headers

### Scope support
Scopes visible: `global`, `in-call`, `wrapup`, `modal`, `auto-dial`
- Extend `HotkeyScope` type if needed to add `agent-shell` and `dial` scopes

### Integration
- Mount `<HotkeyHelpOverlay />` in `AgentShell.tsx` (inside `AgentShellInner`) — renders once, always listening for F1

---

## 2. Notifications Full-Page Drawer + Filters

### Page
File: `web/src/app/(agent)/notifications/page.tsx`
- Next.js `"use client"` page at `/agent/notifications`
- `<NotificationsPage />` component

### NotificationsPage component
File: `web/src/components/notifications/NotificationsPage.tsx`

#### State
- `category: string | null` — filter by notification category
- `severity: "info" | "warning" | "error" | null`
- `readFilter: "all" | "unread" | "read"` (default: `"all"`)
- `dateFrom: string | null`, `dateTo: string | null`
- Persisted to `sessionStorage` via a small `useFilterPersist` effect

#### Data hook: `useNotificationsPage`
File: `web/src/lib/hooks/useNotificationsPage.ts`
- Wraps `apiFetch` with cursor pagination
- Accepts filter params, rebuilds query string, resets items + cursor on filter change
- `GET /api/notifications?limit=40&category=X&severity=Y&read=unread&cursor=Z`
- Returns `{ items, loading, hasMore, loadMore, markRead, markAllRead, dismiss, refresh }`

#### Filter bar
- Category select (populated from unique categories in current results + `"all"` option)
- Severity radio pills: All / Info / Warning / Error
- Read state toggle: All / Unread / Read
- Date range: two `<input type="date">` fields
- "Clear filters" button when any filter active
- All filter controls labelled for screen readers

#### Item list
- Same row UI as `NotificationPanel` but full-width, no truncation on body
- Infinite scroll via Intersection Observer (sentinel div at bottom)
- Empty state illustration + message

#### Header
- Title "Notifications", count of unread
- "Mark all read" button
- Link → "Notification preferences" (existing N01 prefs route `/agent/settings?tab=notifications`)

### NotificationBell update
File: `web/src/components/notifications/NotificationBell.tsx`
- Add "View all" link in `NotificationPanel` footer pointing to `/agent/notifications`

---

## 3. Agent Stats Widget for Top Bar

### API endpoint
File: `api/src/routes/agent-stats.ts`
- `GET /api/agent/stats/today`
- Auth: bearer + tenant extraction (same pattern as `/api/agent/state`)
- Response type `AgentTodayStats`:
  ```ts
  {
    callsHandled: number;
    contacts: number;
    sales: number;
    talkTimeSec: number;
    dropPct: number;          // 0–100
    asOf: string;             // ISO timestamp
  }
  ```
- Queries `vicidial_log` / `vicidial_closer_log` for the current UTC day, filtered by agent user
- Falls back to zeroes if no records (new agent, first day)
- Registered in `api/src/server.ts` under `/api/agent/stats`

### Client hook
File: `web/src/lib/hooks/useAgentTodayStats.ts`
- `useAgentTodayStats()` — fetches on mount, sets 30s interval
- Returns `{ stats: AgentTodayStats | null, loading, error }`
- Clears interval on unmount

### AgentStatsWidget component
File: `web/src/components/agent/AgentStatsWidget.tsx`
- Compact inline row: `📞 12 calls · 8 contacts · 2 sales · 42m · 3.2% drop`
- Renders as a `<button>` that opens a popover `<AgentStatsPopover />` on click
- Popover shows the same data with formatting:
  - Calls: N
  - Contacts: N
  - Sales: N
  - Talk time: Hh Mm Ss
  - Drop %: N.N%
  - Last updated: time-ago string
- Auto-refresh indicator: small spinning dot when loading
- WCAG: button label `"Today's call stats"`, popover `role="dialog"`

### TopNav integration
File: `web/src/components/shell/TopNav.tsx`
- Add `<AgentStatsWidget />` in the right cluster (after ConnectionIndicator)
- Also keep existing `<AgentStateWidget />` in center

---

## File Inventory

### New files
| File | Purpose |
|------|---------|
| `web/src/components/shell/HotkeyHelpOverlay.tsx` | F1 hotkey overlay modal |
| `web/src/components/notifications/NotificationsPage.tsx` | Full-page notifications |
| `web/src/app/(agent)/notifications/page.tsx` | Next.js route |
| `web/src/lib/hooks/useNotificationsPage.ts` | Paginated + filtered notifications hook |
| `web/src/lib/hooks/useAgentTodayStats.ts` | 30s auto-refresh stats hook |
| `web/src/components/agent/AgentStatsWidget.tsx` | Top-bar stats widget + popover |
| `api/src/routes/agent-stats.ts` | GET /api/agent/stats/today |
| `web/src/test/unit/hotkey.overlay.test.tsx` | Overlay scope-filter unit test |
| `web/src/test/unit/notifications.filter.test.tsx` | Filter persistence test |
| `web/src/test/unit/agent.stats.widget.test.tsx` | Stats widget refresh test |

### Modified files
| File | Change |
|------|--------|
| `web/src/lib/hotkeys/registry.ts` | Add `getAll()` + `description` field |
| `web/src/lib/hotkeys/useHotkeys.ts` | Expose `description` in `HotkeyDef` |
| `web/src/lib/hotkeys/index.ts` | Re-export `HotkeyDescriptor` |
| `web/src/components/notifications/NotificationBell.tsx` | Add "View all" footer link |
| `web/src/components/notifications/NotificationPanel.tsx` | Add "View all" footer link |
| `web/src/app/(agent)/AgentShell.tsx` | Mount `<HotkeyHelpOverlay />` |
| `web/src/components/shell/TopNav.tsx` | Add `<AgentStatsWidget />` |

---

## Test Plan

### `hotkey.overlay.test.tsx`
- Scope filter: register bindings in multiple scopes, open overlay, filter by scope string — only matching rows shown
- Query filter: typing partial key or description filters list
- F1 toggle: fire F1 event → modal visible; fire again → hidden
- Esc: fire Escape → modal hidden

### `notifications.filter.test.tsx`
- Filter persistence: set severity=warning, unmount, remount — sessionStorage restores filter
- Category filter changes query string

### `agent.stats.widget.test.tsx`
- Initial render: loading state shown
- After fetch: stats displayed
- Auto-refresh: fake timers advance 30s → second fetch fires
- Click: popover opens

---

## WCAG 2.2 AA Checklist
- Hotkey overlay: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, focus trap, `aria-live` for filter results count
- Notifications page: filter controls `<label>` associations, list items `role="article"`, date inputs labelled
- Stats widget button: `aria-label`, popover `role="dialog"`, `aria-expanded` on trigger
- All interactive elements ≥ 44×44px touch target or explicit `aria-label`
- Color contrast: all text on surface ≥ 4.5:1 (using existing design tokens)

---

## Sequence
1. Extend `HotkeyRegistry` (+ tests pass)
2. `HotkeyHelpOverlay` + mount in shell
3. `useNotificationsPage` hook
4. `NotificationsPage` + route + NotificationBell "View all"
5. `api/src/routes/agent-stats.ts` endpoint
6. `useAgentTodayStats` hook
7. `AgentStatsWidget` + TopNav integration
8. Tests
9. Lint/typecheck pass
