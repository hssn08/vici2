# Module A05 — Live Call Panel + In-Call Workspace — PLAN

**Module:** A05 (Agent UI track, Phase 1)
**Author:** A05 PLAN sub-agent (Claude Sonnet 4.6)
**Date:** 2026-05-13
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 45 citations behind every choice.

**Depends on (PLANs already FROZEN or PROPOSED):**
- A01 PLAN/HANDOFF (Next.js skeleton, route `/call`, `useCallStore`, `useAgentStore`, `useUiStore`, WS wrapper, `KeyboardListenerProvider`, `api.*` client)
- A02 PLAN (`useSoftphone()` hook shape, `<SipProvider/>` in `AgentShell`, mute/hold/DTMF primitives)
- A04 PLAN (hands off to A05 on `call.bridged`; `useCallStore` is populated before A05 mounts)
- T01 PLAN (`UUIDKill`, `UUIDTransfer`, `ConferenceCommand`)
- T03 PLAN (`HoldCustomer`/`ResumeCustomer`/`MuteCustomer`/`TransferThirdParty`/`LeaveThreeWay`/`KickCustomer`)
- R01 PLAN (`StartRecording`/`StopRecording`/`PauseRecording`/`ResumeRecording`)
- C02 PLAN (consent decision 5-mode vocabulary; `consent_log`; A05 displays — does NOT decide)
- D04 module spec (`statuses` catalog, `hotkeyMap(campaignId)`, selectable flag)
- F02 PLAN (schema for `call_log`, `leads`, `callbacks`, `dnc`, `agent_log`, `recording_log`)
- F05 PLAN (JWT, RBAC, `requireAgent` guard, error envelope)

**Blocks:**
- A06 (disposition deep-dive — A05 ships the wrapup overlay at MVP depth; A06 may deepen it)
- A07 (transfer UI — A05 ships blind-only Phase 1; A07 fills the Transfer▾ menu)
- S01/S02 (supervisor whisper/barge — reads same conference; A05 surfaces participant mini-card)

This document turns the A05 RESEARCH findings into the exact component tree,
state machine, store contract, REST surface, WebSocket subscription set, hotkey
registry, recording indicator state machine, disposition workflow, notes contract,
test plan, and acceptance criteria the IMPLEMENT phase will deliver.
**No `.tsx` or `.ts` is produced here.** Once approved, the public interface
(route slots, store field additions, REST paths, WS event set, component prop
types) is FROZEN. Internal reducer phrasing, component sub-decomposition, and
CSS details may change without RFC.

---

## 0. TL;DR — 15-bullet decision summary

1. **A05 is the screen layer; A02 is the audio layer. The split is hard and ESLint-enforced.** A05 reads `useSoftphone()` for mute/DTMF/stats and calls `useApi()` for all server-side actions. A05 never imports `sip.js` or any symbol from `web/src/lib/sip/` directly. Custom ESLint rule `no-direct-sip-import` is a CI gate.

2. **Layout: fixed three-pane CSS Grid** — 56 px top bar (sticky), 360 px left panel (lead + history + notes), flex center panel (Script/Webform/Comments tabs), 64 px action bar (sticky bottom). Grid: `grid-template-columns: 360px 1fr; grid-template-rows: 56px 1fr 64px`. Frozen per RESEARCH §2.

3. **Phase state machine: six states.** `idle → ringing → active ↔ hold ↔ transferring → wrapup → idle`. Entry to `active` is on WS `call.bridged`; entry to `wrapup` is on WS `call.hangup` (after `hangup_grace_seconds` debounce when agent-initiated hangup) or immediately when customer hangs up.

4. **Nine action buttons, frozen order:** Hangup, Hold, Mute, DTMF, Transfer▾, 3-way▾, Record◉, Callback, Mark-DNC. Ordered by frequency-of-use. Hangup is always leftmost; always red (`bg-state-error`); always `F3`; never scrolls.

5. **5-second Hangup grace window (default, per campaign config).** When agent presses Hangup, the UI flips immediately to `wrapup` phase and shows the disposition overlay, but the API `POST /hangup` is deferred for `hangup_grace_seconds` (default 5 s, `campaigns.hangup_grace_seconds`). A "Cancel & resume" button visible in the overlay reverses the phase. When the *customer* hangs up, no grace — jump straight to wrapup.

6. **Disposition workflow: post-hangup mandatory (Option B).** Dispo overlay overlays the center column (not a modal) when `phase==='wrapup'`. 60-second wrapup timer (`campaigns.wrapup_seconds`, default 60 s). Hotkey auto-submit enabled by default (`useUiStore.confirmHotkeyDispo` defaults `false`). Skip button auto-submits `NA` with comment marker `[auto-dispo wrapup expired]`.

7. **Recording indicator: 4-state badge** in the top bar (Recording / Not recording / Paused / Pending consent). Click-to-inspect popover is read-only. File path hidden from agent role. Record◉ action button visible only when `campaign.recording_mode === 'ONDEMAND'`.

8. **Notes: single textarea, dual-write, auto-save.** Debounced 2 s `PATCH /notes` → `call_log.comments`. Append to `leads.comments` happens once on dispo submit (clean boundary). 4 quick-tag chips above the textarea. 4096-char cap enforced client + server.

9. **Hold is server-side via T03.HoldCustomer (not SIP re-INVITE).** Customer moves to `agent_t<tid>_u<uid>_hold` conference profile (MOH on). Reverse via `ResumeCustomer`. WS `call.held`/`call.resumed` confirms and flips `useCallStore.phase`.

10. **Hotkeys: F1=Help, F2=Hold, F3=Hangup, F4=Mute, Space=Hold, M=Mute, D=DTMF, R=Record, Ctrl+T=Transfer, Ctrl+3=3-way, Ctrl+B=Callback, Ctrl+D=DNC, 0-9=dispo (wrapup scope only).** Single-letter and digit hotkeys suppressed when `document.activeElement` is `INPUT` or `TEXTAREA`. Modifier hotkeys always fire. Vicidial parity: Space=Hold, Ctrl+T, Ctrl+P (global pause). Deviation: F1=Help (not F1=Hold as DESIGN.md §7.5 says) — this is a deliberate PLAN-phase override; F2=Hold preserves the Vicidial F-key idiom. **No RFC required** per RESEARCH §15 Q3 recommendation; document in HANDOFF.

11. **Real-time sync: WS-only, no polling during normal operation.** A05 subscribes to 11 event types via `useWebSocket().subscribe()`. Fallback to 5-second polling on `GET /api/agent/call/:uuid/state` only if WS is down >30 s. Polling stops on WS reconnect.

12. **A02 integration: DOM-host stays in `AgentShell.tsx`.** A05 calls `useSoftphone()` only. Never mounts the `<audio>` element. ESLint `no-direct-sip-import` blocks accidental coupling.

13. **Transfer: Phase 1 = blind only.** Transfer▾ menu shows one option ("Blind transfer"). 3-way DOES ship in Phase 1 (spec demo §9 step 13). Warm/consultative/closer-group/voicemail-drop = Phase 2+.

14. **Webform: Phase 1 = iframe slot with strict sandbox + postMessage protocol defined.** The `<WebformIframe/>` component renders with `sandbox="allow-same-origin allow-scripts allow-forms"` and an origin allowlist from `campaign.webform_url`. PostMessage contract is frozen in §6. Webform population is fully operational in Phase 1.

15. **Multi-tab detection via `BroadcastChannel('vici2.callpanel')`.** Second tab shows "Call panel open in another tab — [Take over]" banner. Take-over force-demotes the first tab to read-only.

---

## 1. Goals and non-goals

### 1.1 Phase 1 goals (this PLAN)

- **In-call workspace** for the agent while a call is live: lead info card, call timer, recording indicator, consent badge, script tab, webform iframe (slot + postMessage protocol), comments textarea, history accordion, action bar with 9 buttons.
- **Disposition overlay** (post-hangup mandatory): selectable status list from D04, comments, optional callback scheduler, wrapup timer, Skip escape hatch.
- **5-second Hangup grace window** with "Cancel & resume" affordance.
- **Recording indicator** with 4-state badge + click-to-inspect popover.
- **Blind transfer** (Phase 1) and **3-way conference** (Phase 1).
- **DTMF keypad popover** with keyboard input, tap-and-hold, paste-from-clipboard.
- **Notes auto-save** (2 s debounce, `onBlur`, `beforeunload` sendBeacon).
- **Hotkey registry** via `KeyboardListenerProvider` (A01 PLAN §3.1 slot).
- **WS real-time state sync** with 30 s fallback polling.
- **Responsive layout** — left panel collapses to drawer at ≤1023 px; action bar icon-only with overflow at <768 px.
- **WCAG 2.2 AA compliance** (zero axe-core AA violations in CI).
- **Real-time AI coach slot** — `<RealtimeAssistant/>` returns `null` in Phase 1 (feature flag `NEXT_PUBLIC_FF_AI_COACH=false`).

### 1.2 Phase 2 goals (deferred)

- Warm/consultative transfer (A07, needs second SIP leg).
- Closer/agent-group transfer (I01 in-groups).
- Voicemail drop (AMD integration).
- Real-time AI coach transcription (Whisper streaming, `coach.*` WS events).
- PCI sidecar integration (PCI Pal / Eckoh replacing `uuid_record mask`).
- Visual-regression snapshot suite (phase × mute × hold × recording).
- `limit=20` history (ship 10; HANDOFF note).
- Pre-hangup dispo mode (optional campaign config).
- International TZ overlay for agent ("You: 11:42 PM IST").

### 1.3 Non-goals (never in A05)

- SIP session ownership (A02).
- ESL command issuance (Go dialer layer via T01/T03/R01).
- MySQL writes directly (all writes via F-API).
- Supervisor barge/whisper UI (S01/S02 — A05 surfaces participant mini-card only).
- Lead creation or full lead edit (M03 admin).
- DNC bypass (agents cannot bypass; admin M06).
- Progressive/predictive dial control (E02).

