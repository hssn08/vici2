# Module A06 — Auto-Dial / Predictive-Mode Agent UI — PLAN

**Module:** A06 (Agent UI track, Phase 1)
**Author:** A06-PLAN sub-agent (Claude Sonnet 4.6)
**Date:** 2026-05-13
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 10 topic areas, 40+ citations behind every choice.

**Depends on (PLANs already FROZEN or PROPOSED):**
- A01 PLAN (Next.js skeleton, route map, stores, WS wrapper, `useWebSocket()`, provider slots)
- A02 PLAN / HANDOFF (`useSoftphone()` hook; SIP.js park-leg model; `confFQN()` helper)
- A03 PLAN (agent state widget; `useAgentStore`; `HotkeyRegistry`; `useHotkeys()`)
- A04 PLAN (`useCallStore` base shape; `dialMode` field already defined; `resetDial()`)
- A05 PLAN (call panel; dispo overlay in WRAPUP; `useCallStore.campaign`; `wrapupStartAt`)
- D06 PLAN (callback creation endpoint; D06 state machine)
- E04 HANDOFF (`call.reserved` dispatch path; PROGRESSIVE vs PREDICTIVE AnswerHandler)
- E02 PLAN (`dispatch_tokens` contract; A06 does NOT read this)
- T03 PLAN (agent conference `confFQN(tid, uid)` name; park-and-join extension)
- T04 PLAN (`attempt_uuid` one-UUID rule; `OriginateRequest` shape)
- F02 PLAN + F02 Amendments (schema baseline; `campaigns` table columns)

**Blocks:**
- A07 (transfer UI — uses same in-call workspace; A06 WRAPUP routing must not conflict)
- S01 (supervisor wallboard — reads same `useAgentStore` and WS events)
- M01 (admin campaign config — must expose new A06 campaign columns to admin UI)

This document turns the A06 RESEARCH into the exact component tree, state machine,
store contract, REST surface, WebSocket subscription set, hotkey registry, audible
alert strategy, disposition auto-prompt, and test plan the IMPLEMENT phase will
deliver. **No `.tsx` is produced here.** Once approved, the public interface (route
slots, store field additions, REST paths, WS event set, component prop types, hotkey
registry entries) is FROZEN. Internal reducer phrasing, component sub-decomposition,
and CSS details may change without RFC.

---

## 0. TL;DR — 12-bullet decision summary

1. **A06 = the auto-dial waiting screen + reservation overlay + post-call routing glue.** The in-call panel is A05; the disposition overlay is A05's WRAPUP state. A06 owns exactly: (a) `(agent)/auto/page.tsx` (IDLE + RESERVED states), (b) the `useAutoDialStore` extensions, (c) the reservation overlay component, (d) the audible alert pre-arm, (e) the post-dispo routing logic that navigates to `/auto` instead of `/dial`.

