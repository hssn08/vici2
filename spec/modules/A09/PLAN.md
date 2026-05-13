# A09 — Pause Codes UI: PLAN

**Module:** A09 (Agent UI track, Phase 1)
**Date:** 2026-05-13
**Author:** A09 PLAN sub-agent (Claude Sonnet 4.6)
**Status:** PROPOSED — awaiting orchestrator/human review
**Companion:** [RESEARCH.md](./RESEARCH.md)

**Depends on:**
- A01 HANDOFF (frozen): `useAgentStore`, `Button`, `Badge`, `Dialog`, `Input`, design tokens
- A03 HANDOFF (frozen): `AgentStateWidget`, `useAgentStateSync`, `setAgentState`, `getPauseCodes`, `hotkeyRegistry`
- F02 schema: `PauseCode`, `Campaign.pauseCodesRequired`, `AgentLog`

**Blocks:**
- M07 (pause-code admin CRUD — needs `GET /api/agent/pause-codes` to return data seeded by M07)

---

## 0. TL;DR — 12-bullet decision summary

1. **Three UI modes derive from `campaign.pauseCodesRequired`.** OFF = one-click toggle (no menu). OPTIONAL = listbox + free-text, skip allowed. FORCE = listbox only, no skip, no free-text; disabled when no codes exist.
2. **New files:** `web/components/call/PauseButton.tsx`, `web/components/call/PauseCodeMenu.tsx`, `web/src/lib/agent/useAgentState.ts`. The existing `AgentStateWidget.tsx` is updated to delegate pause to `PauseButton`.
3. **API endpoint:** `POST /api/agent/state` (already stubbed in `web/src/lib/agent/api.ts`). The backend handler (`api/src/routes/agent/pause.ts`) is A09's responsibility. `GET /api/agent/pause-codes` returns codes + `pauseCodesRequired` together.
4. **Optimistic UI:** the store is updated immediately on click. On API failure, rollback to previous state via the server's WS `agent.state` event or explicit rollback.
5. **`pauseCodesRequired` is fetched with the codes** in a single `GET /api/agent/pause-codes` request. It is cached in `useAgentState` hook for 60 seconds.
6. **Last-used code persistence:** stored in `useUiStore.lastUsedPauseCode` (Zustand `persist` to `localStorage`). In OPTIONAL mode, the last-used code is pre-selected; agent can change or skip.
7. **Hotkey Ctrl+P** in `agent-shell` scope triggers pause/unpause. Registered via `useHotkeys()` so it appears in the F1 overlay.
8. **`CampaignConfig` interface amended** to include `pause_codes_required` — backward-compatible (optional field defaulting to `"OPTIONAL"`).
9. **`useAgentState()` hook** — single source of truth for UI state machine, mode config, and transition logic. Components read from it; they do not call the API directly.
10. **Pause duration** shown in `StatusBar` via `pausedSince` timestamp from `useAgentStore`.
11. **RBAC:** agent modifies only own state (`scope: 'own'`). Server enforces this via JWT `uid`. FORCE mode is also validated server-side.
12. **Phase plan:** Phase A (hook + API route + OFF mode) → Phase B (OPTIONAL mode) → Phase C (FORCE mode + server validation) → Phase D (duration display + last-used code + Ctrl+P hotkey) → Phase E (tests).

---

## 1. File Plan

### New files (A09 creates)

```
web/src/components/call/PauseButton.tsx
  — Renders the pause/ready toggle button. Mode-aware: either simple toggle (OFF)
    or opens PauseCodeMenu (OPTIONAL/FORCE).

web/src/components/call/PauseCodeMenu.tsx
  — Modal/popover for code selection. Accepts mode, codes list, onSelect, onCancel.

web/src/lib/agent/useAgentState.ts
  — Hook: current status, pausedSince, pauseCodesRequired, codes, transition methods.

api/src/routes/agent/pause.ts
  — Fastify plugin: GET /api/agent/pause-codes, POST /api/agent/state (pause/unpause).
```

### Modified files (A09 updates)

```
web/src/lib/stores/call.ts
  — Add: pause_codes_required?: "OFF" | "OPTIONAL" | "FORCE" to CampaignConfig

web/src/lib/stores/ui.ts
  — Add: lastUsedPauseCode: string | null; setLastUsedPauseCode action

web/src/components/agent/AgentStateWidget.tsx
  — Delegate pause transition to PauseButton; remove inline PauseCodePicker

web/src/components/call/AgentStateToggle.tsx
  — Replace simple toggle with PauseButton import (or deprecate and redirect)

web/src/components/shell/StatusBar.tsx
  — Add pause duration timer when status === "paused"

web/src/lib/agent/api.ts
  — Extend getPauseCodes return type to include pauseCodesRequired

web/src/lib/agent/index.ts
  — Export useAgentState hook

api/src/routes/index.ts (or wherever routes are registered)
  — Register registerAgentPauseRoutes
```