---

## 2. Layout

### 2.1 CSS Grid specification (FROZEN)

```css
/* web/src/app/(agent)/call/page.tsx — outer layout */
.call-panel-root {
  display: grid;
  grid-template-columns: 360px 1fr;
  grid-template-rows: 56px 1fr 64px;
  height: 100dvh;
  overflow: hidden;
}

.call-top-bar {
  grid-column: 1 / -1;
  grid-row: 1;
  position: sticky;
  top: 0;
  z-index: 50;
  height: 56px;
}

.call-left-panel {
  grid-column: 1;
  grid-row: 2;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}

.call-center-panel {
  grid-column: 2;
  grid-row: 2;
  overflow-y: auto;
  position: relative; /* disposition overlay uses absolute fill */
}

.call-action-bar {
  grid-column: 1 / -1;
  grid-row: 3;
  position: sticky;
  bottom: 0;
  z-index: 40;
  height: 64px;
}
```

### 2.2 ASCII wireframe (FROZEN — reproduced from RESEARCH §2.1)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ TopBar (56 px, sticky)                                                               │
│ [SOLAR_Q2 ▾]  [READY 00:42 ●green]  [⏱ 03:14]  [● REC]  [⚖ CONSENT: ALLOW]        │
│                                                  [Pause ▾] [Settings] [Logout]       │
├──────────────────────┬───────────────────────────────────────────────────────────────┤
│ LeftPanel (360 px)   │ CenterPanel (flex, tabbed)                                    │
│ LEAD INFO            │ Tabs: [Script*] [Webform] [Comments]                          │
│ Mr. John Q. Smith    │                                                               │
│ +1 (415) 555-0142    │  Hi {{lead.first_name}}, this is {{agent_name}}              │
│ 1234 Main St         │  from {{campaign.brand}}...                                  │
│ Berkeley, CA 94703   │                                                               │
│ DOB: 1972-03-14 (52) │  [if voicemail] Hi {{lead.first_name}}...                   │
│ Vendor: WEB-2026     │                                                               │
│ ▾ Custom fields (4)  │  Q1: Do you currently own your home?                         │
│ Status: NEW · 0× ·   │  Q2: Average monthly electric bill?                          │
│ Local: 14:23 PDT     │  Q3: Decision-maker for energy?                              │
│ List: SOLAR-WEB-Q2   │                                                               │
│ 🎙 Recording: ON     │                                                               │
│ ▾ Recent contacts(3) │                                                               │
│ 2d · Sarah · 3m · SALE│                                                             │
│  "wanted brochure…"  │                                                               │
│ ▾ NOTES (auto-save)  │                                                               │
│ [callback][int...] ...│                                                              │
├──────────────────────┴───────────────────────────────────────────────────────────────┤
│ ActionBar (64 px, sticky bottom)                                                     │
│ [Hangup]  [Hold]  [Mute]  [DTMF▾]  [Transfer▾]  [3-way▾]  [Rec◉]  [Callback] [DNC]│
│  red       blue   yellow   grey      grey          grey      red      grey      grey  │
│  F3        F2/Sp  F4/M     D         Ctrl+T        Ctrl+3    R        Ctrl+B   Ctrl+D│
└──────────────────────────────────────────────────────────────────────────────────────┘

When phase==='wrapup', CenterPanel is overlaid by DispositionPicker:

│ DISPOSITION (auto-saving in 0:48 ⏱)                                                  │
│ [1] SALE  [2] NI  [3] CALLBK  [4] DNC  [5] NA  [6] WRONG  [7] DEAD  [0] AGTHU      │
│ Notes: ┌──────────────────────────────────────────────────────────────────────────┐  │
│        │ (pre-filled from in-call notes)                                          │  │
│        └──────────────────────────────────────────────────────────────────────────┘  │
│ ☐ Schedule callback  [date/time picker + Me only / Anyone radio — shown if checked]  │
│                                          [Cancel & resume]  [Skip]  [Submit ⏎]       │
```

### 2.3 Responsive breakpoints (FROZEN)

| Viewport | Behavior |
|---|---|
| ≥1280 px | Full layout; action-bar icon + text label + hotkey hint on hover |
| 1024–1279 px | Same layout; action-bar labels `font-sm` |
| 768–1023 px | Left panel collapses to `<Sheet/>` drawer; "Lead info ▾" button in top bar opens it; center panel full width |
| <768 px | Action bar shrinks to icon-only; 4 visible (Hangup, Hold, Mute, More▾); others in overflow `<DropdownMenu/>` |
| <360 px | Out of scope. Route guards redirect to `/unsupported-viewport` |

### 2.4 The always-visible Hangup rule (inviolable)

The red Hangup button (`bg-state-error`, icon `phone-off`, hotkey `F3`) is always pixel-stable at the far left of the action bar. `<ActionBar/>` is mounted by `(agent)/call/page.tsx` once and never unmounted during any phase transition. During `wrapup` with the customer leg already terminated, Hangup is greyed (`opacity-50`, `aria-disabled="true"`, tooltip "Call already ended") but in the same position.

---

## 3. Phase state machine

### 3.1 States

```
IDLE          — No call. A05 route not active.
RINGING       — Customer leg originated; ringing. Agent sees "Calling…" overlay.
ACTIVE        — Call bridged into agent conference. Full workspace renders.
HOLD          — Customer moved to _hold conference; agent hears silence.
TRANSFERRING  — Third-party leg is ringing; mini participant card visible.
WRAPUP        — Customer leg ended; disposition overlay visible.
```

### 3.2 Transitions (total, explicit)

```
IDLE        → RINGING      : WS call.created  (or call.originated; A04 drives router.push('/call'))
RINGING     → ACTIVE       : WS call.bridged  (useCallStore.setPhase('active'); startedAt set)
RINGING     → IDLE         : WS call.failed / call.cancelled
ACTIVE      → HOLD         : PATCH /hold {action:'hold'} optimistic; WS call.held confirms
HOLD        → ACTIVE       : PATCH /hold {action:'unhold'}; WS call.resumed confirms
ACTIVE      → TRANSFERRING : POST /originate-third (3-way); WS conference.member_added
TRANSFERRING→ ACTIVE       : POST /leave-3way; WS conference.member_left (agent remains bridged)
TRANSFERRING→ WRAPUP       : WS call.hangup (agent left; customer + 3rd party continued via endconf)
ACTIVE      → WRAPUP (agent-initiated hangup):
              Button click → optimistic phase='wrapup' immediately; POST /hangup deferred
              hangup_grace_seconds (default 5 s); WS call.hangup confirms.
              "Cancel & resume" reverses phase to ACTIVE within the grace window.
ACTIVE      → WRAPUP (customer-initiated hangup):
              WS call.hangup → phase='wrapup' immediately (no grace).
HOLD        → WRAPUP       : WS call.hangup (customer hung up while on hold)
WRAPUP      → IDLE         : POST /dispo 200 OK → phase='idle'; router.replace('/dial')
```

### 3.3 Store additions (extends A01 PLAN §5 `useCallStore`)

All new fields added to the existing Zustand `useCallStore` slice in
`web/src/lib/stores/call.ts`:

```ts
interface CallState {
  // existing (from A01)
  phase: 'idle' | 'ringing' | 'active' | 'hold' | 'wrapup' | 'transferring';
  callUuid: string | null;
  leadId: number | null;
  startedAt: number | null;       // unix ms; set on call.bridged
  muted: boolean;                 // local, from useSoftphone()
  recording: 'on' | 'off' | 'paused' | 'pending';

  // A05 additions
  campaign: {
    id: number;
    name: string;
    recording_mode: 'NEVER' | 'ONDEMAND' | 'ALL' | 'ALLFORCE';
    wrapup_seconds: number;
    hangup_grace_seconds: number;
    hot_keys_active: boolean;
    webform_url: string | null;
  } | null;
  lead: Lead | null;              // populated from call.created payload
  consent: ConsentStatus | null;  // from call.created + consent.decision events
  notes: string;                  // in-call textarea state (persisted to callLog on save)
  threeWayParticipants: ConferenceParticipant[];
  hangupGraceActive: boolean;     // true during the 5-second grace window
  hangupGraceTimer: ReturnType<typeof setTimeout> | null;

