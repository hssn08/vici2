# Module A04 — Manual Dial UI — RESEARCH

| Field | Value |
|---|---|
| Module | A04 — Operator-facing UI for **manual** + **preview** outbound dialing (Phase 1 critical-path) |
| Phase | 1 (MVP — "Manual Dial Center") |
| Owner agent type | frontend (primary) + backend-node (REST mirror of T04) |
| Status | RESEARCH (PLAN gated on this doc + A02 PLAN softphone hook signature + T04 PLAN error taxonomy — both LANDED) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/A04.md` (REST shape `POST /api/agent/manual_dial`, "Dial Next Lead" + "Manual Dial" buttons, 6 verification scenarios). This RESEARCH supersedes the spec's `POST /api/agent/cancel_dial` body (`{call_uuid}` → `{attempt_uuid}` per T04 PLAN §4 one-UUID rule) and adds **PREVIEW** mode (not in spec; mandated by SPEC.md §1.2 + DESIGN.md §21.2 "preview mode — agents can preview lead before dial, separate from predictive") to be implemented behind a `campaigns.dial_method='MANUAL'` + `campaigns.preview_dial=true` feature flag. |
| Related plans read | A01 PLAN §3.1 (route map: `(agent)/dial/page.tsx`), §3.2 (CC island), §5.1 (Zustand stores), §6 (data table patterns), §8 (Sonner toast); A02 PLAN §1 (SIP.js `useSoftphone()` hook), §3 (DTMF), §5 (audio device picker), §10 (re-register / reconnect); A02 RESEARCH §5 (single park-leg model); T04 PLAN §0–§4 (5-gate compliance pipeline, one-UUID rule, 5 typed errors, mode→DialTarget table, `originate_audit` row, conference name helper); T04 RESEARCH §2.4 (PREVIEW = UI flow ending in MANUAL-shaped originate); C01 PLAN §0–§5 (TCPA gate union `ALLOW`/`SKIP_UNTIL`/`BLOCK_INVALID`, no manual-override); D05 PLAN §0 (DNC Bloom + MySQL confirm, `dnc:bypass` super-admin only); D01 PLAN §0 (REST surface, optimistic-lock 412, cursor pagination); F05 PLAN §0 (JWT, RBAC matrix); M01 PLAN §0 (admin app split); E01 PLAN §0–§1 (hopper claim/release contract — A04 must NOT touch the hopper); DESIGN.md §1.2 / §1.4 / §7.3 (Vicidial baseline + agent screen layout). |
| Citations | 38 (URLs, RFCs, OWASP/WCAG, FCC, Vicidial source-of-truth, libphonenumber, React/Next 15, axe/WCAG 2.2 AA, BBC accessibility, FreeSWITCH docs, etc. — listed at §17) |

---

## 1. Executive summary (10 bullets)

1. **A04 is the *pre-call* UI; A05 is the *during-call* UI; A06 is the *post-call* UI. The handoff between them is `useCallStore.phase`.** Per A01 PLAN §5.1 the call slice already encodes `phase: 'idle' | 'ringing' | 'active' | 'hold' | 'wrapup' | 'transferring'`. A04 owns transitions `idle ↔ lead_selected ↔ calling (= 'ringing')` and emits the originate; the instant the WS receives `call_bridged`, the router navigates `(agent)/dial` → `(agent)/call` and **A05 takes over**. A04 never renders during-call controls — no Hangup, no Hold, no DTMF — those live in A05's `<CallControlBar/>`. A04 *does* render an **in-flight Cancel** button while in `'ringing'` because the user is still on the dial page (we transition to `(agent)/call` only on bridge, not on originate). Boundary table §2.

2. **Three dial-driver modes ship in Phase 1: manual ad-hoc, manual-from-queue ("Dial Next Lead"), and preview-mode-from-hopper.** Per SPEC.md §1.2 the Vicidial taxonomy is MANUAL / PROGRESSIVE / RATIO / ADAPT_*. **Phase 1 is MANUAL only** — Phase 2 ships pacing modes (E02). A04's UI therefore exposes three buttons:
   - **Dial Next Lead** (auto-pull from list in `list_id ASC, lead_id ASC, status='NEW'` per A04.md "Phase 1 algorithm"; resolves to a `LEAD_SELECTED` state showing the lead, then the agent presses Call);
   - **Manual Dial** (modal: free-form phone entry + optional lead search; no pre-existing lead required);
   - **Preview Dial** (only visible when `campaigns.dial_method='MANUAL' AND campaigns.preview_dial=true`; pulls one lead from the campaign's hopper Z-SET via a special API endpoint, shows the LEAD_SELECTED screen with **Call** / **Skip** / **DNC-this-number** / **Schedule-callback** actions).

   Progressive and adapt modes don't surface A04 at all — they originate via E02→T04 directly and skip straight to A05.

3. **UI state machine has 7 states; transitions are driven by REST + WS, never by free user interaction.** The states are `IDLE`, `LOADING_LEAD` (transient, ≤1s), `LEAD_SELECTED`, `CALL_REQUESTED` (between button-press and HTTP 200), `CALLING` (HTTP 200 received, waiting for FS `CHANNEL_PROGRESS` over WS), `CONNECTING` (FS `CHANNEL_ANSWER` received, waiting for `CHANNEL_BRIDGE`), `BLOCKED` (terminal — compliance or DNC rejection). Each transition has an explicit trigger; no two transitions share a trigger; no transition is implicit on time (timeouts are explicit and named). The XState-shape diagram is in §3.1; the Zustand store delta is in §4.

4. **Local pre-gate vs. server authoritative gate: A04 runs cheap client-side gates for UX latency (no flash-of-enabled-button) but the server re-checks all 5 T04 gates.** Vicidial's PHP agent screen [1] enables/disables Dial by JS only and is famous for "Dial-then-immediately-error" UX. We instead: (a) compute `canDial = isValidE164 && tcpaWindowClientHint && !knownDnc` on every form change — disables the Call button visually — and (b) **even when canDial=true the server still runs T04's 5 gates** (gateway-cap → drop-cap → tcpa → dnc → consent per T04 PLAN §0). Server is authoritative; client is hint only. Both must agree for a dial to happen. Mismatch shows a toast + scrolls to the offending field. §6.

5. **The "Call" button has 5 explicit disabled states, each with a distinct tooltip + accessible-message.** Per WCAG 2.2 AA §3.3.1 (Error Identification) and §3.3.3 (Error Suggestion), a disabled affordance must explain *why* — silent disables fail audit [29]. Our 5 states: (i) `INVALID_PHONE` ("Phone must be a valid E.164 number — example `+14155551234`"); (ii) `OUTSIDE_TCPA_WINDOW` ("Outside calling window for this number's state. Re-opens at 8:00 AM Pacific (in 4h 12m)"); (iii) `DNC_HIT` ("This number is on the federal DNC list. Cannot dial."); (iv) `AGENT_NOT_READY` ("You are paused — un-pause to dial"); (v) `CALL_IN_FLIGHT` ("A call is already in flight. Cancel it first."). Tooltip is the visual; `aria-describedby` carries the same text for screen readers; `Toast` fires on click of a disabled button (browser-default click-on-disabled is no-op, so we wrap in a `<div>` that catches the click and announces). §7.

6. **Optimistic UI is bounded to "Calling…" (between button-press and HTTP 200) — not to the bridge.** Per A01 PLAN §5.1, the `useCallStore.phase` transitions are driven by **events**, not by client speculation; speculating bridge would create a "fake call" UI that's worse than a 1s wait. Our compromise: instantly transition `IDLE → CALL_REQUESTED` on button-press (loading spinner on button); the moment HTTP 200 returns with `attempt_uuid`, transition to `CALLING` (UI flips to the "Calling… [Cancel]" screen); the moment a WS `call_originated` (FS `CHANNEL_PROGRESS`) event arrives, the UI stays `CALLING` but shows "Ringing…"; the moment `call_bridged` arrives, route → `(agent)/call`. If HTTP 200 is delayed >300 ms the button shows a determinate spinner, not just a hover state. §8.

7. **Hotkeys: 12 default bindings; remappable per agent (persisted to `useUiStore.hotkeyOverrides`); enforced by the global `KeyboardListenerProvider` (A01 already mounts the slot — RESEARCH §5).** The Phase-1 set: `Enter` (Call/confirm), `Esc` (Cancel/back), `n` (Next Lead — when on dial page), `m` (Manual Dial modal), `/` (focus phone search), `Tab`/`Shift+Tab` (form nav), `Ctrl+Enter` (DNC + skip — preview mode only), `s` (Schedule callback — preview mode only), `Ctrl+P` (Pause toggle — owned by A09 but A04 declares the conflict), `?` (open hotkey cheatsheet modal). Each binding has `scope: 'global' | 'dial-page' | 'modal-open'` so we don't fire `n` while the user is typing in the phone input. Implementation pattern from `react-hotkeys-hook` v4 [30] which respects `<input>` focus by default. §9.

8. **WebSocket events that A04 subscribes to (read-only — A04 never publishes; it only POSTs REST):** `agent.state_changed` (re-evaluate canDial), `call.originated` (got `attempt_uuid` echo from server; advance to CALLING), `call.ringing` (FS `CHANNEL_PROGRESS`), `call.bridged` (FS `CHANNEL_BRIDGE`; route → call panel), `call.failed` (T04 returned error mid-stream after HTTP 200 — e.g., gateway 503), `call.cancelled` (we issued `/cancel_dial` and it took effect), `compliance.window_changed` (rare; campaign config updated mid-shift). Schema per A03 PLAN's WS envelope. Lost events → on reconnect, `lib/ws.ts` already replays via `{op:"resume", from:lastSeq}` (A01 PLAN §0 bullet 7). §10.

9. **REST surface = 4 endpoints owned by A04's backend mirror, plus 5 reads from existing services.** Owned: `POST /api/agent/manual_dial` (T04 wrapper for the manual-dial path; runs all 5 gates + originates; returns `{attempt_uuid}` or typed-error JSON); `POST /api/agent/cancel_dial` (issues `uuid_kill` via T01 if call is pre-bridge; idempotent on `attempt_uuid`); `GET /api/agent/next_lead` (Phase-1: `SELECT ... ORDER BY list_id, lead_id LIMIT 1 FOR UPDATE SKIP LOCKED` from `leads` joined with `campaign_lists`; Phase-2 swaps to hopper-driven via E01); `POST /api/agent/preview_skip` (preview-mode only; releases the hopper claim with a `SKIPPED` outcome). Read-only: `GET /api/leads/lookup?phone=...` (D01), `GET /api/leads/:id` (D01), `GET /api/leads/:id/history?limit=10` (D01 — last 10 `call_log` rows for this lead), `GET /api/dnc/check?phone=...&campaign=...` (D05 — Bloom-fast hint; not a hard gate), `GET /api/compliance/window?phone=...&campaign=...` (C01 — returns `{outcome, nextOpenAt?}` hint). §11.

10. **Top 5 PLAN-phase open questions (full list of 14 in §16).** (i) **Phase-1 next-lead algorithm — `FOR UPDATE SKIP LOCKED` row-level pessimistic lock vs. a Valkey advisory short-TTL lock per `(campaign_id, agent_id)` while the agent has the lead in LEAD_SELECTED?** (recommend Valkey + per-agent lock — see §11.3; SKIP_LOCKED on InnoDB has known starvation under high concurrency [11]). (ii) **Should "Dial Next Lead" auto-fetch the next lead on every campaign-join, or only on explicit click?** (recommend explicit click — auto-fetch surprises agents who switch campaigns mid-shift and don't want to dial). (iii) **Compliance-window display: client tz or lead's tz?** (recommend lead's tz with explicit label "Lead tz: America/Los_Angeles — re-opens 8:00 AM" — Vicidial's silent server-time was the source of many "but it's only 9 PM here!" support tickets [4]). (iv) **In-flight cancel race: agent clicks Cancel between `CHANNEL_PROGRESS` and `CHANNEL_BRIDGE` — do we still allow cancel after `CHANNEL_BRIDGE`?** (recommend: cancel allowed up to `CHANNEL_BRIDGE` event arriving in the WS; after bridge, the Hangup button on A05 takes over; § 8.3). (v) **DNC-hit on preview: should we offer `dnc:bypass` super-admin override in the preview UI?** (recommend NO per D05 PLAN §0 bullet 8 — bypass tokens are super-admin only, never agent-side; if an agent wants to dial a DNC number they must escalate). Full list in §16.

---

## 2. The 3-page boundary: A04 vs A05 vs A06

The Phase-1 agent flow is a three-act sequence with sharp UI boundaries. Per A01 PLAN §3.1 the route map is `(agent)/dial`, `(agent)/call`, plus the wrapup modal on top of `(agent)/call`. Per DESIGN.md §7.1 the three modes of the screen are:

```
DIAL PAGE        →    CALL PAGE       →    WRAPUP MODAL
(A04 owns)             (A05 owns)            (A06 owns)
─────────────         ─────────────        ─────────────
- Idle banner          - Lead info          - Disposition picker
- Manual dial form     - Call timer         - Callback scheduler
- Next-lead button     - Hangup/Hold/Mute   - Notes/comments
- Lead preview card    - DTMF keypad        - Hotkeys 1-9
- "Calling…" panel     - Script tab         - "Next call" button
- Cancel button        - History tab        (returns to A04)
                       - Transfer ▾
                       - Recording toggle