### New test files

```
web/src/components/call/__tests__/PauseButton.test.tsx
web/src/components/call/__tests__/PauseCodeMenu.test.tsx
web/src/lib/agent/__tests__/useAgentState.test.ts
api/test/pause/pause.test.ts
```

---

## 2. `useAgentState` Hook Design

**Location:** `web/src/lib/agent/useAgentState.ts`

```ts
"use client";

export interface PauseCodeOption {
  code: string;
  label: string;
  billable: boolean;
}

export interface PauseConfig {
  pauseCodesRequired: "OFF" | "OPTIONAL" | "FORCE";
  codes: PauseCodeOption[];
  loading: boolean;
  error: string | null;
}

export interface AgentStateResult {
  // Current state (from useAgentStore)
  status: AgentStatus;
  pauseCode: string | null;
  pausedSince: number | null;
  currentCampaignId: number | null;

  // Pause mode config (fetched + cached)
  pauseConfig: PauseConfig;

  // Transition state
  transitioning: boolean;

  // Actions
  pause: (code: string | null, freeText?: string | null) => Promise<void>;
  unpause: () => Promise<void>;
  refreshPauseConfig: () => void;  // force-refetch codes
}

export function useAgentState(): AgentStateResult;
```

**Internals:**

- Reads `status`, `pauseCode`, `pausedSince`, `currentCampaignId` from `useAgentStore`.
- Maintains internal `{ pauseConfig, transitioning }` with `React.useState`.
- Fetches `GET /api/agent/pause-codes` (via `getPauseCodes`) lazily:
  - On first mount (if agent status is `ready` or `paused`)
  - On `currentCampaignId` change
  - On explicit `refreshPauseConfig()` call
  - Uses a 60-second TTL to avoid redundant fetches
- `pause(code, freeText)`:
  1. Validates: in FORCE mode, code must be non-null and in the codes list
  2. Calls `useAgentStore.setPause(code ?? "")` (optimistic)
  3. Calls `setAgentState({ status: "paused", pauseCode: code })` via API
  4. On error: calls `useAgentStore.setStatus(prev)` to rollback
  5. Saves `code` to `useUiStore.lastUsedPauseCode` if non-null
- `unpause()`:
  1. Calls `useAgentStore.clearPause()` (optimistic)
  2. Calls `setAgentState({ status: "ready" })` via API
  3. On error: calls `useAgentStore.setPause(prevCode)` to rollback

**Caching strategy:**
```ts
const pauseConfigCache = useRef<{
  data: PauseConfig;
  fetchedAt: number;
  campaignId: number | null;
} | null>(null);
```
Cache is invalidated when `currentCampaignId` changes or `fetchedAt` is > 60s ago.

---

## 3. API Endpoint Design

### 3.1 `GET /api/agent/pause-codes`

**File:** `api/src/routes/agent/pause.ts`
**Auth:** JWT bearer; agent role minimum.
**Response:**

```ts
interface PauseCodesResponse {
  pauseCodesRequired: "OFF" | "OPTIONAL" | "FORCE";
  codes: Array<{
    code: string;
    name: string;
    billable: boolean;
  }>;
}
```

**Server logic:**
1. Extract `uid` and `tenantId` from JWT.
2. Fetch agent's current `currentCampaignId` from the agent session (Valkey key `t:{tenantId}:agent:{uid}:state`).
3. If no campaign: return `{ pauseCodesRequired: "OPTIONAL", codes: globalCodes }`.
4. Fetch `campaign.pauseCodesRequired` from DB.
5. Fetch pause codes for this campaign:
   - Campaign-specific codes: `WHERE tenant_id = ? AND campaign_id = ?`
   - Global codes (campaign_id IS NULL): `WHERE tenant_id = ? AND campaign_id IS NULL`
   - Merge: campaign-specific first, then global as fallback (or union, depending on campaign config — recommendation: union both, with campaign-specific codes listed first)
6. Return merged list + `pauseCodesRequired`.

**Edge case — FORCE mode with no codes:**
- Return `{ pauseCodesRequired: "FORCE", codes: [] }`
- Client must show error message and disable pause button

### 3.2 `POST /api/agent/state`

**File:** `api/src/routes/agent/pause.ts` (same plugin)
**Auth:** JWT bearer; agent role minimum.
**Request body:**

```ts
interface SetAgentStateBody {
  status: "ready" | "paused" | "logged-out";
  pauseCode?: string | null;
  pauseReason?: string | null;  // free-form text for OPTIONAL mode
}
```