  // actions
  setActiveCall(payload: CallCreatedPayload): void;
  setPhase(phase: CallPhase): void;
  setRecording(state: RecordingState): void;
  setConsent(consent: ConsentStatus): void;
  addParticipant(p: ConferenceParticipant): void;
  removeParticipant(uuid: string): void;
  updateParticipant(uuid: string, patch: Partial<ConferenceParticipant>): void;
  setNotes(text: string): void;
  clearCall(): void;
}
```

The `call.created` WS event payload must include the denormalized campaign
config (per Q8 decision: API populates this from `t:{tid}:agent:{uid}` Valkey
HASH on call creation).

---

## 4. Lead-info display

### 4.1 Default-visible fields

| Section | Field | Source | Format |
|---|---|---|---|
| **Identity** | Full name | `leads.title + first_name + middle_initial + last_name` | "Mr. John Q. Smith" (omit nullish parts) |
| | Primary phone | `leads.phone_e164` | `+1 (415) 555-0142` via `libphonenumber-js.formatInternational` |
| | Alt phones | `leads.phone_alt`, `leads.phone_alt2` | One per line; "Alt: …" prefix; same format |
| **Address** | Street | `leads.address1`, `address2` | One or two lines |
| | City/State/Postal | `leads.city + state + postal_code` | "Berkeley, CA 94703" |
| **Contact** | Email | `leads.email` | Linkified `mailto:` |
| | Date of birth | `leads.date_of_birth` | `1972-03-14 (52)` — age computed client-side, updated on new UTC day |
| **Source** | Vendor / source | `leads.vendor_lead_code` | Small grey secondary line "WEB-2026-0421" |
| **Lifecycle** | Status | `leads.status` | Pill; color from D04 status palette |
| | Called count | `leads.called_count` | "Called: 3 times" |
| | Last called | `leads.last_called_at` | "Last: 3 days ago" via `date-fns.formatDistanceToNow` |
| | Customer local time | `leads.tz_offset_min` computed | "Local time: 14:23 PDT" — live-updated each minute via `setInterval` |
| | List name | `leads.list_id → lists.name` | "List: SOLAR-WEB-Q2" |
| | Campaign name | `useCallStore.campaign.name` | "Campaign: SOLAR_Q2" |
| **Consent** | Recording line | `useCallStore.consent` | "🎙 Recording: ON (1-party state)" — see §4.2 |

### 4.2 Recording consent line on the card

| Display | Condition |
|---|---|
| `🎙 Recording: ON (1-party state)` | `consent_status=ALLOW`, recording active |
| `🎙 Recording: ON — verbal disclosure played` | `consent_status=PROMPT_MESSAGE`, played |
| `🎙 Recording: ON — beep cadence ${interval}s` | `consent_status=PROMPT_BEEP` |
| `🎙 Recording: ON — customer consented (DTMF 1)` | `consent_status=REQUIRE_ACTIVE`, accepted |
| `🎙 Recording: OFF — customer declined` | `consent_status=REQUIRE_ACTIVE`, declined |
| `🎙 Recording: OFF — campaign config` | `recording_mode=NEVER` |
| `🎙 Pending consent…` | `recording=pending` |

### 4.3 Custom fields (collapsed by default)

`leads.custom_data` (JSON column) collapsed behind
`<details><summary>Custom fields (N)</summary><dl>…</dl></details>`.
Keys are display-slugified (`policy_number` → "Policy number").
Values are string-rendered; nested objects rendered as monospace
`JSON.stringify(value)` (no further recursion). Ordered by JSON insertion
order (V8 preserves it).

### 4.4 Editable fields (limited)

Agent can inline-edit `phone_alt`, `phone_alt2`, and `email` via pencil icon
→ inline input → blur-saves to `PATCH /api/agent/lead/:id`. All other fields
are read-only in Phase 1.

### 4.5 History accordion (Recent contacts)

`GET /api/agent/lead/:lead_id/history?limit=10` returns `HistoryEvent[]`
(typed union: `call | callback | creation`). Rendered as a unified timeline
in the left panel below the lead card. Each entry = 2-line item: headline
(relative time · agent name · duration · status pill) + indented comment
(truncated to 240 chars with "Show more" toggle). Loading = 3 skeleton rows.
Empty = "No prior contact." (italic, grey). Cached `staleTime: 30s`.

---

## 5. Action set (9 buttons — FROZEN)

### 5.1 Button specifications

| # | Label | Phases active | Icon (Lucide) | Hotkey | API call / local action |
|---|---|---|---|---|---|
| 1 | **Hangup** | active, hold, transferring | `phone-off` | `F3` | `POST /api/agent/call/:uuid/hangup` → `T01.UUIDKill(custUUID, NORMAL_CLEARING)`; 5-second grace when agent-initiated |
| 2 | **Hold** | active, hold (toggle) | `pause` / `play` | `F2`, `Space` | `PATCH /api/agent/call/:uuid/hold` `{action:'hold'|'unhold'}` → `T03.HoldCustomer` / `ResumeCustomer` |
| 3 | **Mute** | active, hold (toggle) | `mic-off` / `mic` | `F4`, `M` | Local only: `useSoftphone().toggleMute()` — no API call |
| 4 | **DTMF▾** | active, hold | `dialpad` | `D` | Opens `<DtmfPad/>` popover; each key → `useSoftphone().sendDtmf(tone)` (A02 PLAN §12) |
| 5 | **Transfer▾** | active, hold | `git-fork` | `Ctrl+T` | Opens transfer modal; Phase 1: blind only → `POST /api/agent/call/:uuid/transfer` |
| 6 | **3-way▾** | active, hold | `users` | `Ctrl+3` | Opens 3-way modal → `POST /api/agent/call/:uuid/originate-third`; C01/C02/D05 gates server-side |
| 7 | **Record◉** | active, hold (ONDEMAND only) | `circle` (filled=recording) | `R` | `PATCH /api/agent/call/:uuid/recording` `{action:'start'|'stop'}`; hidden when `recording_mode !== 'ONDEMAND'` |
| 8 | **Callback** | active, hold, wrapup | `calendar-clock` | `Ctrl+B` | Opens callback popover → `POST /api/agent/lead/:id/callbacks` |
| 9 | **Mark DNC** | active, hold, wrapup | `ban` | `Ctrl+D` | Two-step confirm dialog → `POST /api/agent/lead/:id/dnc` |

### 5.2 Button state rules

Each button has: icon, label (≥1024 px), hotkey hint on hover, disabled state
(grey + `aria-disabled` + tooltip), loading state (spinner overlay during
in-flight API). Click on `aria-disabled` button announces reason via
`aria-live` + Sonner toast. Native `disabled` attribute NOT used (removes from
tab order).

Color coding:
- Hangup: `bg-state-error` always (even when disabled — position + color is the safety signal)
- Hold (held state): `bg-state-hold`
- Mute (muted state): `bg-state-warning`
- Record◉ (recording): `bg-state-error` (classic red dot)
- Others: neutral / `bg-muted`

### 5.3 Transfer modal (Phase 1: blind only)

Transfer▾ button opens a `<Dialog>` with one item in Phase 1:
- **Blind transfer** — phone number input (libphonenumber-js validated) + [Cancel] [Transfer].
- The `<DropdownMenu>` wrapper is already structured with a slot for "Warm transfer", "Closer / agent group", "Voicemail drop" — these render as `disabled` with tooltip "Coming in Phase 2" so A07 can enable them without UI refactor.

Submit → `POST /api/agent/call/:uuid/transfer` `{kind:'blind', dest: phone_e164}`.
API: `T01.UUIDTransfer(custUUID, ext-out:<dest>, XML, default)`.
On success: `phase` → `idle` (customer leg is gone); wrapup overlay fires.

### 5.4 3-way modal and flow

Click [3-way▾] → `<Dialog>`:
- Phone number input (libphonenumber-js, +1 default).
- Caller ID dropdown (defaults to campaign outbound CID).
- [Cancel] [Originate].

Submit → `POST /api/agent/call/:uuid/originate-third` `{phone_e164, cid_override?}`.
Server gates: C01 (TCPA for third party), C02 (consent for 3rd party), D05 (DNC).
Returns `{job_uuid, originated_uuid}`.

Phase transitions to `transferring`. Action bar swaps Hangup → "Leave 3-way" button
(POST /leave-3way → `T03.LeaveThreeWay(tid, uid)`; customer + 3rd party stay
bridged via `endconf` flag on agent member). A `<ThreeWayParticipantCard/>` mini-card
renders below the lead info card showing customer + agent + 3rd party, each with
mute/kick controls (supervisor-role only for kick).

Note: third party hears conference audio while ringing (FS conference behavior,
`bgdial` not used in Phase 1 — acceptable per RESEARCH §15 Q12).

### 5.5 Callback flow (mid-call)

Click [Callback] → `<Popover>` above the button:
- Datetime picker (default now + 24 h, next weekday).
- ◯ Me only ◯ Anyone radio.
- Comments textarea (pre-filled from `useCallStore.notes`).
- [Cancel] [Save].

Submit → `POST /api/agent/lead/:id/callbacks` `{callback_at, user_id?, comments}`.
Phase unchanged. Toast "Callback saved for Tue Mar 14, 3:00 PM." During wrapup,
if a mid-call callback was created, the dispo overlay pre-checks "Schedule callback"
and pre-selects the `CALLBK` status.

### 5.6 Mark-DNC flow

Click [Mark DNC] → confirm `<AlertDialog>`:
"Add +1 (415) 555-0142 to internal DNC? This cannot be undone from this screen."
[Cancel] [Confirm DNC].

Confirm → `POST /api/agent/lead/:id/dnc`. Server: inserts `dnc` row
(`source='internal'`, `campaign_id=NULL` — global internal DNC), writes
`c03_audit_log`. Returns 200. UI: soft toast "Lead added to DNC. Set disposition
to DNC?" with a button that selects DNC in the wrapup picker. Rate-limited at
API layer (20/hour/agent).

When selecting DNC in the wrapup picker, a confirmation soft warning appears
("Lead will be added to DNC. Proceed?") before auto-submit.

---

## 6. DTMF keypad

### 6.1 Component spec — `<DtmfPad/>`

`<Popover>` anchored above the DTMF action button. Auto-focuses on open.
4×3 grid of 64×64 px cells (1/2/3, 4/5/6, 7/8/9, *, 0, #).
"Last sent" row (last 12 digits, space-separated; auto-clears after 5 s).
[Clear] button.

### 6.2 Input handling

- **Click**: sends single tone at 200 ms duration via `useSoftphone().sendDtmf(tone)`.
- **Tap-and-hold** (≥300 ms): sends at 600 ms duration.
- **Physical keyboard** (when popover focused): `0-9 * #` intercepted by `keydown` scoped to the popover. `Backspace` clears echo. `Escape` closes popover.
- **Paste (Ctrl+V)**: valid chars `0-9*#` extracted from clipboard; dispatched with 80 ms inter-digit gaps (Twilio convention); max 32 chars.
- Right-click suppressed. Key repeat rate-limited to 10/s.
- When popover is *closed*, `0-9` do NOT trigger DTMF globally.

### 6.3 RFC 4733 vs SIP INFO

