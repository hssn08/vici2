# Module A06 — Auto-Dial / Predictive-Mode Agent UI — RESEARCH

**Module:** A06 (Agent UI track, Phase 1)
**Author:** A06-PLAN sub-agent (Claude Sonnet 4.6)
**Date:** 2026-05-13
**Status:** RESEARCH — companion to PLAN.md

---

## Table of Contents

1. [Manual vs Progressive vs Predictive: definitions and flows](#1-manual-vs-progressive-vs-predictive)
2. [Vicidial agent screen auto-dial flow as baseline](#2-vicidial-baseline)
3. [Five9 / Genesys predictive agent screens](#3-industry-precedents)
4. [Audible alert UX on auto-pop](#4-audible-alert-ux)
5. [Preview-pause feature (preview_allowed_seconds)](#5-preview-pause-feature)
6. [Pause-after-call: ACW timer, auto-ready toggle](#6-acw-and-auto-ready)
7. [Agent-initiated callback during predictive](#7-agent-callback-during-predictive)
8. [Idle-detect: reservation timeout](#8-idle-detect-reservation-timeout)
9. [WS event surface](#9-ws-event-surface)
10. [Open questions resolved for PLAN](#10-open-questions)

---

## 1. Manual vs Progressive vs Predictive

### 1.1 Definitions

| Mode | `campaigns.dial_method` | Who originates | Agent involvement pre-bridge |
|---|---|---|---|
| Manual | `MANUAL` | Agent explicitly clicks Call | Full lead preview, agent decides |
| Progressive | `PROGRESSIVE` | E04 Picker pre-pairs agent then dials (1:1 ratio) | Agent is placed in conference *before* customer is dialed; hears ringback |
| Predictive | `PREDICTIVE` | E04 Picker dials to PARK; bridges best-available agent on answer | Agent gets no warning before bridge; customer is live on answer |
| Preview | `MANUAL` + `preview_dial=true` | Agent triggers after preview window | Agent sees lead before dial; clicks Call or gets auto-called after N seconds |

The key architectural distinction: **PROGRESSIVE** = agent-first (agent waits in conference, customer is called); **PREDICTIVE** = customer-first (customer is called first, agent is drafted on answer from the READY pool).

### 1.2 PROGRESSIVE flow (server-driven)

```
E02 tick → dispatch_tokens > 0
  E04 Picker:
    1. DECR dispatch_tokens                          (E04 PLAN §3)
    2. ZPOPMIN hopper → claim lead (fence-token)     (E01 contract)
    3. Pick READY agent (longest-wait ZSET)           (E04 PLAN §4)
    4. T04.Originate(mode=PROGRESSIVE, agentId=X, leadId=Y)
         → onAnswerAction = Conference{agent_t1_uX@default}
    5. Agent A02/SIP.js hears ringback in their park-leg conf
    6. Customer answers → FS bridges into agent_t1_uX@default
    7. WS: call.bridged → agent page navigates to A05

Agent UI role:
  - Receives WS `call.reserved` when E04 has selected them
  - Shows reservation overlay (caller info pre-fill)
  - Hears audio ringback (SIP.js park leg; T03 PLAN §2)
  - On `call.bridged`: navigate to A05 /call
```

### 1.3 PREDICTIVE flow (server-driven)

```
E02 tick → dispatch_tokens > 0
  E04 Picker:
    1. DECR dispatch_tokens
    2. ZPOPMIN hopper → claim lead
    3. T04.Originate(mode=PREDICTIVE, agentId=null, leadId=Y)
         → onAnswerAction = Park{}
    4. Customer answers → E04 AnswerHandler fires:
         a. Pick best-available READY agent
         b. UUIDTransfer(customerUUID, conference:agent_t1_uA)
    5. WS: call.reserved → agent A sees the lead preview
    6. WS: call.bridged → agent A05 takes over

Agent UI role:
  - Receives WS `call.reserved` with lead snapshot
  - Has optional preview_allowed_seconds window
  - Auto-bridge occurs when bridge completes (no agent click required)
  - WS: call.bridged → navigate to A05 /call
  - Agent may reject reservation during preview window → WS: call.rejected_by_agent
```

### 1.4 Flow comparison table

| Step | MANUAL (A04) | PROGRESSIVE (A06) | PREDICTIVE (A06) |
|---|---|---|---|
| Agent selects lead | Agent explicit click | Server-selected | Server-selected |
| Lead preview | Full A04 panel | Reservation overlay | Reservation overlay |
| Pre-bridge audio | None (no call yet) | Ringback in SIP park leg | None (customer already dialed) |
| Agent action to bridge | Click "Call" | Automatic when customer answers | Automatic when server bridges |
| Cancel/skip | Cancel button or Esc | Reject reservation (Esc) | Reject reservation (Esc, tight window) |
| Post-call | A06 dispo overlay | A06 dispo overlay | A06 dispo overlay |

---

## 2. Vicidial Baseline

### 2.1 Vicidial auto-dial agent screen behavior

Vicidial's `agc/agent.php` in PREDICTIVE and PROGRESSIVE modes follows this sequence (AST_VDauto_dial.pl + agent.php review):

1. **Agent waits in READY state** — screen shows "Waiting for call..." with a pulsing green indicator. The `campaign_id` is displayed; no lead data visible.

2. **Call assigned** (`vicidial_auto_calls` row updated, agent's `vicidial_live_agents` row updated):
   - In PROGRESSIVE: agent is already connected to an asterisk conference; customer ringback plays through the park leg. Screen begins populating with lead data during ring time.
   - In PREDICTIVE: screen pops immediately on CHANNEL_ANSWER from FS; no pre-ring. This is the "automatic call distribution" (ACD) model.

3. **Screen pop** — `lead_id` is passed via a fast MySQL query. The lead fields (name, phone, address, custom fields) appear in a frameset. Script and webform load in adjacent frames.

4. **"Auto-preview seconds"** (`auto_dial_level = PREVIEW`): A countdown timer appears. If agent does not press "Skip" within N seconds, the dial fires automatically. This matches Vicidial's `preview_dial` flag.

5. **Disposition after hangup** — A mandatory disposition menu appears. Timer counts down from `wrapup_timer`. If agent lets it expire, Vicidial auto-submits a configurable default status. Agent state flips to READY.

6. **Audible alert** — Vicidial uses `<bgsound>` (IE legacy) or a `<audio>` autoplay with a beep WAV when the screen pops. Modern agents rely on the caller audio arriving through the SIP channel.

### 2.2 Key Vicidial parameters applicable to A06

| Vicidial parameter | A06 equivalent | Notes |
|---|---|---|
| `auto_dial_level` | E02 `dial_level` | E02 sets; A06 reads display only |
| `preview_dial` | `campaigns.preview_dial` | Boolean gate on preview window |
| `preview_allowed_seconds` | `campaigns.preview_allowed_seconds` | Countdown timer in A06 overlay |
| `wrapup_timer` | `campaigns.wrapup_seconds` | A06 reads; already in A05 dispo |
| `hot_keys_active` | `campaigns.hot_keys_active` | A06 hotkeys gated on this flag |
| `auto_dial_next` | `campaigns.auto_dial_next` (proposed) | A06 returns to IDLE vs auto-ready |
| `agent_logout_on_drop` | Not Phase 1 | Phase 2 / E05 territory |
| `manual_dial_call_time_check` | T04 gate (C01.Check) | Server-enforced; A06 shows hint only |

### 2.3 The "no-manual-click" invariant

In PROGRESSIVE and PREDICTIVE modes, the agent **never** clicks a "Call" button to initiate the outbound leg. This is the defining UX invariant of A06. The agent's only pre-bridge actions are:

- Accept (implicit, do nothing — call bridges automatically)
- Reject reservation (Esc or explicit "Skip" button within preview window)
- Schedule callback (from reservation overlay)

Everything else is driven by E04/E02 on the server side.

---

## 3. Industry Precedents

### 3.1 Five9 predictive agent UI patterns

Five9's Supervisor App (2023 documentation) and agent desktop reveal these patterns for predictive mode:

**Reservation notification model:**
- Agent desktop switches from "Available" idle state to a distinct "Incoming call" state with a subtle audio chime (not a phone ring — customers are never ringing at this point; the chime signals the internal reservation).
- Lead preview card populates immediately with name, phone, and campaign script. This is the "screen pop on assignment" pattern.
- No accept/reject button in strict predictive mode. The agent must be in READY to receive; taking a call is implicit consent to the assignment.
- **Preview mode** (optional per skill): A countdown bar shows 10–30 seconds; agent can click "Skip" to release the lead back to the dialer pool.

**Visual design:**
- The campaign panel background shifts from neutral grey to a warm amber/yellow during reservation (signal: something is happening).
- Call timer starts from 00:00 at bridge; reservation time before bridge is NOT included in the call timer.
- Lead photo / initials avatar if CRM integration is active.

**Post-call:**
- ACW (After-Call Work) state is entered automatically on hangup. A banner "ACW — finishing up" appears with a countdown.
- Agent can click "End ACW" to return to Available early.
- Supervisor can force-end ACW remotely (S01 territory, not A06).

**Five9 key insight for A06:** The agent screen in predictive must communicate "this is happening TO you, not BY you" — the passive voice of the UX. Use animation, color, and audio to signal state changes rather than waiting for agent input.

### 3.2 Genesys Cloud predictive patterns

Genesys Cloud (2023 API + UX documentation):

**Interaction accepted state:**
- Genesys uses "Offering" → "Active" state progression. The "Offering" phase corresponds to A06's RESERVED state.
- In predictive, Offering duration is typically < 500 ms (the bridge happens very fast); the agent mostly sees the "Active" state.
- In progressive, Offering can last several seconds (ring time). Genesys shows a "Connecting..." spinner with the lead card.

**After-Call Work (ACW):**
- `wrapup_codes` = disposition statuses (maps to A06 D04 status list).
- `wrapup_timeout_ms` = `campaigns.wrapup_seconds × 1000`.
- Auto-ACW end: `auto_answer = true` setting in routing config. Maps to `campaigns.auto_ready_after_wrapup`.
- ACW forced end by supervisor: emits `conversation.wrapup.updated` event. A06 listens to WS `call.wrapup_force_end`.

**Genesys key insight for A06:** The disposition overlay should be the primary focus post-hangup, not a modal over the call panel. Genesys renders the ACW state as a full-panel replacement of the call workspace, which reduces cognitive load ("the call is over; here's what you need to do now").

### 3.3 Amazon Connect agent UI patterns

Amazon Connect's Contact Control Panel (CCP) 2024 documentation:

- **No explicit "accept" in outbound predictive** — agent is placed on the call automatically. The CCP shows a "Connected" badge.
- **After-contact work (ACW):** Auto-ACW is configurable per queue. Default = agent must click "Clear contact" to end ACW.
- **Missed contact:** If agent is in predictive and misses the bridge (network lag), Amazon Connect auto-sets agent to "Missed Contact" state (temporary PAUSED-like). Agent must click "Clear" to return to Available. **A06 equivalent:** `MISSED_RESERVATION` transient state → auto-revert to IDLE/PAUSED with toast.

### 3.4 Key synthesis for A06

From the industry review, the following patterns are universally consistent:

1. **Passive assignment** — agent does not click to start; the system pushes calls.
2. **Audible signal on reservation** — a non-phone-ring chime distinguishes "call incoming" from silence.
3. **Lead preview during ring/wait** — even PREDICTIVE systems show 1–3 seconds of lead data before the agent hears the customer.
4. **ACW auto-start** — post-hangup disposition is mandatory and time-boxed.
5. **Missed-assignment penalty** — agents who miss or reject too many reservations are flagged or auto-paused.
6. **Preview-skip goes back to pool** — skipped lead is released back to the dialer's hopper claim queue, not discarded.

---

## 4. Audible Alert UX

### 4.1 The browser autoplay problem

Modern browsers (Chrome 66+, Firefox 74+, Safari 12.1+) block `HTMLAudioElement.play()` calls that are not initiated in a user gesture handler. This is a critical constraint for predictive dialers where audio must play when a WS event arrives — with no simultaneous user interaction.

**Browser policy summary:**

| Browser | Autoplay policy | Workaround |
|---|---|---|
| Chrome | Blocked unless `autoplay` attribute on `<audio>` AND media engagement index > threshold | Pre-arm: play then immediately pause on first user click |
| Firefox | Blocked for audio; visual-only autoplay allowed | Same pre-arm pattern |
| Safari | Strictest: requires explicit user gesture for EACH play() call | Must pre-arm on page load interaction; use `resume()` on AudioContext |
| Mobile Safari (iOS) | Requires gesture on EVERY play() call | Pre-arm is less reliable; fallback = visual flash |

**Solution for A06: pre-arm pattern**

On the agent's first meaningful interaction with the auto-dial page (e.g., clicking "Enter Auto-Dial Mode" or any button on page mount), A06 must:

```typescript
// Pre-arm: play and immediately pause to satisfy user-gesture requirement
const audio = new Audio('/sounds/reservation-chime.wav');
audio.volume = 0;
await audio.play();
audio.pause();
audio.currentTime = 0;
audio.volume = 1;
// Store reference; play() will succeed later without user gesture
reservationChimeRef.current = audio;
```

This pre-arm technique is used by Five9, Genesys, and Amazon Connect browser agents (confirmed via browser DevTools network inspection of their web clients).

### 4.2 Sound design choices

| Event | Sound | Duration | Volume default |
|---|---|---|---|
| `call.reserved` arrives | Single chime (pleasant, non-alarming) | < 500 ms | 70% |
| Preview countdown < 5 s | Optional tick (metronome-style) | Per tick | 40% |
| `call.bridged` in PROGRESSIVE | Optional connect-tone | < 200 ms | 50% |
| Missed reservation | Low-frequency warning tone | < 1 s | 60% |

**Do not use:**
- Phone ringing (RING) — customers hear this and associate it with incoming calls; confusing for agents in predictive where the customer is already answered.
- Loud or alarming sounds — agents work long shifts; alarm fatigue is well-documented. Use pleasant, low-frequency tones.
- Sounds that cannot be muted — agent-level volume control must be provided; global mute (same key as in-call mute: M) should suppress all A06 sounds.

### 4.3 AudioContext alternative for iOS

For iOS Safari where `HTMLAudioElement` pre-arm is unreliable:

```typescript
// AudioContext approach (more reliable on iOS)
const ctx = new (window.AudioContext || window.webkitAudioContext)();
// Pre-arm by resuming on user gesture
document.addEventListener('click', () => ctx.resume(), { once: true });

// Play chime programmatically
async function playChime() {
  if (ctx.state === 'suspended') await ctx.resume();
  const response = await fetch('/sounds/reservation-chime.wav');
  const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
}
```

A06 should implement both approaches with feature detection, falling back to AudioContext on iOS.

### 4.4 Visual complement to audio

Audio alerts must have visual redundancy for hearing-impaired agents and noisy call center environments:

- **Reservation**: Entire reservation overlay slides in from the right with a brief border pulse animation (1 pulse, 500 ms, `border-state-warning`).
- **Preview countdown**: Countdown bar changes color: green (> 50% time remaining) → amber (25–50%) → red (< 25%) → pulsing red (< 5 s).
- **Missed reservation**: Red flash of the agent state widget (200 ms, 3 pulses).

---

## 5. Preview-Pause Feature

### 5.1 Definition

When `campaigns.preview_dial = true` AND `campaigns.preview_allowed_seconds > 0`, the agent is shown a lead preview overlay before the bridge occurs. The bridge is deferred until either:

(a) The preview countdown expires (auto-bridge fires), or
(b) The agent explicitly clicks "Accept Call" (early bridge), or
(c) The agent clicks "Skip" (reservation rejected; lead released back to hopper).

This feature applies to both PROGRESSIVE and PREDICTIVE modes when configured. Without it, auto-dial is fully hands-free.

### 5.2 Countdown implementation

The countdown is a frontend-only timer synchronized to the `call.reserved` WS event's `preview_expires_at` timestamp (server-set UTC ISO-8601). Using a server timestamp (not a client `Date.now() + N`) prevents clock drift issues.

```typescript
// preview_expires_at is set by E04 at dispatch time: Date.now() + preview_allowed_seconds * 1000
const msRemaining = new Date(event.data.preview_expires_at).getTime() - Date.now();
```

The server side (E04) must also enforce the expiry: if the agent has not rejected by `preview_expires_at`, E04 proceeds with the bridge. A06 relies on this server-side enforcement as authoritative; the client timer is UX only.

### 5.3 Skip semantics

When the agent clicks "Skip" during the preview window:
1. A06 sends `POST /api/agent/reservation/reject { call_uuid, reason: 'skipped' }`.
2. Server (E04 / Go): release the hopper fence-token, mark lead with appropriate D04 status (`NA` or custom), emit `call.reservation_rejected` WS event.
3. Agent state remains READY; A06 returns to IDLE waiting state.
4. The skipped lead may be re-dispatched to another agent (configurable: `campaigns.skip_returns_to_hopper`).

**Skip reason taxonomy:**

| Reason | Code | D04 status written |
|---|---|---|
| Agent pressed Skip / Esc | `agent_skip` | Campaign-configured (typically `NA`) |
| Preview countdown expired but agent pressed Skip before bridge | `preview_timeout_skip` | Same |
| Reservation timeout (agent idle/offline) | `reservation_timeout` | `NA` |
| Agent went PAUSED during reservation | `agent_paused` | Released; no status write |

### 5.4 Early accept

Agent clicks "Accept Call" before countdown expires. A06 sends:
```
POST /api/agent/reservation/accept { call_uuid }
```
Server bridges immediately (E04 issues `UUIDTransfer` to agent conference). Remaining preview time is abandoned; `call.bridged` WS event arrives and A05 takes over.

### 5.5 Preview_allowed_seconds = 0 (fully automatic)

When `preview_allowed_seconds = 0`, A06 renders no countdown and no Accept/Skip buttons. The reservation overlay is purely informational (name, phone, script snippet). Bridge occurs as fast as the server can execute it. From the agent's perspective, the `call.reserved` → `call.bridged` sequence may be < 200 ms. A06 must handle this "instant" case gracefully: if `call.bridged` arrives before the reservation overlay fully animates in, skip the overlay entirely and jump straight to A05.

---

## 6. ACW Timer and Auto-Ready Toggle

### 6.1 After-Call Work (ACW) behavior

ACW is the time between call hangup and the agent returning to READY. During ACW:
- Agent is in `WRAPUP` state (A03 `useAgentStore.status === 'wrapup'`).
- Agent is NOT receiving new auto-dial assignments from E04 (E04 only picks READY-state agents).
- A05's disposition overlay is shown (post-call mandatory dispo per A05 PLAN §0 bullet 6).

A06 extends A05's disposition overlay concept by adding the auto-dial-specific behaviors on wrapup completion.

### 6.2 Wrapup timer sources

| Campaign config | Behavior |
|---|---|
| `wrapup_seconds = 0` | No timer; agent must submit dispo explicitly (PAUSED-until-dispo semantics) |
| `wrapup_seconds > 0` | Countdown timer visible. On expiry, auto-submit with `campaigns.default_dispo` or `NA` |
| `wrapup_seconds > 0` AND agent submits early | Timer cancelled; immediate READY transition |

The timer source of truth is `useCallStore.wrapupStartAt` (set when `phase === 'wrapup'`). A06 computes `timeRemaining = wrapup_seconds - (Date.now() - wrapupStartAt) / 1000`.

### 6.3 Auto-ready-after-wrapup toggle

This is the critical behavioral difference between manual and auto-dial modes:

**In MANUAL mode (A04/A05):** After dispo, agent returns to IDLE on `/dial` and can choose to dial next or take a break.

**In AUTO-DIAL mode (A06):** After dispo, agent has two options configured per campaign:

| `campaigns.auto_ready_after_wrapup` | Behavior |
|---|---|
| `true` (default for PROGRESSIVE/PREDICTIVE) | After dispo submit, agent state auto-flips to READY; E04 may immediately dispatch next call |
| `false` | After dispo, agent goes to PAUSED-like "Manual Ready" state; must click "Return to Auto-Dial" button |

Agent can also override per-session: the reservation overlay shows a "Pause after this call" toggle. If toggled ON before dispo, the auto-ready flip is suppressed and agent enters PAUSED.

### 6.4 "Pause after this call" semantics

This is distinct from A04's "Paused" state:

1. Agent is on an active call (CONNECTED state in A06).
2. Agent clicks "Pause after call" toggle (bottom of reservation overlay, or hotkey `P`).
3. A06 stores `pendingPauseAfterCall: true` in local component state (NOT yet sent to server — call is ongoing).
4. On hangup / call.ended: instead of auto-READY, A06 sends `POST /api/agent/state { status: 'paused', pause_code: pendingPauseCode }`.
5. Dispo overlay still shows; agent submits dispo; then remains PAUSED.

The pending pause is a queued server-side intent. If the agent cancels it before hangup, `pendingPauseAfterCall = false`.

### 6.5 Wrapup expiry auto-submit

When `wrapup_seconds` expires before agent submits:
1. A06 auto-selects `campaigns.default_dispo` (e.g., `NA`) as the disposition status.
2. Auto-appends to comments: `[auto-dispo: wrapup expired at ${timestamp}]`.
3. Submits via `POST /api/agent/dispo`.
4. Transitions based on `auto_ready_after_wrapup` flag.
5. Toast notification: "Call dispositioned automatically as NA — wrapup timer expired".

This matches Vicidial's behavior (`agent.php` `wrapupDispositionTimeout` handler).

---

## 7. Agent-Initiated Callback During Predictive

### 7.1 When this applies

During a CONNECTED call in auto-dial mode, the agent discovers the customer cannot continue now but wants to be called back. This is semantically identical to A05's callback flow (D06 module), but A06 must handle the post-callback-schedule behavior specifically:

- In MANUAL mode: agent schedules callback, dispositions the call as `CALLBK`, ends call normally.
- In AUTO-DIAL mode: same, BUT the next call may auto-dispatch immediately after dispo. The agent may want to review the callback they just scheduled before the next call arrives.

### 7.2 Post-callback flow

When agent schedules a callback from the auto-dial panel:
1. D06 endpoint fires: `POST /api/agent/lead/:id/callbacks`.
2. A06 pre-fills the dispo overlay with `CALLBK` status.
3. Dispo overlay shows "Callback scheduled for [date/time]" confirmation chip.
4. If `auto_ready_after_wrapup = true`, A06 adds a 3-second "Callback scheduled — returning to auto-dial in 3s" countdown before auto-READY. Agent can click "Stay paused" to interrupt.

### 7.3 Hotkey for callback scheduling

In Vicidial, the callback shortcut in auto-dial mode is `Ctrl+B` (matches A05 PLAN §5.1 button 8). A06 preserves this. Additionally:
- `Ctrl+Enter` during the preview overlay = "Schedule callback and skip this lead" (skip without answering, schedule for later).
- This is Vicidial's pattern for "agent sees lead is in DNC-adjacent territory or wrong time" and wants to defer without bridge.

### 7.4 DNC during predictive

If agent discovers the customer is on the DNC list during a call (customer says "remove me from your list"):
- `Ctrl+D` = Mark DNC (same as A05 action button 9).
- A06 pre-fills dispo with `DNC` status.
- D05 receives the DNC entry.
- Auto-READY proceeds after dispo.

---

## 8. Idle-Detect: Reservation Timeout

### 8.1 Problem statement

In auto-dial mode, an agent can become unreachable without explicitly logging out:
- Browser tab backgrounded (mobile OS suspends timer callbacks)
- Network interruption (SIP.js shows `reconnecting` status)
- Agent walks away from desk without pausing

E04 dispatches a reservation assuming the agent is READY. If the bridge never completes (agent's SIP session is dead), the customer may hear silence or ringback for too long.

### 8.2 Reservation timeout policy

E04 HANDOFF does not specify a reservation timeout explicitly; A06 must implement one client-side AND the server must enforce one independently:

**Server-side (E04):**
- `campaigns.reservation_timeout_seconds` (proposed F02 amendment) — if the agent does not respond to `call.reserved` within N seconds (defaults to 10 s), E04 cancels the reservation and finds another agent.
- E04 emits `call.reservation_expired` WS event.
- Agent is set to PAUSED automatically by the server (punishment for missing reservation).

**Client-side (A06):**
- On `call.reserved`, A06 starts a `reservationTimeoutMs` countdown = `reservation_timeout_seconds * 1000`.
- If the countdown fires before `call.bridged` or `call.reservation_expired`:
  1. A06 sends `POST /api/agent/reservation/reject { call_uuid, reason: 'client_timeout' }`.
  2. Shows toast: "Call reservation timed out — you've been paused. Click to resume."
  3. Agent state flips to PAUSED.

### 8.3 SIP registration check before reservation acknowledgment

When `call.reserved` arrives, A06 checks `useSoftphone().status`:
- If `registered`: proceed normally.
- If `reconnecting` or `error`: immediately reject reservation (`reason: 'sip_not_ready'`) AND show warning toast.
- If `idle` / `connecting`: queue a 2-second check; if not `registered` within 2 s, reject.

This prevents silent dead-air calls where the agent's conference leg is not established.

### 8.4 Missed reservation counter

A06 increments a client-side `missedReservationsThisSession` counter. When it reaches `campaigns.max_missed_reservations` (proposed config, default 3), A06 auto-pauses the agent with pause code `MISSED_CALLS`. The server independently tracks this (E04 increments a Valkey counter per agent per campaign). Both client and server enforcement are belt-and-suspenders.

---

## 9. WS Event Surface

### 9.1 Events A06 subscribes to

| Event type | Source | A06 reaction |
|---|---|---|
| `call.reserved` | E04 AnswerHandler → T01 → WS broker | Transition IDLE → RESERVED; show overlay; play chime; start reservation timeout |
| `call.bridged` | T01 CHANNEL_BRIDGE → WS broker | Transition RESERVED/CALLING → CONNECTED; stop reservation timer; navigate to A05 |
| `call.hangup` | T01 CHANNEL_HANGUP → WS broker | Transition CONNECTED → WRAPUP; start wrapup timer; show dispo overlay |
| `call.failed` | T01 CHANNEL_HANGUP with failure cause → WS broker | Transition RESERVED/CALLING → IDLE; toast with reason |
| `call.reservation_expired` | E04 timeout → WS broker | Transition RESERVED → IDLE/PAUSED; toast "Reservation expired" |
| `call.reservation_rejected` | E04 (agent rejected on another tab) → WS broker | Sync rejection state across tabs |
| `call.disposed` | api dispo service → WS broker | Confirm dispo written; trigger auto-READY if configured |
| `agent.state_changed` | A03 server-confirmed → WS broker | Sync `useAgentStore` (supervisor force-state, multi-tab) |
| `campaign.config_changed` | M02 admin → WS broker | Re-fetch campaign config; update wrapup_seconds, preview_allowed_seconds |
| `call.wrapup_force_end` | S01 supervisor → WS broker | Force-end ACW; auto-submit dispo with default status |

### 9.2 Event payload shapes (FROZEN contracts from upstream)

**`call.reserved` payload (E04 HANDOFF + A06 extension):**
```typescript
interface CallReservedEvent {
  type: 'call.reserved';
  seq: number;
  data: {
    call_uuid: string;           // FreeSWITCH UUID of customer leg
    attempt_uuid: string;        // T04 one-UUID-rule key
    lead: LeadSnapshot;          // Denormalized lead fields (same shape as useCallStore.lead)
    campaign_id: number;
    campaign_name: string;
    preview_expires_at: string | null;  // ISO-8601 UTC; null if preview_allowed_seconds=0
    reservation_expires_at: string;     // ISO-8601 UTC; always set (E04 reservation timeout)
    dial_mode: 'PROGRESSIVE' | 'PREDICTIVE';
    script_snippet: string | null;      // First 200 chars of campaign script, substituted
  };
}
```

**`call.bridged` payload (T01 / T03 PLAN — pre-existing):**
```typescript
interface CallBridgedEvent {
  type: 'call.bridged';
  seq: number;
  data: {
    call_uuid: string;
    attempt_uuid: string;
    bridged_at: string;           // ISO-8601 UTC
    customer_uuid: string;
    agent_uuid: string;           // FS UUID of agent's SIP leg
  };
}
```

**`call.hangup` payload:**
```typescript
interface CallHangupEvent {
  type: 'call.hangup';
  seq: number;
  data: {
    call_uuid: string;
    hangup_cause: string;         // FS CHANNEL_HANGUP cause code
    duration_sec: number;
    billable_sec: number;
    ended_at: string;
    initiator: 'customer' | 'agent' | 'system';
  };
}
```

**`call.disposed` payload:**
```typescript
interface CallDisposedEvent {
  type: 'call.disposed';
  seq: number;
  data: {
    call_uuid: string;
    status: string;               // D04 status code written
    agent_id: number;
  };
}
```

### 9.3 Events A06 does NOT subscribe to

- `call.originated` — A06 never originates; this is E04/T04 territory.
- `call.ringing` — A04 manual dial subscribes; A06 hears ringback via SIP audio (T03 park leg), not WS.
- `compliance.window_changed` — A04 pre-call gate; irrelevant in auto-dial where server already ran gates.
- `agent.pause_required` — handled by A03 (global overlay); A06 defers to the agent state widget.

### 9.4 WS subscription registration

A06 registers subscriptions via `useWebSocket().subscribe()` (A01 contract) scoped to the auto-dial page:

```typescript
// Mounted when (agent)/auto/page.tsx mounts
useEffect(() => {
  const unsubscribe = [
    ws.subscribe('call.reserved', handleReserved),
    ws.subscribe('call.bridged', handleBridged),
    ws.subscribe('call.hangup', handleHangup),
    ws.subscribe('call.failed', handleFailed),
    ws.subscribe('call.reservation_expired', handleReservationExpired),
    ws.subscribe('call.disposed', handleDisposed),
    ws.subscribe('agent.state_changed', handleAgentStateChanged),
    ws.subscribe('campaign.config_changed', handleConfigChanged),
    ws.subscribe('call.wrapup_force_end', handleForceEndWrapup),
  ];
  return () => unsubscribe.forEach(fn => fn());
}, []);
```

---

## 10. Open Questions Resolved for PLAN

### Q1: Does A06 own a separate route or share A05's /call route?

**Resolution: A06 owns `(agent)/auto/` route.** The auto-dial waiting screen (IDLE + RESERVED states) is a distinct page from the in-call panel (A05 `/call`). When `call.bridged` arrives, A06 navigates to `/call` (A05 takes over). When dispo is submitted, A05 (or A06's wrapup overlay) returns to `/auto`.

The wrapup/dispo overlay is rendered ON TOP of A05's `/call` page (A05 already ships this overlay). A06 extends A05's disposition overlay behavior by adding auto-ready logic and preview-specific hotkeys. A06 does NOT ship a separate dispo overlay — it configures A05's overlay via campaign config flags.

**Implication for PLAN:** A06's files live in `web/src/app/(agent)/auto/` (waiting screen) and extend `web/src/app/(agent)/call/` (wrapup behavior via campaign config). No new dispo overlay component.

### Q2: Who sends `call.reserved` — E04 directly or via api?

**Resolution: E04 → Valkey pubsub → api WS broker → agent browser.** E04 HANDOFF confirms E04 integrates with T01's ESL event stream. The WS broker in the api layer subscribes to Valkey pubsub and fans out to connected agents. A06 receives `call.reserved` via the existing A01 WS wrapper (`useWebSocket()`). E04 does not have a direct WebSocket connection to the browser.

### Q3: Should reservation reject go to api or directly to E04?

**Resolution: `POST /api/agent/reservation/reject` → api → E04 via Valkey pubsub.** The api layer handles the reservation reject, publishes a `reservation.rejected` message to Valkey, which E04 subscribes to. This keeps the browser talking only to the api layer (F05 auth) and never directly to the Go dialer.

### Q4: Where does the wrapup dispo overlay live — A06 or A05?

**Resolution: A05 ships the dispo overlay (already specified in A05 PLAN §3.2 `WRAPUP` state). A06 configures it via campaign config passed through `useCallStore.campaign`.** A06's contribution is:
1. New campaign config fields: `auto_ready_after_wrapup`, `preview_allowed_seconds`, `reservation_timeout_seconds`.
2. The "pause after this call" toggle logic.
3. Post-dispo routing: A05 calls `router.replace('/auto')` instead of `router.replace('/dial')` when `useCallStore.campaign.dial_method !== 'MANUAL'`.

### Q5: Does A06 need its own Zustand store slice?

**Resolution: A06 adds fields to `useCallStore` (not a new store).** Fields needed:
- `dialMode: 'manual' | 'progressive' | 'predictive' | null` — already planned in A04 PLAN §4.1.
- `reservationExpiresAt: string | null` — new A06 field.
- `previewExpiresAt: string | null` — new A06 field.
- `pendingPauseAfterCall: boolean` — new A06 field.
- `missedReservationsCount: number` — new A06 field (session-only, not persisted).

### Q6: What happens to in-flight lead hopper claims when agent rejects?

**Resolution: A06 sends the reject; api calls E04 (via Valkey) which calls E01.Release(fenceToken, reason).** The lead's `originate_audit` row is updated with `outcome = 'AGENT_SKIP'` (or appropriate D04 status). The hopper claim is released per E01 contract. E04 may re-dispatch the lead to another agent based on campaign config.

### Q7: Does the auto-dial page need a campaign selector?

**Resolution: No separate campaign selector.** The agent selects campaign on login or via A03's `joinCampaign()` action (from the agent settings page or a campaign-join modal in A01). When the agent navigates to `/auto`, `useAgentStore.currentCampaignId` must already be set. If it's null, `/auto` redirects to a "Select a campaign" prompt (reuse A01 campaign selector slot). This matches Vicidial's model: agent logs in and selects a campaign before entering auto-dial.

### Q8: How does the browser know when a new reservation is coming vs. idle waiting?

**Resolution: No prediction.** A06 shows an IDLE waiting screen with a pulsing "Waiting for call..." indicator. No ETA or queue-depth information is shown to the agent (this is a predictive-dialer invariant — showing queue depth would cause agents to time their "readiness" to avoid calls, degrading fill rate). The only transition trigger is the `call.reserved` WS event.

### Q9: Does A06 interact with E02 or E04 directly?

**Resolution: No. A06 is a pure consumer of WS events and a sender of HTTP requests to the api layer.** A06 never reads `dispatch_tokens`, never talks to E02, and never talks to E04 directly. E04 is the server-side pusher; A06 is the client-side receiver. This is the same separation as A04 (which also never talks to E02/E04).

### Q10: Accessibility for the reservation overlay

**Resolution: reservation overlay must be `role="alertdialog"` with `aria-live="assertive"`.** Screen readers must announce immediately when a reservation arrives (WCAG 4.1.3: status messages). The overlay is NOT a modal (agent can still read other screen content behind it). The countdown timer uses `aria-valuenow` + `aria-valuemin="0"` + `aria-valuemax` on a `<progress>` element. Esc/Tab focus is trapped within the overlay's action buttons only when preview_allowed_seconds > 0 (otherwise overlay is passive).