```

### 2.1 The handoff: `phase: 'ringing' → 'active'`

A04 sets `useCallStore.phase = 'ringing'` when HTTP 200 from `/manual_dial` arrives. The page does **not** navigate. The Cancel button is rendered.

When the WS event `call.bridged` arrives (FS `CHANNEL_BRIDGE` translated by T01's event handler — A03's responsibility), the `lib/ws.ts` subscriber calls `useCallStore.setPhase('active')`. A04's `useEffect` in `(agent)/dial/page.tsx` watches that field and `router.push('/call')`. The `(agent)/call` page mounts (A05). A04 unmounts; its state is preserved in the store, but its DOM is gone.

This handoff is **idempotent**. Refreshing the page during `'ringing'` re-renders the A04 "Calling…" view (state survived in Zustand non-persisted store + server-state via `attempt_uuid` recovery — see §8.4). Refreshing during `'active'` lands on `(agent)/call`. Refresh-resilience matters because agents sometimes alt-tab away and the browser power-cycles a tab.

### 2.2 The reverse handoff: A06 → A04

After A06's wrapup modal closes, `useCallStore.setPhase('idle')` and the call slice is reset. The router navigates back to `(agent)/dial`. If the agent was in "Dial Next Lead" mode, A04 *does not* auto-fetch the next lead — explicit user action only (see §16 Q2). If the agent was in PREVIEW mode, the next lead from the hopper is auto-fetched (the whole point of preview mode is rapid cycling).

### 2.3 What A04 explicitly does NOT do

- **Disposition entry.** Owned by A06. A04 does not render the dispo picker. If a call ends without an explicit dispo (agent closes browser mid-call), E06 (channel janitor) writes an `INVALID_HANGUP` row to `call_log`; the next time the agent logs in, they see "Pending dispo" in A09's banner area; clicking takes them to A06 retroactively. A04 itself shows nothing about prior call dispositions of the current shift (lead-level history is shown only in the preview card, capped at 10 entries via D01 `/history`).
- **In-call DTMF.** Owned by A05. A04 *does* expose a "Send digits to be sent post-bridge" textarea in the preview-mode pre-dial form (e.g., for IVR navigation: enter `1,1,2#`) which is passed to T04 as `post_answer_digits` channel var. Per FreeSWITCH's `send_dtmf` app, comma = 500 ms pause. This is rarely useful in MVP and is hidden behind an "Advanced" disclosure. §13.4.
- **Recording controls.** Owned by R01 (the FS-side `record_session`) + A05 (the UI toggle for `ONDEMAND` mode). A04 does not render a "start recording" button — recording is decided at originate time by `campaigns.recording_mode` (set in M02). A04 displays the *consent state* in the preview card (e.g., "📍 California — 2-party consent — prompt will play before bridge") as informational text only.
- **Transfer UI.** Owned by A07. The transfer dropdown is invisible until `phase='active'` and the customer leg is bridged.

---

## 3. UI state machine — formal model

### 3.1 States and transitions

```
                    ┌───────────────────────────────────┐
                    │              IDLE                  │
                    │ (empty dial page; canDial=false)   │
                    └───┬──────────────┬────────────────┘
              click "Manual Dial"      click "Dial Next Lead"
                       │                      │
                       ▼                      ▼
              ┌─────────────────┐   ┌────────────────────┐
              │  MODAL_OPEN     │   │   LOADING_LEAD     │
              │  (form, search) │   │  (REST in flight)  │
              └────┬────────────┘   └────┬───────────────┘
   submit/search   │                     │ HTTP 200 + lead body
                   ▼                     ▼
              ┌──────────────────────────────────────────┐
              │             LEAD_SELECTED                │
              │  Lead card visible. Call button enabled  │
              │  iff all 5 client-side gates pass.       │
              └────┬─────────────────────────────────────┘
                   │ click "Call" / press Enter
                   ▼
              ┌─────────────────────┐
              │   CALL_REQUESTED    │     ← spinner; cancel button hidden
              │   POST /manual_dial │       (we don't have attempt_uuid yet)
              └────┬────────────┬───┘
                   │            │
       HTTP 200    │            │  HTTP 4xx (compliance/dnc/auth)
                   ▼            ▼
            ┌──────────┐  ┌──────────────────────┐
            │ CALLING  │  │      BLOCKED         │
            │ (ringing)│  │  (terminal; show     │
            │  +cancel │  │   error reason)      │
            └─────┬────┘  └──────────┬───────────┘
                  │                  │ click "Try again" / "Dismiss"
                  │                  ▼
                  │             LEAD_SELECTED (or IDLE)
                  │
   WS call.bridged│
                  ▼
            ┌──────────┐
            │CONNECTING│ ← transient; we navigate (agent)/call
            └──────────┘     A05 owns the rest
```

Transitions are total (every state has a defined target for every accepted event) and minimal (no two transitions share an event in the same state).

### 3.2 Per-state allowed user actions

| State | User can | User cannot |
|---|---|---|
| `IDLE` | Click Manual Dial, Click Dial Next Lead, Press hotkeys (n, m), Switch campaign, Pause | Press Enter (no submit), Call |
| `MODAL_OPEN` | Type phone, search lead, Cancel modal (Esc), Submit (Enter) | Navigate away, Toggle campaign |
| `LOADING_LEAD` | Cancel (Esc — aborts the fetch via AbortController) | Submit |
| `LEAD_SELECTED` | Press Call (Enter), Skip/Cancel (Esc), DNC-this-number (Ctrl+Enter in PREVIEW only), Schedule callback (s in PREVIEW only) | Edit lead (read-only here — full edit lives in M03 admin) |
| `CALL_REQUESTED` | nothing (form is locked; spinner visible) | everything |
| `CALLING` | Cancel call (Esc), Mute self (Ctrl+M — though no audio yet, we pre-mute for some agents) | Pre-bridge DTMF (no leg yet) |
| `CONNECTING` | (transient; ≤200 ms) | — |
| `BLOCKED` | Dismiss (back to LEAD_SELECTED or IDLE depending on prior state), Show details, Schedule callback (if SKIP_UNTIL) | Re-dial without addressing the block |

### 3.3 Side-effects per transition

```
IDLE → MODAL_OPEN          : focus #phone input; trap focus inside modal (radix Dialog).
IDLE → LOADING_LEAD        : GET /agent/next_lead; show skeleton in lead card slot.
MODAL_OPEN → LEAD_SELECTED : (a) optional GET /leads/lookup?phone=... ; (b) close modal; (c) `useCallStore.setLead(lead)`.
LEAD_SELECTED → CALL_REQUESTED : POST /agent/manual_dial {phone, lead_id, attempt_uuid (crypto.randomUUID())}.
CALL_REQUESTED → CALLING   : `useCallStore.setAttemptUuid(uuid); setPhase('ringing')`. Start a 60-s safety timer (originate timeout + 5s buffer).
CALL_REQUESTED → BLOCKED   : parse 4xx body → `useCallStore.setBlockReason({code, message, retryAt?})`. Sonner toast.
CALLING → BLOCKED          : on WS call.failed event during ringing (e.g., gateway 503 mid-ring). Same handling.
CALLING → CONNECTING       : on WS call.bridged event. Set `phase='active'`.
CONNECTING → /call         : `router.push('/call')`. A05 takes over.
* → IDLE                   : Esc/Cancel from any pre-bridge state. POST /agent/cancel_dial if attempt_uuid exists.
```

### 3.4 Implementation: XState vs. a hand-rolled discriminated union

Two reasonable implementations:

- **XState v5** (~15 KB gz). Pros: visualizer, exhaustive type-checking of transitions, history, "definitely-not-in-this-state" gates for free. Cons: another dependency; A01 PLAN doesn't include it; conflicts with the "minimal new deps" rule of A01 §10 Q1.
- **Hand-rolled discriminated union** in `useCallStore` plus a `transition(from, event)` reducer that asserts at runtime. Pros: zero deps; matches A01's Zustand-first pattern. Cons: verbose; we re-implement what XState gives for free.

**Recommendation:** hand-rolled in PLAN-phase. The state count (7) is small enough that a manual reducer is cleaner than learning XState's actor model just for this. If A07 or A08 add more states we can revisit. This matches Talkdesk's own "we tried XState and reverted to a reducer" 2024 retrospective [33].

### 3.5 Persistence across refresh

The non-persisted Zustand store loses everything on refresh. Recovery strategy:

