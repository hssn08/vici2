# A09 — Pause Codes UI: RESEARCH

**Module:** A09 (Agent UI track, Phase 1)
**Date:** 2026-05-13
**Author:** A09 PLAN sub-agent (Claude Sonnet 4.6)
**Status:** FINAL

---

## 1. Pause Codes Data Model

### 1.1 Schema: `PauseCode` (api/prisma/schema.prisma, line 624)

```prisma
model PauseCode {
  id         BigInt   @id @default(autoincrement())
  tenantId   BigInt   @default(1) @map("tenant_id")
  campaignId String?  @map("campaign_id") @db.VarChar(32)   // NULL = global
  code       String   @db.VarChar(16)
  name       String   @db.VarChar(64)
  billable   Boolean  @default(true)
  createdAt  DateTime @default(now()) @map("created_at") @db.DateTime(6)
  updatedAt  DateTime @updatedAt @map("updated_at") @db.DateTime(6)

  tenant   Tenant    @relation(...)
  campaign Campaign? @relation(...)

  @@index([tenantId, campaignId, code])
  @@map("pause_codes")
}
```

**Key observations:**

- **Scoping:** `campaignId` is nullable. `NULL` means the code is global (tenant-level) and applies to all campaigns. When `campaignId` is set, the code is campaign-specific and is cascade-deleted if the campaign is deleted (`onDelete: Cascade`). The extra-indexes migration adds a functional UNIQUE on `(tenant_id, IFNULL(campaign_id,'__SYS__'), code)`, preventing duplicate codes within the same scope.
- **Fields used by UI:** `code` (short key stored in `agent_log.pause_code`, max 16 chars), `name` (display label, max 64 chars), `billable` (shown as annotation in picker).
- **No `active`/`enabled` flag exists in the current schema.** If M07 adds soft-delete, A09 will filter server-side. The API endpoint must return only active codes.
- **Relation to Tenant:** `pauseCodes PauseCode[]` is also on the `Tenant` model (line 141). This is for global codes.
- **Relation to Campaign:** `pauseCodes PauseCode[]` is on the `Campaign` model (line 493). This is for campaign-scoped codes.

### 1.2 Schema: `PauseCodesRequired` enum (api/prisma/schema.prisma, lines 361–365)

```prisma
enum PauseCodesRequired {
  OFF
  OPTIONAL
  FORCE
}
```

- **OFF:** Agent can freely toggle READY ↔ PAUSED without any code or reason.
- **OPTIONAL:** Agent may select a pause code from the list *or* enter free-form text as a reason. The code field in `agent_log` may be null or a short string.
- **FORCE:** Agent *must* select a registered pause code before entering PAUSED. Free-form text is not allowed. The UI must prevent the transition until a code is selected.

### 1.3 Schema: `Campaign.pauseCodesRequired` (api/prisma/schema.prisma, line 420)

```prisma
pauseCodesRequired  PauseCodesRequired @default(OPTIONAL) @map("pause_codes_required")
```

Located in the `Campaign` model. Default is `OPTIONAL`. This field is serialized via the campaign service (`api/src/routes/campaigns/service.ts`, line 50 and 104):

```ts
// write path
if (input.pause_codes_required !== undefined) d.pauseCodesRequired = input.pause_codes_required;
// read path
pause_codes_required: c.pauseCodesRequired,
```

The Zod schema validation for it is at `api/src/routes/campaigns/schema.ts`, line 33 and 100:

```ts
export const PauseCodesRequiredEnum = z.enum(["OFF", "OPTIONAL", "FORCE"]);
// ...
pause_codes_required: PauseCodesRequiredEnum.default("OPTIONAL"),
```

### 1.4 Schema: `AgentLog` and `agent_log.pause_code` (api/prisma/schema.prisma, line 1288)

```prisma
model AgentLog {
  id          BigInt     @default(autoincrement())
  tenantId    BigInt
  userId      BigInt
  campaignId  String?
  callLogId   BigInt?
  eventAt     DateTime
  event       AgentEvent
  pauseCode   String?    @map("pause_code") @db.VarChar(16)
  durationSec Int?
  metadata    Json?
  ...
  @@map("agent_log")
}
```