A05 calls `sendDtmf(tone)` and A02 dispatches per `useUiStore.dtmfMode`
(configured in `(agent)/settings/page.tsx` "Advanced"). A05 does not expose this toggle.

### 6.4 Webform iframe postMessage protocol (FROZEN)

`<WebformIframe/>` renders `<iframe sandbox="allow-same-origin allow-scripts allow-forms" src={webformUrl}>`.

Origin allowlist sourced from `campaign.webform_url` (hostname extracted, stored in `useCallStore.campaign.webform_url`).

**Outbound (A05 → iframe):** On mount and on lead data change:
```jsonc
{ type: "vici2:lead", version: 1, payload: {
    lead_id, first_name, last_name, phone_e164, email,
    address1, city, state, postal_code,
    custom_data: Record<string, string>,
    call_uuid
  }
}
```

**Inbound (iframe → A05):** Validated against `{ type: 'vici2:disposition' | 'vici2:notes_append', version: 1, ... }`. Origin must match allowlist; other messages dropped.

```jsonc
// iframe may suggest a disposition:
{ type: "vici2:disposition", version: 1, payload: { status: string } }
// iframe may append notes:
{ type: "vici2:notes_append", version: 1, payload: { text: string } }
```

A05 applies `postMessage` origin check (`event.origin !== allowedOrigin && drop`). CSP `frame-src` directive restricts iframe load source.

---

## 7. Disposition workflow

### 7.1 Decision: post-hangup mandatory (Option B)

Per RESEARCH §7.1 and SPEC §9 demo step 9 (Hangup → picker → SALE). No pre-hangup dispo in Phase 1.

### 7.2 DispositionPicker overlay

When `phase === 'wrapup'`, the `<DispositionPicker/>` component absolutely fills the center column (not a `<Dialog>` — avoids `aria-modal` tab-trap per RESEARCH cite [23]). The rest of the UI (left panel notes, top bar) remains interactive.

Picker structure:
1. **Header:** "DISPOSITION" + wrapup timer (circular progress, `campaigns.wrapup_seconds`).
2. **Status grid:** all statuses where `selectable=true AND hotkey IS NOT NULL`, rendered as `<button>` tiles ordered by hotkey (`1`→`9`→`0`→unlabeled). Each tile shows hotkey badge + status code + status label.
3. **Comments:** `<textarea>` pre-filled from `useCallStore.notes`. Typing resets the wrapup timer.
4. **Schedule callback:** `<Checkbox>`. When checked, reveals datetime picker + ◯ Me only ◯ Anyone. Pre-checked if a mid-call callback exists.
5. **Footer:** [Cancel & resume] (only if `hangupGraceActive`; reverses to `active`) · [Skip] · [Submit ⏎].

Status source: `GET /api/agent/campaign/:id/statuses` cached in TanStack Query.

### 7.3 Wrapup timer behavior

- Circular progress badge, bottom-right of overlay.
- T-10 s: progress turns yellow; soft toast "Auto-saving as NA in 10 s".
- T-0: auto-submit `{status:'NA', comments:'[auto-dispo wrapup expired]'}` → page O01 `vici2_dispo_auto_count`.
- Typing in the comments textarea resets timer to `wrapup_seconds`.
- Timer is computed from `Date.now() - wrapupStartAt` (clock arithmetic; not accumulator).

### 7.4 Click vs hotkey

- **Click** a tile → highlights; Enter submits.
- **Press hotkey digit (0-9, only in `wrapup` scope)** → highlights AND auto-submits (unless `useUiStore.confirmHotkeyDispo === true`).
  - `confirmHotkeyDispo` defaults `false` (Vicidial muscle-memory pattern).
  - New-agent onboarding hint: "Pressing a number key submits immediately. Change this in Settings."

### 7.5 Dispo submission

`POST /api/agent/dispo` with:
```jsonc
{
  "call_uuid": "...",
  "status": "SALE",
  "comments": "...",
  "callback_at": "2026-05-15T15:00:00Z",  // optional
  "callback_user_id": 42                    // optional; null = anyone
}
```

API (server-side):
1. Writes `agent_log` row (includes `wrap_seconds` computed from `wrapup_start_at`).
2. Updates `leads.status`, `leads.called_count++`, `leads.last_called_at`.
3. Appends notes to `leads.comments` with separator `\n----\n<agent_display> <iso_ts>\n<notes>`.
4. Updates `call_log.status`, `call_log.comments`, `call_log.wrap_seconds`.
5. If `callback_at`: inserts `callbacks` row.
6. If `status === 'DNC'`: inserts `dnc` row (if not already inserted by mid-call Mark-DNC).
7. Returns 200.

UI then: `clearCall()` → `phase='idle'` → `router.replace('/dial')`.
Agent state transitions from `wrapup` to `ready` (or `paused` if a supervisor
force-pause was queued during the call).

### 7.6 Skip escape hatch

"Skip" button in overlay footer → confirm "Mark as NA without notes?" → submits
`{status:'NA'}`. Pages O01 `vici2_dispo_skipped_total{reason='user_initiated'}`.

### 7.7 "Cancel & resume" (Hangup grace window)

During the `hangup_grace_seconds` window (default 5 s, configurable per campaign,
disableable per agent via `useUiStore.disableHangupGrace`):
- The dispo overlay shows immediately (for muscle-memory; agent can type notes now).
- "Cancel & resume" button is visible in the overlay footer.
- Click → `clearTimeout(hangupGraceTimer)` → `setPhase('active')` → overlay dismisses.
- Grace expires or agent clicks anything else → `POST /hangup` fires.
- When customer hangs up (WS `call.hangup` arrives before agent presses anything): no grace, jump to wrapup with timer.

Determination: `useCallStore.hangupGraceActive` is `true` only when the agent
pressed Hangup (not when the customer triggered it). The WS `call.hangup` event
handler checks `hangupGraceActive`: if true, it skips the re-transition (already
in wrapup). If `hangupGraceActive === false` and WS `call.hangup` arrives, phase
flips to wrapup immediately (customer-initiated path).

---

## 8. Notes

### 8.1 Single textarea, no rich text

`<NotesTextarea/>` — 6-row default, auto-grows to 12 rows, scrolls inside beyond.
4 quick-tag chips above: `[callback]` `[interested]` `[not-interested]` `[wrong-person]`.
Toggle inserts/removes `[tag] ` prefix in the textarea. Vicidial-compatible
`vicidial_call_notes` parser sees these tags.

### 8.2 Auto-save mechanics

- `onChange` debounced 2 s → `PATCH /api/agent/call/:uuid/notes` `{comments}`.
- `onBlur` fires immediately.
- `beforeunload` fires `navigator.sendBeacon('/api/agent/call/:uuid/notes', body)`.
- Status badge near textarea: "Saved ✓" / "Saving…" / "Save failed — retry?".
- Phase transitions do NOT unmount the textarea. The dispo overlay covers the center
  column only; the left panel (where notes live) remains mounted and functional.

### 8.3 Dual-write contract

- **In-call saves:** → `call_log.comments` only.
- **On dispo submit:** the API appends the final `call_log.comments` to `leads.comments`
  with separator (once, clean boundary, per RESEARCH §15 Q6 decision).

### 8.4 Max length

Client caps textarea at 4096 chars. Server enforces 4096 with `422 NOTES_TOO_LONG`.

---

## 9. Recording indicator (4-state machine)

### 9.1 State derivation

```
recording_mode   recording   consent_status        UI state         action button
─────────────    ─────────   ────────────────      ──────────────   ──────────────
ALL/ALLFORCE     on          any                   Recording        disabled "always-on"
ALL/ALLFORCE     pending     PROMPT_*/REQUIRE_*    Pending-consent  disabled (prompt in progress)
NEVER            any         any                   Not recording    hidden (button hidden)
ONDEMAND         off         ALLOW/PROMPT_*        Not recording    Record◉ (start)
ONDEMAND         off         REQUIRE_ACTIVE        Not recording    Record◉ (start; requires DTMF1)
ONDEMAND         off         SKIP                  Not recording    disabled "consent denied"
ONDEMAND         on          any allow             Recording        Record◉ (stop)
ONDEMAND         pending     PROMPT_*/REQUIRE_*    Pending-consent  spinner "Waiting for consent…"
any              paused      any                   Paused (PCI)     Resume (sup only)
```

Source: `useCallStore.recording` (set by WS events) × `useCallStore.campaign.recording_mode`
× `useCallStore.consent`.

### 9.2 Top-bar badge (4 visual states)

| Visual | State |
|---|---|
| `● REC` — red dot, red text | Recording |
| `○ REC OFF` — grey dot, grey text | Not recording |
| `⏸ REC PAUSED` — yellow dot | Paused (PCI mask) |
| `… CONSENT` — orange dot, pulse animation | Pending consent prompt |

Click → opens read-only `<Popover>` showing:
- Recording state.
- C02 decision (state-applied, mechanism, reason).
- Start time + elapsed (if active).
- File path: **hidden from agent role** (shows "Stored securely" — per RESEARCH §15 Q10).
- For PAUSED: "Resume recording" button visible only to supervisor/admin role.

### 9.3 Action-bar Record◉ (ONDEMAND only)

Only rendered when `campaign.recording_mode === 'ONDEMAND'`. Click → 
`PATCH /api/agent/call/:uuid/recording` `{action: 'start' | 'stop'}` → R01.

For `start` with `consent_status === 'PROMPT_MESSAGE' | 'REQUIRE_ACTIVE'`: API
plays the consent prompt (F03 dialplan extension). UI shows "Waiting for consent…"
spinner. WS `call.recording_started` or `consent.decision` (declined) settles the state.

For `stop`: immediate, no consent gate needed.

### 9.4 PCI mask cluster