**Server logic:**
1. Extract `uid` and `tenantId` from JWT.
2. Load current agent state from Valkey.
3. Validate transition (e.g., cannot go to `paused` from `busy`).
4. If transitioning to `paused`:
   a. Fetch `campaign.pauseCodesRequired`.
   b. If FORCE: require `pauseCode` to be non-null and valid (exists in `pause_codes` table for this campaign/tenant). Return `400 PAUSE_CODE_REQUIRED` if not.
   c. If OPTIONAL: accept `pauseCode` OR `pauseReason` OR neither.
   d. If OFF: accept any (ignore code/reason).
   e. Write `agent_log` row: `{ event: "pause", pauseCode, metadata: { reason: pauseReason } }`.
5. If transitioning to `ready` (unpause):
   a. Calculate `durationSec` from previous `pausedSince` timestamp.
   b. Write `agent_log` row: `{ event: "unpause", durationSec }`.
6. Update Valkey: `SET t:{tenantId}:agent:{uid}:state { status, pauseCode, pausedSince }`.
7. Publish WS event: `t:{tenantId}:broadcast:agent:{uid}` → `{ type: "agent.state", status, pauseCode, pausedSince }`.
8. Return confirmed state.

**Error codes:**
- `PAUSE_CODE_REQUIRED` (400): FORCE mode, no code provided
- `INVALID_PAUSE_CODE` (400): FORCE mode, code not in valid list
- `INVALID_TRANSITION` (400): e.g., trying to pause while busy
- `UNAUTHENTICATED` (401): missing/invalid JWT

---

## 4. `PauseButton` Component Design

**Location:** `web/src/components/call/PauseButton.tsx`

### 4.1 Props

```ts
interface PauseButtonProps {
  /** If true, button is disabled (e.g., agent is busy) */
  disabled?: boolean;
  /** Optional size variant for use in different contexts */
  size?: "sm" | "md";
}
```

### 4.2 Behavior

The component calls `useAgentState()` internally for all state.

**When `status === "ready"` (or `wrapup` — agent can queue pause):**
- Button label: "Pause"
- Variant: `secondary`
- `aria-pressed={false}`
- On click:
  - If `pauseCodesRequired === "OFF"`: immediately calls `useAgentState().pause(null)` → optimistic transition
  - If `pauseCodesRequired === "OPTIONAL"` or `"FORCE"`: sets `menuOpen=true` → renders `PauseCodeMenu`

**When `status === "paused"`:**
- Button label: "Ready" (or "Go Ready")
- Variant: `primary` (green-adjacent)
- `aria-pressed={true}`
- On click: immediately calls `useAgentState().unpause()` → optimistic READY

**When `transitioning === true`:**
- Button shows `loading` spinner
- Disabled

**When `pauseConfig.loading === true` and mode is not OFF:**
- Open-menu click shows skeleton in PauseCodeMenu

**When `status === "busy"` or `"wrapup"` (A05 manages call):**
- The PauseButton is disabled (`disabled={true}`)

### 4.3 Hotkey integration

```ts
useHotkeys(
  React.useMemo(() => [{
    scope: "agent-shell" as const,
    key: "p",
    ctrl: true,
    ignoreInputFocus: true,
    priority: 10,
    description: "Toggle pause / go ready (Ctrl+P)",
    handler: () => {
      if (status === "paused") void unpause();
      else if (status === "ready") {
        if (pauseCodesRequired === "OFF") void pause(null);
        else setMenuOpen(true);
      }
    },
  }], [status, pauseCodesRequired, pause, unpause])
);
```

---

## 5. `PauseCodeMenu` Component Design

**Location:** `web/src/components/call/PauseCodeMenu.tsx`

### 5.1 Props

```ts
interface PauseCodeMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "OPTIONAL" | "FORCE";
  codes: PauseCodeOption[];
  loading: boolean;
  error: string | null;
  lastUsedCode: string | null;
  onSelect: (code: string | null, freeText?: string | null) => void;
  onCancel: () => void;
}
```

### 5.2 Rendering — OPTIONAL mode

Structure: `Dialog` (uses existing `web/src/components/ui/dialog.tsx`):

```
[Dialog]
  [DialogHeader] "Why are you pausing?"
  [List / Listbox]
    [Each PauseCodeOption]
      - Code badge + Name label + "(billable)" annotation
      - Highlighted if matches lastUsedCode
  [Separator]
  [Free-text section]
    [Label] "Or enter a reason:"
    [Input] placeholder="Type reason..." maxLength=255
  [Footer]
    [Button "Cancel" variant=secondary]
    [Button "Skip" variant=ghost]   ← only in OPTIONAL mode; pauses with no code
    [Button "Pause" variant=primary disabled={nothing selected}]
```

The "Pause" button is enabled when:
- A code is selected from the list, OR
- The free-text field has content (length > 0)
- OPTIONAL skip: the "Skip" button bypasses both requirements

### 5.3 Rendering — FORCE mode