The `AgentEvent` enum includes `pause` and `unpause`. The `pauseCode` field stores the selected code at pause time; it is null on `unpause` events (duration is calculated at unpause). The `durationSec` field is filled in on `unpause` events.

---

## 2. How Agent State is Set Today

### 2.1 Client-side API layer (web/src/lib/agent/api.ts)

The entire agent state API is defined at `/root/vici2/web/src/lib/agent/api.ts`:

```ts
GET  /api/agent/state       → AgentStateResponse
POST /api/agent/state       → AgentStateResponse  (body: { status, pauseCode? })
GET  /api/agent/pause-codes → PauseCode[]
```

The `setAgentState` function posts `{ status: "paused", pauseCode: code }` for pause, and `{ status: "ready" }` for unpause. The `getPauseCodes` function fetches available codes — these are loaded lazily when the pause picker opens.

**Critical finding:** The backend routes for `POST /api/agent/state` and `GET /api/agent/pause-codes` are **not yet implemented** in `api/src/routes/`. The client-side API layer (`web/src/lib/agent/api.ts`) was created by A03 as a stub that calls the backend, but the backend handlers are A09's responsibility to implement.

### 2.2 Client-side Zustand store (web/src/lib/stores/agent.ts)

```ts
export type AgentStatus = "logged-out" | "ready" | "paused" | "busy" | "wrapup";

interface AgentState {
  status: AgentStatus;
  pauseCode: string | null;
  pausedSince: number | null;
  currentCampaignId: number | null;
  inboundGroupIds: number[];

  setStatus: (status: AgentStatus) => void;
  setPause: (code: string) => void;    // sets status=paused, records pausedSince=Date.now()
  clearPause: () => void;              // sets status=ready, clears pauseCode and pausedSince
  joinCampaign: (id: number | null) => void;
  patchFromEvent: (patch: Partial<AgentState>) => void;  // WS event handler
}
```

`setPause(code)` is called *optimistically* before the API response. `clearPause()` returns the agent to ready. The `pausedSince` timestamp allows the UI to show pause duration as a running timer.

### 2.3 Existing AgentStateWidget (web/src/components/agent/AgentStateWidget.tsx)

This component was delivered by A03. It implements:
- A badge-style button showing current status
- A `StateMenu` popover with `READY / PAUSED / OFFLINE` options
- A `PauseCodePicker` sub-component that fetches codes via `getPauseCodes()` and shows them in a listbox

**Critically, the existing widget does NOT read `campaign.pauseCodesRequired`.** It always shows the pause code picker when transitioning to `paused`. A09 must:
1. Extend the existing `AgentStateWidget` or replace it with a purpose-built `PauseButton` + `PauseCodeMenu` pair
2. Feed `pauseCodesRequired` from the campaign config into the pause flow

### 2.4 Existing AgentStateToggle (web/src/components/call/AgentStateToggle.tsx)

This is a simpler toggle component (delivered by A01 as a placeholder). It does not call the API at all — it only updates the local Zustand store. The A01 HANDOFF explicitly states: "A09 will swap the simple toggle for a pause-code picker." A09 should replace the internals of `AgentStateToggle` or deprecate it in favor of `PauseButton`.

### 2.5 WS event sync (web/src/lib/agent/useAgentStateSync.ts)

The WebSocket syncs server-authoritative agent state via `agent.state` events:

```ts
interface AgentStatePayload {
  status: AgentStatus;
  pauseCode?: string | null;
  pausedSince?: number | null;
  currentCampaignId?: number | null;
  inboundGroupIds?: number[];
}
```

This means the server confirms state changes by broadcasting `agent.state` events back. The UI should treat the server WS event as the ground truth and use optimistic updates only for responsiveness.

### 2.6 PauseAfterCallToggle (web/src/app/(agent)/auto/_components/PauseAfterCallToggle.tsx)

