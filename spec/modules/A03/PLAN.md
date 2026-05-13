# A03 — Agent Shell Extension + Global Hotkey Infrastructure + Agent State Widget

**Date:** 2026-05-13
**Branch:** feat/A03-implement
**Owner:** A03-IMPLEMENT agent

---

## 1. Scope

A03 extends the A01 skeleton to deliver:

1. **Hotkey Registry** (`lib/hotkeys/`) — scope-aware, priority-ordered, input-suppress logic. Replaces the ad-hoc `useInCallHotkeys` by providing a central registry; A05 migrates to it.
2. **Agent State Widget** — full state machine: READY / PAUSED / BUSY / WRAPUP / OFFLINE. Click-to-change with pause-code dropdown.
3. **AgentShell top bar enhancement** — call state pill + agent state widget + pause reason + tenant info + user menu.
4. **Connection indicator** — WS state + SIP registered + dialer reachability in status bar.
5. **API layer** — `GET/POST /api/agent/state` + `GET /api/agent/pause-codes` stubbed via `lib/api`.
6. **WS event handler** — subscribe to `agent.state` events; patch `useAgentStore` via `patchFromEvent`.
7. **Notification helper** — `useNotify()` thin wrapper around existing `useToast` for typed success/warning/danger/info.

---

## 2. File plan

```
web/src/lib/hotkeys/
├── registry.ts           — HotkeyRegistry class (register/unregister, fire, scope priority)
├── useHotkeyRegistry.ts  — React hook: mounts global keydown; teardown on unmount
├── useHotkeys.ts         — Convenience hook for declarative hotkey registration
└── index.ts              — Barrel

web/src/lib/agent/
├── api.ts                — getAgentState(), setAgentState(), getPauseCodes()
├── useAgentStateSync.ts  — WS subscription → patchFromEvent
└── index.ts              — Barrel

web/src/components/agent/
├── AgentStateWidget.tsx  — Full READY/PAUSED/BUSY/WRAPUP/OFFLINE widget
├── PauseCodeDropdown.tsx — Dropdown of pause codes from API
├── ConnectionIndicator.tsx — WS + SIP + dialer health dots
└── __tests__/
    ├── AgentStateWidget.test.tsx
    └── PauseCodeDropdown.test.tsx

web/src/components/shell/
└── TopNav.tsx            — Enhanced with AgentStateWidget + ConnectionIndicator (edit)

web/src/components/providers/
└── HotkeyProvider.tsx    — Mounts registry at <Providers> level

web/src/app/providers.tsx  — Add <HotkeyProvider> (edit)

web/src/test/unit/
├── hotkeys.registry.test.ts
└── agent.api.test.ts
```

---

## 3. HotkeyRegistry design

```ts
type Scope = "global" | "in-call" | "wrapup" | "modal";
interface HotkeyBinding {
  id: string;
  scope: Scope;
  key: string; // e.g. "F1", "m", "Escape"
  ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean;
  ignoreInputFocus?: boolean; // default: false (suppressed in inputs)
  priority?: number; // higher wins; default 0
  handler: (e: KeyboardEvent) => void;
}
```

- `register(binding)` → returns `() => void` (deregister)
- On keydown: collect matching bindings sorted by priority desc; call highest-priority; `e.preventDefault()` if handled.
- Input-suppress: if `activeElement` is INPUT/TEXTAREA/contenteditable AND `ignoreInputFocus` is false AND no ctrl/meta, skip.

---

## 4. Agent State machine

```
OFFLINE → READY (login/join campaign)
READY   → PAUSED (setPause(code)) | BUSY (call started)
PAUSED  → READY (clearPause) | BUSY (call started while paused)
BUSY    → WRAPUP (call ended) | READY (no wrapup)
WRAPUP  → READY (endWrapup / timeout) | PAUSED
```

POST `/api/agent/state` body: `{ status, pause_code? }`. Response reflects server-confirmed state.
Optimistic update + rollback on error.

---

## 5. Pause codes

GET `/api/agent/pause-codes` → `PauseCode[]`  
```ts
interface PauseCode { code: string; label: string; billable?: boolean; }
```
Loaded lazily when pause dropdown opens. Cached in component state (30s TTL).

---

## 6. TopNav extension

New sections added to existing TopNav right-side cluster:
- `<ConnectionIndicator />` — 3 dots (WS / SIP / dialer) with tooltip
- `<AgentStateWidget />` — click opens popover with state options + pause-code picker

---

## 7. Tests

- `hotkeys.registry.test.ts` — unit: register, fire, priority, input-suppress, deregister, scope
- `AgentStateWidget.test.tsx` — RTL: render states, click PAUSE opens dropdown, click READY transitions, API calls mocked
- `PauseCodeDropdown.test.tsx` — RTL: renders codes, selects one

---

## 8. Constraints

- No new npm packages. Use existing: React, Zustand, `lib/api`, `lib/ws`, `components/ui/*`.
- `useInCallHotkeys` in `lib/hooks/` remains for backward compat; A05 continues to use it (A06 migrates to registry).
- WS subscription wired in `AgentShell` via `useAgentStateSync()` hook called inside `AgentShell`.
- Tests run with `pnpm --filter @vici2/web test`.