2. **Six states, two routes.** IDLE and RESERVED live at `(agent)/auto`. CALLING, CONNECTED, WRAPUP live at `(agent)/call` (A05's page). A06 transitions between these two routes. The wrapup dispo overlay is A05-owned but A06-configured via `useCallStore.campaign` fields.

3. **A06 never dials.** No `POST /api/agent/manual_dial` call is ever issued from A06. Dialing is E04's job. A06 only sends reservation accept/reject signals and dispo submissions. The "no-manual-click" invariant (RESEARCH §2.3) is enforced architecturally: no dial button exists in A06.

4. **Reservation overlay is `role="alertdialog"` with `aria-live="assertive"`.** Screen readers announce the arrival immediately. Focus moves to the overlay's first action button. If `preview_allowed_seconds = 0`, overlay is passive (no buttons, no focus trap) — it slides in informatively and the call bridges automatically.

5. **Audible alert uses pre-arm pattern** (RESEARCH §4.1). A chime is armed on the user's first click within `(agent)/auto/page.tsx`. A global `AudioManager` singleton holds the pre-armed `HTMLAudioElement` (and `AudioContext` fallback for iOS). Volume controlled by `useUiStore.autoDialChimeVolume` (0–1). Hotkey `M` mutes/unmutes chime (same key as in-call mute — mode-sensitive binding).

6. **Preview countdown uses server timestamp** (`call.reserved.data.preview_expires_at`) not `Date.now() + N` to prevent clock drift. Countdown bar changes color green → amber → red → pulsing-red. Server enforces expiry independently; client timer is UX only.

7. **"Pause after this call" is a queued-intent pattern.** Agent toggles during CONNECTED; actual `POST /api/agent/state` fires after `call.hangup` arrives. If agent cancels the toggle before hangup, intent is discarded. This prevents the 2-API-call race where `state=paused` fires before `call.hangup` is processed.

8. **Auto-ready after wrapup is campaign-configured.** `campaigns.auto_ready_after_wrapup BOOLEAN DEFAULT true`. A06 reads this from `useCallStore.campaign`. After dispo submit: if `true` → `POST /api/agent/state { status: 'ready' }` → navigate to `/auto`. If `false` → navigate to `/auto` in PAUSED-display state (agent must click "Return to auto-dial").

9. **Reservation timeout is dual-enforced.** Server (E04): `campaigns.reservation_timeout_seconds` (proposed F02 amendment, default 10). Client (A06): starts a `reservationTimeoutMs` timer on `call.reserved`; on expiry, sends `POST /api/agent/reservation/reject { reason: 'client_timeout' }`. Whichever fires first wins; the reject endpoint is idempotent (409 on already-bridged = navigate to `/call` instead).

10. **Six hotkeys in A06 scope, all registered via A03 `HotkeyRegistry`.** `Esc` = reject reservation, `Space` = early accept (preview mode only), `P` = toggle pause-after-call, `Ctrl+B` = schedule callback (preview mode), `Ctrl+D` = skip + DNC (preview mode), `?` = show cheatsheet. In-call hotkeys inherited from A05 (not re-registered by A06).

11. **A06 adds four fields to `useCallStore` and one campaign config field.** New store fields: `reservationExpiresAt`, `previewExpiresAt`, `pendingPauseAfterCall`, `missedReservationsCount`. New campaign field: `autoReadyAfterWrapup`. A04 already owns `dialMode`; A06 reads it.

12. **One F02 schema amendment required (A06.A1) and one proposed (A06.A2).** A06.A1 adds `campaigns.auto_ready_after_wrapup BOOLEAN DEFAULT true` and `campaigns.preview_allowed_seconds SMALLINT DEFAULT 0`. A06.A2 (proposed) adds `campaigns.reservation_timeout_seconds SMALLINT DEFAULT 10`. Both are additive, no RFC required per SPEC §12.

---

## 1. Goals and Non-Goals

### 1.1 Phase 1 goals (this PLAN)

- **Auto-dial waiting screen** at `(agent)/auto`: shows campaign name, agent status, "Waiting for call..." indicator. Entered when agent joins a PROGRESSIVE or PREDICTIVE campaign in READY state.
- **Reservation overlay**: pops when `call.reserved` arrives. Shows lead name, phone, campaign, script snippet. Plays audible chime. Has Skip button (preview mode) or is purely informational (no preview).
- **Preview countdown**: when `campaigns.preview_allowed_seconds > 0`, shows countdown bar with color progression. Accept/Skip buttons. Server timestamp-synchronized.
- **SIP readiness check**: on `call.reserved`, validates `useSoftphone().status === 'registered'` before proceeding; rejects if SIP not ready.
- **"Pause after this call" toggle**: available during CONNECTED state (surfaced in A05's call panel as an A06-owned control). Queued intent, fires post-hangup.
- **Auto-ready after wrapup**: after dispo submit in auto-dial mode, automatically transitions agent to READY and navigates back to `/auto` (if `auto_ready_after_wrapup = true`).
- **Post-dispo routing**: navigates to `/auto` (not `/dial`) after wrapup completes in auto-dial mode.
- **Audible alert system**: `AudioManager` singleton with pre-arm, volume control, iOS fallback.
- **Reservation timeout**: dual client+server enforcement; missed-reservation counter.
- **WCAG 2.2 AA compliance**: `role="alertdialog"`, `aria-live="assertive"`, keyboard navigation.

### 1.2 Phase 2 goals (deferred)

- **Missed-reservation auto-pause**: pause after N consecutive missed reservations (A06.A2 `max_missed_reservations` campaign config).
- **Skip-returns-to-hopper config**: campaign flag to control whether skipped leads re-enter hopper immediately or wait `recycle_delay_seconds`.
- **AMD voicemail-drop integration**: E05 + T02 + A06 coordination when AMD detects voicemail.
- **Supervisor force-end wrapup** (`call.wrapup_force_end` WS event) — partial spec in RESEARCH §9.1.
- **International agent timezone overlay** in reservation overlay.
- **Supervisor-configurable chime sounds** (upload custom WAV via M01 admin).

### 1.3 Non-goals (never in A06)

- Initiating any outbound call (E04's job).
- Managing `dispatch_tokens` or `dial_level` (E02/E03's job).
- The in-call workspace (A05: Hangup, Hold, Mute, DTMF, Transfer, 3-way, Notes).
- The disposition overlay component itself (A05 owns; A06 configures via campaign flags).
- Manual dial (A04 owns: all explicit-click dialing).
- DNC bypass UI (agents cannot bypass; admin M06).
- Recording controls (R01 + A05).

---

## 2. Page Boundary and Route Map

### 2.1 Three-page handoff chain (auto-dial)

| Phase | Route | Module | Entry trigger | Exit trigger |
|---|---|---|---|---|
| Waiting | `(agent)/auto` | **A06** | Agent joins auto-dial campaign + READY | `call.bridged` WS event |
| In-call | `(agent)/call` | A05 | `call.bridged` → `router.push('/call')` | `call.hangup` → WRAPUP phase |
| Post-call | WRAPUP overlay at `/call` | A05 + A06 config | `call.hangup` | Dispo submit → A06 routing |

A06 differs from A04's handoff chain in the **return leg**: A04 returns to `/dial` (manual); A06 returns to `/auto` (auto-dial restarts). The router decision is made by checking `useCallStore.campaign.dial_method !== 'MANUAL'` in A05's post-dispo effect.

### 2.2 Route file structure

```
web/src/app/(agent)/auto/
├── page.tsx           — AutoDialPage: IDLE and RESERVED states
├── layout.tsx         — AutoDialLayout: AgentShell wrapper (inherits from (agent)/layout.tsx)
└── _components/
    ├── AutoDialShell.tsx          — outer container, WS subscriptions, state machine
    ├── WaitingScreen.tsx          — IDLE state UI
    ├── ReservationOverlay.tsx     — RESERVED state UI (alertdialog)
    ├── PreviewCountdown.tsx       — countdown bar + color transitions
    ├── PauseAfterCallToggle.tsx   — rendered inside A05's ActionBar slot (Phase 1: via A05 prop)
    └── AudioManager.ts            — singleton for chime pre-arm and playback
```

### 2.3 What A06 renders at each state

| A06 state | Route | What renders |
|---|---|---|
| `IDLE` | `/auto` | WaitingScreen: campaign name, agent status pill, pulsing indicator, "Pause" button |
| `RESERVED` | `/auto` | WaitingScreen (behind) + ReservationOverlay (above, slides in from right) |
| `CALLING` | `/call` | A05 renders; A06's `PauseAfterCallToggle` injected into A05's ActionBar via slot |
| `CONNECTED` | `/call` | Same; `PauseAfterCallToggle` visible with toggle state |
| `WRAPUP` | `/call` | A05's DispositionPicker; A06's post-dispo routing hooks active |
| `MISSED` | `/auto` | WaitingScreen with MissedReservationBanner (toast-style, dismisses in 5 s) |

---

## 3. State Machine

### 3.1 States

| State | Description | UI location |
|---|---|---|
| `IDLE` | Waiting for a reservation. Agent is READY. | `/auto` — WaitingScreen |
| `RESERVED` | `call.reserved` arrived. Lead preview shown. Chime played. | `/auto` — ReservationOverlay |
| `CALLING` | `call.bridged` — navigated to A05. Bridge in progress (pre-active, SIP connecting). | `/call` |
| `CONNECTED` | Call is active. A05 full workspace. | `/call` |
| `WRAPUP` | Call ended. Dispo overlay visible. ACW timer running. | `/call` |
| `MISSED` | Reservation timed out or SIP not ready. Auto-PAUSED. | `/auto` — MissedReservationBanner |
| `PAUSED` | Agent explicitly paused (or pending-pause fired after wrapup). | `/auto` — WaitingScreen with PAUSED indicator |

Note: CALLING, CONNECTED, WRAPUP are A05 states that A06 tracks via `useCallStore.phase`. A06's reducer maps them from the shared store.

### 3.2 Transition table

| From | Event | To | Side-effects |
|---|---|---|---|
| `IDLE` | WS `call.reserved` | `RESERVED` | `setReservation(event.data)`; play chime; start reservation timeout; focus overlay |
| `IDLE` | `useSoftphone().status` drops to `error` | `IDLE` | Toast "SIP disconnected — new calls paused"; E04 should not dispatch to errored agent (A03 syncs status) |
| `RESERVED` | WS `call.bridged` | `CALLING` | Stop reservation timeout; navigate `router.push('/call')`; `useCallStore.setPhase('ringing')` |
| `RESERVED` | WS `call.failed` | `IDLE` | Clear reservation; toast with reason |
| `RESERVED` | WS `call.reservation_expired` | `MISSED` | Clear reservation; increment `missedReservationsCount`; auto-pause if threshold reached |
| `RESERVED` | Agent presses Esc or "Skip" | `IDLE` | `POST /api/agent/reservation/reject { reason: 'agent_skip' }`; clear overlay |
| `RESERVED` | Agent presses Space or "Accept" (preview mode) | `RESERVED` | `POST /api/agent/reservation/accept`; remove countdown bar; await `call.bridged` |
| `RESERVED` | Reservation timeout (client timer) | `MISSED` | `POST /api/agent/reservation/reject { reason: 'client_timeout' }`; auto-pause |
| `RESERVED` | SIP not registered on `call.reserved` check | `IDLE` | `POST /api/agent/reservation/reject { reason: 'sip_not_ready' }`; toast |
| `CALLING` | WS `call.bridged` confirms (A05 handles) | `CONNECTED` | A05 sets `useCallStore.phase('active')` |
| `CONNECTED` | Agent toggles "Pause after call" | `CONNECTED` | `pendingPauseAfterCall = !pendingPauseAfterCall` (local only) |
| `CONNECTED` | WS `call.hangup` | `WRAPUP` | `useCallStore.setPhase('wrapup')`; A05 shows dispo overlay |
| `WRAPUP` | Dispo submitted (`call.disposed` WS confirmed) | `IDLE` or `PAUSED` | If `pendingPauseAfterCall`: send `POST /api/agent/state { status: 'paused' }` → `PAUSED`; else if `auto_ready_after_wrapup`: send `POST /api/agent/state { status: 'ready' }` → `IDLE`; else → `PAUSED` (manual ready) |
| `WRAPUP` | Wrapup timer expires (auto-dispo) | `IDLE` or `PAUSED` | Same as above; auto-submits with `campaigns.default_dispo` or `NA` |
| `MISSED` | Agent dismisses banner or N seconds | `PAUSED` | `missedReservationsCount` stays; agent must un-pause to receive calls |
| `PAUSED` | Agent clicks "Return to Auto-Dial" | `IDLE` | `POST /api/agent/state { status: 'ready' }`; `router.replace('/auto')` |

### 3.3 State machine implementation

The reducer lives in `AutoDialShell.tsx` as a React `useReducer` with a discriminated-union shape:

```typescript
// web/src/app/(agent)/auto/_components/AutoDialShell.tsx (internal type)
type AutoDialState =
  | { status: 'idle' }
  | { status: 'reserved'; reservation: ReservationData }
  | { status: 'calling' }          // Navigated to A05; synced from useCallStore
  | { status: 'connected' }        // Synced from useCallStore
  | { status: 'wrapup' }           // Synced from useCallStore
  | { status: 'missed' }
  | { status: 'paused' };

type AutoDialAction =
  | { type: 'RESERVATION_RECEIVED'; data: ReservationData }
  | { type: 'CALL_BRIDGED' }
  | { type: 'CALL_FAILED'; reason: string }
  | { type: 'CALL_HANGUP' }
  | { type: 'RESERVATION_EXPIRED' }
  | { type: 'RESERVATION_TIMEOUT' }   // Client-side timer
  | { type: 'AGENT_SKIP' }
  | { type: 'AGENT_ACCEPT' }
  | { type: 'DISPO_SUBMITTED' }
  | { type: 'DISPO_TIMEOUT' }
  | { type: 'PAUSE_QUEUED' }
  | { type: 'PAUSE_READY' }
  | { type: 'SIP_NOT_READY' }
  | { type: 'RETURN_TO_AUTODIAL' };
```

A `transition(state, action)` pure function enforces valid transitions and throws on illegal ones (caught by error boundary). This mirrors A04's approach (RESEARCH §3.3).

### 3.4 Sync from useCallStore

`AutoDialShell` subscribes to `useCallStore` via Zustand's `subscribeWithSelector`:

```typescript
useEffect(() => {
  const unsub = useCallStore.subscribe(
    (s) => s.phase,
    (phase) => {
      if (phase === 'active') dispatch({ type: 'CALL_BRIDGED' });
      if (phase === 'wrapup') dispatch({ type: 'CALL_HANGUP' });
    }
  );
  return unsub;
}, []);
```

This avoids duplicating WS subscriptions already handled by A05.

---

## 4. Reservation Overlay Component

### 4.1 Component specification

`ReservationOverlay.tsx` renders above `WaitingScreen` when `status === 'reserved'`. It is NOT a modal (no backdrop, no scroll lock) — it slides in from the right edge of the screen.

**WCAG semantics:**
```tsx
<div
  role="alertdialog"
  aria-modal="false"
  aria-labelledby="reservation-title"
  aria-describedby="reservation-lead-phone"
  aria-live="assertive"
>
```

**Layout:**

```
┌─────────────────────────────────────────────────────────────┐
│ INCOMING CALL · PREDICTIVE                         [×] Skip │
│                                                             │
│ 🔔  John Q. Smith                                           │
│     +1 (415) 555-0142   ·   Berkeley, CA   ·   2:42 PM PST │
│                                                             │
│ Campaign: SOLAR_Q2                                          │
│                                                             │
│ Script: "Hi {{lead.first_name}}, this is {{agent_name}}..." │
│                                                             │
│ ┌─────────────────────────────────────────────────┐         │
│ │████████████████████░░░░░░░░░░░░░░░░░░░░░░│ 12s │         │  ← Preview countdown (preview mode only)
│ └─────────────────────────────────────────────────┘         │
│                                                             │
│ [Schedule Callback]         [Skip]    [Accept Call ⏎]       │
│  Ctrl+B                      Esc       Space                 │
└─────────────────────────────────────────────────────────────┘
```

When `preview_allowed_seconds = 0`, the countdown bar and action buttons are hidden. Only the lead info and campaign name are shown. The overlay automatically disappears on `call.bridged`.

### 4.2 ReservationOverlay props (FROZEN)

```typescript
interface ReservationOverlayProps {
  reservation: ReservationData;         // From call.reserved WS event
  dialMode: 'PROGRESSIVE' | 'PREDICTIVE';
  previewExpiresAt: string | null;      // ISO-8601 UTC; null = no preview mode
  reservationExpiresAt: string;         // ISO-8601 UTC; always set
  onSkip: () => void;                   // Sends reject { reason: 'agent_skip' }
  onAccept: () => void;                 // Sends accept; only visible if previewExpiresAt non-null
  onScheduleCallback: () => void;       // Opens D06 callback modal
}

interface ReservationData {
  callUuid: string;
  attemptUuid: string;
  lead: LeadSnapshot;
  campaignId: number;
  campaignName: string;
  scriptSnippet: string | null;
}
```

### 4.3 Preview countdown bar

`PreviewCountdown.tsx` receives `expiresAt: string` and renders a `<progress>` element:

```tsx
<progress
  value={msRemaining}
  max={totalMs}
  aria-valuenow={Math.ceil(msRemaining / 1000)}
  aria-valuemin={0}
  aria-valuemax={Math.ceil(totalMs / 1000)}
  aria-label={`${Math.ceil(msRemaining / 1000)} seconds remaining to preview this call`}
  className={clsx(
    'w-full h-2 rounded-full',
    pctRemaining > 0.5 ? 'accent-green-500' :
    pctRemaining > 0.25 ? 'accent-amber-500' :
    'accent-red-500 animate-pulse'
  )}
/>
```

The progress value updates via `requestAnimationFrame` (not `setInterval`) for smooth animation. The text label `12s` is announced via `aria-live="polite"` on a sibling `<span>` that updates every second (not every frame — screen reader flood prevention).

### 4.4 Entry/exit animation

- **Entry**: CSS `translate-x-full` → `translate-x-0` with `transition-transform duration-300 ease-out`. The panel slides in from the right.
- **Exit** (on call.bridged): fade-out `opacity-0` with `transition-opacity duration-200`. Then page navigates.
- **Animation** must respect `prefers-reduced-motion`: if `window.matchMedia('(prefers-reduced-motion: reduce)').matches`, skip translate/fade; render/remove instantly.

---

## 5. Audible Alert

### 5.1 AudioManager singleton

`AudioManager.ts` is a module-level singleton (not a React hook) to survive re-renders:

```typescript
// web/src/app/(agent)/auto/_components/AudioManager.ts

class AudioManager {
  private chime: HTMLAudioElement | null = null;
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private volume: number = 0.7;
  private muted: boolean = false;

  async arm(chimeSrc: string): Promise<void>  // Call on first user interaction
  async play(): Promise<void>                  // Play chime; no-op if muted
  setVolume(v: number): void                   // 0–1
  setMuted(m: boolean): void                   // M hotkey
  isArmed(): boolean                           // Check before relying on play()
}

export const audioManager = new AudioManager();
```

**Pre-arm trigger in `AutoDialShell`:**

```typescript
useEffect(() => {
  const armOnFirstInteraction = async () => {
    if (!audioManager.isArmed()) {
      await audioManager.arm('/sounds/reservation-chime.wav');
    }
    document.removeEventListener('click', armOnFirstInteraction);
    document.removeEventListener('keydown', armOnFirstInteraction);
  };
  document.addEventListener('click', armOnFirstInteraction, { once: true });
  document.addEventListener('keydown', armOnFirstInteraction, { once: true });
}, []);
```

### 5.2 Chime asset

- File: `web/public/sounds/reservation-chime.wav`
- Format: WAV (PCM 16-bit, 44100 Hz, mono) for maximum browser compatibility.
- Duration: ≤ 500 ms.
- Character: single ascending two-note tone (pleasant, non-alarming). NOT a phone ring.
- File size: ≤ 50 KB.

A06 IMPLEMENT must include the WAV file. Using a royalty-free or synthetically generated tone is acceptable. The `AudioManager` also accepts a custom URL from `useUiStore.autoDialChimeSrc` (Phase 2 supervisor-configurable override; defaults to the bundled WAV).

### 5.3 Volume and mute controls

`useUiStore` additions for A06:

```typescript
// Additions to web/src/lib/stores/ui.ts (additive, no breaking changes)
autoDialChimeVolume: number;      // 0–1, default 0.7, persisted in localStorage
autoDialChimeMuted: boolean;      // default false, persisted
```

The "Chime volume" slider and mute toggle are surfaced in `(agent)/settings/page.tsx` (audio section, already exists per A02 HANDOFF). No new settings page needed.

### 5.4 Visual flash on reservation (no-audio fallback)

When `autoDialChimeMuted = true` OR audio pre-arm failed (browser blocked), A06 still provides visual notification:
- Reservation overlay slides in with a 3-pulse border animation (`border-state-warning`, 500 ms per pulse).
- Browser tab title changes to `🔔 Incoming Call — SOLAR_Q2` until overlay is dismissed.
- `document.title` restored to default on overlay close.

---

## 6. Zustand Store Additions

### 6.1 `useCallStore` new fields (additive)

These fields are added to `web/src/lib/stores/call.ts` (`CallState` interface) without breaking changes:

```typescript
// A06 additions to CallState
reservationExpiresAt: string | null;    // ISO-8601 UTC; from call.reserved
previewExpiresAt: string | null;        // ISO-8601 UTC; from call.reserved; null = no preview
pendingPauseAfterCall: boolean;         // Agent toggled "pause after call"
missedReservationsCount: number;        // Session-only counter; reset on logout

// New actions
setReservation: (data: ReservationPayload) => void;
clearReservation: () => void;
setPendingPause: (pending: boolean) => void;
incrementMissedReservations: () => void;
resetMissedReservations: () => void;
```

`setReservation` sets `callUuid`, `lead`, `reservationExpiresAt`, `previewExpiresAt` from the `call.reserved` event payload. It also sets `dialMode` to `'progressive'` or `'predictive'` based on `event.data.dial_mode`.

### 6.2 `useCallStore.campaign` new fields

`CampaignConfig` interface in `call.ts` gains two fields (populated from the campaign config in `call.reserved` and from a TanStack Query `GET /api/campaigns/:id`):

```typescript
// Additions to CampaignConfig interface in call.ts
auto_ready_after_wrapup: boolean;      // default true; A06 post-dispo routing
preview_allowed_seconds: number;       // 0 = no preview; A06 overlay countdown
```

These are the A06.A1 schema amendment fields. The `call.reserved` event payload includes them inline (populated by E04 from the campaign config cache).

### 6.3 `useUiStore` new fields

```typescript
// Additions to web/src/lib/stores/ui.ts
autoDialChimeVolume: number;           // default 0.7; persisted
autoDialChimeMuted: boolean;           // default false; persisted
```

Both are persisted in `localStorage` via Zustand's `persist` middleware (already wired in `ui.ts` per A01 PLAN).

---

## 7. Disposition Auto-Prompt and Post-Call Routing

### 7.1 Disposition flow (A06 configures A05)

A06 does not ship its own dispo overlay. A05's WRAPUP state handles it. A06's contribution is the **routing and auto-ready behavior** that fires after `POST /api/agent/dispo` succeeds.

The dispo submission endpoint is:

```
POST /api/agent/dispo
Body: {
  call_uuid: string;
  attempt_uuid: string;
  status: string;           // D04 status code
  comments?: string;
  callback?: {
    at: string;             // ISO-8601 UTC
    agent_only: boolean;
  };
}
Response: { ok: true; call_log_id: number }
```

This matches the A06.md spec's public interface (unchanged).

### 7.2 Post-dispo routing logic

After successful dispo submission, A05 calls a `useAutoDialRouter` hook that A06 provides:

```typescript
// web/src/app/(agent)/auto/_components/useAutoDialRouter.ts
export function useAutoDialRouter() {
  const campaign = useCallStore((s) => s.campaign);
  const dialMode = useCallStore((s) => s.dialMode);
  const pendingPause = useCallStore((s) => s.pendingPauseAfterCall);

  async function handleDispoComplete() {
    if (dialMode === null || dialMode === 'manual') {
      router.replace('/dial');  // Manual mode — back to A04
      return;
    }

    if (pendingPause) {
      await api.post('/api/agent/state', { status: 'paused', pause_code: pendingPauseCode });
      useCallStore.getState().setPendingPause(false);
      router.replace('/auto');  // /auto will show PAUSED state
    } else if (campaign?.auto_ready_after_wrapup) {
      await api.post('/api/agent/state', { status: 'ready' });
      router.replace('/auto');  // /auto IDLE — ready for next call
    } else {
      // auto_ready_after_wrapup = false: go to /auto in paused state
      router.replace('/auto');  // Agent must click "Return to Auto-Dial"
    }
  }

  return { handleDispoComplete };
}
```

A05 invokes `handleDispoComplete()` after its `POST /api/agent/dispo` succeeds. The hook is provided by A06 and imported into A05's `DispositionPicker` component. This is the primary A05↔A06 coupling point.

### 7.3 Wrapup auto-submit (timer expiry)

When `useCallStore.wrapupStartAt` + `campaign.wrapup_seconds * 1000 < Date.now()`:

1. A06's `WrapupTimerWatcher` (a non-rendering component mounted inside A05's wrapup overlay via A06 slot) fires.
2. Auto-submits dispo: `POST /api/agent/dispo { call_uuid, status: campaign.default_dispo ?? 'NA', comments: '[auto-dispo: wrapup expired]' }`.
3. Calls `handleDispoComplete()` on success.
4. Toast: "Call dispositioned automatically as NA — wrapup timer expired".

`WrapupTimerWatcher` is the only auto-submit mechanism. If it fails (network error), it retries once after 5 s; on second failure, shows a persistent error toast ("Could not auto-submit disposition — please submit manually").

---

## 8. "Pause After This Call" Toggle

### 8.1 PauseAfterCallToggle component

`PauseAfterCallToggle.tsx` is rendered in A05's ActionBar (the 64-px sticky bottom bar). It occupies the rightmost position after button 9 (Mark DNC). It is visible only when `useCallStore.dialMode !== 'manual'`.

```
ActionBar: [Hangup] [Hold] [Mute] [DTMF▾] [Transfer▾] [3-way▾] [Rec◉] [Callback] [DNC] │ [⏸ After] │
```

The `│` separator distinguishes the A06 control from A05's native buttons.

**Visual states:**
- **Off** (default): muted grey, icon `play-circle`, label "After: Ready". Tooltip: "Return to auto-dial after this call (P to toggle)".
- **On** (pending pause): amber, icon `pause-circle`, label "After: Pause". Tooltip: "Pause after this call — click to cancel (P to toggle)".

**Interaction:**
- Click or `P` hotkey: toggles `pendingPauseAfterCall` in `useCallStore`.
- When ON, shows a pause-code selector (same `<PauseCodeDropdown/>` as A03).
- Selected pause code stored in `useAutoDialStore.pendingPauseCode` (session-only).

### 8.2 Hotkey scope

`P` hotkey is registered in `'in-call'` scope via A03's `HotkeyRegistry`:

```typescript
useHotkeys({
  id: 'a06-pause-after-call',
  scope: 'in-call',
  key: 'p',
  ignoreInputFocus: false,  // Suppressed in inputs/textareas
  handler: () => togglePendingPause(),
  description: 'Toggle "pause after this call"',
});
```

Conflicts with A05's in-call hotkeys: A05 PLAN §0 bullet 10 does not assign `P` to any in-call hotkey. No conflict.

---

## 9. WS Subscriptions

### 9.1 Subscription registration

All subscriptions registered in `AutoDialShell.tsx`'s `useEffect` (mounted/unmounted with the page):

```typescript
useEffect(() => {
  const unsubscribes = [
    ws.subscribe('call.reserved',             handleReserved),
    ws.subscribe('call.failed',               handleCallFailed),
    ws.subscribe('call.reservation_expired',  handleReservationExpired),
    ws.subscribe('call.disposed',             handleDisposed),
    ws.subscribe('agent.state_changed',       handleAgentState),
    ws.subscribe('campaign.config_changed',   handleConfigChanged),
    ws.subscribe('call.wrapup_force_end',     handleForceEndWrapup),
  ];
  // call.bridged and call.hangup are handled by A05's WS subscriptions
  // (A05 owns useCallStore.phase transitions for active/wrapup)
  return () => unsubscribes.forEach(fn => fn());
}, [ws]);
```

A06 deliberately does NOT re-subscribe to `call.bridged` and `call.hangup` — A05 already handles these and updates `useCallStore.phase`. A06 watches `useCallStore.phase` via `subscribeWithSelector` instead (§3.4).

### 9.2 Lost-event recovery

A06 uses the same `{op: "resume", from: lastSeq}` cursor mechanism as A04 and A05 (A01 WS wrapper contract). A06 does not add separate recovery logic. On page reload while in RESERVED state:

1. `GET /api/agent/current_call` (A04's existing endpoint, also checked by A06 on `/auto` mount).
2. If response shows `phase === 'reserved'`, reconstruct `ReservationData` from response.
3. If response shows `phase === 'active'`, navigate immediately to `/call` (A05).
4. If 404, reset to IDLE.

### 9.3 Multi-tab handling

A06 uses `BroadcastChannel('vici2-auto-dial')` (distinct from A04's `vici2-agent-dial`):
- On `call.reserved`, broadcast to other tabs.
- Second tab receives broadcast, shows "Auto-dial call in another tab — [Switch to it]" banner.
- Second tab does NOT duplicate the reservation handling.

---

## 10. API Endpoints

A06 introduces two new REST endpoints owned by the api layer.

### 10.1 `POST /api/agent/reservation/reject`

```typescript
// Request
interface ReservationRejectBody {
  call_uuid: string;
  reason: 'agent_skip' | 'client_timeout' | 'sip_not_ready' | 'preview_timeout_skip';
}

// Response 200
interface ReservationRejectResponse { ok: true }

// Response 409 (already bridged — race condition)
// A06 catches this and navigates to /call instead
```

Server behavior:
1. Validate agent JWT; confirm agent owns this reservation (from Valkey `t:{tid}:agent:{uid}:reservation`).
2. Publish `reservation.rejected` to Valkey pubsub → E04 AnswerHandler picks it up.
3. E04: release hopper fence-token; update `originate_audit` outcome.
4. Set agent `state = 'paused'` if reason is `client_timeout` or `reservation_timeout` (server-side consequence for idle agents).
5. Return 200.

On 409 (`ALREADY_BRIDGED`): agent should navigate to `/call` — bridge happened in the race window.

### 10.2 `POST /api/agent/reservation/accept`

```typescript
// Request
interface ReservationAcceptBody {
  call_uuid: string;
}

// Response 200
interface ReservationAcceptResponse { ok: true }
// call.bridged WS event will follow shortly
```

Server behavior:
1. Validate agent JWT.
2. Publish `reservation.accepted` to Valkey pubsub → E04 AnswerHandler issues `UUIDTransfer` immediately (rather than waiting for preview countdown expiry).
3. Return 200. `call.bridged` arrives via WS shortly after.

### 10.3 `POST /api/agent/dispo` (owned by A05/A06 jointly)

Already specified in A06.md public interface. A06 uses it identically to A05. No changes to this endpoint contract.

### 10.4 Read-only endpoints A06 consumes

| Endpoint | Purpose | Stale time |
|---|---|---|
| `GET /api/agent/current_call` | Page-reload restore (A04 contract, reused) | N/A |
| `GET /api/campaigns/:id` | Fetch `auto_ready_after_wrapup`, `preview_allowed_seconds` | 5 min TanStack Query |
| `GET /api/agent/pause-codes` | Pause-after-call dropdown | 30 s (A03 contract) |

---

## 11. Hotkeys

### 11.1 A06 hotkey registry (FROZEN)

All registered via A03 `HotkeyRegistry`. Scope `'auto-dial'` is active only when `(agent)/auto/page.tsx` is mounted.

| Hotkey | Scope | Action | Condition | `ignoreInputFocus` |
|---|---|---|---|---|
| `Esc` | `auto-dial` | Reject reservation | `status === 'reserved'` | false |
| `Space` | `auto-dial` | Accept call early | `status === 'reserved' AND previewExpiresAt !== null` | false |
| `Ctrl+B` | `auto-dial` | Open callback scheduler | `status === 'reserved'` | true |
| `Ctrl+D` | `auto-dial` | Skip + DNC | `status === 'reserved'` | true |
| `P` | `in-call` | Toggle pause-after-call | `status === 'connected' or 'calling'` | false |
| `M` | `auto-dial` | Toggle chime mute | always | false |
| `?` | `auto-dial` | Show hotkey cheatsheet | always | false |

### 11.2 Conflict check with A05 hotkeys

| A05 hotkey | A06 conflict | Resolution |
|---|---|---|
| `F2` / `Space` = Hold | `Space` = Accept (A06 preview scope) | Scope: A06's `Space` is in `auto-dial` scope; A05's `Space` is in `in-call` scope. No overlap — scopes are mutually exclusive by page route. |
| `M` = Mute (in-call) | `M` = Chime mute (auto-dial scope) | Same resolution — different scopes. In `in-call`, `M` = audio mute (A05); in `auto-dial`, `M` = chime mute (A06). |
| `P` (unassigned in A05) | `P` = Pause-after-call | A05 has no `P` binding; no conflict. |
| `Ctrl+B` = Callback | A06 preview scope same | Same scope logic — A05 `Ctrl+B` is `in-call`; A06 `Ctrl+B` is `auto-dial`. |

### 11.3 Cheatsheet integration

The `?` cheatsheet auto-discovers all registered hotkeys from `HotkeyRegistry.getAll()` (A03 API). A06 hotkeys appear automatically under an "Auto-Dial" section header (keyed by scope name). No hard-coded list.

---

## 12. F02 Schema Amendments

### 12.1 A06.A1 — Required (Phase 1)

Two new columns on `campaigns`:

```sql
ALTER TABLE campaigns
  ADD COLUMN auto_ready_after_wrapup TINYINT(1) NOT NULL DEFAULT 1
    COMMENT 'A06: auto-flip agent to READY after wrapup + dispo in auto-dial mode'
  AFTER wrapup_seconds,

  ADD COLUMN preview_allowed_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 0
    COMMENT 'A06: seconds of lead preview before auto-bridge (0=disabled)'
  AFTER auto_ready_after_wrapup;
```

Prisma model additions:

```prisma
// A06 Amendment A06.A1
autoReadyAfterWrapup    Boolean @default(true) @map("auto_ready_after_wrapup")
previewAllowedSeconds   Int     @default(0)    @map("preview_allowed_seconds")
```

No migration for existing rows needed — `DEFAULT 1` and `DEFAULT 0` match the current implicit behavior.

### 12.2 A06.A2 — Proposed (Phase 2)

```sql
ALTER TABLE campaigns
  ADD COLUMN reservation_timeout_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 10
    COMMENT 'A06/E04: seconds before a dispatched reservation expires if agent does not respond'
  AFTER preview_allowed_seconds;
```

This amendment is proposed (not required for Phase 1) because the E04 HANDOFF does not yet expose a reservation timeout configuration. Phase 1 uses the hardcoded 10-second default on both client and server. The column can be added as an additive amendment in Phase 2 without RFC.

---

## 13. Component File Plan

### 13.1 New files

```
web/src/app/(agent)/auto/
├── page.tsx                                     — AutoDialPage component
├── layout.tsx                                   — Minimal wrapper (inherits (agent) layout)
└── _components/
    ├── AutoDialShell.tsx                        — State machine, WS subscriptions, router
    ├── WaitingScreen.tsx                        — IDLE/PAUSED states UI
    ├── ReservationOverlay.tsx                   — RESERVED state (alertdialog)
    ├── PreviewCountdown.tsx                     — Countdown bar
    ├── MissedReservationBanner.tsx              — MISSED state dismissable banner
    ├── PauseAfterCallToggle.tsx                 — Injected into A05 ActionBar
    ├── WrapupTimerWatcher.tsx                   — Non-rendering; fires auto-dispo
    ├── AudioManager.ts                          — Singleton; chime pre-arm + play
    └── useAutoDialRouter.ts                     — Post-dispo routing hook (imported by A05)

web/public/sounds/
└── reservation-chime.wav                        — Chime audio asset (≤50 KB WAV)
```

### 13.2 Modified files

| File | Change | Risk |
|---|---|---|
| `web/src/lib/stores/call.ts` | Add 4 new fields + 4 new actions | Low — additive; existing consumers unaffected |
| `web/src/lib/stores/ui.ts` | Add `autoDialChimeVolume`, `autoDialChimeMuted` | Low — additive |
| `web/src/app/(agent)/call/_components/ActionBar.tsx` | Inject `<PauseAfterCallToggle/>` slot | Medium — must not break A05 layout |
| `web/src/app/(agent)/call/_components/DispositionPicker.tsx` | Import and call `useAutoDialRouter.handleDispoComplete()` | Medium — primary A05↔A06 coupling point |
| `web/src/app/(agent)/settings/page.tsx` | Add chime volume + mute controls | Low |
| `api/prisma/schema.prisma` | A06.A1 amendment (2 columns) | Low — additive migration |
| `api/src/routes/agent/` | Add `reservation.ts` (reject + accept endpoints) | Medium — new E04 Valkey pubsub contract |

### 13.3 No new Zustand store

A06 does NOT create a separate `useAutoDialStore`. All state lives in:
- `useCallStore` (reservation data, pendingPause, missedCount, new campaign fields)
- `useUiStore` (chime volume/mute)
- `useAgentStore` (agent status — read-only from A06; written by A03)
- Local React state in `AutoDialShell` (the `AutoDialState` discriminated union)

The local state in `AutoDialShell` is explicitly NOT Zustand because it is page-scoped and not needed by other pages. If `/auto` unmounts (e.g., page navigate to `/call`), the local state is recreated from `useCallStore` on re-mount.

---

## 14. Test Plan

### 14.1 Unit tests

| Test file | Coverage target |
|---|---|
| `web/src/test/unit/auto/autoDialReducer.test.ts` | All state transitions; illegal transitions throw; pure function |
| `web/src/test/unit/auto/audioManager.test.ts` | arm/play/mute; JSDOM AudioContext mock |
| `web/src/test/unit/auto/previewCountdown.test.ts` | Timer math; server-timestamp sync; color thresholds |
| `web/src/test/unit/auto/useAutoDialRouter.test.ts` | All three post-dispo routing branches; pendingPause; manual bypass |
| `web/src/test/unit/auto/wrapupTimerWatcher.test.ts` | Expiry fires auto-dispo; retry on failure; cancelled on early submit |

### 14.2 React Testing Library (RTL) tests

| Test file | Scenarios |
|---|---|
| `web/src/test/unit/auto/AutoDialShell.test.tsx` | WS event → state transitions; render IDLE → RESERVED → navigate; WS cleanup on unmount |
| `web/src/test/unit/auto/ReservationOverlay.test.tsx` | Renders with correct ARIA; Skip fires reject; Accept fires accept; countdown visible when previewExpiresAt set; no buttons when no preview |
| `web/src/test/unit/auto/WaitingScreen.test.tsx` | IDLE renders campaign name; PAUSED renders "Return to Auto-Dial"; MISSED renders banner |
| `web/src/test/unit/auto/PauseAfterCallToggle.test.tsx` | Toggle state; pause-code dropdown; hidden when dial_mode='manual' |

### 14.3 API endpoint tests

| Test file | Scenarios |
|---|---|
| `api/test/agent/reservation.test.ts` | POST /reject 200; POST /reject 409 on already-bridged; POST /accept 200; auth guard rejects unauthenticated |

### 14.4 E2E tests (Playwright — Phase 2)

Per A02 HANDOFF §Known limitations: Playwright not yet installed. These scenarios are defined here for when Playwright is added:

1. **PROGRESSIVE happy path**: Agent joins campaign → navigates to `/auto` → WS inject `call.reserved` → overlay appears → WS inject `call.bridged` → page navigates to `/call` → A05 workspace → hang up → dispo submitted → returns to `/auto`.
2. **PREDICTIVE with preview**: same, but with `preview_allowed_seconds=15` → countdown visible → agent presses Space → overlay disappears → `call.bridged` arrives → A05.
3. **Skip reservation**: overlay appears → press Esc → `POST /reservation/reject` fires → IDLE.
4. **Pause after call**: during A05 → press P → toggle amber → hang up → dispo submit → `POST /agent/state {paused}` fires → `/auto` shows PAUSED.
5. **Wrapup timer expiry**: agent does not submit dispo → timer expires → auto-submit fires → `/auto`.
6. **Missed reservation**: `call.reservation_expired` WS → MISSED state → banner visible → PAUSED.
7. **SIP not ready rejection**: `useSoftphone().status = 'error'` when `call.reserved` → `POST /reservation/reject { reason: sip_not_ready }` → IDLE + toast.

---

## 15. Acceptance Criteria

All must pass before A06 IMPLEMENT is marked DONE:

- [ ] **AC-A06-01**: Navigating to `(agent)/auto` when agent's campaign `dial_method = 'MANUAL'` redirects to `(agent)/dial` (A04).
- [ ] **AC-A06-02**: WS `call.reserved` event triggers: ReservationOverlay visible, chime plays (pre-armed), reservation timeout starts, `useCallStore` fields updated.
- [ ] **AC-A06-03**: WS `call.bridged` while RESERVED: overlay disappears, page navigates to `/call`, A05 workspace renders.
- [ ] **AC-A06-04**: Pressing Esc while RESERVED: `POST /api/agent/reservation/reject { reason: 'agent_skip' }` fires, overlay closes, state returns to IDLE.
- [ ] **AC-A06-05**: With `preview_allowed_seconds > 0`: countdown bar visible, green → amber → red progression, server-timestamp synchronized.
- [ ] **AC-A06-06**: Pressing Space while RESERVED with preview mode: `POST /api/agent/reservation/accept` fires, countdown bar removed, await `call.bridged`.
- [ ] **AC-A06-07**: `call.reservation_expired` WS: MISSED state shown, `missedReservationsCount` incremented, agent auto-paused.
- [ ] **AC-A06-08**: Reservation timeout (client timer): `POST /api/agent/reservation/reject { reason: 'client_timeout' }` fires, MISSED state.
- [ ] **AC-A06-09**: `PauseAfterCallToggle` renders in A05 ActionBar when `dialMode !== 'manual'`; does not render in manual mode.
- [ ] **AC-A06-10**: Toggling pause-after-call (`P`) during CONNECTED: `pendingPauseAfterCall` flips; button turns amber.
- [ ] **AC-A06-11**: After dispo submit with `auto_ready_after_wrapup = true`: `POST /api/agent/state { status: 'ready' }` fires, router navigates to `/auto` IDLE.
- [ ] **AC-A06-12**: After dispo submit with `pendingPauseAfterCall = true`: `POST /api/agent/state { status: 'paused' }` fires, router navigates to `/auto` PAUSED.
- [ ] **AC-A06-13**: After dispo submit with `auto_ready_after_wrapup = false` and no pending pause: router navigates to `/auto` PAUSED (manual ready required).
- [ ] **AC-A06-14**: Wrapup timer expiry auto-submits dispo with `NA` (or `campaigns.default_dispo`), appends `[auto-dispo: wrapup expired]` to comments.
- [ ] **AC-A06-15**: `role="alertdialog"` on ReservationOverlay; `aria-live="assertive"` parent; focus moves to first action button on overlay open; axe-core zero AA violations on `/auto` page.
- [ ] **AC-A06-16**: A06 schema amendment A06.A1 migration runs without error; `campaigns.auto_ready_after_wrapup` and `campaigns.preview_allowed_seconds` columns exist with correct defaults.
- [ ] **AC-A06-17**: AudioManager pre-arm fires on first interaction; `play()` succeeds without user gesture after pre-arm; `M` key mutes/unmutes chime.
- [ ] **AC-A06-18**: `prefers-reduced-motion` media query suppresses slide/fade animations; overlay still renders correctly.
- [ ] **AC-A06-19**: On `/auto` page reload while in RESERVED state: `GET /api/agent/current_call` restores reservation state OR redirects to `/call` if `phase === 'active'`.
- [ ] **AC-A06-20**: Second browser tab receives BroadcastChannel message and shows "Auto-dial call in another tab" banner; does not duplicate reservation handling.

---

## 16. Dependencies and Risks

### 16.1 Hard dependencies

| Dependency | What A06 needs | Status |
|---|---|---|
| A05 PLAN FROZEN | `DispositionPicker` accepts `useAutoDialRouter` hook call; `ActionBar` has slot for `PauseAfterCallToggle` | A05 PROPOSED — must confirm slot availability |
| A03 PLAN/HANDOFF | `HotkeyRegistry` accepts new scopes; `useHotkeys()` stable | A03 DONE |
| A02 HANDOFF | `useSoftphone().status` reliable for SIP-readiness check | A02 DONE |
| E04 HANDOFF | `call.reserved` WS event includes `preview_expires_at`, `reservation_expires_at`, `dial_mode`, `script_snippet` | E04 DONE — payload extension needed (§9.2) |
| F02 Schema | `campaigns.auto_ready_after_wrapup`, `campaigns.preview_allowed_seconds` columns | Not yet in schema — A06 must file amendment |

### 16.2 Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **Browser blocks chime audio on WS event** | Medium | Pre-arm pattern (§5.1); visual flash fallback (§5.4); iOS AudioContext fallback (RESEARCH §4.3) |
| **`call.reserved` → `call.bridged` < 200 ms (no time to render overlay)** | Medium (PREDICTIVE fast-path) | A06 checks: if `call.bridged` arrives before overlay animation completes, cancel animation and navigate immediately. Skip overlay render entirely if bridge is instant. |
| **A05 ActionBar slot not available** | Low (A05 PLAN specifies overflow slot for future buttons) | A06 IMPLEMENT coordinates with A05 IMPLEMENT. Fallback: inject via React portal |
| **E04 `call.reserved` payload missing `preview_expires_at`** | Low (E04 DONE but payload extension not confirmed) | A06 treats null `preview_expires_at` as no-preview mode; safe fallback |
| **Race: agent presses Esc while bridge is completing** | Low | `POST /api/agent/reservation/reject` returns 409 `ALREADY_BRIDGED`; A06 catches and navigates to `/call` |
| **Agent at `/auto` with wrong campaign (MANUAL mode)** | Low | Route guard on `/auto` page: if `campaign.dial_method === 'MANUAL'`, redirect to `/dial` |
| **Multi-tab confusion** | Medium | BroadcastChannel deduplication (§9.3); second tab shows banner |
| **Zustand hydration on SSR** | Low | `useCallStore` already handles SSR hydration (A01 pattern); new fields default safely |

### 16.3 Phase 2 items filed here

| Item | Phase | Owner |
|---|---|---|
| Supervisor force-end wrapup (`call.wrapup_force_end`) | Phase 2 | S01 + A06 |
| Missed-reservation auto-pause threshold config (`max_missed_reservations`) | Phase 2 | M01 admin + A06.A2 |
| `skip_returns_to_hopper` campaign config | Phase 2 | E01 + E04 + A06 |
| Playwright E2E test suite | Phase 2 | A06 IMPLEMENT + QA |
| Custom chime upload via M01 admin | Phase 2 | M01 + A06 |
| `campaigns.reservation_timeout_seconds` schema amendment | Phase 2 | F02 A06.A2 |