The auto-dial module (A06) introduced a "pause after call" feature. It stores `pendingPauseAfterCall: boolean` and `pendingPauseCode: string | null` in `useCallStore`. When the call ends, the auto-dial router checks `pendingPauseAfterCall` and, if set, transitions the agent to paused using `pendingPauseCode`. A09's `useAgentState` hook (or extended store) must handle the `pendingPauseCode` correctly — if FORCE mode and no code was pre-selected, the agent must be prompted.

---

## 3. `pauseCodesRequired` Mode Behaviors

### 3.1 OFF mode

- PauseButton renders as a simple toggle: READY → click → immediately PAUSED (no menu). PAUSED → click → immediately READY.
- No `PauseCodeMenu` renders at all.
- `pauseCode` stored as `null` (or a sentinel like `"__NONE__"` is not recommended; null is cleaner).
- `agent_log.pause_code` is null.

### 3.2 OPTIONAL mode

- Clicking "Pause" opens `PauseCodeMenu` with the list of available codes AND a free-text input field.
- Agent can either: (a) select a code from the list, (b) type a free-form reason and submit, or (c) click "Skip" to pause without any reason (code remains null).
- If the code list is empty and the agent types nothing and clicks Skip, pause proceeds with `pauseCode = null`.
- Free-form text: stored in `agent_log.metadata.pause_reason` (as JSON); `agent_log.pause_code` remains null for free-form entries.

### 3.3 FORCE mode

- Clicking "Pause" opens `PauseCodeMenu` showing only the list of available codes.
- The "Skip" button and free-text input are hidden.
- If the list is empty (no codes configured for the campaign/tenant), the UI must show an error: "No pause codes configured. Contact your administrator." The button to confirm pause is disabled.
- The agent cannot reach PAUSED status without a valid `pauseCode` from the list.
- The API endpoint must also validate this server-side: reject `POST /api/agent/state { status: "paused", pauseCode: null }` if campaign `pauseCodesRequired === FORCE`.

---

## 4. shadcn/ui Components Available

The project uses hand-vendored primitives compatible with shadcn/ui. Available at `web/src/components/ui/`:

| Component | File | Relevant for A09 |
|---|---|---|
| `Button` | `button.tsx` | PauseButton trigger; uses `loading` prop for transitioning state |
| `Badge` | `badge.tsx` | Status indicator (warning tone for PAUSED) |
| `Dialog` + `DialogContent` | `dialog.tsx` | Could house PauseCodeMenu as a modal in FORCE mode |
| `Input` | `input.tsx` | Free-text reason field in OPTIONAL mode |
| `Label` | `label.tsx` | Labels for the free-text field |
| `Skeleton` | `skeleton.tsx` | Loading state while codes fetch |

**No DropdownMenu primitive exists.** The `AgentStateWidget.tsx` implemented its own popover using a positioned `div` + `role="listbox"`. A09 can follow the same pattern or render a `Dialog` for the code picker, which provides better focus trapping and accessibility.

**Recommendation:** Use a `Dialog` for FORCE mode (agent must pick — harder to dismiss accidentally) and a lightweight popover/listbox for OPTIONAL mode. For OFF mode, no overlay at all.

---

## 5. Hotkey Integration with A07's HotkeyHelpOverlay

### 5.1 Hotkey registry

The `HotkeyRegistry` singleton at `web/src/lib/hotkeys/registry.ts` is the central registry. All hotkeys registered via `useHotkeys()` or `hotkeyRegistry.register()` automatically appear in the F1 overlay (`HotkeyHelpOverlay.tsx`). The overlay reads `hotkeyRegistry.getAll()` and groups by `HotkeyScope`.

### 5.2 Scopes

Valid scopes (from `web/src/lib/hotkeys/registry.ts`):
```ts
type HotkeyScope = "global" | "in-call" | "wrapup" | "modal" | "auto-dial" | "agent-shell" | "dial";
```

The pause hotkey should use scope `"agent-shell"` since it is relevant whenever the agent shell is visible (not just during a call).

### 5.3 Proposed pause hotkey