Hidden behind a "PCI" toggle visible only to agents in PCI-trained groups
(`user.groups` includes `pci_trained`; sourced from JWT claims). When visible:
- [PCI: Start mask] → `{action:'pause'}` → R01 `uuid_record mask`. Indicator → PAUSED.
- [PCI: End mask] → `{action:'resume'}` → `uuid_record unmask`. Indicator → RECORDING.

Tooltip: "Pausing recording mutes DTMF but is NOT a substitute for a PCI
sidecar (PCI SSC 2024+). Phase 2: PCI Pal integration."

---

## 10. Real-time state sync

### 10.1 WS event subscriptions

All via `useWebSocket().subscribe(type, handler)` from A01 PLAN §4.

| Event type | Producer | A05 action |
|---|---|---|
| `call.created` | T01 | `setActiveCall(payload)` — lead + campaign + consent populated |
| `call.answered` | T01 | `setPhase('ringing')` if not already |
| `call.bridged` | T01 | `setPhase('active')`; `startedAt = payload.ts` |
| `call.hangup` | T01 | If `hangupGraceActive`: no-op (already in wrapup). Else: `setPhase('wrapup')`. |
| `call.held` | T03 | `setPhase('hold')` |
| `call.resumed` | T03 | `setPhase('active')` |
| `call.recording_started` | R01 | `setRecording('on')` |
| `call.recording_stopped` | R01 | `setRecording('off')` |
| `call.recording_paused` | R01 | `setRecording('paused')` |
| `consent.decision` | C02 | `setConsent(payload)` |
| `conference.member_added` | T01 | `addParticipant(payload)` |
| `conference.member_left` | T01 | `removeParticipant(payload.uuid)` |
| `conference.member_muted` | T01 | `updateParticipant(uuid, {muted:true})` |
| `conference.member_unmuted` | T01 | `updateParticipant(uuid, {muted:false})` |
| `agent.status_changed` | T01/API | `useAgentStore.setStatus(...)` |

### 10.2 No polling (steady state)

A05 has one `setInterval`: the call timer (ticks each 1 s; computes `Date.now() - startedAt` — clock arithmetic, no accumulator, immune to background throttling).

### 10.3 Reconnect + fallback

A01 PLAN §4 WS reconnect with `{op:'resume', from:lastSeq}` cursor is inherited.

- WS down 0–5 s: silent.
- WS down >5 s: banner "State sync reconnecting — call audio unaffected" (`aria-live="polite"`).
- WS down >30 s: begin `setInterval(5000)` polling `GET /api/agent/call/:uuid/state`. Auto-stops when WS reconnects.
- WS restored: toast "State sync restored."

### 10.4 Race-condition mitigations

| Race | Mitigation |
|---|---|
| Agent clicks Hangup; WS `call.hangup` arrives before API response | `useOptimistic` (React 19, per A01 PLAN §9) flip to wrapup on click; WS arrival is no-op if already in wrapup |
| Mute toggle + WS (mute is local-only) | No WS for mute; `useSoftphone().muted` is the single source of truth |
| Customer hangs up while agent typing | Phase transition does NOT unmount notes textarea; dispo overlay covers center column only |
| WS lag delays `call.answered` | `startedAt` derived from `useSoftphone()` INVITE timestamp as 3-second fallback |
| 3-way leg ringing while customer already hung up | WS `call.hangup` kills the 3-way modal; phase → wrapup |
| Supervisor force-pauses agent mid-call | Independent state machines; top bar shows `[BUSY-on-call → paused (force) 00:12]`; on hangup, agent → paused, not ready |
| Browser tab close during active call | `beforeunload` confirm dialog; A02 sends SIP BYE on close; FS `endconf-grace-time=5` cleans up |

### 10.5 Multi-tab handling

`BroadcastChannel('vici2.callpanel')` with message `{event:'active', tabId}` on mount.
Second tab detects collision → shows read-only banner "Call panel open in another tab"
+ [Take over] button. Take-over sends `{event:'takeover', tabId}` → first tab shows
"Control transferred to another tab" banner + reads only.

---

## 11. Hotkeys

### 11.1 Default keymap (FROZEN)

Registered via `KeyboardListenerProvider.register(...)` (A01 PLAN §3.1).

| Key | Scope | Action |
|---|---|---|
| `F1` | global | Open help/cheatsheet overlay |
| `F2` | in-call | Hold toggle |
| `F3` | in-call | Hangup (always fires; no input suppression) |
| `F4` | in-call | Mute toggle |
| `Space` | in-call (no input focused) | Hold toggle |
| `M` | in-call (no input focused) | Mute toggle |
| `D` | in-call (no input focused) | Open DTMF keypad popover |
| `R` | in-call (no input focused, ONDEMAND only) | Record toggle |
| `Ctrl+T` | in-call | Open Transfer modal |
| `Ctrl+3` | in-call | Open 3-way modal |
| `Ctrl+B` | in-call, wrapup | Open callback scheduler |
| `Ctrl+D` | in-call, wrapup | Mark DNC (confirm dialog) |
| `Ctrl+P` | global | Agent pause toggle |
| `Ctrl+L` | global | Log out (confirm dialog) |
| `0`–`9` | wrapup only | Pick disposition by hotkey (D04 map) + auto-submit |
| `Enter` | wrapup | Submit current selection (if a tile is highlighted) |
| `Esc` | global | Close current popover/modal |
| `?` | global | Open help overlay (alias for F1) |

### 11.2 Conflict suppression

When `document.activeElement.tagName === 'INPUT' || 'TEXTAREA' || activeElement.isContentEditable`:
- Single-letter (`M`, `D`, `R`) and bare digit (`0`–`9`), `Space`, bare `Enter` hotkeys are suppressed.
- Modifier-keyed hotkeys (`Ctrl+T`, `F1`–`F12`) still fire.
- `Esc` always fires.
- Visual hint when textarea is focused: small tooltip near textarea "Press Esc to use hotkeys."

### 11.3 Vicidial parity notes

Matches: `Space`=Hold, `Ctrl+T`=Transfer, `Ctrl+P`=Pause, `0-9`=dispo.
Deviation from DESIGN.md §7.5: `F1`=Help (not Hold). `F2`=Hold (not in DESIGN.md).
This is a deliberate PLAN-phase override. HANDOFF will document. No RFC required (per
RESEARCH §15 Q3 recommendation).

### 11.4 User customization

`(agent)/settings/page.tsx` "Keyboard shortcuts" section:
- List each action + current key + [Change].
- Click [Change] → "Press any key…" capture-next-keystroke dialog.
- Validates uniqueness across all scopes.
- Persists to `useUiStore.hotkeyMap` (`vici2.ui` persisted store).
- [Reset to defaults] and [Print cheat sheet] links.

### 11.5 Help overlay (`<HotkeyHelp/>`)

`F1` or `?` opens a full-screen overlay (not `aria-modal`; Esc closes).
Auto-discovers the registered hotkey map. Groups by scope (global / in-call / wrapup).

---

## 12. A02 integration

### 12.1 `useSoftphone()` contract (A05 consumer surface, FROZEN with A02 PLAN)

```ts
// import path: @/lib/sip (A02 PLAN §2.1 freeze)
interface UseSoftphoneReturn {
  status: 'connecting' | 'registered' | 'on-call' | 'reconnecting' | 'error';
  muted: boolean;
  toggleMute(): void;
  hold(): Promise<void>;    // SIP re-INVITE sendonly — NOT USED by A05 for customer hold
  unhold(): Promise<void>;  // Same
  isOnHold: boolean;
  sendDtmf(tone: '0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'*'|'#'): void;
  stats: SoftphoneStats | null;
  lastError: { code: string; message: string } | null;
}
```

A05 uses: `status` (top-bar SIP indicator), `muted` + `toggleMute()` (Mute button),
`sendDtmf()` (DTMF keypad), `stats` (diagnostic tooltip on the REC badge popover).
A05 does NOT use `hold()`/`unhold()` — customer hold is server-side via T03
(RESEARCH §15 Q1 decision: T03 path gives MOH; SIP-side hold does not).

### 12.2 DOM-host rule

`<audio id="remoteAudio">` is owned by `<SipProvider/>` in `AgentShell.tsx` (A02
PLAN §2.3). A05 never mounts an audio element. On `/call` route, audio continues
because AgentShell persists across page navigations.

### 12.3 ESLint enforcement

Custom rule `no-direct-sip-import` (CI gate, fails PR):
- Forbids `import * from 'sip.js'` outside `web/src/lib/sip/`.
- Forbids `useSoftphone().simpleUser` property access (private; accesses the SIP.js
  `SimpleUser` instance directly).

### 12.4 SIP status surface in top bar

| `useSoftphone().status` | Top-bar display |
|---|---|
| `registered` | No badge (default clean state) |
| `connecting` | Small spinner next to agent state pill |
| `reconnecting` | Yellow badge "Reconnecting audio…" |
| `error` | Red banner "Audio disconnected — click to reconnect" |

Simultaneously with WS state banner if both are down.

---

## 13. API endpoints

### 13.1 REST endpoints (A05-owned or primary consumer)

All paths prefixed `/api`. All requests include `Authorization: Bearer <jwt>` and
`X-Vici2-Tenant: <tenantId>` (via `api.*` client, A01 §3). Server returns 404 if
`call_uuid` is not owned by the calling agent's session.