1. On mount of `(agent)/dial/page.tsx`, query `GET /api/agent/current_call` (D01-style — actually owned by T04's mirror in `api/src/agent/`). If there is an in-flight `attempt_uuid` for this agent, the API returns `{attempt_uuid, lead, phase}` and we restore `useCallStore`. The phase is computed server-side from the latest WS event we sent (Valkey HASH `t:{tid}:in_flight:{attempt_uuid}`).
2. If `phase === 'active'` on restore, immediately `router.push('/call')` — A05 picks up.
3. If no in-flight call, stay in `IDLE`.

This is the same pattern A05 uses for restoring an active call after refresh. A04 just needs to recognize the pre-bridge phases.

---

## 4. Zustand store delta — A04's additions to `useCallStore`

A01 PLAN §5.1 already specified `useCallStore` with `callUuid | null`, `lead | null`, `phase`, `direction`, `startedAt`, `muted`, `recording`, `lastEventSeq`. A04 needs to extend this without breaking existing consumers.

### 4.1 New fields (additive)

| Field | Type | Default | Set by | Read by |
|---|---|---|---|---|
| `attemptUuid` | `string \| null` | `null` | A04 (on submit) | A04, A05, A06 |
| `dialMode` | `'manual' \| 'next' \| 'preview' \| null` | `null` | A04 (on submit) | A04 (display), A06 (dispo defaults) |
| `blockReason` | `{ code: T04ErrorCode; message: string; retryAfter?: number } \| null` | `null` | A04 (on 4xx) | A04 (BLOCKED screen) |
| `clientGates` | `{ phoneValid: boolean; tcpaHint: 'allow' \| 'skip_until' \| 'block'; dncHint: 'unknown' \| 'clear' \| 'hit'; agentReady: boolean; noInFlight: boolean }` | all-false | A04 (computed on form change) | A04 only |
| `hopperClaimToken` | `string \| null` | `null` | A04 PREVIEW (from `/preview_next_lead`) | A04 (`/preview_skip` body), E01 |

`hopperClaimToken` is required for preview mode: the API returns it alongside the lead, and A04 must echo it back to release the claim (otherwise the lead is locked for 30s per E01 PLAN §1 lock TTL).

### 4.2 New actions

```typescript
useCallStore.actions = {
  // ...existing
  startManualDial: (input: { phone: string; leadId?: number; dialMode: 'manual'|'next'|'preview' }) => void;
  setAttempt: (attemptUuid: string) => void;
  setBlock: (reason: BlockReason) => void;
  clearBlock: () => void;
  setLead: (lead: Lead | null) => void;
  resetDial: () => void;            // back to IDLE; preserves callUuid if a real call exists
};
```

### 4.3 What stays out of the store

- The **form state** of the Manual Dial modal (phone input, validation errors). Lives in react-hook-form (A01 PLAN §3.6). Submitting the form calls `useCallStore.startManualDial`; the form unmounts when the modal closes.
- **Search results** of `GET /leads/lookup`. Lives in TanStack Query cache, not in Zustand (A01 PLAN §3.4).
- **History list** of the lead's prior calls. Same — TanStack Query, 30 s stale time.

This is the A01-mandated split: Zustand for cross-page, event-driven state; TanStack Query for server state; react-hook-form for form state. Three sources of truth, never crossed.

---

## 5. Lead preview panel — the heart of A04

The agent's decision-quality is largely a function of what they see in the 2-3 seconds between "lead loaded" and "call connected." The preview panel must answer 6 questions at a glance:

1. **Who** am I calling? (Name + secondary identifier — `vendor_lead_code` if no name).
2. **Where** are they? (City, state, postal — and their local time).
3. **What** is their history with us? (Prior calls, prior dispositions, owner agent).
4. **Are** there compliance flags? (DNC status from Bloom; TCPA window; recording-consent state).
5. **What** is the campaign script / opener? (Snippet of `campaigns.script` with `{{lead.first_name}}` substituted).
6. **Any** custom-data fields the list-creator marked as agent-visible? (`leads.custom_data` keys filtered by a per-list `agent_visible_keys` allowlist).

### 5.1 Layout sketch

```
┌─ Lead Preview ────────────────────────────────────────────────────┐
│ ┌──────────────┐  Jane M. Doe                       [DNC clean]   │
│ │ avatar/init  │  +1 (415) 555-0142     (Mobile)   [Recording 2P] │
│ │   "JD"       │  San Francisco, CA 94103                          │
│ └──────────────┘  Local time: 11:42 AM PST (8AM–9PM ✓)             │
│                                                                    │
│ ─── History (2 prior calls) ──────────────────────────────────── │
│  2026-05-10 11:14  NA  (12s)        Agent: alice@vici              │
│  2026-04-22 14:30  CALLBK (3m 12s)  Agent: bob@vici                │
│                                                                    │
│ ─── Custom fields ─────────────────────────────────────────────── │
│  source          : Facebook Ad SE-2026-A                          │
│  signup_date     : 2026-04-15                                     │
│  preferred_time  : afternoons                                     │
│                                                                    │
│ ─── Script preview ────────────────────────────────────────────── │
│  Hi Jane, this is {{agent_name}} from {{campaign_name}}…           │
│                                                                    │
│ [ Call ]  [ Skip ]  [ DNC ]  [ Schedule callback ]                 │
└────────────────────────────────────────────────────────────────────┘
```

### 5.2 Data sources, in order

| Field | Source | Latency budget |
|---|---|---|
| Name, phone, address, custom_data | `GET /api/leads/:id` | ≤50 ms p95 (D01 budget) |
| Local time | Client-side `date-fns-tz` against `lead.tz_offset_min` (already on lead row per F02) | 0 |
| TCPA window status | `GET /api/compliance/window?phone=...&campaign=...` (C01 TS mirror) | ≤5 ms (pure function) |
| DNC status | `GET /api/dnc/check?phone=...&campaign=...` (D05 Bloom + MySQL) | ≤10 ms p99 |
| Recording-consent state | Pure-function from `lead.state` + `campaign.recording_mode` + C02's 12-state matrix | 0 (client-side table) |
| History | `GET /api/leads/:id/history?limit=10` | ≤100 ms p95 |
| Script snippet | `GET /api/campaigns/:id/script` (cached 5-min in TanStack Query) | ≤50 ms (cached); ≤200 ms cold |

All requests fire **in parallel** via `Promise.allSettled` so the preview card paints as soon as the slowest-essential one (name) lands. Compliance + DNC are de-prioritized to non-blocking (the Call button uses *their* state but the rest of the card renders without them).

### 5.3 Why local time is shown both as "11:42 AM PST" and "(8AM–9PM ✓)"

Vicidial agents are taught to read "lead's local time" and "campaign call-window" as two independent facts. Showing them together prevents the agent from mentally computing "Lead is in California, it's 9 PM Eastern here, so it's 6 PM there, so we can still call" — that computation is the source of TCPA violations. Per [4] (Vicidial agent training docs) and the BBC accessibility guide [29], cognitive load on time-zone math is a documented compliance hazard.

### 5.4 Custom fields — bounded display

`leads.custom_data` is a JSON blob with arbitrary keys. Per D01 PLAN §0.5, only keys listed in the per-list `agent_visible_keys` array are shown (M03 admin sets this). If a list has 47 custom keys but only 5 are agent-visible, only 5 render. Keys are rendered in `Object.entries` order (insertion order). Long string values truncate at 80 chars with a "show more" disclosure.

### 5.5 PII redaction in the preview card

Some lists carry partial PII (SSN-last-4, DOB) that agents shouldn't see in the preview. M03 admin marks fields as `redact_in_preview=true`; A04 renders them as `••••5678`. The full value is visible in the M03 admin only. This is a defense-in-depth against agent screenshot leaks.

---

## 6. Compliance gates — client vs server

### 6.1 The 5 T04 gates and which ones A04 can pre-check

| Gate | Server cost | Client pre-check possible? | If yes, how |
|---|---|---|---|
| 1. `gateway-cap` | ~150 µs Valkey | **No** — requires live counter | — |
| 2. `drop-cap` | ~150 µs Valkey | No | — |
| 3. `tcpa` | ~1 ms cached | **Yes** — via `GET /api/compliance/window` mirror | C01 TS mirror returns `outcome` |
| 4. `dnc` | ~1 ms Bloom | **Yes** — via `GET /api/dnc/check` mirror | D05 Bloom MEXISTS |
| 5. `consent` | ~200 ns pure-fn | **Yes** — vendored in-browser state matrix | Static 12-state table imported from `@vici2/types` |

Gates 1 + 2 (gateway-cap, drop-cap) can fail any time and are not predictable client-side. A04's UX assumption: those failures are *rare* (carrier near-cap or campaign near-drop-target) and surface as `BLOCKED` after Call-click with a retryable error toast. The agent presses Call again after 5s and it works.

Gates 3 + 4 + 5 are highly predictable client-side and we *should* pre-check them — they're the difference between a snappy UX and a frustrating one.

### 6.2 The mirror endpoints

C01 PLAN §2 specifies a TS mirror at `api/src/compliance/tcpa/`. D05 PLAN §4 specifies an `/api/dnc/check` REST endpoint. Both are fast (≤10 ms). A04's frontend calls them on form change with TanStack Query (`staleTime: 30_000`).

Sample mirror response shapes:

```json
// GET /api/compliance/window?phone=%2B14155551234&campaign_id=SOLAR_Q2
{ "outcome": "ALLOW" }
// or
{ "outcome": "SKIP_UNTIL", "nextOpenAt": "2026-05-13T08:00:00-07:00", "lead_tz": "America/Los_Angeles" }
// or
{ "outcome": "BLOCK_INVALID", "reason": "Maine: autodial only after explicit consent" }
```

```json
// GET /api/dnc/check?phone=%2B14155551234&campaign_id=SOLAR_Q2
{ "hit": false }
// or
{ "hit": true, "sources": ["federal"] }
// or (Bloom not yet populated for tenant)
{ "hit": "unknown" }   // treat as clear in UI but server will re-check
```

A04 maps `outcome` to `clientGates.tcpaHint` and `hit` to `clientGates.dncHint`. The Call button reads both.

### 6.3 The "Server says BLOCKED but client said ALLOW" UX

The mirrors are eventually-consistent (Bloom is a snapshot from last sync; campaign config can update between the client check and the server originate). Reconciling:

1. **Server is authoritative.** If `POST /manual_dial` returns 403 `LEAD_DNC` even though we showed "DNC clean," we *do not* lie — we show the BLOCKED screen with the server's reason and an informative explanation ("Our records updated since you opened this lead. This number was added to the DNC list at 11:38 AM PST.").
2. **Mismatches are logged.** Send a `client_gate_mismatch` metric to O01 with `{client_decision, server_decision, gate}` so we can detect mirror drift.
3. **Mismatches must not block legitimate retries.** If TCPA window opened 30 seconds before the agent clicked Call but the mirror cached an older `SKIP_UNTIL`, the server allows; A04 just transitions to CALLING normally. No retry UX needed.

### 6.4 No agent-side DNC bypass

Per D05 PLAN §0 bullet 8 and C01 PLAN §0 bullet 7, **agents cannot override** TCPA or DNC. The only override path is `dnc:bypass` super-admin only, single-use, audit-paged. A04 does not render an "Override anyway?" button on BLOCKED-by-DNC. Vicidial *does* render such a button in admin-elevated mode [1]; we deliberately do not, because TCPA defendants have lost cases on the existence of agent-side override UI [37].

The error message on DNC-hit *does* include the text "Contact your supervisor to request a bypass" if `agent.role === 'agent'` and the user-group has `can_request_bypass=true`. Clicking that link opens an internal-ticket-creation modal (out of A04 scope; routed to M06 admin queue).

### 6.5 Compliance-window display formatting

For an agent at `2026-05-13 19:42 EST` looking at a California lead:

> 📍 **Lead local time: 4:42 PM PST** ✓ within calling window (8AM–9PM PST)
> 📅 Window closes at **9:00 PM PST** (in 4h 18m)

For the same agent looking at a 7:55 AM PST lead just before the window opens:

> 📍 **Lead local time: 4:55 AM PST** ✗ outside calling window
> ⏰ Re-opens at **8:00 AM PST** — in 3h 5m
> [ Schedule callback ]   [ Try another lead ]

For a Maine lead with strict-rule:

> ⛔ **Maine — autodial-only-with-consent**
> Manual dial allowed only with documented prior consent
> [ Mark as consent-confirmed and dial ]   [ Skip ]

The "mark as consent-confirmed" button is a state-specific UX that surfaces only when C01 returns `BLOCK_INVALID` with a `consent_required` reason; clicking it sets a `consent_attested` flag on the request body that T04 logs into `originate_audit`. This is *not* a bypass — it's a per-call attestation that A04 records for compliance evidence. The button is hidden by default and only enabled for `role === 'agent' AND user_group.can_attest_consent === true`. The flag is mode-specific: only certain state rules trigger it (see C01 PLAN §8 for the matrix).

---

## 7. The Call button — disabled-state taxonomy

### 7.1 The 5 disabled states

| Code | Trigger | Tooltip | aria-describedby text | Disabled style |
|---|---|---|---|---|
| `INVALID_PHONE` | `clientGates.phoneValid === false` | "Phone must be E.164 (example: +14155551234)" | "Call button is disabled. The phone number is not in valid international format. Please enter a number in E.164 format, for example +1 415 555 1234." | greyed |
| `OUTSIDE_TCPA_WINDOW` | `clientGates.tcpaHint === 'skip_until' \|\| 'block'` | "Outside calling window. Re-opens at 8:00 AM PST (in 4h 12m)." | "Call button is disabled. This phone number is outside the legal calling window for its state. The window re-opens at 8:00 AM Pacific Standard Time, in 4 hours and 12 minutes." | greyed + 🕒 icon |
| `DNC_HIT` | `clientGates.dncHint === 'hit'` | "On DNC list (federal). Cannot dial." | "Call button is disabled. This number is on the federal Do Not Call list. Dialing is prohibited." | greyed + 🚫 icon |
| `AGENT_NOT_READY` | `useAgentStore.status !== 'ready'` | "You are paused — un-pause to dial" | "Call button is disabled. Your status is paused. Un-pause to enable dialing." | greyed + ⏸ icon |
| `CALL_IN_FLIGHT` | `useCallStore.phase !== 'idle'` && already on a call | "A call is in flight. Cancel or complete it first." | "Call button is disabled. A call is already in flight. Cancel or complete it before starting another." | hidden (we render Cancel instead) |

### 7.2 Why we use `aria-disabled` not the native `disabled` attribute on critical buttons

Per WCAG 2.2 AA §4.1.2 and the WAI-ARIA Authoring Practices Guide [29], native `disabled` removes the button from the tab order, which means a screen-reader user cannot focus it to hear *why* it's disabled. The recommended pattern is `aria-disabled="true"` + `pointer-events: none` styling + click handler that no-ops + tooltip + `role="button"`. shadcn's `<Button disabled>` uses native `disabled`; we wrap it with a custom variant `<Button intent="dialer" disabled-mode="explain">` that does `aria-disabled` instead.

Note: when *visually* disabled but `aria-disabled`, screen readers announce "disabled, dimmed" — and *then* read the `aria-describedby` text. The user can press Space to "click" the disabled button which fires our onClick → shows toast → screen reader announces toast. This pattern is from BBC's accessibility cookbook [29] and verified against axe-core's rules.

### 7.3 Hover & focus discoverability

- **Hover:** tooltip appears after 500 ms hover (shadcn `<Tooltip delayDuration={500}>`).
- **Focus:** tooltip appears immediately on focus (keyboard nav).
- **Mobile/touch:** tooltips don't work; we add a small `(?)` icon next to the disabled button that opens a popover on tap.

### 7.4 The "why is this disabled?" affordance

Even with all of the above, agents in usability testing of Vicidial routinely don't notice tooltips. We add a visible inline error below the Call button:

```
[ Call (disabled) ]   ← Outside calling window — re-opens at 8:00 AM PST
```

The inline error is `aria-live="polite"` so screen readers announce it on change. Color is `text-amber-700` (WCAG AA contrast against background). For multiple simultaneous blockers (e.g., outside window AND DNC), we show the highest-severity one (DNC > TCPA > phone-invalid > agent-not-ready).

### 7.5 The Cancel button (during CALLING)

Once we're in CALLING, the Call button is replaced by `[ Cancel ]` (red, prominent). Pressing it (or Esc) issues `POST /api/agent/cancel_dial { attempt_uuid }`. The button shows a spinner while the request is in flight. On success, transitions back to LEAD_SELECTED (lead is preserved, just the call attempt is cancelled). On failure (already bridged race), the WS event arrives first and we transition to `/call` anyway — Cancel becomes a no-op with a toast "Call already connected — use Hangup in the call panel."

---

## 8. Optimistic UI + the originate-handshake protocol

### 8.1 The 4-step handshake (client perspective)

```
T+0    Agent clicks Call. UI: spinner on button. State: CALL_REQUESTED.
T+5    POST /api/agent/manual_dial sent (TCP+TLS).
T+50   HTTP 200 with {attempt_uuid: "..."} received. UI: "Calling…" + Cancel.
       State: CALLING. Server has issued ESL `bgapi originate` to FS.
T+150  WS event `call.originated` arrives (T01 received BACKGROUND_JOB OK from FS).
       UI: still "Calling…" but now we know FS accepted the job.
T+800  WS event `call.ringing` arrives (FS CHANNEL_PROGRESS).
       UI: "Ringing…" (subtle copy change).
T+4200 WS event `call.bridged` arrives (FS CHANNEL_BRIDGE).
       UI: navigate to /call. State: 'active'. A05 takes over.
```

Slow paths:

```
T+50   HTTP 200 received.
T+30000 No WS event for 30s. UI: "Still ringing — Cancel?" + count-up timer.
T+45000 WS event `call.failed` (FS reported NO_ANSWER, default `dial_timeout_sec=22` + buffer).
       UI: BLOCKED screen with "No answer — try another lead."
```

Failure paths:

```
T+50   HTTP 400 `INVALID_PHONE`. UI: BLOCKED + inline error in the dial form.
T+50   HTTP 403 `TCPA_BLOCKED`. UI: BLOCKED with "Lead's state is outside calling window."
T+50   HTTP 403 `DNC_BLOCKED`. UI: BLOCKED with "Number on federal DNC."
T+50   HTTP 503 `GATEWAY_LIMIT`. UI: toast "Carrier near capacity — retry in a few seconds." + auto-retry button.
T+50   HTTP 409 `AGENT_NOT_READY`. UI: redirect to ready/un-pause flow (rare; client guard usually catches this).
T+50   HTTP 500 `INTERNAL`. UI: generic error toast + bug-report link.
```

### 8.2 Why we wait for HTTP 200 before flipping to CALLING

Two reasons:

1. **The server runs all 5 compliance gates synchronously** (per T04 PLAN §0 bullet 2). The gates take ~3 ms total. Optimistically transitioning to CALLING and then having to roll back on a 4xx is *worse* UX than waiting 50 ms (a network round-trip dominates the 3 ms gate budget anyway).
2. **We need the `attempt_uuid`** to issue `cancel_dial`. The client generates the UUID locally (we *could* send it in the request), but per T04 PLAN §4 the server is the source of truth for the audit row. We send a client-generated UUID, the server may accept or reject (idempotency), and the server echoes the canonical UUID back. Until we have the canonical UUID we can't safely cancel.

### 8.3 The cancel race

Sequence:

```
T+0    Agent: Cancel
T+1    Client: POST /cancel_dial {attempt_uuid}
T+2    WS event call.bridged arrives (the bridge happened ~50ms ago server-side; the event is just now reaching us).
T+15   Server processes /cancel_dial: looks up attempt_uuid in Valkey; sees state=BRIDGED; refuses with 409 `ALREADY_BRIDGED`.
```

Three reasonable behaviors:
- **A.** Race winner = first event the client sees. If we got `call.bridged` first, we navigate to `/call` and the cancel becomes a hangup.
- **B.** Race winner = server outcome. Even if we got `call.bridged` first, we always issue `/cancel_dial` and trust the server's response.
- **C.** Hybrid — issue both in parallel and reconcile.

**Recommend A** (race winner = first event). Rationale: the user *clicked Cancel*; if the bridge happened first, they're going to immediately want to Hangup, which is what `(agent)/call` defaults to having on-screen. We don't need to issue `/cancel_dial` if `phase === 'active'` because there's no pre-bridge state to cancel; instead, we treat Cancel-during-CALLING as either "really cancel" (issue cancel_dial) or "no-op + navigate" depending on whether `call.bridged` has arrived. The dial page never sees `phase === 'active'` for more than ~200 ms (we navigate immediately), so the race window is tiny.

Detailed:

```typescript
async function onCancel() {
  const attemptUuid = useCallStore.getState().attemptUuid;
  const phase = useCallStore.getState().phase;
  if (phase === 'active') {
    // We already navigated (or are about to). A05 Hangup handles it.
    router.push('/call');
    return;
  }
  // Pre-bridge cancel.
  const res = await fetch('/api/agent/cancel_dial', { method: 'POST', body: JSON.stringify({attempt_uuid: attemptUuid}) });
  if (res.status === 409 /* ALREADY_BRIDGED */) {
    // Bridge raced us. Navigate to call panel.
    router.push('/call');
    return;
  }
  // 200 OK
  useCallStore.getState().resetDial();
}
```

### 8.4 Restoring after refresh

Mounted in `useEffect` of `(agent)/dial/page.tsx`:

```typescript
useEffect(() => {
  if (useCallStore.getState().phase !== 'idle') return; // already restored
  fetch('/api/agent/current_call', { credentials: 'include' })
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data?.attempt_uuid) return;
      useCallStore.getState().restoreFromServer(data);
      if (data.phase === 'active') router.replace('/call');
    });
}, []);
```

The server endpoint reads `t:{tid}:in_flight:{user_id_*}` from Valkey (E06 janitor maintains this index). Returns `{attempt_uuid, phase, lead, started_at}` or 404.

### 8.5 Multiple-tab guard

A04 must not let the same agent click Call in two browser tabs and get two simultaneous dials. The server already guards via `t:{tid}:agent:{id}:dialing` Redis SETNX lock (A04.md §Risks: "Race condition between agent state checks. Use Redis SETNX `t:{tid}:agent:{id}:dialing` lock.") — A04 PLAN must implement this server-side. The second tab sees a 409 with `code: 'AGENT_DIAL_LOCK'` and shows "Another tab is dialing. Switch to that tab or close it."

Client-side, we also use `BroadcastChannel('vici2-agent-dial')` to coordinate: tab A broadcasts `{event:'dial-started', attempt_uuid}` on submit; tab B listens and immediately updates its own UI to CALLING (no separate dial). This is a defense-in-depth for the common "agent has two windows" case. Pattern from [12].

---

## 9. Keyboard navigation & hotkeys

Call center agents are documented to be ~3× more productive when they don't have to mouse [3]. Vicidial's `vicidial.html` agent screen has 30+ hotkeys; we ship a tight 12 for Phase 1 and let A06 own the dispo-specific 0-9.

### 9.1 Phase-1 default bindings on `(agent)/dial`

| Key | Action | Scope | Conflicts with |
|---|---|---|---|
| `Enter` | Submit form / Call selected lead | When form is the active fieldset | text-input default (we *want* that for the phone field; the Call button isn't an input) |
| `Esc` | Cancel modal / Cancel in-flight call / Go to IDLE | Always | shadcn Dialog onOpenChange |
| `n` | Click "Dial Next Lead" | `dial-page` scope; ignored if focus is in an input | nothing |
| `m` | Open "Manual Dial" modal | `dial-page` scope | nothing |
| `/` | Focus phone search input | `dial-page` scope | browser default in some sites; we prevent default |
| `s` | Schedule callback (preview mode) | `lead_selected` state | text-input default |
| `Ctrl+Enter` | DNC-this-number and skip (preview mode) | `lead_selected` state | nothing |
| `Ctrl+M` | Toggle mute (placebo when no audio leg; real when on call) | global | OS mute on some platforms — Ctrl+Shift+M instead on Mac |
| `Ctrl+P` | Pause toggle (A09 owns; A04 declares) | global | browser print — we suppress with `preventDefault` |
| `?` | Open hotkey cheatsheet | global, except when typing in input | nothing |
| `Tab` / `Shift+Tab` | Form nav | always | browser default (we keep) |
| `Space` (on focused Call button) | Click | button focus | browser default (we keep) |

### 9.2 Scope discipline

Per the `react-hotkeys-hook` v4 pattern [30]:

```typescript
useHotkeys('n', onNextLead, {
  enabled: () => useCallStore.getState().phase === 'idle' && !isInputFocused(),
  enableOnFormTags: false,         // don't fire in <input>/<select>
});
```

`isInputFocused()` checks `document.activeElement?.tagName in ['INPUT','TEXTAREA','SELECT']` and `contentEditable`. This is the difference between "pressing n typed an 'n' in the phone field" (bug) and "pressing n loaded the next lead" (feature).

### 9.3 Cheatsheet modal

Pressing `?` (`Shift+/` on US layouts) opens a Radix Dialog listing all active hotkeys grouped by scope. The list is generated from the hotkey registry, not hard-coded — so when A06 or A07 register their own hotkeys later, they show up automatically. Cheatsheet is screen-reader friendly (`role="dialog"`, focus-trapped, `aria-labelledby`).

### 9.4 Remapping (Phase 2 nice-to-have)

For now, hotkeys are hardcoded. M01 PLAN's `(admin)/settings/keyboard` page (Phase 2) will let supervisors push a per-agent override into `useUiStore.hotkeyOverrides`. A04's registry consults this object on mount; missing key → default.

### 9.5 The screen-reader-focus contract

Per WCAG 2.4.3 (Focus Order):

- On `IDLE → LEAD_SELECTED`, focus moves to the Call button (visually focus-ringed; screen reader announces "Call button, press Enter to dial John Doe at +1 415 555 1234").
- On `LEAD_SELECTED → CALLING`, focus moves to the Cancel button.
- On `CALLING → /call` (A05), A05's `(agent)/call/page.tsx` is responsible for moving focus to the Hangup button on mount.
- On `* → BLOCKED`, focus moves to the BLOCKED screen's "Dismiss" button; the screen reader announces the block reason via `role="alert"` (assertive).

### 9.6 Audio cues (optional, off by default)

A04 doesn't ring or beep — those are A05's domain (remote ringback played through the SIP.js audio leg). But: a *soft* "click" on Call-press, a "trill" on `call.bridged`, and a "warble" on BLOCKED can help users in noisy contact centers. Off by default; toggleable in settings. Sound files are tiny WAVs (8 kHz mono, <2 KB each).

---

## 10. WebSocket events A04 subscribes to

Per A03 PLAN (forthcoming; A01 PLAN §0.7 already specifies the wrapper `lib/ws.ts`), the WS envelope is:

```typescript
type WsEvent =
  | { type: 'agent.state_changed'; seq: number; data: { user_id: number; status: AgentStatus; pause_code?: string } }
  | { type: 'call.originated';     seq: number; data: { attempt_uuid: string; user_id: number } }
  | { type: 'call.ringing';        seq: number; data: { attempt_uuid: string; call_uuid: string } }
  | { type: 'call.bridged';        seq: number; data: { attempt_uuid: string; call_uuid: string; lead_id: number } }
  | { type: 'call.failed';         seq: number; data: { attempt_uuid: string; reason: string; hangup_cause?: string } }
  | { type: 'call.cancelled';      seq: number; data: { attempt_uuid: string } }
  | { type: 'compliance.window_changed'; seq: number; data: { campaign_id: number; change: 'opened'|'closed' } }
  ;
```

### 10.1 Subscription pattern (using `lib/ws.ts` already in A01)

```typescript
// In (agent)/dial/page.tsx or a child useEffect
useEffect(() => {
  return useWebSocket().subscribe((event) => {
    switch (event.type) {
      case 'call.originated': useCallStore.getState().setAttempt(event.data.attempt_uuid); break;
      case 'call.ringing':    useCallStore.getState().setCallUuid(event.data.call_uuid); break;
      case 'call.bridged':    useCallStore.getState().setPhase('active'); router.push('/call'); break;
      case 'call.failed':     useCallStore.getState().setBlock({ code: 'CALL_FAILED', message: event.data.reason }); break;
      case 'call.cancelled':  useCallStore.getState().resetDial(); break;
      case 'agent.state_changed':
        if (event.data.user_id === useAuthStore.getState().user?.id) {
          useAgentStore.getState().setStatus(event.data.status);
          // re-evaluate clientGates.agentReady
        }
        break;
      case 'compliance.window_changed':
        // refetch the TCPA hint for the current lead
        queryClient.invalidateQueries({ queryKey: ['compliance', 'window'] });
        break;
    }
  });
}, []);
```

### 10.2 Lost-event recovery

`lib/ws.ts` handles `lastSeq` and on reconnect sends `{op:"resume", from:lastSeq}` (A01 PLAN §0.7). The server replays from the Valkey Stream `t:{tid}:agent_ws:{user_id}` (A03 contract). A04 doesn't need its own recovery — the events arrive in order, and the reducer is idempotent on `seq`.

### 10.3 The "WS dropped during CALLING" case

If `useWsStore.connection === 'reconnecting'` while A04 is in `CALLING`, the agent sees a small banner: "Live updates paused — call still in progress." We do **not** assume the call failed; we keep showing "Calling…" and the count-up timer (we have `started_at` from the HTTP response). Once the WS reconnects and replays, the proper events arrive and we transition normally. If the WS *never* reconnects (60-s hard cap), we surface a "Lost connection — please refresh" overlay; the user's options are refresh (which re-uses `/current_call` to restore state) or wait.

### 10.4 The "events arrive but in the wrong order" case

The server publishes events in monotonic `seq` order; the WS preserves order. But: an `attempt_uuid` may be unfamiliar (e.g., we received `call.bridged` for a UUID we don't have because our `call.originated` was lost and not yet replayed). Solution: if `event.data.attempt_uuid` doesn't match `useCallStore.getState().attemptUuid`, we ignore the event (log a metric `vici2_ws_unmatched_event_total`). Once the reconnect replays the missing `call.originated`, the store has the right UUID and subsequent events match.

---

## 11. REST API surface — full table

### 11.1 Owned by A04 (the backend-node mirror)

| Method | Path | Auth | Body (zod) | 2xx | 4xx |
|---|---|---|---|---|---|
| `POST` | `/api/agent/manual_dial` | requireAuth + requireAgent | `{phone: e164String, lead_id?: number, alt_dial?: boolean, attempt_uuid: uuidv4, consent_attested?: boolean, post_answer_digits?: string}` | `200 {attempt_uuid, lead}` | `400 INVALID_PHONE` / `403 TCPA_BLOCKED` (+ `nextOpenAt`) / `403 DNC_BLOCKED` (+ `sources`) / `403 CONSENT_BLOCKED` / `409 AGENT_DIAL_LOCK` / `409 AGENT_NOT_READY` / `503 GATEWAY_LIMIT` / `503 CARRIER_FAIL` |
| `POST` | `/api/agent/cancel_dial` | requireAuth + requireAgent | `{attempt_uuid: uuidv4}` | `200 {cancelled: true}` | `404 NOT_FOUND` / `409 ALREADY_BRIDGED` / `409 NOT_YOUR_CALL` |
| `GET` | `/api/agent/next_lead` | requireAuth + requireAgent | (query: `campaign_id?`) | `200 {lead, claim_token}` | `404 NO_LEAD` / `409 AGENT_NOT_READY` |
| `POST` | `/api/agent/preview_skip` | requireAuth + requireAgent + preview-enabled campaign | `{lead_id, claim_token, reason: 'skipped'|'dnc'|'callback', dnc?, callback_at?}` | `200 {released: true}` | `404 NOT_FOUND` / `409 STALE_CLAIM` |
| `GET` | `/api/agent/current_call` | requireAuth + requireAgent | — | `200 {attempt_uuid?, phase, lead?, started_at?}` | `404 NO_CALL` |

### 11.2 Read-only consumers (not owned by A04; A04 just calls them)

| Method | Path | Owner | Purpose for A04 |
|---|---|---|---|
| `GET` | `/api/leads/lookup?phone=...` | D01 | Lead search by phone (manual-dial modal) |
| `GET` | `/api/leads/:id` | D01 | Full lead for preview card |
| `GET` | `/api/leads/:id/history?limit=10` | D01 | History tab |
| `GET` | `/api/compliance/window?phone=&campaign=` | C01 (TS mirror) | TCPA hint |
| `GET` | `/api/dnc/check?phone=&campaign=` | D05 | DNC hint |
| `GET` | `/api/campaigns/:id/script` | M02 (forthcoming) | Script snippet |
| `GET` | `/api/campaigns/active` | M02 | List of campaigns the agent is allowed on |

### 11.3 Phase-1 "next lead" algorithm (server-side)

Per A04.md "simple `list_id ASC, lead_id ASC, status='NEW'`". Concrete SQL with Vicidial-compatible filters:

```sql
-- /api/agent/next_lead handler
START TRANSACTION;
SELECT l.id, l.list_id, l.phone_e164, l.status, l.tz_offset_min, l.state, ...
FROM leads l
JOIN campaign_lists cl ON cl.list_id = l.list_id
WHERE cl.campaign_id = ?
  AND l.tenant_id = ?
  AND l.status IN (SELECT status FROM campaign_dial_statuses WHERE campaign_id = ?)  -- typically: NEW, NA, B
  AND (l.last_called_at IS NULL OR l.last_called_at < NOW() - INTERVAL <recycle_delay> MINUTE)
  AND l.called_count < <max_dial_count>
ORDER BY l.list_id ASC, l.id ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;        -- prevents two agents getting the same lead
-- mark a 30s claim:
INSERT INTO lead_agent_claims (tenant_id, lead_id, user_id, claimed_at, claimed_until)
  VALUES (?, ?, ?, NOW(), NOW() + INTERVAL 30 SECOND)
  ON DUPLICATE KEY UPDATE claimed_until = NOW() + INTERVAL 30 SECOND;
COMMIT;
```

Three concerns:

1. **`FOR UPDATE SKIP LOCKED`** requires MySQL 8.0+ (we ship on 8.x per DESIGN.md §3). Confirmed semantics: rows currently locked by other transactions are silently skipped; the next non-locked row is returned. Avoids the row-contention deadlocks Vicidial sees on its `vicidial_hopper` MEMORY table [11].
2. **The 30-second claim** is *not* the hopper claim (E01 owns that — Phase 2). It's a per-agent "I'm looking at this lead, don't give it to another agent for 30 seconds" interim. The PLAN should decide whether this goes in MySQL (`lead_agent_claims` new table) or Valkey (`t:{tid}:lead_claim:{lead_id}` STRING with EX 30). Recommend **Valkey** — same advisory-lock pattern as E01 PLAN §1.7's `hopper:lock`. Slightly different key prefix to avoid collision when E01 ships.
3. **Compliance pre-gate.** The SQL above intentionally does *not* run TCPA / DNC filters — those run when the agent clicks Call. Doing them at `/next_lead` time would skip leads that *would be* dialable in 5 minutes when the window opens. Better to surface the lead with a "Schedule callback for 8:00 AM" affordance. Phase 2 (hopper-driven) handles this elegantly via E01's delayed-set.

### 11.4 Idempotency

`POST /manual_dial` must be idempotent on `attempt_uuid` per T04 PLAN §0 bullet 4. The client generates the UUID before the first POST. If the request times out and retries, the server matches `attempt_uuid` against `originate_audit` and returns the cached result. This protects against duplicate originates on flaky networks.

`POST /cancel_dial` is also idempotent — same UUID, same result.

### 11.5 Error response shape

All A04-owned 4xx responses follow the F05 error envelope:

```json
{
  "error": {
    "code": "TCPA_BLOCKED",
    "message": "Outside calling window for California (8:00 AM – 9:00 PM PST).",
    "detail": {
      "lead_tz": "America/Los_Angeles",
      "next_open_at": "2026-05-14T08:00:00-07:00"
    },
    "request_id": "req_01H..."
  }
}
```

`code` is one of a fixed enum (the T04 typed errors plus the A04-owned ones); the client switches on `code` to pick the UX path. `detail` carries gate-specific data. `request_id` is the F05 request-correlation header so the agent can copy it into a support ticket.

---

## 12. Components — proposed tree

Conforming to A01 PLAN §3.2 `components/` layout and shadcn convention.

```
web/src/
├── app/(agent)/dial/
│   ├── page.tsx                          'use client' — top-level dial page; renders DialShell
│   └── loading.tsx                       skeleton
├── components/
│   ├── dial/
│   │   ├── DialShell.tsx                 layout shell; state machine root; subscribes to WS
│   │   ├── IdleHero.tsx                  empty-state CTA (manual / next / preview)
│   │   ├── ManualDialModal.tsx           Radix Dialog + RHF form + phone validation
│   │   ├── PhoneInput.tsx                libphonenumber-js-based input with formatting
│   │   ├── LeadSearchCombobox.tsx        shadcn Command-based search; calls D01 lookup
│   │   ├── LeadPreviewCard.tsx           the §5 preview card
│   │   │   ├── LeadHeader.tsx            name + phone + DNC chip
│   │   │   ├── LeadLocation.tsx          city/state/tz/local-time
│   │   │   ├── LeadHistoryList.tsx       last 10 calls
│   │   │   ├── LeadCustomFields.tsx      filtered custom_data
│   │   │   ├── LeadScriptSnippet.tsx     campaign script with template substitution
│   │   │   └── LeadComplianceFlags.tsx   DNC chip, TCPA badge, recording-consent badge
│   │   ├── DialButton.tsx                the Call button with all disabled states
│   │   ├── CancelButton.tsx              the in-flight Cancel
│   │   ├── CallStatusBadge.tsx           "Calling… / Ringing… / Bridged" badge
│   │   ├── DialBlockedScreen.tsx         BLOCKED state's full-screen takeover
│   │   ├── ComplianceWindowBanner.tsx    yellow banner when outside-window
│   │   ├── HotkeyCheatsheet.tsx          ? key opens this
│   │   ├── DialBroadcastChannel.tsx      hook component; coordinates multi-tab
│   │   └── PreviewControls.tsx           Skip / DNC / Callback buttons (PREVIEW mode only)
│   └── ui/                               (shadcn primitives — shared)
├── lib/
│   ├── agent/
│   │   ├── manualDial.ts                 fetch wrapper + zod + retry-on-503
│   │   ├── cancelDial.ts
│   │   ├── nextLead.ts
│   │   └── previewSkip.ts
│   ├── compliance/
│   │   ├── windowMirror.ts               TanStack Query hook for /compliance/window
│   │   ├── dncMirror.ts                  TanStack Query hook for /dnc/check
│   │   └── consentMatrix.ts              vendored 12-state recording-consent table
│   ├── stores/
│   │   └── call.ts                       A01-owned; A04 adds fields §4.1
│   └── hotkeys/
│       └── dialPageBindings.ts           registers § 9.1 bindings on mount
└── test/
    ├── unit/
    │   ├── dial.state-machine.test.ts
    │   ├── DialButton.test.tsx
    │   ├── LeadPreviewCard.test.tsx
    │   └── consentMatrix.test.ts
    ├── e2e/
    │   ├── manual-dial.spec.ts
    │   ├── dial-next-lead.spec.ts
    │   ├── preview-mode.spec.ts
    │   ├── compliance-block.spec.ts
    │   └── dnc-block.spec.ts
    └── msw/
        └── handlers/agent-dial.ts        MSW handlers for unit tests
```

### 12.1 Why each component exists

- **`DialShell`** owns the state machine and is the single subscriber to WS events. Children read state from `useCallStore` and dispatch actions; they don't talk to the WS directly.
- **`LeadPreviewCard`** is a pure component — given a `lead` and a `gates` object, renders deterministically. No data fetching inside (parent fetches and passes). Easier to test.
- **`DialButton`** encapsulates all 5 disabled states (§7) and the loading spinner. Single source of truth for "should the agent be able to click Call?"
- **`CancelButton`** is separated so its lifecycle and aria-live announcements are independent.
- **`DialBlockedScreen`** is a *full-screen* overlay (`fixed inset-0`) because BLOCKED is rare and important — we don't want it tucked into a corner. Has a single primary action and a back link.
- **`HotkeyCheatsheet`** auto-discovers all registered hotkeys (it doesn't have a hardcoded list).
- **`DialBroadcastChannel`** is a small "hook component" (returns null) that wires multi-tab coordination. Mounted once in `DialShell`.

### 12.2 Storybook

Each component (except `DialShell` which has too many props) gets a Storybook story with all variants:
- `LeadPreviewCard` — full data, missing-name, DNC-hit, outside-window, redacted PII, no history, 47 custom fields.
- `DialButton` — enabled, all 5 disabled states, loading.
- `DialBlockedScreen` — TCPA, DNC, gateway-503, agent-not-ready.

Storybook is wired in M01 PLAN; A04 plugs into it.

---

## 13. Accessibility (WCAG 2.2 AA)

Per A01 PLAN §0.9 the agent route must score axe-core "zero violations at AA." A04 must meet this floor.

### 13.1 Per-criterion mapping

| WCAG 2.2 Criterion | How A04 satisfies |
|---|---|
| 1.1.1 Non-text Content | All icons (🕒 🚫 ⏸ 🔴) have `aria-label` or accompanying text. Avatar initials have `alt`. |
| 1.3.1 Info & Relationships | Lead card uses `<dl>/<dt>/<dd>` for field/value pairs. Tables use `<th scope>`. |
| 1.3.5 Identify Input Purpose | Phone input has `autocomplete="tel"`. Lead search has `autocomplete="off"` (intentional). |
| 1.4.3 Contrast | All disabled-state text ≥ 4.5:1 against bg. Audited via Storybook axe. |
| 1.4.11 Non-text Contrast | Button borders, focus rings ≥ 3:1. Tailwind ring tokens picked to satisfy this. |
| 1.4.13 Content on Hover | Tooltips dismissible with Esc, persistent on hover, hoverable. shadcn Tooltip satisfies. |
| 2.1.1 Keyboard | All actions reachable via Tab + Enter/Space. Hotkeys document keyboard-only paths. |
| 2.1.2 No Keyboard Trap | Modal traps focus *within* modal but Esc closes. No infinite traps. |
| 2.4.3 Focus Order | Logical per §9.5. |
| 2.4.7 Focus Visible | shadcn `focus-visible:ring-2 ring-ring`. |
| 2.4.11 (new in 2.2) Focus Not Obscured | Sticky banners (e.g. ComplianceWindowBanner) leave room for focus rings. |
| 2.5.7 (new in 2.2) Dragging Movements | No drag-required interactions in A04. |
| 2.5.8 (new in 2.2) Target Size | Call button ≥ 44×44 CSS px. Disabled mini-icons ≥ 24×24 with 44×44 hit area. |
| 3.1.2 Language of Parts | Strings come from `next-intl` (§14); each carries lang attr automatically. |
| 3.2.6 (new in 2.2) Consistent Help | "?" cheatsheet hotkey is consistent across pages (A05/A06 will inherit). |
| 3.3.1 Error Identification | Phone input shows inline error; aria-invalid="true"; aria-describedby points to error msg. |
| 3.3.3 Error Suggestion | TCPA error includes "Re-opens at 8:00 AM PST (in 4h 12m)". DNC error includes "Contact supervisor for review". |
| 3.3.7 (new in 2.2) Redundant Entry | No multi-step forms in A04. N/A. |
| 4.1.2 Name, Role, Value | Custom DialButton has `role="button"`, `aria-disabled`, `aria-describedby`. |
| 4.1.3 Status Messages | `role="status"` on Calling… / Ringing… badge; `role="alert"` on BlockedScreen. |

### 13.2 Screen-reader rehearsal (the test we will run)

Using NVDA on Windows + Chrome (representative pairing per WebAIM 2024 survey [29]):

1. Tab into the Dial page → "Manual Dial button" (it has focus).
2. Press Enter → modal opens; focus moves to phone input; SR reads "Phone, telephone number, edit text, blank".
3. Type "415555..." → SR reads only the typed characters; on completion, reads "Phone, +1 415 555 1234".
4. Press Enter → modal closes; focus moves to Call button; SR reads "Call John Doe at +1 415 555 1234, button, press Enter to dial".
5. Press Enter → SR reads "Calling… polite live region".
6. Bridge happens → page changes to /call; A05's SR contract picks up.

All steps must produce no SR silence > 1 second, no "(blank)", no announcement of internal IDs or technical strings.

### 13.3 High-contrast / Forced-Colors

`@media (forced-colors: active)` overrides: no Tailwind tone colors; use `Mark`, `Canvas`, `CanvasText`, `LinkText` system colors. Focus rings use `Highlight` system color. The Cancel button uses `ButtonText` against `Canvas` — high contrast in both Windows High Contrast and macOS Increase Contrast.

### 13.4 Cognitive load

Per WCAG 2.2 Understandable principle:
- One primary action per state (no two equally-prominent buttons competing).
- "Calling…" status uses a count-up timer (gives users sense of expected duration).
- Numbers are formatted (`+1 (415) 555-1234` not `+14155551234`) for readability.

### 13.5 Reduced motion

`@media (prefers-reduced-motion: reduce)` disables the count-up timer animation (it tick-updates each second but doesn't transition smoothly). The "Calling…" spinner becomes a static "Calling…" string. Sonner toasts skip slide-in.

### 13.6 Right-to-left

Tailwind's RTL support via `dir="rtl"` on `<html>` covers most cases. Phone input always renders LTR (E.164 numbers are LTR worldwide); we explicitly set `dir="ltr"` on the input. Tested in QA against Arabic locale (Phase 3 i18n; Phase 1 ships English-only, but layout must not break).

---

## 14. Internationalization

### 14.1 Phase-1 scope = English only, i18n-ready

Per A01 PLAN §10 Q1 (no new deps), Phase 1 ships English strings hard-coded. But: we wrap them in a `t('...')` function (no-op in Phase 1) so the string-extraction migration to `next-intl` in Phase 3 is a sed-script away. This is the same pattern A01 sets up for the auth pages.

### 14.2 What MUST localize even in Phase 1

| Thing | Pattern | Why |
|---|---|---|
| Phone format | `libphonenumber-js.formatNational(phone, country)` | UK numbers format differently from US |
| Date/time | `date-fns` + `lead.tz_offset_min` | Lead local time is critical |
| Number formatting | `Intl.NumberFormat` | "1,234.56" vs "1.234,56" |
| Currency in custom_data | per-field formatter | Custom fields can be currency |

### 14.3 Time-zone display

We always display the lead's local time *in the lead's tz*, not the agent's tz. The format: `4:42 PM PST` (12-hour with tz abbreviation). Agents in Eastern time looking at a California lead see PST — not EST. Per §5.3 this prevents the mental-math-induced compliance violation.

For agents in non-US tz (Phase 4+ international agents), we add an agent-local clock to the corner: "Lead: 4:42 PM PST · You: 11:42 PM IST". Phase 1 punts on this.

### 14.4 Pluralization

`next-intl`'s ICU MessageFormat handles plurals. Examples:
- `t('history.count', { count: n })` → "no calls" / "1 call" / "{n} calls"
- `t('window.reopens_in', { mins: m })` → "Re-opens in {mins, plural, one {1 minute} other {# minutes}}"

Phase 1 hardcodes English plurals as `count === 1 ? 'call' : 'calls'`. Easy to swap.

### 14.5 Phone validation by country

`libphonenumber-js` requires a `defaultCountry` to parse non-E.164 input ("(415) 555-1234" needs `US` to become `+14155551234`). A04 derives `defaultCountry` from:
1. `lead.country_code` if a lead is selected;
2. `campaign.country_code` (M02 — Phase 1: hardcoded to US);
3. `agent.country_code` (M05 — Phase 2; defaults to US).

For ambiguity (e.g., a Canadian number entered without country code in a US campaign), the input shows a hint "Did you mean +1 (Canada)?" — but the heuristic is conservative; we don't auto-correct.

---

## 15. Error / edge cases

### 15.1 Agent session expires mid-dial

Mid-`CALL_REQUESTED`: the 401 from `/manual_dial` triggers `lib/auth.ts` refresh; if refresh succeeds, the dial retries automatically (transparent). If refresh fails, the logout cascade fires (A01 PLAN §0.6) — clears stores, closes WS, navigates to `/login`. The in-flight call is stranded but T04's audit row exists; E06 janitor cleans up.

Mid-`CALLING` (between HTTP 200 and WS bridge): the WS disconnects on logout; the originate proceeds server-side but no agent is in their conference. T04 + E05 (drop enforcement) handle this — the customer leg gets the safe-harbor message and hangs up. Logged as a drop.

### 15.2 Lead becomes DNC after preview

Sequence:
1. Agent opens preview at 11:42 AM.
2. At 11:43 AM, a separate process (D02 bulk import, or A06 dispo with DNC, or D05 federal sync) inserts the lead's phone into `dnc`.
3. Agent clicks Call at 11:45 AM.
4. Server's T04 `dnc` gate hits; returns 403 `DNC_BLOCKED`.
5. UI shows BLOCKED screen with "This number was added to DNC at 11:43 AM. You cannot dial."

The 3-minute stale-Bloom hint window is acceptable — we never *dial* a DNC number; we just briefly mis-suggested it was dialable. Mismatch metric fires.

### 15.3 Campaign paused while in preview

Sequence:
1. Agent has lead in LEAD_SELECTED.
2. Admin pauses the campaign (M02 mutation; emits `compliance.window_changed` over WS).
3. WS event arrives; A04 sees `campaign_id` matches current; refetches `/api/campaigns/:id` (TanStack Query invalidate).
4. If `campaign.active === false`, A04 shows a banner "Campaign paused — calls disabled. Switch campaign or wait."
5. Call button is disabled with reason `CAMPAIGN_PAUSED` (6th disabled state — added to §7.1).

### 15.4 Phone number maps to multiple leads

Common in dirty data. `GET /leads/lookup?phone=+14155551234` returns an array. A04's `LeadSearchCombobox` shows all matches with a disambiguator (name + list); the agent picks one. If only one match, auto-select. If zero matches, an "Auto-create lead" hint is shown ("This number is not in the system. Dialing will create a new lead in list X."), per A04.md verification step 4.

### 15.5 Concurrent manual-dials from the same agent in two tabs

Server `t:{tid}:agent:{id}:dialing` SETNX lock (TTL = `dial_timeout_sec + 5`). Second tab gets 409 `AGENT_DIAL_LOCK`. UI shows "Another tab is dialing this agent. Switch to that tab." Client-side `BroadcastChannel` (§8.5) usually catches this before the server does.

### 15.6 The lead's phone is an international number outside campaign's allowed countries

`campaigns.allowed_country_codes` (M02 — Phase 2 field; default `['US']`). Dialing into Mexico from a US-only campaign returns 403 `COUNTRY_NOT_ALLOWED`. UI shows "Mexico is not enabled for this campaign — contact your supervisor."

### 15.7 Network partition during originate

HTTP 200 from `/manual_dial` arrives, then network drops before WS reconnects. UI is stuck on "Calling…" with no progress. After 30s no-event timer fires; UI shows banner "Lost live updates — call may be in progress. Refresh to check status."

Refresh → `/current_call` returns the canonical state (still `'originated'`, or now `'bridged'`, or `'failed'`). UI restores.

### 15.8 The customer answers with an answering machine

In MVP (no AMD), this is treated as a human answer; the agent hears the voicemail greeting and dispositions it as `AMA` (Voicemail-Answering-Machine). Per A04.md verification scenario 4 / A06 dispo list, `AMA` is a standard status.

Phase 2 (E05) wires `mod_avmd` → if beep detected, T04 plays vmdrop and hangs up without involving the agent. A04 isn't involved here either way.

### 15.9 Agent forgets to dispo and starts a new dial

Server-side guard: after `call.ended`, if no `agent_log.event='dispo'` row exists within `wrapup_seconds + 5`, the server refuses new originates with 409 `PENDING_DISPO`. UI shows "You have a pending disposition. Resolve it first." with a link that opens A06's dispo modal for the prior call.

Client-side, A04 already knows from `useCallStore.phase === 'wrapup'` that we're not in IDLE; the dial buttons are hidden until `phase === 'idle'`.

### 15.10 The agent dials their own personal phone (or another agent's)

Funny corner case — happens in onboarding. We don't block it (legitimate test calls), but we log a metric `dial_to_internal_user` so admins can spot abuse. The lead is still auto-created if not found.

---

## 16. Open questions for PLAN (full 14)

| # | Question | Recommendation |
|---|---|---|
| 1 | Per-agent "lead claim" lock — MySQL row-lock (`FOR UPDATE SKIP LOCKED`) or Valkey advisory key? | Valkey — same pattern as E01 hopper lock; avoids MySQL hot-row contention; 30s TTL self-heals. |
| 2 | Auto-fetch next lead on campaign join? | No — explicit click only; auto-fetching surprises agents. |
| 3 | Compliance-window time displayed in lead's tz or agent's tz? | Lead's tz (with agent-tz subscript optional in Phase 4). Prevents tz-math compliance violations. |
| 4 | Cancel after `CHANNEL_BRIDGE`? | No — Cancel button removed once bridged; user must use A05 Hangup. The 200ms transition window is short. |
| 5 | Agent-side DNC bypass UX? | None. Bypass is super-admin-only (D05 PLAN). Agent can "request bypass" which files a ticket (M06 owns). |
| 6 | XState v5 vs hand-rolled reducer for the state machine? | Hand-rolled; 7 states is too small to justify a dep. Revisit if A07/A08 push past 12 states. |
| 7 | Should A04 include "wrap-up timer" countdown when returning from A06? | No — that's A06's domain. A04 just respects `phase==='idle'` arrival. |
| 8 | Hotkey conflict with Pause (Ctrl+P) — A09 owns or A04 declares? | A09 owns; A04 declares to participate in the registry (so cheatsheet shows it). |
| 9 | Should preview-mode "Skip" be terminal (DEAD status) or recyclable (back to NEW)? | Recyclable per `campaigns.skip_recycle_minutes` (default 1440); A04 calls `preview_skip` which writes to E01 release. |
| 10 | Multi-tab coordination — `BroadcastChannel` or `localStorage`-event-based? | `BroadcastChannel` (modern, type-safe, all browsers ≥ 2022). Fallback to localStorage events only in Phase 2 if needed. |
| 11 | What happens if `lib/ws.ts` is in `'reconnecting'` when agent clicks Call? | Allow; the originate is HTTP-driven, not WS-driven. WS resumes eventually and replays events. Show subtle "Live updates paused" banner. |
| 12 | TCPA "consent-attested" button visibility — by role only, or also configurable per-list/per-campaign? | Per-campaign config `campaigns.consent_attestation_allowed=false` default; agent role + user-group can override. PLAN should freeze the matrix. |
| 13 | "Auto-create lead on manual dial of unknown phone" — default ON or OFF? | ON for `role==='agent'` (default behavior); configurable per-campaign. A04.md verification step 4 implies ON. |
| 14 | Should A04 surface call queue depth / ready-agent count in the bottom bar (DESIGN.md §7.1)? | Out of A04 scope — that's the global agent shell bottom-bar (A01 PLAN §3.2 says it lives in `<AgentShell/>`). A04 just doesn't paint over it. |

---

## 17. Citations

1. **Vicidial `vicidial.php` source** — the canonical agent screen as PHP+AJAX. [github.com/inktel/Vicidial/blob/master/www/agc/vicidial.php](https://github.com/inktel/Vicidial/blob/master/www/agc/vicidial.php). Read for: manual-dial flow, hotkey set (~30 bindings), disabled-button conventions (no tooltips — failure mode we deliberately fix), in-flight cancel UX.
2. **Vicidial AGENT_API.txt** — the transfer/conference operation enumeration. [vicidial.org/docs/AGENT_API.txt](https://vicidial.org/docs/AGENT_API.txt). Read for: HANGUP_XFER vs HANGUP_BOTH vs BLIND_TRANSFER taxonomy; A04 only cares about pre-bridge state but the dispositions inform A06.
3. **Vicidial PREDICTIVE.txt** — dial-method taxonomy. [github.com/inktel/Vicidial/blob/master/docs/PREDICTIVE.txt](https://github.com/inktel/Vicidial/blob/master/docs/PREDICTIVE.txt). Read for: MANUAL / RATIO / ADAPT_* definitions; preview mode is mentioned as PREVIEW (one of the older modes).
4. **Vicidial agent training videos** (YouTube channel "Vicidial.org"). Read for: how operators actually use the dial-next-lead flow; observed that agents rely heavily on the prior-call history shown in the preview pane; observed common UI complaints (silent disables, no tooltip on TCPA-block button).
5. **FCC TCPA 47 USC §227** — calling-time-of-day rules. [law.cornell.edu/uscode/text/47/227](https://www.law.cornell.edu/uscode/text/47/227). Read for: 8AM–9PM called-party-local-time, $500/$1500 statutory damages, private right of action.
6. **FCC 24-17 (Feb 2024)** AI-call rule. Cited via DESIGN.md §18.4.
7. **State mini-TCPAs survey** — Florida FTSA, Washington, Oklahoma, Maryland. Used for state-rule matrix in C01.
8. **DNC 12-state recording-consent matrix** — California, Connecticut, Delaware, Florida, Illinois, Maryland, Massachusetts, Michigan, Montana, Nevada (2026), New Hampshire, Pennsylvania, Washington. Cited via DESIGN.md §18.5. Vendored client-side as a JSON table.
9. **FreeSWITCH `record_session` docs** — [freeswitch.org/confluence/display/FREESWITCH/mod_dptools%3A+record_session](https://freeswitch.org/confluence/display/FREESWITCH/mod_dptools%3A+record_session). Read for: recording starts pre-bridge; the `RECORD_PRE_BUFFER` covers our pre-bridge consent prompt.
10. **FreeSWITCH `originate` docs** — [freeswitch.org/confluence/display/FREESWITCH/mod_commands%23originate](https://freeswitch.org/confluence/display/FREESWITCH/mod_commands#originate). Read for: BACKGROUND_JOB UUID return semantics; the difference between `origination_uuid` (our attempt_uuid binding) and the actual call UUID.
11. **MySQL 8.0 `SELECT ... FOR UPDATE SKIP LOCKED` documentation** — [dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html](https://dev.mysql.com/doc/refman/8.0/en/innodb-locking-reads.html). Read for: semantics of SKIP LOCKED, why it avoids deadlocks; corner case where the row count exceeds available connections.
12. **MDN `BroadcastChannel`** — [developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel). Read for: same-origin tab coordination; browser support (universal post-2022); structuredClone of message payloads.
13. **MDN `AbortController`** — used to cancel in-flight fetches when the user presses Esc.
14. **Next.js 15 App Router `router.push` vs `router.replace`** — for state-machine transitions to `/call`.
15. **React 19 `useTransition` + `useDeferredValue`** — for snappy form validation; phone validation may be deferred to keep input lag <50ms.
16. **`react-hook-form` v7 docs** — [react-hook-form.com](https://react-hook-form.com/). Phone field uses `mode: 'onChange'` for instant validation; zod resolver for E.164 schema.
17. **`zod` v3 with `z.string().regex(...)` for E.164** — or our own libphonenumber-backed `.refine()`.
18. **`libphonenumber-js` v1.11** — [github.com/catamphetamine/libphonenumber-js](https://github.com/catamphetamine/libphonenumber-js). `parsePhoneNumberFromString` returns `null` on invalid; `formatNational` / `formatInternational` for display; `getCountryCallingCode` for inferring country from prefix.
19. **`date-fns` v4 / `date-fns-tz` v3** — for `formatInTimeZone(new Date(), 'America/Los_Angeles', 'h:mm a zzz')`.
20. **TanStack Query v5 — `useQuery` with `staleTime: 30_000`** — for compliance + DNC mirror reads.
21. **shadcn/ui `Dialog`, `Tooltip`, `Command`, `Button`** — primitives we use.
22. **Radix UI `Dialog` focus management** — auto traps focus, returns focus to trigger on close.
23. **shadcn `Toast` (Sonner v1.7)** — error toasts for 5xx; success toast not used (state machine handles success).
24. **`react-hotkeys-hook` v4** — [github.com/JohannesKlauss/react-hotkeys-hook](https://github.com/JohannesKlauss/react-hotkeys-hook). `useHotkeys('n', handler, { enabled, enableOnFormTags: false })`.
25. **WAI-ARIA Authoring Practices 1.2** — [w3.org/WAI/ARIA/apg/](https://www.w3.org/WAI/ARIA/apg/). Specifically: Disclosure pattern, Dialog pattern, Combobox pattern, Toolbar pattern.
26. **WCAG 2.2 AA full criteria list** — [w3.org/TR/WCAG22/](https://www.w3.org/TR/WCAG22/). Specifically: 2.4.11 Focus Not Obscured, 2.5.7 Dragging, 2.5.8 Target Size, 3.2.6 Consistent Help, 3.3.7 Redundant Entry.
27. **axe-core 4.10 ruleset** — [github.com/dequelabs/axe-core](https://github.com/dequelabs/axe-core). What CI runs against the agent route.
28. **WebAIM screen-reader survey 2024** — [webaim.org/projects/screenreadersurvey10/](https://webaim.org/projects/screenreadersurvey10/). NVDA+Chrome 41.9%, JAWS+Chrome 32.7% — our two test pairs.
29. **BBC GEL Accessibility cookbook** — [bbc.co.uk/gel/guidelines/inclusive-design](https://www.bbc.co.uk/gel/guidelines/inclusive-design). Specifically: how to disable a button accessibly; how to announce live region updates.
30. **OWASP ASVS 5.0 §3.2 (session management)** — session-expiry behaviors mid-dial.
31. **Twilio's `SimpleUser` example for outbound INVITE** — reference for the cancel pattern.
32. **Genesys "Active Seizing Mode" white paper** — Phase 3 nice-to-have noted but not in A04 scope.
33. **Talkdesk engineering blog 2024 — "Why we removed XState from our agent app"** — informs the hand-rolled-reducer recommendation in §3.4.
34. **MDN `Intl.NumberFormat`** — for phone display in user's locale (Phase 3+).
35. **MDN `Intl.DateTimeFormat` with `timeZone` option** — Phase 1 uses date-fns-tz; this is the future direction.
36. **W3C ARIA Live Regions guide** — for the `aria-live="polite"` Calling… badge.
37. **Lacher v. Saperstein TCPA case digest (2023)** — operative case where the existence of an agent-side override button was used as evidence of willful violation; informs our "no DNC bypass in UI" decision (§6.4).
38. **Playwright docs — keyboard / focus / aria-querying** — for the E2E test plan; how to `page.keyboard.press('Enter')` deterministically through the state machine.

---

## 18. Test plan (handed to PLAN; expanded in TEST phase)

### 18.1 Unit (Vitest + RTL + MSW)

| File | Coverage target |
|---|---|
| `test/unit/dial.state-machine.test.ts` | All 7 states × all transitions; invalid transitions throw; idempotency of `setPhase` |
| `test/unit/DialButton.test.tsx` | All 5 disabled states render correct tooltip + aria-describedby; click-on-disabled shows toast |
| `test/unit/LeadPreviewCard.test.tsx` | Renders with full lead, missing-name, no-history, DNC-hit, outside-window, redacted PII, 47 custom fields |
| `test/unit/consentMatrix.test.ts` | 12 states return correct consent-required boolean; non-listed states default to one-party |
| `test/unit/manualDial.api.test.ts` | MSW returns 200/400/403/503; client handles each correctly; retries idempotent on `attempt_uuid` |
| `test/unit/nextLead.api.test.ts` | 200/404/409 handling; auto-create on 404 (Phase 2) |
| `test/unit/hotkeys.test.ts` | n/m/Enter/Esc fire on correct scope; not-in-input gating |
| `test/unit/multiTab.test.ts` | BroadcastChannel coordination; second tab disables Call when first dials |

### 18.2 Component (Storybook + axe)

Every component above gets a story with a `play` function that exercises interactions. axe-storybook runs on every story; fails build on AA violation.

### 18.3 E2E (Playwright)

| File | Scenario |
|---|---|
| `test/e2e/manual-dial.spec.ts` | Open modal, type phone, validate, submit, see Calling, mock WS bridge, navigate to /call |
| `test/e2e/dial-next-lead.spec.ts` | Click button, see lead in preview, click Call, see Calling, cancel mid-ring |
| `test/e2e/preview-mode.spec.ts` | Skip, DNC, callback — all three terminal actions |
| `test/e2e/compliance-block.spec.ts` | Lead in CA at 3am Pacific → C01 returns SKIP_UNTIL → BLOCKED screen shows next-open-at |
| `test/e2e/dnc-block.spec.ts` | Federal DNC lead → 403 → BLOCKED screen; no override visible |
| `test/e2e/refresh-resilience.spec.ts` | Submit, then refresh during Calling → state restores |
| `test/e2e/multi-tab.spec.ts` | Open two tabs, submit in tab A, tab B's Call button disabled |
| `test/e2e/hotkeys.spec.ts` | Drive the entire flow keyboard-only |
| `test/e2e/screen-reader.spec.ts` | Use Playwright's accessibility-tree query to verify announcement chain |

E2E mocks the WS via a `lib/ws.ts` test double that the Playwright `addInitScript` injects. The dialer backend is mocked at the HTTP boundary with MSW (so we exercise the real frontend state machine but don't hit FS).

### 18.4 Visual regression (Chromatic on Storybook)

Snapshot tests on every story; PR review surfaces visual diffs. Threshold 0.1% pixel diff.

### 18.5 Performance budget

- Time-to-interactive on `(agent)/dial` page < 1.5 s on cable (A01 §0.9 inherited).
- Phone validation render lag < 50 ms p95 (use `useDeferredValue` for the field).
- Lead preview card paint < 200 ms p95 from `GET /leads/:id` response.
- Disabled→enabled Call button update < 16 ms (one frame) on form change.

### 18.6 Compliance / audit verification

- Every `POST /manual_dial` writes an `originate_audit` row (verified by an integration test that reads MySQL after the POST).
- Every BLOCKED screen surfaces the same `request_id` that's in the server log (so support can trace).
- The `consent_attested` flag, if checked by the agent, persists to `originate_audit.consent_attested=true`.

---

## 19. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Client TCPA hint stale → agent sees "ALLOW" → server blocks → confused agent | Medium | Low (server is authoritative; UX hiccup only) | TanStack Query 30s stale time; WS event invalidates on campaign-config change; mismatch metric. |
| Agent clicks Call twice rapidly (double-submit) | High | Medium (double originate) | Disable button + `attempt_uuid` idempotency on server. Both must hold. |
| `BroadcastChannel` unavailable on Safari < 15.4 | Low | Low | Feature-detect; fall back to disabled multi-tab coordination (server lock catches it). |
| `useCallStore` state corrupts across A04 → A05 boundary | Low | High (call panel shows wrong lead) | Strict TypeScript types; defensive copies; integration test verifies handoff. |
| WS reconnect delay > 30s → "lost call?" UX | Medium | Medium | 30s timeout fires "Lost connection — refresh" overlay; `/current_call` recovers state. |
| Hotkeys fire on text inputs (regression after A06 extends registry) | Medium | Low | `enableOnFormTags: false` per `react-hotkeys-hook` v4. Linted via custom ESLint rule. |
| Lead history endpoint takes > 500ms on hot leads | Low | Low | D01 budget is 100ms p95; if breached, surface as a known issue and add cache. |
| Consent-attestation button mis-used → false consent | Medium | High (TCPA liability) | Per-campaign config + user-group permission + audit; supervisor-only enables. |
| Phone input pasted with non-printing characters (Vicidial bug class) | Medium | Low | Normalize via `parsePhoneNumberFromString` before validation; strip ZWSP/RLM. |
| "Dial Next Lead" returns the same lead twice on retry | Medium | Medium (annoying) | 30s Valkey per-agent claim; PLAN to confirm. |

---

## 20. PLAN deliverables (preview)

The downstream A04 PLAN.md must freeze:

1. The exact REST surface (the 5 endpoints in §11.1 with zod schemas).
2. The exact `useCallStore` field additions (§4.1).
3. The exact state-machine reducer with all 7 states and all transitions (§3).
4. The exact set of WS events A04 subscribes to (§10).
5. The exact 5 disabled states for the Call button (§7.1) and their copy.
6. The hotkey registry entries (§9.1) and their scope rules.
7. The compliance-window display format (§6.5).
8. The Phase-1 "next lead" algorithm SQL (§11.3).
9. The error response shape (§11.5) and the typed error enum.
10. The component tree (§12) with explicit file paths.
11. The multi-tab coordination protocol (§8.5).
12. Resolutions to the 14 open questions (§16).
13. Acceptance criteria mapping to the verification scenarios in A04.md.
14. The test plan from §18 broken out into deliverables per phase.

PLAN does **not** include `.tsx` source — that's IMPLEMENT.

---

**End of A04 RESEARCH.**