- **Ctrl+P** — "Toggle pause / go ready" (matches Vicidial's Ctrl+P convention noted in A05 PLAN §0 bullet 10)
- Registered with `ignoreInputFocus: true` so it fires even when a text field is focused
- Priority: `10` (above default 0, below F-keys at 100)
- When FORCE or OPTIONAL: opens the `PauseCodeMenu`
- When OFF: immediately toggles
- When already picking a code (menu open): Escape closes the menu; Ctrl+P while menu open has no effect (menu handles its own keyboard navigation)

The `useInCallHotkeys` hook at `web/src/lib/hooks/useInCallHotkeys.ts` does NOT use the central registry (it registers its own raw `keydown` listener). A09's pause hotkey must use the central registry via `useHotkeys()` to appear in the F1 overlay.

Note: A05 PLAN §0 bullet 10 references `Ctrl+P` for global pause. This must not conflict with any in-call hotkeys (checked: `useInCallHotkeys.ts` does not bind Ctrl+P). The `PauseAfterCallToggle` binds lowercase `p` (no modifiers) for "pause after call" in the `in-call` scope — no conflict with `Ctrl+P`.

---

## 6. State Machine: Extended Agent Pause States

The current `AgentStatus` type in `useAgentStore` has: `"logged-out" | "ready" | "paused" | "busy" | "wrapup"`.

The A03 PLAN specifies the state machine:
```
OFFLINE → READY (login)
READY   → PAUSED | BUSY
PAUSED  → READY | BUSY (call can arrive while paused)
BUSY    → WRAPUP → READY | PAUSED
```

A09 introduces *transient UI states* that are client-only (not persisted to server). These are needed for optimistic UI and interruption handling:

```
READY   → [PAUSING]  → PAUSED   (optimistic: setPause called; server confirms)
PAUSED  → [UNPAUSING] → READY   (optimistic: clearPause called; server confirms)
[PAUSING] → READY   (rollback if API fails)
[UNPAUSING] → PAUSED (rollback if API fails)
[PAUSING] → BUSY    (if call arrives before pause is confirmed — rare but possible)
```

**Approach:** These transient states are NOT added to `AgentStatus`. Instead, A09 introduces a `pauseTransition: "none" | "pausing" | "unpausing"` field in either the store or local component state. The `PauseButton` is disabled and shows a spinner during transitions.

**Interruption handling (PAUSING → call arrives):**
- WS delivers `{ status: "busy" }` via `patchFromEvent`
- `patchFromEvent` overwrites status to `"busy"`
- The menu, if open, is closed by the parent component (which watches `status`)
- The pending pause code is discarded

---

## 7. Existing `useAgentState` Hook — Does It Exist?

**Finding:** No `useAgentState` hook file exists in the codebase. The spec for A09 in `A09.md` calls for creating this hook. The closest existing hook is the store-bound selector pattern: `useAgentStore((s) => s.status)` etc.

There is `useAgentStateSync` at `web/src/lib/agent/useAgentStateSync.ts` — this handles WS → store syncing but is not a general-purpose "read agent state" hook.

The `useAgentTodayStats` hook at `web/src/lib/hooks/useAgentTodayStats.ts` fetches productivity stats.

**Conclusion:** A09 must create `web/src/lib/hooks/useAgentState.ts` (or `web/src/lib/agent/useAgentState.ts`). Following the convention of co-locating agent-related helpers in `web/src/lib/agent/`, it should go there.

---

## 8. Campaign Config in the UI — How `pauseCodesRequired` Reaches the Component

Currently, the `CampaignConfig` type in `web/src/lib/stores/call.ts` (line 50–63) does **not include** `pause_codes_required`:

```ts
export interface CampaignConfig {
  id: number;
  name: string;
  dial_method?: ...;
  recording_mode: ...;
  wrapup_seconds: number;
  hangup_grace_seconds: number;
  hot_keys_active: boolean;
  webform_url: string | null;
  auto_ready_after_wrapup?: boolean;
  preview_allowed_seconds?: number;
  default_dispo?: string | null;
  // pauseCodesRequired is NOT present
}
```

A09 must add `pause_codes_required: "OFF" | "OPTIONAL" | "FORCE"` to `CampaignConfig`.

The `currentCampaignId` is available in `useAgentStore`. The `campaign` object with full config is in `useCallStore` (populated when a call is active). Between calls (agent in READY state), the campaign config may not be loaded.

**Resolution options:**
1. Fetch campaign config from `GET /api/agent/pause-codes?campaignId=<id>` (the server can include `pauseCodesRequired` in the response)
2. Fetch from `GET /api/campaigns/:id` and cache in agent store or component state
3. Have the backend include `pauseCodesRequired` in the `GET /api/agent/state` response

**Recommended approach:** The `GET /api/agent/pause-codes` endpoint returns both the codes AND `pauseCodesRequired` for the agent's current campaign. This is a single request. Response shape:

```ts
interface PauseCodesConfig {
  pauseCodesRequired: "OFF" | "OPTIONAL" | "FORCE";
  codes: Array<{ code: string; name: string; billable: boolean }>;
}
```

---

## 9. Duration Display

The `pausedSince: number | null` field in `useAgentStore` is set by `setPause()` to `Date.now()`. A duration display showing how long the agent has been paused can be computed with a simple `setInterval` timer in the component. The `StatusBar` at `web/src/components/shell/StatusBar.tsx` currently shows `Agent: paused (CODE)` but has no duration. A09 should add duration to the status bar.

---

## 10. RBAC Analysis

From `shared/types/src/rbac.ts`:

- `pause-code:read` — granted to: `super_admin`, `admin`, `supervisor`, `agent`, `viewer`. Agents CAN read pause codes.
- `pause-code:edit` — granted to: `super_admin`, `admin` only. Agents CANNOT edit pause codes (M07 only).
- There is no explicit `agent:pause` verb. The agent sets their own state via `POST /api/agent/state` which is implicitly allowed for the `agent` role (they can only modify their own state via `scope: 'own'` semantics).

The API must enforce: an agent can only change their own state. A supervisor can change any agent's state within their group (future capability — not required for A09). The `POST /api/agent/state` endpoint uses the JWT's `uid` to determine whose state to change (always `own`).

---

## 11. Open Questions

1. **Should `pauseCodesRequired` be returned in `GET /api/agent/state` or `GET /api/agent/pause-codes`?** Recommendation: include it in the pause-codes response to avoid a second round-trip. The PLAN resolves this by extending the pause-codes API response.

2. **Where does the `agent_log` entry get written?** The server writes to `agent_log` on `POST /api/agent/state`. A09's API route handler must insert a row with `event=pause` and `pauseCode=<code>` on the pause transition, and `event=unpause` with `durationSec` on the unpause transition.

3. **What happens if the agent has no campaign (`currentCampaignId = null`)?** This is possible for agents in a "no campaign" state (e.g., just logged in). When `currentCampaignId` is null, the server should return the tenant-level global pause codes with `pauseCodesRequired = OPTIONAL` as the default. The PLAN resolves this as: if no campaign is joined, fall back to tenant-global codes and OPTIONAL mode.

4. **How does A09's `useAgentState` hook expose `pauseCodesRequired` to components?** The hook fetches codes when needed and caches them. The `pauseCodesRequired` setting is also cached. This way components do not make direct API calls.

5. **The existing `AgentStateWidget` already partially implements A09's requirements.** Should A09 extend it or refactor? Answer: A09 extends it. `PauseButton.tsx` and `PauseCodeMenu.tsx` become standalone components that can be used independently; `AgentStateWidget` is updated to use them.

6. **How does `PauseAfterCallToggle` set a pause code in FORCE mode?** The auto-dial flow (A06) stores `pendingPauseCode` in `useCallStore`. A09 must ensure that when `pendingPauseAfterCall=true` and `pendingPauseCode=null` and `pauseCodesRequired=FORCE`, the agent is prompted for a code at the moment the call ends rather than silently failing.

7. **localStorage persistence of last-used code?** The A09 spec asks about this. The `useUiStore` is the only persisted store (it uses Zustand `persist`). Adding `lastUsedPauseCode` to `useUiStore` is the correct approach — no new persistence mechanism needed.