| Verb | Path | Body (request) | Response | Effect |
|---|---|---|---|---|
| `POST` | `/api/agent/call/:uuid/hangup` | `{}` | `{ok:true}` | `T01.UUIDKill(custUUID, NORMAL_CLEARING)`; `c03_audit_log` row |
| `PATCH` | `/api/agent/call/:uuid/hold` | `{action:'hold'|'unhold'}` | `{ok:true}` | `T03.HoldCustomer` or `ResumeCustomer` |
| `POST` | `/api/agent/call/:uuid/dtmf` | `{digits:string}` | `{ok:true}` | Server-side `uuid_send_dtmf` — Phase 1.5 fallback; primary = RFC 4733 from browser |
| `POST` | `/api/agent/call/:uuid/transfer` | `{kind:'blind', dest:string}` | `{ok:true}` | `T01.UUIDTransfer(custUUID, ext-out:<dest>, XML, default)` |
| `POST` | `/api/agent/call/:uuid/originate-third` | `{phone_e164:string, cid_override?:string}` | `{job_uuid, originated_uuid}` | C01/C02/D05 gates; `T03.TransferThirdParty(tid,uid,...)` |
| `POST` | `/api/agent/call/:uuid/leave-3way` | `{}` | `{ok:true}` | `T03.LeaveThreeWay(tid, uid)` |
| `PATCH` | `/api/agent/call/:uuid/recording` | `{action:'start'|'stop'|'pause'|'resume'}` | `{ok:true}` | Delegates to `dialer/internal/recording/` (R01) |
| `PATCH` | `/api/agent/call/:uuid/notes` | `{comments:string}` | `{ok:true}` | `UPDATE call_log SET comments=? WHERE call_uuid=?` |
| `POST` | `/api/agent/dispo` | `{call_uuid, status, comments?, callback_at?, callback_user_id?}` | `{ok:true}` | Full dispo write (§7.5) |
| `POST` | `/api/agent/lead/:id/dnc` | `{reason?:string}` | `{ok:true}` | INSERT `dnc` row; `c03_audit_log` |
| `POST` | `/api/agent/lead/:id/callbacks` | `{callback_at, user_id?, comments?}` | `{id:number}` | INSERT `callbacks` row |
| `PATCH` | `/api/agent/lead/:id` | `{phone_alt?, phone_alt2?, email?}` | `{ok:true}` | Limited lead edit; audit logged |
| `GET` | `/api/agent/lead/:id/history` | `?limit=10` | `HistoryEvent[]` | `call_log JOIN users JOIN statuses + callbacks + entry` |
| `GET` | `/api/agent/campaign/:id/statuses` | — | `StatusDef[]` | D04 `hotkeyMap`; filtered `selectable=true` |
| `GET` | `/api/agent/script/:campaign_id` | `?lead_id=...` | `{html:string}` | Server-rendered script with lead substitution; sanitized |
| `GET` | `/api/agent/call/:uuid/state` | — | `{phase, recording, consent}` | WS-down polling fallback only |

### 13.2 Error handling

Standard envelope per F05 / A01 PLAN §3: `ApiError {code, message, status, details?}`.

| Error | A05 action |
|---|---|
| `409 CALL_ALREADY_ENDED` | Toast "Call already ended" → transition to wrapup |
| `403 AGENT_NOT_ASSIGNED` | Toast "You're not the owner of this call" |
| `429 RATE_LIMITED` | Toast "Too many requests — wait a moment" |
| `422 NOTES_TOO_LONG` | Toast "Note is too long (max 4096 chars)" |
| `500` | Toast "Server error — action wasn't applied" + auto-retry once after 1 s |

### 13.3 Optimistic updates

Using React 19 `useOptimistic` (A01 PLAN §9):
- Mute, Hold (start), Recording start/stop → optimistic flip; WS confirms; failure reverts + toast.
- Hangup → optimistic `phase='wrapup'` immediately on click (with grace window).
- DTMF → fire-and-forget (no optimistic needed; `sendDtmf` is local).

---

## 14. Component tree (FROZEN file paths)

### 14.1 Route page

```
web/src/app/(agent)/call/
  page.tsx                    — Route entry; mounts <CallPanelRoot/>; no SSR
                                (all data from WS + TanStack Query)
  layout.tsx                  — Inherits (agent) AgentShell layout (A01 §3)
  loading.tsx                 — Skeleton while store hydrates
```

### 14.2 Compound components under `web/src/components/call/`

```
call/
  CallPanelRoot.tsx           — Top-level grid; mounts TopBar + LeftPanel +
                                 CenterPanel + ActionBar; manages phase
  TopBar.tsx                  — 56 px sticky; campaign pill, agent state pill,
                                 call timer, recording badge, consent badge,
                                 pause▾, settings, logout
  CallTimer.tsx               — Reads useCallStore.startedAt; clock arithmetic;
                                 requestAnimationFrame when foregrounded;
                                 setInterval(1000) when backgrounded
  RecordingBadge.tsx          — 4-state pill + click-to-inspect Popover
  ConsentBadge.tsx            — Consent status pill in top bar (read-only)
  SoftphoneStatusBadge.tsx    — SIP connection state indicator (spinner/warning/error)

  LeftPanel.tsx               — Scrollable 360 px column
  LeadInfoCard.tsx            — Default fields + consent line
  LeadCustomFields.tsx        — <details> disclosure component
  LeadEditableField.tsx       — Inline edit (phone_alt, phone_alt2, email)
  HistoryTimeline.tsx         — Unified history accordion; TanStack Query
  HistoryEntry.tsx            — Single timeline item (2-line render)
  NotesPanel.tsx              — Tag chips + NotesTextarea
  NotesTextarea.tsx           — Auto-save, debounce, sendBeacon, status badge

  CenterPanel.tsx             — Tabs (Script / Webform / Comments); disposition overlay
  ScriptTab.tsx               — Server-rendered HTML from /api/agent/script/...
  WebformIframe.tsx           — iframe + postMessage protocol; origin allowlist
  CommentsTab.tsx             — Mirrors NotesTextarea (same state, different location)
  DispositionPicker.tsx       — Wrapup overlay (absolute fill, not Dialog)
  DispositionGrid.tsx         — Status tiles sorted by hotkey
  WrapupTimer.tsx             — Circular progress countdown
  CallbackScheduler.tsx       — Datetime picker + Me only / Anyone radio
  RealtimeAssistant.tsx       — null in Phase 1; FF guarded

  ActionBar.tsx               — 64 px sticky bottom; 9 buttons
  HangupButton.tsx            — Always-visible red button
  HoldButton.tsx              — Toggle; active/hold phases
  MuteButton.tsx              — Local-only toggle
  DtmfButton.tsx              — Opens DtmfPad Popover
  DtmfPad.tsx                 — 4×3 grid + echo display + keyboard handler
  TransferButton.tsx          — DropdownMenu; Phase 1: 1 option
  TransferModal.tsx           — Blind transfer form (Dialog)
  ThreeWayButton.tsx          — Opens ThreeWayModal
  ThreeWayModal.tsx           — Phone + CID form (Dialog)
  ThreeWayParticipantCard.tsx — Mini-card below LeadInfoCard when transferring
  RecordButton.tsx            — ONDEMAND only; toggle start/stop
  CallbackButton.tsx          — Popover; mid-call scheduler
  MarkDncButton.tsx           — Two-step AlertDialog

  HotkeyHelp.tsx              — Full-screen overlay (F1 / ?)
```

### 14.3 Shared hooks (within A05 scope)

```
web/src/lib/hooks/
  useDispositionPicker.ts     — status list query; hotkey handler; auto-submit logic
  useHangupGrace.ts           — grace timer; cancel; commit
  useWrapupTimer.ts           — countdown from wrapup_seconds; auto-submit on expiry
  useNotesSave.ts             — debounced PATCH; onBlur; sendBeacon
  useThreeWay.ts              — participant list; originate; leave
```

### 14.4 Existing stores extended (A01 §5)

- `useCallStore` — additions per §3.3 above.
- `useUiStore` — additions: `confirmHotkeyDispo: boolean`, `disableHangupGrace: boolean`,
  `hotkeyMap: Record<string, string>`.

---

## 15. Test plan

### 15.1 Unit tests (Vitest + React Testing Library)

Path: `web/src/components/call/__tests__/` and `web/src/lib/hooks/__tests__/`.

| Test file | What it covers |
|---|---|
| `LeadInfoCard.test.tsx` | Field rendering; custom-field disclosure; phone formatting; missing-fields fallbacks; consent line variants |
| `HistoryTimeline.test.tsx` | Loading/empty/error states; `HistoryEvent` type rendering; relative time; status pill colors |
| `NotesTextarea.test.tsx` | Debounced save; tag chip toggle; max-length enforcement; auto-save on blur; sendBeacon on unload |
| `ActionBar.test.tsx` | Phase-dependent enabled state per button; click handlers; loading state during in-flight API; aria-disabled announcement |
| `DispositionPicker.test.tsx` | Hotkey selection; auto-submit (`confirmHotkeyDispo=false`); confirm-step mode (`=true`); callback required for CALLBK; notes included in submit payload |
| `DtmfPad.test.tsx` | Click sends; keyboard input; paste-from-clipboard (valid chars extracted); long-press timing; echo display; max 32 chars |
| `RecordingBadge.test.tsx` | All 4 visual states; click opens popover; ONDEMAND-only action button visibility; PCI cluster visibility |
| `CallTimer.test.tsx` | Tick accuracy (clock arithmetic); background-tab `setInterval` fallback; `startedAt=null` shows `00:00` |
| `WrapupTimer.test.tsx` | Countdown; T-10 yellow turn + toast; auto-submit at T-0; reset on textarea input |
| `WebformIframe.test.tsx` | Origin allowlist; postMessage send on mount; postMessage receive (disposition suggestion; notes_append); invalid origin dropped |
| `HangupGrace.test.tsx` | Agent-initiated: grace active, cancel reverses phase, expiry fires POST /hangup; customer-initiated: no grace |
| `useCallStore.test.ts` | All `patchFromEvent` reducers; phase state machine transitions; invariant: no backward transitions |
| `useHotkeys.test.ts` | Default map; conflict suppression in inputs; `Esc` always fires; custom remap persistence |
| `useNotesSave.test.ts` | Debounce 2 s; immediate on blur; sendBeacon on unload |
| `useWrapupTimer.test.ts` | Fake timers; auto-submit; textarea reset; T-10 toast |