```
[Dialog]
  [DialogHeader] "Select pause reason (required)"
  [List / Listbox]
    — if loading: show Skeleton rows
    — if codes.length === 0: error state (see below)
    — else: code items (same as OPTIONAL)
  [Footer]
    [Button "Cancel" variant=secondary]
    [Button "Pause" variant=primary disabled={!selectedCode}]
    — NO "Skip" button
    — NO free-text input
```

**FORCE mode, no codes configured:**
```
[Dialog]
  [DialogHeader] "Cannot Pause"
  [Body] "No pause codes are configured for this campaign. Please contact your administrator."
  [Footer]
    [Button "Close" variant=secondary]
    — Pause button is absent
```

### 5.4 Keyboard navigation

- Arrow Up/Down: move selection through the list
- Enter: confirm selection
- Escape: cancel (calls `onCancel`)
- Tab: moves between list items and action buttons; focus trap within dialog

The Dialog component (`web/src/components/ui/dialog.tsx`) provides the backdrop and handles click-outside close. A09 must add focus management: on open, focus the first code item (or the free-text input in OPTIONAL mode if lastUsedCode is null).

### 5.5 Screen reader announcements

- When menu opens: `role="dialog"` with `aria-labelledby` pointing to the title handles announcement automatically.
- When a code is selected: `aria-selected="true"` on the item.
- When transitioning: `role="status"` with `aria-live="polite"` announces "Pausing..." and then "Paused with code BREAK."
- Error state in FORCE mode: `role="alert"` for the error message.

---

## 6. State Flow: Optimistic UI vs Server-Confirmed

```
Agent clicks "Pause" (OFF mode)
  ↓
[UI] useAgentStore.setPause("") — status → "paused", pausedSince = now
[UI] transitioning = true
  ↓
[API] POST /api/agent/state { status: "paused" }
  ↓ (success)
[WS] receives agent.state { status: "paused", pauseCode: null, pausedSince: <server ts> }
[UI] patchFromEvent updates pausedSince to server timestamp
[UI] transitioning = false
  ↓ (failure)
[UI] useAgentStore.setStatus("ready") — rollback
[UI] transitioning = false
[UI] show error toast: "Failed to pause. Please try again."

Agent clicks "Pause" (OPTIONAL mode)
  ↓
[UI] PauseCodeMenu opens
Agent selects code "BREAK"
  ↓
[UI] useAgentStore.setPause("BREAK") — optimistic
[UI] PauseCodeMenu closes
[UI] transitioning = true
  ↓
[API] POST /api/agent/state { status: "paused", pauseCode: "BREAK" }
[UI] useUiStore.setLastUsedPauseCode("BREAK")
  ↓ (success)
[WS] agent.state event confirms
[UI] transitioning = false
  ↓ (failure)
[UI] rollback: setStatus("ready")
[UI] PauseCodeMenu could reopen (implementation decision: show error toast instead)

Agent clicks "Ready" (any mode)
  ↓
[UI] useAgentStore.clearPause() — status → "ready", clears pauseCode + pausedSince
[UI] transitioning = true
  ↓
[API] POST /api/agent/state { status: "ready" }
  ↓ (success)
[WS] agent.state event confirms
[UI] transitioning = false
  ↓ (failure)
[UI] rollback: useAgentStore.setPause(prevCode) — back to paused
[UI] error toast
```

---

## 7. Changes to Existing Files

### 7.1 `CampaignConfig` in `web/src/lib/stores/call.ts`

```ts
export interface CampaignConfig {
  id: number;
  name: string;
  // ... existing fields ...
  // A09 amendment — backward-compatible (optional, defaults to OPTIONAL)
  pause_codes_required?: "OFF" | "OPTIONAL" | "FORCE";
}
```

The API that populates `CampaignConfig` (called when a call is assigned) must also return `pause_codes_required`. This is populated from `campaigns.pause_codes_required` in the campaign service.

### 7.2 `useUiStore` in `web/src/lib/stores/ui.ts`

Add:
```ts
lastUsedPauseCode: string | null;
setLastUsedPauseCode: (code: string | null) => void;
```

Persisted in `localStorage` under `vici2.ui` (already uses `persist` middleware).

### 7.3 `AgentStateWidget` at `web/src/components/agent/AgentStateWidget.tsx`

Current: contains inline `PauseCodePicker` component.
After A09: `AgentStateWidget` delegates to `PauseButton` for the pause trigger and `PauseCodeMenu` for the picker. The inline `PauseCodePicker` and `StateMenu` sub-components are removed in favor of the dedicated components.

The `AgentStateWidget` still orchestrates the overall state display (badge showing current status, options for `logged-out` state).

### 7.4 `AgentStateToggle` at `web/src/components/call/AgentStateToggle.tsx`