Coverage target: ≥70% on all files under `web/src/components/call/` and `web/src/lib/stores/call.ts`.

### 15.2 Integration tests (MSW + RTL)

Path: `web/src/test/integration/call-panel/`.

| Test file | Flow |
|---|---|
| `mute-toggle-flow.test.ts` | Mount A05 → fire `call.bridged` WS → click Mute → assert `useSoftphone().toggleMute` called → UI muted state |
| `hold-flow.test.ts` | Click Hold → PATCH /hold → WS `call.held` → phase='hold'; click again → unhold |
| `dtmf-flow.test.ts` | Open keypad → click 5 → `sendDtmf('5')` called; paste '12#' → 3 calls with 80 ms gaps |
| `dispo-flow.test.ts` | WS `call.hangup` → phase='wrapup' → press hotkey '1' (SALE) → POST /dispo status=SALE → phase='idle' |
| `hangup-grace-flow.test.ts` | Press Hangup → phase='wrapup' immediately → Cancel & resume → phase='active'; press Hangup → wait 5 s → POST /hangup fires |
| `callback-flow.test.ts` | Open callback popover → fill datetime → submit → POST /callbacks |
| `recording-toggle-flow.test.ts` | Click Record (ONDEMAND) → PATCH /recording start → WS `call.recording_started` → badge=Recording |
| `recording-consent-flow.test.ts` | PROMPT_MESSAGE mode → click Record → spinner "Waiting for consent…" → WS `consent.decision` (ALLOW) → badge=Recording |
| `transfer-flow.test.ts` | Open Transfer → enter phone → submit → POST /transfer kind=blind |
| `3way-flow.test.ts` | Open 3-way → enter phone → submit → POST /originate-third → WS `conference.member_added` → participant card shows 3rd |
| `leave-3way-flow.test.ts` | 3-way active → click "Leave 3-way" → POST /leave-3way → phase='wrapup'; customer + 3rd remained bridged |
| `notes-autosave-flow.test.ts` | Type in textarea → wait 2.1 s → PATCH /notes called |
| `wrapup-timer-expiry.test.ts` | Enter wrapup → fake timers 60 s → POST /dispo status=NA, comments contain '[auto-dispo wrapup expired]' |
| `ws-reconnect-resync.test.ts` | Simulate WS disconnect → reconnect → `{op:'resume', from:lastSeq}` → no missed phase transitions |
| `multi-tab-detection.test.ts` | Mount in two simulated tabs → second tab shows read-only banner |
| `postmessage-protocol.test.ts` | iframe sends `vici2:disposition` from allowed origin → dispo picker pre-selects; from unknown origin → ignored |
| `ws-event-burst.test.ts` | Fire 500 WS events in 1 s → no dropped renders; p95 handler time < 100 ms |

### 15.3 E2E — Playwright

Path: `web/test/e2e/call-panel.spec.ts`.

Golden disposition flow:
```
1. Login as agent (MSW mocks F05).
2. Navigate to /dial (A04).
3. Initiate manual dial to mock number.
4. Mock: WS call.created → call.answered → call.bridged.
5. Assert /call loads; lead info card populated.
6. Press Space → WS call.held → Hold button shows Resume.
7. Press Space → WS call.resumed → back to active.
8. Press D → DTMF keypad opens; type '1234#' → sendDtmf called 5 times.
9. Close DTMF keypad (Esc).
10. Press F3 (Hangup) → grace window; dispo overlay shows immediately.
11. Type "wanted brochure" in comments textarea.
12. Press 1 (SALE hotkey) → POST /dispo status=SALE → /dial renders; agent state=ready.
```

A11y tests via `@axe-core/playwright`:
- `/call` phase=active — zero AA violations.
- `/call` phase=wrapup (overlay) — zero AA violations.
- `/call` DTMF popover open — zero AA violations.
- `/call` at 768 px viewport (left panel drawer) — zero AA violations.

Performance (Lighthouse-CI, mock data):
- Performance ≥85 on `/call`.
- Accessibility ≥95 on `/call`.

### 15.4 Manual exploratory

- QA agents work the screen for 2 days during IMPLEMENT, file qualitative reports (cognitive load, hotkey conflicts, missing affordances).
- Two-tab detection verified manually.
- Recording-consent visual flow tested with real `consent_log` fixtures.
- 768 px responsive layout verified on Chrome DevTools + real tablet.
- PCI mask cluster tested with `pci_trained` group membership in JWT.

---

## 16. Acceptance criteria

A05 IMPLEMENT is DONE when ALL of the following pass:

1. **AC-1 Hangup always visible.** Red Hangup button is pixel-stable bottom-left at every phase value. Axe-core finds zero violations on `/call`.
2. **AC-2 Full call flow.** SPEC §9 demo step 9 runs end-to-end: Hangup → dispo overlay → SALE hotkey → /dial → agent state=ready.
3. **AC-3 Grace window.** Agent presses Hangup; has 5 s to press "Cancel & resume"; doing so returns to active call without the API /hangup being called.
4. **AC-4 Customer hangup — no grace.** WS `call.hangup` (customer-initiated, `hangupGraceActive=false`) goes straight to wrapup.
5. **AC-5 Recording indicator.** All 4 badge states render correctly per §9.1 state matrix. Click opens popover. File path hidden from agent role.
6. **AC-6 Wrapup timer.** At T-0, auto-submit fires with `status='NA'` and `[auto-dispo wrapup expired]` comment. O01 counter increments.
7. **AC-7 Notes dual-write.** Auto-save within 2.1 s of keystroke. On dispo submit, `leads.comments` has the appended block with separator. No double-append on refresh.
8. **AC-8 DTMF keypad.** Click, keyboard input, paste all send correct tones. Paste respects 80 ms gaps and 32-char limit. Echo clears after 5 s idle.
9. **AC-9 3-way.** POST /originate-third triggers; WS `conference.member_added` shows participant mini-card; "Leave 3-way" fires POST /leave-3way; customer + 3rd stay connected.
10. **AC-10 Blind transfer.** Transfer▾ → Blind transfer → phone number → POST /transfer kind=blind. Phase → wrapup.
11. **AC-11 Hotkeys.** All 17 hotkeys in §11.1 work. Single-letter keys are suppressed inside textarea/input. F3 (Hangup) fires even inside a textarea.
12. **AC-12 WS fallback.** WS disconnected >30 s → polling starts. WS reconnects → polling stops → banner dismisses.
13. **AC-13 Responsive 768 px.** Left panel collapses to drawer. Action bar is icon-only with overflow. No horizontal scroll.
14. **AC-14 Multi-tab.** Second tab shows read-only banner. [Take over] transfers control.
15. **AC-15 Zero ESLint `no-direct-sip-import` violations.** CI gate passes.
16. **AC-16 Coverage.** ≥70% line coverage on all files under `web/src/components/call/` and `web/src/lib/stores/call.ts`.
17. **AC-17 Axe-core.** Zero AA violations in: phase=active, phase=wrapup, DTMF open, 768 px viewport.
18. **AC-18 Lighthouse.** Performance ≥85, Accessibility ≥95 on `/call` with mock data.

---

## 17. Dependencies and risks

### 17.1 Hard dependencies (must be DONE before A05 IMPLEMENT starts)

| Dependency | Why |
|---|---|
| A01 HANDOFF (DONE) | Route `/call`, stores, WS wrapper, `KeyboardListenerProvider`, `api.*` client |
| A02 PLAN (PROPOSED → IMPLEMENT) | `useSoftphone()` hook shape frozen; `<SipProvider/>` in AgentShell |
| A04 PLAN (PROPOSED → IMPLEMENT) | Populates `useCallStore` before handing off; `call.bridged` fires `router.push('/call')` |
| T01 PLAN | `UUIDKill`, `ConferenceCommand` — called by API routes A05 triggers |
| T03 PLAN | `HoldCustomer`, `ResumeCustomer`, `TransferThirdParty`, `LeaveThreeWay` |
| R01 PLAN | Recording API shape for `PATCH /recording` |
| D04 module spec | `statuses` selectable set and `hotkeyMap` shape |
| F02 PLAN (schema) | `call_log.comments`, `leads.comments`, `dnc`, `callbacks`, `recording_log` all must exist |

### 17.2 Risk register

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Agent presses Hangup too soon (customer mid-sentence) | High | Medium | 5-second grace window; "Cancel & resume" in overlay; configurable per campaign |
| Hotkey conflicts with screen readers / browser shortcuts | Medium | Medium | Modifier-keyed shortcuts for safety-critical actions; suppress in inputs; conflict matrix in HANDOFF; user remap |
| WS lag causes stale phase (stuck ACTIVE while audio dead) | Medium | Low | Optimistic flips on user actions; 30 s fallback polling; banner if WS down; 3 s `startedAt` fallback |
| A02 softphone disconnect mid-call | Low | High | A02 handles reconnect; A05 shows "Audio reconnecting" banner; customer leg stays in FS conference regardless |
| Multi-tab: two agents on same call panel | Medium | Medium | BroadcastChannel detection; second tab read-only with [Take over]; documented in HANDOFF |
| Recording indicator misleads agent (says "recording" when paused) | Low | High | Explicit `paused` state in 4-state machine; popover shows full detail; C02 `consent_log` is audit source |
| Webform iframe XSS | Medium | High | `sandbox` attrs; origin allowlist; postMessage origin check; CSP `frame-src` directive |
| Notes lost on tab crash (pre-auto-save) | Low | Low | `beforeunload` sendBeacon; 2 s debounce; status badge indicator |
| Dispo overlay keyboard a11y (focus trap) | Medium | Medium | Overlay is NOT an `aria-modal`; full keyboard support; axe-core CI gate |
| Phase transition during typing loses notes focus | Medium | Medium | Phase transition only overlays center column; left-panel notes textarea unmounted = never (same mount) |
| DTMF duplicate sends (key repeat, double-click) | Low | Medium | Rate-limit 10/s in `sendDtmf` wrapper; debounce key repeat |
| Agent can't find Hangup in emergency | Critical | High | Pinned bottom-left, red, F3, never scrolls — non-negotiable §2.4 |
| Campaign `recording_mode` not in WS `call.created` payload | Medium | High | Q8 decision: API must denormalize campaign config into `call.created` event; A05 IMPLEMENT should file API contract test |
| Browser extension blocks WebSocket (uBlock Origin strict mode) | Medium | Low | WS reconnect (A01); diagnostic hint in HANDOFF ("disable extensions") |
| Mobile screen (<768 px) breakage | Medium | Low | Route guard redirects <360 px; 768 px tested in E2E; icon-only action bar ≥ passes axe |