This component is deprecated in favor of `PauseButton`. It currently does not call the API (local-only). Update it to:
```ts
// AgentStateToggle is now a thin wrapper around PauseButton for backward compat
export function AgentStateToggle() {
  return <PauseButton />;
}
```

Or mark as deprecated and migrate any remaining usages.

### 7.5 `StatusBar` at `web/src/components/shell/StatusBar.tsx`

Add a live pause duration counter when `status === "paused"` and `pausedSince` is set:

```ts
// Inside StatusBar
const pausedSince = useAgentStore((s) => s.pausedSince);
const [pauseSeconds, setPauseSeconds] = React.useState(0);

React.useEffect(() => {
  if (!pausedSince) { setPauseSeconds(0); return; }
  const tick = () => setPauseSeconds(Math.floor((Date.now() - pausedSince) / 1000));
  tick();
  const id = setInterval(tick, 1000);
  return () => clearInterval(id);
}, [pausedSince]);

// Render:
{agentStatus === "paused" && (
  <span>
    Agent: <strong>paused</strong>
    {pauseCode ? ` (${pauseCode})` : null}
    <span aria-live="off"> — {formatDuration(pauseSeconds)}</span>
  </span>
)}
```

The `formatDuration` helper: `0:00`, `1:23`, `12:34`, `1:23:45` for hours.

---

## 8. `getPauseCodes` API Extension

**Current signature** (`web/src/lib/agent/api.ts`):
```ts
export async function getPauseCodes(): Promise<PauseCode[]>
```

**Extended signature:**
```ts
export interface PauseCodesConfig {
  pauseCodesRequired: "OFF" | "OPTIONAL" | "FORCE";
  codes: PauseCode[];
}

export async function getPauseCodes(): Promise<PauseCodesConfig>
```

This is a breaking change to the `getPauseCodes` return type. The only consumer currently is `AgentStateWidget.tsx` (the inline `PauseCodePicker`), which A09 replaces. So the migration is contained within A09.

---

## 9. Backend Route Structure

**New file:** `api/src/routes/agent/pause.ts`

```ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getPrisma } from "../../lib/prisma.js";
// ... imports

const SetAgentStateSchema = z.object({
  status: z.enum(["ready", "paused", "logged-out"]),
  pauseCode: z.string().max(16).nullable().optional(),
  pauseReason: z.string().max(255).nullable().optional(),
});

export async function registerAgentPauseRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/agent/pause-codes", { preHandler: [requireAuth] }, handleGetPauseCodes);
  app.post("/api/agent/state", { preHandler: [requireAuth] }, handleSetAgentState);
}
```

**`handleGetPauseCodes`:** Queries `pause_codes` table for tenant + current campaign. Returns `PauseCodesConfig`.

**`handleSetAgentState`:** Validates body, checks FORCE mode code requirements, writes `agent_log`, updates Valkey, publishes WS event.

**Valkey keys:**
- Agent state key: `t:{tenantId}:agent:{uid}:state` (JSON: `{ status, pauseCode, pausedSince, currentCampaignId }`)
- This key is read by `handleGetPauseCodes` to determine `currentCampaignId`

**`agent_log` write:**

For pause:
```sql
INSERT INTO agent_log (tenant_id, user_id, campaign_id, event_at, event, pause_code, metadata)
VALUES (?, ?, ?, NOW(6), 'pause', ?, JSON_OBJECT('reason', ?))
```

For unpause:
```sql
INSERT INTO agent_log (tenant_id, user_id, campaign_id, event_at, event, duration_sec)
VALUES (?, ?, ?, NOW(6), 'unpause', TIMESTAMPDIFF(SECOND, FROM_UNIXTIME(?/1000), NOW(6)))
```

---

## 10. Accessibility Deep-Dive

### 10.1 PauseButton

- `aria-pressed={status === "paused"}` — togglebutton semantics
- `aria-label="Pause — currently ready"` or `"Go ready — currently paused"` with status
- `aria-busy={transitioning}` when API call is in flight
- Focus visible: existing `Button` component uses `focus-visible:ring-2`

### 10.2 PauseCodeMenu (Dialog-based)

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby="pause-menu-title"`
- Focus trap: Tab cycles through items + Cancel/Pause buttons
- Focus restore: on close, return focus to the PauseButton that opened the menu
- First focused element: first code item in FORCE mode; free-text input in OPTIONAL mode (when no lastUsedCode)
- `role="listbox"` on the codes container; `role="option"` on each item; `aria-selected`
- `aria-disabled="true"` on the Pause button when no selection

### 10.3 Screen reader announcements for state changes

```html
<!-- Live region for agent state changes — mounted once in AgentShell or StatusBar -->
<div aria-live="assertive" aria-atomic="true" class="sr-only" id="agent-state-announce">
  <!-- Text updated on pause/unpause transitions -->
</div>
```

On pause: announce "You are now paused. Reason: BREAK."
On unpause: announce "You are now ready."
On error: announce "Failed to change status. Please try again."

The live region text is managed by `useAgentState` hook via a ref to the DOM element, or via a simple wrapper state in `AgentShell`.

### 10.4 Keyboard-only flow

Complete keyboard flow for FORCE mode:

1. Agent presses `Ctrl+P` → menu opens
2. Focus moves to first code item (or "No codes" message)
3. Arrow keys navigate list
4. `Enter` selects code → "Pause" button becomes enabled
5. `Tab` to "Cancel" or "Pause" button
6. `Enter` on "Pause" → submit; menu closes
7. `Escape` → cancel; focus returns to PauseButton

---

## 11. RBAC and Security

### 11.1 Client-side

- `PauseButton` checks `status !== "busy"` and `status !== "wrapup"` before allowing interaction. This is a UX guard, not a security boundary.
- No role check is needed in the UI — agents always have access to their own state changes.

### 11.2 Server-side (`api/src/routes/agent/pause.ts`)

- `requireAuth` pre-handler extracts JWT.
- The handler uses `auth.uid` to determine whose state to change. There is no body field for `userId` — the agent can only modify their own state.
- FORCE mode validation: if `pauseCodesRequired === "FORCE"` and `pauseCode` is null or not in the valid codes list → 400.
- Transition validation: if agent is `busy` (active call in progress) → reject pause request with `INVALID_TRANSITION`.

### 11.3 `agent_log` audit trail

Every pause/unpause is logged in `agent_log` (schema verified in RESEARCH §1.4). The log includes:
- `event`: `pause` or `unpause`
- `pauseCode`: the selected code (or null)
- `metadata.reason`: free-form text if OPTIONAL mode was used
- `durationSec`: filled on `unpause`

---

## 12. `PauseAfterCallToggle` Integration

The A06 auto-dial module stores `pendingPauseAfterCall` and `pendingPauseCode` in `useCallStore`. When a call ends, the auto-dial router reads these to determine whether to pause the agent.

**A09's concern:** If `pauseCodesRequired === "FORCE"` and `pendingPauseCode === null`, the auto-dial should not silently pause without a code. The current `PauseAfterCallToggle` does not handle FORCE mode.

**Resolution:**

1. `PauseAfterCallToggle` remains as-is (A06's component).
2. `useAgentState.pause(code)` is the single point where FORCE-mode validation occurs.
3. When the auto-dial router calls `pause(null)` in FORCE mode, `useAgentState.pause` throws a validation error before any API call.
4. The auto-dial router must catch this and: in FORCE mode, do NOT pause the agent silently; instead transition to `ready` and open the `PauseCodeMenu` (or show a toast: "Cannot pause: select a pause code first.").

This is an A09 + A06 coordination point. A09 documents it in HANDOFF.md. The fix to the auto-dial router is the responsibility of the A09 implementor.

**Implementation detail:** `useAgentState.pause` signature:
```ts
pause(code: string | null, freeText?: string | null): Promise<void>
// throws PauseValidationError if FORCE mode and code is null/invalid
```

---

## 13. Persistence of Last-Used Pause Code

**Why:** Agents frequently use the same pause code (e.g., "LUNCH") repeatedly. Pre-selecting it reduces clicks.

**Implementation:**

```ts
// In useUiStore (web/src/lib/stores/ui.ts)
interface UiState {
  // ... existing fields
  lastUsedPauseCode: string | null;
  setLastUsedPauseCode: (code: string | null) => void;
}
```

**In `useAgentState.pause`:**
```ts
if (code) {
  useUiStore.getState().setLastUsedPauseCode(code);
}
```

**In `PauseCodeMenu`:**
- The code matching `lastUsedCode` gets a "Recent" badge and is rendered first in the list.
- In OPTIONAL mode, it is pre-selected.
- In FORCE mode, it is pre-selected (still requires confirmation click).

**Persistence scope:** localStorage (already done by `useUiStore` with `persist` middleware). Cross-session and cross-tab persistent. If the code no longer exists in the campaign's code list, it falls back to no pre-selection (the code is validated against the live list).

---

## 14. Acceptance Criteria

### AC-1: OFF mode — one-click toggle

- Given `campaign.pauseCodesRequired === "OFF"` (or no campaign)
- When agent clicks Pause
- Then: agent status becomes PAUSED immediately (optimistic), no menu opens
- Then: `POST /api/agent/state { status: "paused" }` is called (no pauseCode)
- Then: `agent_log` entry with `event=pause, pause_code=null` is created
- Then: clicking again → status becomes READY; `agent_log` entry with `event=unpause`

### AC-2: OPTIONAL mode — code selection

- Given `campaign.pauseCodesRequired === "OPTIONAL"`
- When agent clicks Pause
- Then: PauseCodeMenu opens with code list + free-text input + Skip button
- When agent selects code "BREAK" and clicks "Pause"
- Then: status → PAUSED with `pauseCode = "BREAK"` in store and WS event
- Then: `agent_log` entry with `event=pause, pause_code="BREAK"`

### AC-3: OPTIONAL mode — free-form text

- Given `campaign.pauseCodesRequired === "OPTIONAL"`
- When agent types "Bathroom break" in free-text, leaves code list unselected
- When agent clicks "Pause"
- Then: status → PAUSED with `pauseCode = null` in store
- Then: `agent_log` entry with `event=pause, pause_code=null, metadata={"reason":"Bathroom break"}`

### AC-4: OPTIONAL mode — skip

- Given `campaign.pauseCodesRequired === "OPTIONAL"`
- When agent clicks "Skip" in PauseCodeMenu
- Then: status → PAUSED, no code, no reason
- Then: `agent_log` entry with `event=pause, pause_code=null, metadata=null`

### AC-5: FORCE mode — must pick a code

- Given `campaign.pauseCodesRequired === "FORCE"`
- When agent clicks Pause
- Then: PauseCodeMenu opens, no Skip button, no free-text input
- When agent tries to dismiss without selecting → Escape closes without pausing
- When agent selects code and clicks "Pause"
- Then: status → PAUSED with the selected code

### AC-6: FORCE mode — free-form rejected

- Given `campaign.pauseCodesRequired === "FORCE"`
- When agent submits `POST /api/agent/state { status: "paused", pauseCode: null }`
- Then: server returns 400 `PAUSE_CODE_REQUIRED`
- Then: client shows error, rolls back optimistic update

### AC-7: FORCE mode — no codes configured

- Given `campaign.pauseCodesRequired === "FORCE"` and zero pause codes in DB
- When agent clicks Pause
- Then: PauseCodeMenu shows "No pause codes configured" message
- Then: Pause button is disabled
- Then: agent cannot pause until admin adds codes (M07)

### AC-8: Pause duration visible

- Given agent is PAUSED
- Then: StatusBar shows duration `00:00` counting up every second
- When agent goes READY, duration resets

### AC-9: Cannot dial while PAUSED

- Given agent is PAUSED
- Then: DialButton (from A04) is disabled
- (This is enforced by DialButton, not by A09. A09 ensures `useAgentStore.status === "paused"` is accurate so DialButton can read it.)

### AC-10: Hotkey Ctrl+P

- Given agent is READY and any mode
- When agent presses Ctrl+P
- Then: same behavior as clicking the Pause button for that mode
- Given agent is PAUSED
- When agent presses Ctrl+P
- Then: agent transitions to READY (same as clicking "Go Ready")
- Given agent presses F1
- Then: HotkeyHelpOverlay shows Ctrl+P in the "Agent Shell" section

### AC-11: Rollback on API failure

- Given agent optimistically transitions to PAUSED
- When API returns 500
- Then: store rolls back to READY
- Then: error toast displayed

### AC-12: agent_log entries

- Every pause/unpause has an `agent_log` row with correct `event`, `pause_code`, `duration_sec`
- `pause_code` in log must not exceed 16 characters (matches schema constraint)

### AC-13: Last-used code persistence

- Given agent last paused with code "LUNCH"
- When agent opens PauseCodeMenu again
- Then: "LUNCH" is pre-selected and appears first in the list

### AC-14: WS confirms state

- Given pause is in progress (optimistic)
- When WS delivers `agent.state { status: "paused", pauseCode: "BREAK" }`
- Then: store reflects server-confirmed state

### AC-15: PauseAfterCallToggle + FORCE mode

- Given agent toggles "Pause after call" in FORCE mode without a code
- When call ends
- Then: agent is NOT silently paused; PauseCodeMenu opens for code selection

---

## 15. Phase Plan

### Phase A — Hook + API route + OFF mode (Day 1 morning)

1. Create `api/src/routes/agent/pause.ts`:
   - `GET /api/agent/pause-codes` handler (reads DB, returns config)
   - `POST /api/agent/state` handler (validates, writes agent_log, updates Valkey, publishes WS)
2. Register routes in API app
3. Extend `getPauseCodes()` in `web/src/lib/agent/api.ts` to return `PauseCodesConfig`
4. Create `web/src/lib/agent/useAgentState.ts` (OFF mode only for now)
5. Create `web/src/components/call/PauseButton.tsx` (OFF mode: simple toggle)
6. Update `AgentStateWidget` to use `PauseButton`
7. Verify: OFF mode one-click pause/unpause works end-to-end with API and WS

### Phase B — OPTIONAL mode (Day 1 afternoon)

1. Create `web/src/components/call/PauseCodeMenu.tsx` with OPTIONAL rendering
2. Connect `PauseButton` to `PauseCodeMenu` for OPTIONAL mode
3. Implement free-text path in `useAgentState.pause`
4. Add `lastUsedPauseCode` to `useUiStore` and wire up persistence
5. Verify: OPTIONAL mode works: code selection, free-text, skip

### Phase C — FORCE mode + server validation (Day 2 morning)

1. Add FORCE rendering to `PauseCodeMenu` (no skip, no free-text, no-codes error state)
2. Add FORCE validation in `useAgentState.pause` (client-side guard)
3. Add FORCE validation in server `handleSetAgentState` (server-side enforcement)
4. Handle `PauseAfterCallToggle` in FORCE mode (open code menu instead of silent pause)
5. Verify: FORCE mode rejects free-form; no codes → error message

### Phase D — UX polish (Day 2 afternoon)

1. Add pause duration timer to `StatusBar`
2. Register `Ctrl+P` hotkey via `useHotkeys()` in `PauseButton`
3. Add `aria-live` announcer to `AgentShell` for pause state changes
4. Ensure focus management in `PauseCodeMenu` (trap, restore)
5. Verify: F1 overlay shows Ctrl+P; duration counts up; accessibility passes

### Phase E — Tests (Day 3 — 1–2 days budget allows Day 3 focus)

1. `web/src/components/call/__tests__/PauseButton.test.tsx`:
   - OFF mode: click → API called, optimistic update, rollback on error
   - Ctrl+P hotkey fires
2. `web/src/components/call/__tests__/PauseCodeMenu.test.tsx`:
   - OPTIONAL: code selection, free-text, skip
   - FORCE: skip button absent, no-codes error state
   - Keyboard navigation (arrow keys, Enter, Escape)
3. `web/src/lib/agent/__tests__/useAgentState.test.ts`:
   - Cache TTL (60s)
   - FORCE validation error thrown
   - Rollback path
4. `api/test/pause/pause.test.ts`:
   - GET /api/agent/pause-codes: returns merged global+campaign codes
   - POST /api/agent/state: valid pause, valid unpause, FORCE rejection, transition rejection
   - agent_log rows created correctly

---

## 16. Dependencies and Integration Points

| Dependency | What A09 needs | Status |
|---|---|---|
| `useAgentStore` (A03) | `status`, `pauseCode`, `pausedSince`, `setPause`, `clearPause`, `patchFromEvent` | Exists; frozen |
| `setAgentState` (A03 stub) | `POST /api/agent/state` client call | Exists; backend to implement |
| `getPauseCodes` (A03 stub) | `GET /api/agent/pause-codes` client call | Exists; backend to implement + return type extended |
| `hotkeyRegistry` (A03) | Register Ctrl+P | Exists; frozen |
| `Button`, `Badge`, `Dialog`, `Input` (A01) | UI primitives | Exists; frozen |
| `useUiStore` (A01) | `lastUsedPauseCode` field | Exists; field added by A09 |
| `CampaignConfig.pause_codes_required` (A09 adds) | Mode determination | A09 adds this field |
| F02 schema: `PauseCode` model | DB table | Exists in schema.prisma |
| F02 schema: `AgentLog` model | Log writes | Exists in schema.prisma |
| M07 (pause code CRUD) | Data source for codes | Not started; A09 works with seeded test data |
| A06 `PauseAfterCallToggle` | FORCE mode coordination | Exists; requires update for FORCE mode |
| Valkey (agent state cache) | Read `currentCampaignId`; write state | Infrastructure exists |

---

## 17. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Backend Valkey schema for agent state is not yet defined | Medium | High | PLAN documents expected key format; coordinate with A03/A04 backend impl |
| `CampaignConfig.pause_codes_required` not populated by call-assignment API | Medium | Medium | Fetch separately via `GET /api/agent/pause-codes`; do not rely on CampaignConfig for mode |
| FORCE mode validation race: agent submits before mode is loaded | Low | Low | Default to OPTIONAL if mode is not yet known; UI shows loading skeleton |
| `agent_log` partition on `eventAt`: ensure INSERT uses `NOW(6)` not client timestamp | Low | Low | Use server-side `NOW(6)` in all INSERT statements |
| Focus management in Dialog breaks on mobile/tablet | Low | Medium | Test with `Tab` traversal; Dialog component already handles backdrop click |

---

## 18. What A09 Does NOT Implement

- **Pause code CRUD** — this is M07's responsibility. A09 only reads codes.
- **Supervisor-forced pause** — supervisor setting an agent's state remotely is a future feature.
- **Pause timer alerting** — notify supervisor if agent pauses for too long — future/S01 feature.
- **Batch unpause** — supervisor unpausing multiple agents at once — future/S01 feature.
- **Inbound pause during call** — agent can request to be removed from queue while on a call — A06 feature.