---

## 18. A11y and browser quirks

### 18.1 A11y rules

- `<ActionBar/>` buttons: `aria-label` = "Hangup (F3)" etc.; `aria-disabled` (not `disabled`) to keep in tab order; `aria-pressed` on toggles (Hold, Mute, Record◉).
- `<DispositionPicker/>` is NOT `role="dialog"` / `aria-modal` — it is a plain `<section aria-label="Disposition">` overlay. Focus is managed (`useEffect` focuses the first status tile on overlay mount). On dismiss, focus returns to the Hangup button.
- `<LeadInfoCard/>` uses `<dl><dt><dd>` for field/value pairs.
- Status pills use `<span>` with `role="status"` where live-updated.
- Call timer uses `<time>` element with `dateTime` attribute updated each second.
- `<HistoryTimeline/>` uses `<ul>` + `<li>` with `aria-label` on the list "Call history".
- Recording badge popover: `<div role="tooltip">` or shadcn Popover (which handles role automatically).
- DTMF keypad: `<button>` cells; `role="grid"` on the 4×3 container; `aria-label="Send tone 1"` etc.
- `<NotesTextarea/>`: `<label>` associated; `aria-describedby` pointing to save-status badge.
- `aria-live="polite"` on the toast region (Sonner).
- `aria-live="assertive"` on critical errors (call ended unexpectedly).

WCAG 2.2 AA criterion mapping (key):
- 1.4.3 Contrast: all text/icon combos meet 4.5:1 (4.65:1 for normal; 3:1 for large/bold); `bg-state-error` red button uses white icon — verified to meet 4.5:1.
- 2.1.1 Keyboard: every action reachable by keyboard (hotkeys or Tab order).
- 2.4.3 Focus order: tab order follows reading order (top bar → left panel → center tab strip → action bar).
- 4.1.3 Status messages: save status, call timer, recording badge — all via `aria-live` regions.

### 18.2 Autoplay restrictions (Chrome / Safari)

A02 PLAN §8.4 mounts `<AudioGate/>` (first-login click-to-enable). A05 concern:
if `audio.onpause` fires for reasons other than user action (background tab
power-save), A05 detects it via listener on the audio element owned by
`AgentShell` and re-shows `<AudioGate/>`.

### 18.3 Microphone permission

A02 PLAN §8.4 owns `<MicPermissionGate/>`. A05 surfaces the error state via
`useSoftphone().status === 'error'` → red banner.

Firefox private mode: mic permission expires on tab close. One-time onboarding
hint in the gate component.

### 18.4 Background tab throttling

- Call timer uses `Date.now() - startedAt` (clock arithmetic; not `++` accumulator);
  background throttling of `setInterval` does not cause drift.
- `requestAnimationFrame` used for timer display updates when foregrounded; falls
  back to `setInterval(1000)` when `document.visibilityState === 'hidden'`.
- WS stays open in background (not affected by timer throttling).
- A02 handles audio context resume on `visibilitychange`.

### 18.5 Safari specifics

- `setSinkId` unavailable — speaker picker disabled with tooltip "Speaker selection not supported in Safari" (A02 PLAN §8.2).
- `navigator.permissions.query({name:'microphone'})` returns `'prompt'` even when granted on Safari ≤16 — A02 falls back to `getUserMedia` try/catch.
- `BroadcastChannel` supported since Safari 15.4 — minimum supported version for this project.
- Strict autoplay enforcement — `<AudioGate/>` handles.

### 18.6 Browser extension interference

Ad blockers (uBlock Origin strict mode) can block WSS handshakes. A05 surfaces the
WS-down banner. HANDOFF diagnostic: "disable extensions, reload, try again."

---

## 19. Open question resolutions (all 20 from RESEARCH §15)

| Q# | Decision |
|---|---|
| Q1 Hold path | Server-side T03.HoldCustomer (customer moves to `_hold` conference profile → MOH). SIP re-INVITE `simpleUser.hold()` NOT used for customer hold. |
| Q2 Dispo auto-submit on hotkey | Auto-submit default (`confirmHotkeyDispo=false`). Toggle in Settings for new agents. |
| Q3 F1 = Help or Hold? | F1=Help; F2=Hold; Space=Hold. Deliberate divergence from DESIGN.md §7.5. HANDOFF documents; no RFC needed. |
| Q4 Wrapup auto-NA | Status `NA` with `comments` marker `[auto-dispo wrapup expired]`. No new AUTODISPO status in Phase 1. |
| Q5 Hangup grace default | Default ON (5 s). `campaigns.hangup_grace_seconds` (default 5). `useUiStore.disableHangupGrace` per-agent override. |
| Q6 Notes append timing | Append-once-on-dispo. In-call saves to `call_log.comments` only. Clean boundary. |
| Q7 3-way phone pre-validate | Both: client libphonenumber-js + server-side compliance gates. |
| Q8 Campaign config in WS event | API populates `useCallStore.campaign` from `call.created` event payload (denormalized from Valkey HASH). |
| Q9 Notes textarea size | Fixed 6-row default; auto-grows to 12 rows; scrolls inside beyond. |
| Q10 Recording file path visibility | Hidden from agent role — agent sees "Stored securely" + start time + duration. Sup/admin see file path. |
| Q11 Customer hangup grace | No grace window when customer-initiated hangup. Immediate wrapup. |
| Q12 3-way originate — 3rd party hears customer while ringing | Yes, ship as-is (FS conference behavior). HANDOFF note for A07 to revisit with `bgdial`. |
| Q13 Mark-DNC auto-dispo | Yes — after confirming DNC add, soft-toast pre-selects DNC in the wrapup picker with Undo link. |
| Q14 Lead row not found | Trust A04 invariant (stub `leads` row always created pre-originate). Show "Loading lead info…" skeleton if `lead===null`; resolves within ~200 ms. |
| Q15 Script rendering | Server-rendered HTML. `GET /api/agent/script/:cid?lead_id=...` returns substituted, sanitized HTML. |
| Q16 Webform iframe Phase 1 | Ship the iframe + postMessage protocol (frozen in §6.4) in Phase 1 with strict sandbox + origin allowlist. |
| Q17 Multi-tab | BroadcastChannel('vici2.callpanel') detection; second tab read-only + [Take over] button. |
| Q18 Record◉ icon | Lucide `circle` filled with `bg-state-error` color when recording. No custom SVG needed. |
| Q19 Hangup audit | Both: `ring_seconds` + `talk_seconds` + `hold_seconds` + `wrap_seconds` in `call_log`. |
| Q20 ESLint rule | `no-direct-sip-import` CI-blocking rule in `web/.eslintrc`; blocks `from 'sip.js'` and `useSoftphone().simpleUser` access outside `web/src/lib/sip/`. |

---

## 20. HANDOFF notes (for downstream modules)

- **A06 (disposition deep-dive):** A05 ships the wrapup overlay at MVP depth (`DispositionPicker.tsx`). A06 may deepen the overlay (e.g., multi-step dispo, campaign-specific webform link on SALE, richer callback UX). The component accepts a `mode: 'mvp' | 'extended'` prop.
- **A07 (transfer UI):** Transfer▾ `<DropdownMenu>` has placeholder slots for "Warm transfer", "Closer / agent group", "Voicemail drop" — all render `disabled` in Phase 1. A07 enables them.
- **N07 (Whisper transcription):** `<RealtimeAssistant/>` slot + feature flag `NEXT_PUBLIC_FF_AI_COACH`. Phase 1: returns `null`. Phase 3: subscribes to `coach.transcript_segment` + `coach.suggestion` WS events.
- **O01 (observability):** Expects `vici2_dispo_auto_count`, `vici2_dispo_skipped_total{reason}`, `vici2_compliance_consent_*` metrics from server. A05 does not emit client-side metrics directly.
- **F1=Help vs F1=Hold:** Deliberate deviation from DESIGN.md §7.5 (`F1=Hold` Vicidial default). Rationale: F1=Help is the modern CCaaS norm; Space=Hold preserves Vicidial muscle memory; F2=Hold gives a dedicated F-key. If DESIGN.md §7.5 is treated as binding by the project owner, an RFC must be filed; otherwise this PLAN-phase decision stands.
- **History limit=20:** Phase 1 ships `limit=10`. API endpoint already accepts the `limit` query param; UI "Show older" button is a Phase 2 add (bump to `limit=50` max).
- **PCI sidecar Phase 2:** The PCI mask cluster (`uuid_record mask/unmask`) is NOT PCI-compliant per PCI SSC 2024+. Phase 2 integration with PCI Pal / Eckoh is tracked separately (R01 Phase 2 note).
- **A02 hold path:** If A02 IMPLEMENT chooses to expose `simpleUser.hold()` as part of `useSoftphone()` for A07 warm-transfer use cases, the A07 IMPLEMENT must not break A05's hold flow, which routes via T03 exclusively.

---

*End of A05 PLAN.md*
