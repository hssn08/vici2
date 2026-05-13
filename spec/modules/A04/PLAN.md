# Module A04 — Manual Dial UI — PLAN

**Module:** A04 (Agent UI track, Phase 1)
**Author:** A04 PLAN sub-agent (Claude Sonnet 4.6)
**Date:** 2026-05-13
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 38 citations behind every choice.
**Depends on (PLANs already FROZEN or PROPOSED):**
- A01 PLAN (Next.js skeleton, route map, stores, WS wrapper, provider slots)
- A02 PLAN (`useSoftphone()` hook; SIP.js park-leg model)
- T04 PLAN (5-gate compliance pipeline, `attempt_uuid` one-UUID rule, 5 typed errors, `originate_audit`)
- F05 PLAN (JWT, RBAC, error envelope, `requireAuth` + `requireAgent` guards)
- C01 PLAN (TCPA `ALLOW`/`SKIP_UNTIL`/`BLOCK_INVALID` union; TS mirror)
- D05 PLAN (DNC Bloom + MySQL confirm; `dnc:bypass` super-admin only)
- D01 PLAN (lead REST surface, optimistic-lock 412, cursor pagination)
- E01 PLAN (hopper claim/release contract — A04 must NOT touch the hopper directly)
- F02 PLAN + F02 Amendments A1/T04.x (`originate_audit` table, column contract)

**Blocks:** A05 (call panel — receives handoff when `call.bridged` WS event arrives)

This document turns the A04 RESEARCH findings into the exact component tree,
state machine, store contract, REST surface, WebSocket subscription, hotkey
registry, test plan, and acceptance criteria the IMPLEMENT phase will deliver.
**No `.tsx` is produced here.** Once approved, the public interface (route
slots, store field additions, REST paths, WS event set, component prop types)
is FROZEN. Internal reducer phrasing, component sub-decomposition, and CSS
details may change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **A04 owns exclusively the pre-call UI: `IDLE → LEAD_SELECTED → CALLING` (phase `'ringing'`).** The instant `call.bridged` arrives over the WS, `router.push('/call')` fires and A05 takes over. A04 never renders Hangup, Hold, DTMF, or any during-call control.

2. **Three dial-driver modes ship in Phase 1:** Manual ad-hoc (free-form phone entry via modal), Dial-Next-Lead (explicit click, `list_id ASC, lead_id ASC` SQL pull), and Preview Dial (campaign `dial_method='MANUAL' AND preview_dial=true` feature-flag; pulls one lead from the hopper claim-token flow, exposes Skip/DNC/Callback actions). Progressive/predictive modes (Phase 2 E02) skip A04 entirely.

3. **State machine has 7 states implemented as a hand-rolled discriminated-union reducer in `useCallStore`** (no XState — 7 states is below the complexity threshold; matches A01's Zustand-first pattern). States: `IDLE`, `MODAL_OPEN`, `LOADING_LEAD`, `LEAD_SELECTED`, `CALL_REQUESTED`, `CALLING`, `BLOCKED`. Transitions are total, explicit, and event-driven; no implicit time-based transitions.

4. **Client pre-gates are UX hints; the T04 server pipeline is authoritative.** A04 computes `clientGates` on form change (TCPA hint via C01 mirror, DNC hint via D05 Bloom mirror, phone validity via libphonenumber-js, agent-ready from `useAgentStore`, no-in-flight from `useCallStore`) to disable the Call button early — no "flash of enabled button." If client says ALLOW but server says BLOCK, the BLOCKED screen renders the server's reason; a `client_gate_mismatch` metric fires.

5. **The Call button has 5 disabled states plus a 6th campaign-paused state**, each with a distinct `aria-disabled` + tooltip + inline error message. Native HTML `disabled` is NOT used (it removes the button from the tab order). A click on an `aria-disabled` button announces the reason via Sonner toast and `aria-live`.

6. **REST surface = 5 owned endpoints + 7 read-only consumers.** Owned: `POST /api/agent/manual_dial` (T04 wrapper), `POST /api/agent/cancel_dial` (idempotent), `GET /api/agent/next_lead` (Phase-1 SQL algorithm), `POST /api/agent/preview_skip`, `GET /api/agent/current_call` (refresh-restore). All request/response bodies have Zod schemas; the 4xx shape follows F05's error envelope.

7. **WebSocket events A04 subscribes to (read-only; A04 never publishes WS messages):** `call.originated`, `call.ringing`, `call.bridged`, `call.failed`, `call.cancelled`, `agent.state_changed`, `compliance.window_changed`. Lost-event recovery is provided by `lib/ws.ts`'s `{op:"resume", from:lastSeq}` cursor (A01 contract); A04 adds no separate recovery logic.

8. **Multi-tab guard is two-layer: client `BroadcastChannel('vici2-agent-dial')` + server Valkey SETNX `t:{tid}:agent:{id}:dialing` lock (TTL = `dial_timeout_sec + 5`).** Second-tab dial attempt gets 409 `AGENT_DIAL_LOCK` from the server; the `BroadcastChannel` catches the race client-side before the HTTP round-trip.

9. **12 hotkeys in Phase 1, scoped via `react-hotkeys-hook` v4 `enableOnFormTags: false`.** Enter/Esc/n/m/`/`/s/Ctrl+Enter/Ctrl+M/Ctrl+P/?/Tab. Scope is `'dial-page'` or `'global'`; hotkeys in inputs don't fire. The `?` cheatsheet auto-discovers the registry — no hard-coded list.

10. **Accessibility target: axe-core zero AA violations (CI gate, same as A01 §0.9).** `aria-disabled` on Call button; `role="alert"` on BLOCKED screen; `role="status"` on Calling badge; lead card uses `<dl><dt><dd>`; focus management is specified per transition (§10). WCAG 2.2 AA criterion mapping in §15.

---

## 1. Goals and non-goals

### 1.1 Phase 1 goals (this PLAN)

- **Manual ad-hoc dial:** agent types a phone number (or searches by name/number from D01), sees the lead preview card, clicks Call. Server runs T04 5-gate pipeline. WS events drive state transitions to `/call`.
- **Dial Next Lead:** agent clicks one button; server returns the next undialed lead for the active campaign (Phase-1 SQL algorithm). Agent reviews and calls.
- **Preview Dial:** campaign-gated mode. Server pulls one lead from the hopper claim, returns it with a `claim_token`. Agent can Call, Skip, DNC-this-number, or Schedule Callback. Skip releases the hopper claim via `/preview_skip`.
- **In-flight Cancel:** agent can abort a dial attempt at any point before `call.bridged` arrives.
- **Lead preview card:** name, phone, location + local time, compliance badges (DNC, TCPA window, recording-consent), prior-call history (≤10 rows), custom fields (filtered by `agent_visible_keys`), script snippet.
- **Refresh resilience:** on page reload, `GET /api/agent/current_call` restores state; if `phase === 'active'` the page immediately redirects to `/call`.
- **WCAG 2.2 AA compliance** throughout.

### 1.2 Phase 2 goals (explicitly deferred)

- **Predictive/Progressive modes** — E02 owns these; they skip A04 entirely and go straight to A05.
- **Supervisor-configurable hotkey overrides** stored in `useUiStore.hotkeyOverrides` (M01 admin `(admin)/settings/keyboard`).
- **Answering-machine detection (AMD) UI** — A05 Phase 2 concern (E05 / `mod_avmd`).
- **International agent timezone overlay** ("Lead: 4:42 PM PST · You: 11:42 PM IST") in the preview card.
- **20-row history** (ship 10; HANDOFF note for 20 if D01 performance allows).
- **`lead_filter` DSL** (Phase 3 — cel-go).

### 1.3 Non-goals (never in A04)

- In-call Hangup, Hold, Mute, DTMF (A05).
- Disposition entry (A06).
- Transfer UI (A07).
- Recording controls (R01 + A05).
- DNC bypass UI — agents cannot bypass DNC. Agents can submit a request ticket (M06, out of scope).
- Editing lead fields — read-only in the preview card. Full edit lives in M03 admin.

---

## 2. The three-page boundary

| Phase | Page | Module | Entry trigger | Exit trigger |
|---|---|---|---|---|
| Pre-call | `(agent)/dial` | **A04** | Agent login / wrapup complete | `call.bridged` WS event |
| In-call | `(agent)/call` | A05 | `call.bridged` → `router.push('/call')` | Hangup → `call.ended` |
| Post-call | Wrapup modal on `/call` | A06 | `call.ended` | Dispo submitted → `router.replace('/dial')` |

### 2.1 Handoff to A05

When `call.bridged` arrives, `useCallStore.setPhase('active')` is called by the WS subscriber. A04's `useEffect` watches `phase` and fires `router.push('/call')`. A04 unmounts; A05 mounts and reads the same `useCallStore` fields (`callUuid`, `lead`, `startedAt`, `attemptUuid`).

### 2.2 Return from A06

After dispo, A06 calls `useCallStore.resetDial()` (sets `phase = 'idle'`). Router navigates to `/dial`. A04 mounts in IDLE state. In Preview mode, A04 auto-fetches the next hopper lead (`GET /api/agent/next_lead?campaign_id=...`). In Manual/Next-Lead mode, no auto-fetch — explicit user action only (RESEARCH §16 Q2).

### 2.3 What A04 explicitly does NOT render

- Disposition picker (A06 owns).
- In-call DTMF keypad (A05 owns; A04 does expose an "Advanced" disclosure for `post_answer_digits` pre-dial — collapsed by default).
- Recording controls (R01 + A05).
- Transfer dropdown (A07).
- Call-queue depth or ready-agent count (A01's `<AgentShell/>` bottom bar).

---

## 3. State machine

### 3.1 States

| State | Description |
|---|---|
| `IDLE` | Empty dial page. No lead. Both dial buttons available. |
| `MODAL_OPEN` | Manual Dial modal is open. Form focus trapped. |
| `LOADING_LEAD` | `GET /api/agent/next_lead` in flight. AbortController cancelable. |
| `LEAD_SELECTED` | Lead in preview card. Call button enabled iff all 5 client-side gates pass. |
| `CALL_REQUESTED` | Button pressed; `POST /api/agent/manual_dial` in flight. Form locked; spinner. |
| `CALLING` | HTTP 200 received; `attempt_uuid` stored. WS event `call.ringing` expected. Cancel button shown. |
| `BLOCKED` | Server returned a compliance/DNC/phone 4xx, or WS `call.failed` arrived. Full-screen overlay. |

### 3.2 Transition table

| From | Event | To | Side-effect |
|---|---|---|---|
| `IDLE` | click "Manual Dial" or hotkey `m` | `MODAL_OPEN` | Focus `#phone-input`; trap focus inside Radix Dialog |
| `IDLE` | click "Dial Next Lead" or hotkey `n` | `LOADING_LEAD` | `GET /api/agent/next_lead`; show skeleton in lead card slot |
| `IDLE` | preview-mode mount | `LOADING_LEAD` | Same as above but with `claim_token` in response |
| `MODAL_OPEN` | Esc or Cancel button | `IDLE` | Close modal; restore focus to "Manual Dial" button |
| `MODAL_OPEN` | Submit (Enter or button) | `LEAD_SELECTED` | Optional `GET /leads/lookup?phone=...`; close modal; `setLead()` |
| `LOADING_LEAD` | Esc | `IDLE` | Abort fetch via `AbortController` |
| `LOADING_LEAD` | HTTP 200 + lead body | `LEAD_SELECTED` | `setLead(lead); setHopperClaimToken(token)` |
| `LOADING_LEAD` | HTTP 404 `NO_LEAD` | `IDLE` | Toast "No leads available in this campaign" |
| `LEAD_SELECTED` | click "Call" or Enter (gates pass) | `CALL_REQUESTED` | Lock form; start spinner; `POST /api/agent/manual_dial` |
| `LEAD_SELECTED` | Esc or "Cancel" | `IDLE` | Clear lead; `resetDial()` |
| `LEAD_SELECTED` | "Skip" (preview only) | `LOADING_LEAD` | `POST /api/agent/preview_skip {reason:'skipped'}`; fetch next |
| `LEAD_SELECTED` | Ctrl+Enter "DNC" (preview only) | `LOADING_LEAD` | `POST /api/agent/preview_skip {reason:'dnc'}`; fetch next |
| `LEAD_SELECTED` | `s` "Schedule callback" (preview only) | (modal overlay) | Opens callback scheduler; on submit returns to `LEAD_SELECTED` or `IDLE` |
| `LEAD_SELECTED` | `compliance.window_changed` WS | `LEAD_SELECTED` | Invalidate `['compliance','window']` TanStack Query; re-evaluate gates |
| `LEAD_SELECTED` | campaign paused (WS → TanStack refetch) | `LEAD_SELECTED` | Add `CAMPAIGN_PAUSED` to `clientGates`; disable Call |
| `CALL_REQUESTED` | HTTP 200 `{attempt_uuid}` | `CALLING` | `setAttempt(attempt_uuid); setPhase('ringing')`; start 60-s safety timer |
| `CALL_REQUESTED` | HTTP 4xx (typed error) | `BLOCKED` | `setBlock({code, message, retryAfter?})`; Sonner toast |
| `CALL_REQUESTED` | HTTP 409 `AGENT_DIAL_LOCK` | `BLOCKED` | Toast "Another tab is dialing. Switch to it." |
| `CALLING` | Esc or "Cancel" button | `LEAD_SELECTED` | `POST /api/agent/cancel_dial {attempt_uuid}`; on 409 `ALREADY_BRIDGED` → `router.push('/call')` |
| `CALLING` | WS `call.originated` | `CALLING` | `setAttempt(event.data.attempt_uuid)` (echo confirm) |
| `CALLING` | WS `call.ringing` | `CALLING` | `setCallUuid(call_uuid)`; copy "Ringing…" |
| `CALLING` | WS `call.bridged` | *(navigate)* | `setPhase('active'); router.push('/call')` — A05 takes over |
| `CALLING` | WS `call.failed` | `BLOCKED` | `setBlock({code:'CALL_FAILED', message: event.data.reason})` |
| `CALLING` | 60-s safety timer fires, no WS event | `CALLING` | Show "Still ringing — Cancel?" banner; count-up timer |
| `BLOCKED` | click "Dismiss" / "Try again" | `LEAD_SELECTED` or `IDLE` | `clearBlock()`; prior lead restored if available |

### 3.3 Implementation: hand-rolled discriminated union

The reducer lives inside `useCallStore` (`web/src/lib/stores/call.ts`, owned by A01 — A04 extends it). Pattern:

```typescript
type DialPhase =
  | { state: 'idle' }
  | { state: 'modal_open' }
  | { state: 'loading_lead' }
  | { state: 'lead_selected'; lead: Lead }
  | { state: 'call_requested'; lead: Lead }
  | { state: 'calling'; lead: Lead; attemptUuid: string; callUuid: string | null }
  | { state: 'blocked'; lead: Lead | null; reason: BlockReason };
```

A `transition(currentState, event)` pure function enforces valid transitions and throws at runtime (caught by error boundary) if an illegal transition is attempted. XState is explicitly deferred (RESEARCH §3.4, Talkdesk retrospective).

### 3.4 Persistence across refresh

On mount of `(agent)/dial/page.tsx`:

1. If `useCallStore.getState().dialPhase.state !== 'idle'`, skip (already restored from store hydration).
2. Else call `GET /api/agent/current_call`. On 200, call `restoreFromServer(data)` which reconstructs the store from `{attempt_uuid, phase, lead, started_at}`.
3. If restored `phase === 'active'`, immediately `router.replace('/call')`.
4. On 404 or error, stay in IDLE.

The server reads `t:{tid}:in_flight:{user_id}_*` from Valkey (written/maintained by E06 janitor).

---

## 4. Zustand store — A04 additions to `useCallStore`

A01 PLAN §5.1 specifies the base `useCallStore` fields (`callUuid`, `lead`, `phase`, `direction`, `startedAt`, `muted`, `recording`, `lastEventSeq`). A04 adds the following fields **additively** (no breaking changes to existing consumers):

### 4.1 New fields

| Field | Type | Default | Set by | Read by |
|---|---|---|---|---|
| `attemptUuid` | `string \| null` | `null` | A04 on submit | A04 (cancel_dial body), A05, A06 |
| `dialMode` | `'manual' \| 'next' \| 'preview' \| null` | `null` | A04 on submit | A04 (display variant), A06 (dispo defaults) |
| `blockReason` | `{ code: DialErrorCode; message: string; retryAfter?: number } \| null` | `null` | A04 on 4xx | A04 BLOCKED screen |
| `clientGates` | `ClientGates` (see §4.2) | all-false | A04 on form change | A04 DialButton only |
| `hopperClaimToken` | `string \| null` | `null` | A04 preview mode from `/next_lead` | A04 `/preview_skip` body |

### 4.2 `ClientGates` type

```typescript
type ClientGates = {
  phoneValid: boolean;                             // libphonenumber-js parse
  tcpaHint: 'allow' | 'skip_until' | 'block' | 'unknown';
  dncHint: 'clear' | 'hit' | 'unknown';
  agentReady: boolean;                             // useAgentStore.status === 'ready'
  noInFlight: boolean;                             // phase === 'idle' || phase === 'lead_selected'
  campaignActive: boolean;                         // campaigns.active from TanStack cache
};
```

### 4.3 New actions

```typescript
// Additive to existing useCallStore actions
startManualDial(input: { phone: string; leadId?: number; dialMode: 'manual' | 'next' | 'preview' }): void;
setAttempt(attemptUuid: string): void;
setBlock(reason: BlockReason): void;
clearBlock(): void;
setLead(lead: Lead | null): void;
setHopperClaimToken(token: string | null): void;
resetDial(): void;   // back to IDLE; preserves callUuid if a real call exists on A05
restoreFromServer(data: { attempt_uuid: string; phase: string; lead: Lead; started_at: string }): void;
```

### 4.4 What stays out of the store

- **Phone form state** (react-hook-form in `ManualDialModal`; unmounts when modal closes).
- **Lead search results** (TanStack Query cache, `staleTime: 60_000`).
- **Lead history** (TanStack Query cache, `staleTime: 30_000`).
- **Compliance/DNC mirror queries** (TanStack Query cache, `staleTime: 30_000`).

This preserves the A01-mandated three-source-of-truth split: Zustand for cross-page event-driven state, TanStack Query for server state, react-hook-form for form state.

---

## 5. Lead preview card

The preview card answers 6 questions at a glance: who, where, history, compliance flags, script snippet, custom data. It is a **pure component** — the parent (`DialShell`) fetches all data and passes it as props. No data fetching inside the card.

### 5.1 Fields displayed

| Section | Fields | Source |
|---|---|---|
| Header | Name (`title + first + last`; fallback `vendor_lead_code`), phone (formatted `+1 (415) 555-1234`), phone type | `GET /api/leads/:id` |
| Location | City, state, postal, local time (`4:42 PM PST`), TCPA window indicator | Lead row + `date-fns-tz` |
| Compliance badges | DNC status chip, TCPA window badge, recording-consent badge | C01 mirror, D05 mirror, vendored `consentMatrix` |
| History | Last ≤10 prior calls: `{date, duration, status, agent_name}` | `GET /api/leads/:id/history?limit=10` |
| Custom fields | Keys in `agent_visible_keys` allowlist; PII-redacted fields → `••••5678` | Lead row + M03 config |
| Script snippet | First 200 chars of `campaigns.script` with `{{lead.first_name}}` substituted | `GET /api/campaigns/:id/script` (5-min TanStack cache) |

### 5.2 Data fetch strategy

All requests fire in parallel via `Promise.allSettled`. The lead name/phone (fastest) unblocks the main card paint. Compliance + DNC results are non-blocking: the card renders without them; the Call button remains disabled until they resolve or until 30-s stale-cache fallback fires.

| Request | Budget | Stale time |
|---|---|---|
| `GET /api/leads/:id` | ≤50 ms p95 | 30 s |
| `GET /api/compliance/window` | ≤5 ms (pure function) | 30 s; invalidated on `compliance.window_changed` WS |
| `GET /api/dnc/check` | ≤10 ms p99 | 30 s |
| `GET /api/leads/:id/history` | ≤100 ms p95 | 30 s |
| `GET /api/campaigns/:id/script` | ≤200 ms cold / ≤50 ms cached | 5 min |

### 5.3 Time-zone display

Always display the **lead's local time** in the lead's timezone (not the agent's). Format: `4:42 PM PST`. The TCPA window indicator shows the lead's calling window bounds: `(8AM–9PM ✓)` or `✗ outside window — re-opens at 8:00 AM PST (in 3h 5m)`. This prevents timezone-math compliance violations (RESEARCH §5.3).

### 5.4 PII redaction

Fields with `redact_in_preview=true` (set in M03) render as `••••5678`. No full value is ever sent to the browser in the preview context.

### 5.5 Custom fields bounds

Maximum 80 chars per value; truncated with "show more" disclosure. Only `agent_visible_keys` keys render. `Object.entries` insertion order preserved.

---

## 6. Compliance gates — client pre-check

### 6.1 Gate matrix

| Gate | Server | Client pre-check | Method |
|---|---|---|---|
| 1. `gateway-cap` | ~150 µs Valkey | **No** — live counter only | — |
| 2. `drop-cap` | ~150 µs Valkey | No | — |
| 3. `tcpa` | C01.Check | **Yes** — `GET /api/compliance/window` mirror | `clientGates.tcpaHint` |
| 4. `dnc` | D05.IsDnc Bloom | **Yes** — `GET /api/dnc/check` mirror | `clientGates.dncHint` |
| 5. `consent` | vendored 12-state table | **Yes** — same table, imported from `@vici2/types` | `consentMatrix[lead.state][campaign.recording_mode]` |

Gates 1 + 2 failure surfaces as BLOCKED after Call-click with a retryable error. Client pre-check prevents "flash-of-enabled-button" UX for the 3 predictable gates.

### 6.2 Server-authoritative mismatch UX

If `POST /manual_dial` returns 403 `DNC_BLOCKED` even though client showed "DNC clean":
- Show BLOCKED screen with server reason + explanation: "Our records updated since you opened this lead. This number was added to the DNC list at 11:43 AM PST."
- Emit `client_gate_mismatch` metric to O01 with `{client_decision, server_decision, gate}`.
- Do NOT block legitimate retries: if server allows despite a stale client cache, transition to CALLING normally.

### 6.3 No agent-side DNC bypass

Per D05 PLAN §0 bullet 8: agents cannot bypass DNC. BLOCKED-by-DNC shows "Contact your supervisor to request a bypass" (link opens M06 ticket modal, out of A04 scope). No "Override anyway?" button is rendered. (TCPA defendant case law: Lacher v. Saperstein, 2023 — agent-side override button admitted as evidence of willful violation.)

### 6.4 Compliance-window display

Outside-window display format:
```
📍 Lead local time: 4:55 AM PST   ✗ outside calling window
⏰ Re-opens at 8:00 AM PST — in 3h 5m
[ Schedule callback ]   [ Try another lead ]
```

Inside-window format:
```
📍 Lead local time: 4:42 PM PST   ✓ within calling window (8AM–9PM PST)
📅 Window closes at 9:00 PM PST (in 4h 18m)
```

Maine strict-rule format (C01 `BLOCK_INVALID` + `consent_required` reason):
```
⛔ Maine — autodial-only-with-consent
Manual dial allowed only with documented prior consent
[ Mark as consent-confirmed and dial ]   [ Skip ]
```

The "Mark as consent-confirmed" button is visible only when: C01 returns `BLOCK_INVALID` with `consent_required`, agent `role === 'agent'`, and `user_group.can_attest_consent === true` AND `campaign.consent_attestation_allowed === true`. Clicking sets `consent_attested: true` in the POST body, which T04 logs to `originate_audit.consent_attested`. This is an attestation of prior consent, not a compliance bypass.

---

## 7. Call button — disabled-state taxonomy

### 7.1 The 6 disabled states (FROZEN)

| Code | Trigger condition | Tooltip | Inline error | Icon |
|---|---|---|---|---|
| `INVALID_PHONE` | `clientGates.phoneValid === false` | "Phone must be E.164 (example: +14155551234)" | "Invalid phone number format" | — |
| `OUTSIDE_TCPA_WINDOW` | `tcpaHint === 'skip_until' \|\| 'block'` | "Outside calling window. Re-opens at 8:00 AM PST (in 4h 12m)." | "Outside calling window — re-opens at 8:00 AM PST" | 🕒 |
| `DNC_HIT` | `dncHint === 'hit'` | "On DNC list (federal). Cannot dial." | "Federal DNC — cannot dial" | 🚫 |
| `AGENT_NOT_READY` | `agentReady === false` | "You are paused — un-pause to dial" | "Un-pause to enable dialing" | ⏸ |
| `CALL_IN_FLIGHT` | `noInFlight === false` | "A call is in flight. Cancel or complete it first." | *(button hidden; Cancel shown instead)* | — |
| `CAMPAIGN_PAUSED` | `campaignActive === false` | "Campaign paused — calls disabled" | "Campaign is paused — switch campaigns or wait" | — |

When multiple blockers exist simultaneously, show the highest-severity: `DNC_HIT > OUTSIDE_TCPA_WINDOW > INVALID_PHONE > AGENT_NOT_READY > CAMPAIGN_PAUSED`.

### 7.2 `aria-disabled` pattern (WCAG 4.1.2)

Use `aria-disabled="true"` (NOT HTML `disabled`) so the button stays in the tab order. Pattern:

```tsx
<button
  role="button"
  aria-disabled={!canDial}
  aria-describedby="dial-btn-reason"
  onClick={canDial ? handleCall : () => announceBlockReason()}
  className={canDial ? 'btn-primary' : 'btn-primary opacity-50 cursor-not-allowed'}
>
  Call
</button>
<span id="dial-btn-reason" aria-live="polite" className="text-sm text-amber-700">
  {!canDial && blockReasonText}
</span>
```

Clicking the `aria-disabled` button announces reason via Sonner toast and the `aria-live` region. The `aria-describedby` text is the long-form accessible string (not the tooltip abbreviation).

### 7.3 Cancel button (during CALLING)

Once `phase === 'calling'`, the Call button is replaced by a red "Cancel" button. Pressing it (or Esc) calls `onCancel()`:

```typescript
async function onCancel() {
  const { attemptUuid, phase } = useCallStore.getState();
  if (phase === 'active') { router.push('/call'); return; }
  const res = await fetch('/api/agent/cancel_dial', {
    method: 'POST',
    body: JSON.stringify({ attempt_uuid: attemptUuid }),
  });
  if (res.status === 409) { router.push('/call'); return; } // ALREADY_BRIDGED race
  useCallStore.getState().resetDial();
}
```

Cancel is NOT available after `call.bridged` — the Hangup button on A05 takes over.

---

## 8. Optimistic UI and handshake protocol

### 8.1 The 4-step handshake timeline

```
T+0    Agent clicks Call. State: CALL_REQUESTED. Button spinner.
T+50   HTTP 200 {attempt_uuid}. State: CALLING. "Calling…" + Cancel button.
T+150  WS call.originated — FS accepted the bgapi job.
T+800  WS call.ringing (CHANNEL_PROGRESS) — "Ringing…"
T+4200 WS call.bridged (CHANNEL_BRIDGE) — navigate to /call; A05 takes over.
```

### 8.2 Slow / failure paths

```
T+30000  No WS event: "Still ringing — Cancel?" + count-up timer.
T+45000  WS call.failed (NO_ANSWER): BLOCKED "No answer — try another lead."

T+50    HTTP 400 INVALID_PHONE:    BLOCKED + inline form error.
T+50    HTTP 403 TCPA_BLOCKED:     BLOCKED "Outside calling window."
T+50    HTTP 403 DNC_BLOCKED:      BLOCKED "On federal DNC list."
T+50    HTTP 503 GATEWAY_LIMIT:    Toast "Carrier at capacity — retry." + auto-retry at 5 s.
T+50    HTTP 409 AGENT_DIAL_LOCK:  BLOCKED "Another tab is dialing."
T+50    HTTP 500 INTERNAL:         Toast + bug-report link.
```

### 8.3 Why we wait for HTTP 200 before CALLING

(a) The server runs all 5 compliance gates synchronously (~3 ms) — optimistic CALLING + rollback on 4xx is worse UX than waiting 50 ms. (b) We need the canonical `attempt_uuid` from the server for idempotent cancel.

### 8.4 `attempt_uuid` idempotency

The client generates a UUIDv4 (`crypto.randomUUID()`) before the first POST. On network timeout + retry, the same UUID is sent. T04's `originate_audit` UNIQUE index on `attempt_uuid` returns the cached result. No duplicate originates on flaky networks.

### 8.5 Multi-tab coordination

```typescript
// DialBroadcastChannel.tsx (hook component, renders null)
const bc = new BroadcastChannel('vici2-agent-dial');
bc.postMessage({ event: 'dial-started', attempt_uuid });   // on submit
bc.onmessage = (e) => {
  if (e.data.event === 'dial-started') {
    useCallStore.getState().setBlock({ code: 'AGENT_DIAL_LOCK', message: '...' });
  }
};
```

Server `t:{tid}:agent:{id}:dialing` SETNX lock (TTL = `dial_timeout_sec + 5`) is the authoritative guard. `BroadcastChannel` is defense-in-depth for same-origin tabs.

---

## 9. API endpoints (FROZEN)

### 9.1 Owned by A04

| Method | Path | Auth | Request body (Zod) | 2xx response | Notable 4xx codes |
|---|---|---|---|---|---|
| `POST` | `/api/agent/manual_dial` | `requireAuth + requireAgent` | `{ phone: e164, lead_id?: number, alt_dial?: boolean, attempt_uuid: uuid, consent_attested?: boolean, post_answer_digits?: string }` | `200 { attempt_uuid, lead }` | `400 INVALID_PHONE`, `403 TCPA_BLOCKED` (+`nextOpenAt`), `403 DNC_BLOCKED` (+`sources`), `403 CONSENT_BLOCKED`, `409 AGENT_DIAL_LOCK`, `409 AGENT_NOT_READY`, `503 GATEWAY_LIMIT`, `503 CARRIER_FAIL` |
| `POST` | `/api/agent/cancel_dial` | `requireAuth + requireAgent` | `{ attempt_uuid: uuid }` | `200 { cancelled: true }` | `404 NOT_FOUND`, `409 ALREADY_BRIDGED`, `409 NOT_YOUR_CALL` |
| `GET` | `/api/agent/next_lead` | `requireAuth + requireAgent` | query: `campaign_id?` | `200 { lead, claim_token }` | `404 NO_LEAD`, `409 AGENT_NOT_READY` |
| `POST` | `/api/agent/preview_skip` | `requireAuth + requireAgent` | `{ lead_id, claim_token, reason: 'skipped'\|'dnc'\|'callback', dnc?: boolean, callback_at?: ISO8601 }` | `200 { released: true }` | `404 NOT_FOUND`, `409 STALE_CLAIM` |
| `GET` | `/api/agent/current_call` | `requireAuth + requireAgent` | — | `200 { attempt_uuid?, phase, lead?, started_at? }` | `404 NO_CALL` |

### 9.2 Read-only consumers (not owned by A04)

| Method | Path | Owner | A04 purpose |
|---|---|---|---|
| `GET` | `/api/leads/lookup?phone=` | D01 | Lead search in ManualDialModal |
| `GET` | `/api/leads/:id` | D01 | Full lead for preview card |
| `GET` | `/api/leads/:id/history?limit=10` | D01 | History tab in preview card |
| `GET` | `/api/compliance/window?phone=&campaign_id=` | C01 mirror | TCPA client hint |
| `GET` | `/api/dnc/check?phone=&campaign_id=` | D05 | DNC client hint |
| `GET` | `/api/campaigns/:id/script` | M02 | Script snippet in preview card |
| `GET` | `/api/campaigns/active` | M02 | List of campaigns agent is assigned to |

### 9.3 Error response shape (F05 envelope)

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

`code` is a fixed enum. Client switches on `code` to select UX path. `request_id` matches the F05 `X-Request-ID` response header.

### 9.4 `DialErrorCode` enum (FROZEN)

```typescript
type DialErrorCode =
  | 'INVALID_PHONE'
  | 'TCPA_BLOCKED'
  | 'DNC_BLOCKED'
  | 'CONSENT_BLOCKED'
  | 'GATEWAY_LIMIT'
  | 'CARRIER_FAIL'
  | 'AGENT_DIAL_LOCK'
  | 'AGENT_NOT_READY'
  | 'PENDING_DISPO'
  | 'CALL_FAILED'
  | 'ALREADY_BRIDGED'
  | 'NOT_YOUR_CALL'
  | 'STALE_CLAIM'
  | 'CAMPAIGN_PAUSED'
  | 'COUNTRY_NOT_ALLOWED';
```

### 9.5 Phase-1 next-lead SQL algorithm

```sql
-- Handler: GET /api/agent/next_lead
START TRANSACTION;
SELECT l.id, l.list_id, l.phone_e164, l.status, l.tz_offset_min, l.state,
       l.first_name, l.last_name, l.city, l.state_abbr, l.postal_code,
       l.custom_data, l.called_count, l.last_called_at
FROM leads l
JOIN campaign_lists cl ON cl.list_id = l.list_id
WHERE cl.campaign_id = ?
  AND l.tenant_id = ?
  AND l.status IN (
    SELECT status FROM campaign_dial_statuses WHERE campaign_id = ?
  )
  AND (l.last_called_at IS NULL
       OR l.last_called_at < NOW() - INTERVAL <recycle_delay_min> MINUTE)
  AND l.called_count < <max_dial_count>
ORDER BY l.list_id ASC, l.id ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

-- Advisory claim (Valkey, not MySQL — avoids hot-row contention)
-- SET t:{tid}:lead_claim:{lead_id} "{user_id}" EX 30 NX
-- On SETNX failure: retry the SQL loop (another agent claimed it, SKIP LOCKED returns next)
COMMIT;
```

Per-agent claim is stored in **Valkey** (`t:{tid}:lead_claim:{lead_id}` STRING, TTL 30 s) — not a MySQL `lead_agent_claims` table. Same advisory-lock pattern as E01 PLAN §1.7; key prefix is different to avoid E01 collision when E01 ships in Phase 2 (E01 uses `t:{tid}:hopper:claim:{lead_id}`).

Three open-question resolutions (RESEARCH §16):
- **Q1:** Valkey advisory lock (not `FOR UPDATE SKIP LOCKED` alone) to prevent MySQL hot-row starvation under high concurrency.
- **Q2:** No auto-fetch on campaign join — explicit click only.
- **Q9:** Preview-mode Skip is recyclable per `campaigns.skip_recycle_minutes` (default 1440 min). `/preview_skip` writes to E01's release flow.

---

## 10. WebSocket events

A04 subscribes to these events from `lib/ws.ts` (the singleton established by A01). A04 never publishes WS messages; it only POSTs REST.

### 10.1 Event subscription in `DialShell.tsx`

```typescript
useEffect(() => {
  return useWebSocket().subscribe((event) => {
    switch (event.type) {
      case 'call.originated':
        useCallStore.getState().setAttempt(event.data.attempt_uuid);
        break;
      case 'call.ringing':
        useCallStore.getState().setCallUuid(event.data.call_uuid);
        break;
      case 'call.bridged':
        useCallStore.getState().setPhase('active');
        router.push('/call');
        break;
      case 'call.failed':
        useCallStore.getState().setBlock({
          code: 'CALL_FAILED', message: event.data.reason,
        });
        break;
      case 'call.cancelled':
        useCallStore.getState().resetDial();
        break;
      case 'agent.state_changed':
        if (event.data.user_id === useAuthStore.getState().user?.id) {
          useAgentStore.getState().setStatus(event.data.status);
          // clientGates.agentReady re-computed in DialButton
        }
        break;
      case 'compliance.window_changed':
        queryClient.invalidateQueries({ queryKey: ['compliance', 'window'] });
        break;
    }
  });
}, []);
```

If `event.data.attempt_uuid` does not match `useCallStore.getState().attemptUuid`, the event is silently ignored and a `vici2_ws_unmatched_event_total` metric is incremented. Lost events are recovered by `lib/ws.ts`'s `{op:"resume", from:lastSeq}` on reconnect.

### 10.2 WS dropped during CALLING

If `useWsStore.connection === 'reconnecting'` while in CALLING: show "Live updates paused — call still in progress" banner. Do NOT assume failure. Keep showing "Calling…" with count-up timer (`started_at` available from the HTTP response). If WS never reconnects within 60 s, show "Lost connection — please refresh" overlay. Refresh → `/current_call` restores state.

---

## 11. Hotkeys

### 11.1 Phase-1 default bindings (FROZEN)

| Key | Action | Scope | `enableOnFormTags` |
|---|---|---|---|
| `Enter` | Submit form / Call selected lead | `dial-page` (not inside inputs — native submit handles input Enter) | `false` |
| `Esc` | Cancel modal / Cancel in-flight call / Back to IDLE | `always` | `true` (shadcn Dialog uses Esc natively) |
| `n` | Click "Dial Next Lead" | `dial-page` | `false` |
| `m` | Open "Manual Dial" modal | `dial-page` | `false` |
| `/` | Focus phone search input | `dial-page` | `false` (suppress browser default) |
| `s` | Schedule callback (preview mode only) | `lead_selected` state | `false` |
| `Ctrl+Enter` | DNC-this-number + skip (preview mode only) | `lead_selected` state | `false` |
| `Ctrl+M` | Toggle mute (placebo pre-bridge; real in A05) | `global` | `false` |
| `Ctrl+P` | Pause toggle (declared by A04; owned by A09) | `global` | `false` |
| `?` | Open hotkey cheatsheet modal | `global` | `false` |
| `Tab` / `Shift+Tab` | Form navigation | `always` | browser default preserved |
| `Space` (on focused Call button) | Click | `button-focused` | browser default preserved |

### 11.2 Scope enforcement

```typescript
useHotkeys('n', onNextLead, {
  enabled: () =>
    useCallStore.getState().dialPhase.state === 'idle' &&
    !isInputFocused(),
  enableOnFormTags: false,
});
```

`isInputFocused()` checks `document.activeElement?.tagName` in `['INPUT', 'TEXTAREA', 'SELECT']` plus `contentEditable`. `react-hotkeys-hook` v4 respects `enableOnFormTags: false` by default.

### 11.3 Cheatsheet modal

`?` opens a Radix Dialog that iterates the hotkey registry (not a hard-coded list). Each hotkey shows `{key, action, scope}`. Future modules (A05, A06, A07) that register bindings appear automatically. Focus-trapped; Esc closes; `aria-labelledby="hotkey-cheatsheet-title"`.

### 11.4 Phase-2 remapping

Phase 2 (M01 admin settings): supervisors can push per-agent `useUiStore.hotkeyOverrides`. A04's registry consults this map on mount; missing key → default binding.

### 11.5 Focus management per transition (WCAG 2.4.3)

| Transition | Focus target | SR announcement |
|---|---|---|
| `IDLE → MODAL_OPEN` | `#phone-input` | "Manual Dial dialog opened. Phone number, edit text." |
| `MODAL_OPEN → LEAD_SELECTED` | Call button | "Call [Name] at [phone], button, press Enter to dial." |
| `LEAD_SELECTED → CALLING` | Cancel button | "Calling… [Name]. Cancel call button." |
| `* → BLOCKED` | "Dismiss" button | `role="alert"` announces block reason immediately. |
| `CALLING → /call` | A05 handles on mount | A05 moves focus to Hangup button. |

---

## 12. Concurrency: Valkey advisory lead-claim lock

### 12.1 Agent lead-claim

Key: `t:{tid}:lead_claim:{lead_id}` (STRING, value = `"{user_id}"`, TTL = 30 s).

Two-step claim on `GET /api/agent/next_lead`:
1. SQL `FOR UPDATE SKIP LOCKED` selects the first eligible lead (skips rows locked by other transactions).
2. After commit, attempt `SET t:{tid}:lead_claim:{lead_id} {user_id} EX 30 NX` in Valkey.
3. If Valkey NX fails (another agent claimed it between SQL select and commit), retry the SQL loop. Under normal load this retry never exceeds 2 iterations.

Self-heal: TTL ensures the claim expires in 30 s even if the agent navigates away or closes the browser. E06 janitor is not responsible for cleaning these; Valkey expiry handles it.

### 12.2 Interaction with E01 hopper (Phase 2)

Phase-1 Valkey key prefix `t:{tid}:lead_claim:{lead_id}` is distinct from E01's future `t:{tid}:hopper:claim:{lead_id}`. When E01 ships, the `GET /api/agent/next_lead` handler will be updated to use E01's atomic claim Lua script instead, and Phase-1 advisory claims will be deprecated. IMPLEMENT note: the handler should log which claim path is used for the transition audit.

### 12.3 Preview-mode hopper claim

Preview mode uses E01's existing `claim_lead_from_hopper.v1.lua` (E01 PLAN §0.7) via the `hopperClaimToken` returned from `GET /api/agent/next_lead`. A04 echoes this token back in `POST /api/agent/preview_skip` body. The E01 Lua release script verifies the token before releasing.

---

## 13. Component tree (FROZEN file paths)

```
web/src/
├── app/
│   └── (agent)/
│       └── dial/
│           ├── page.tsx              'use client'; top-level dial page; mounts DialShell
│           └── loading.tsx           skeleton for Next.js Suspense boundary
├── components/
│   └── dial/
│       ├── DialShell.tsx             state machine root; WS subscriber; layout wrapper
│       ├── IdleHero.tsx              empty-state CTA with Manual Dial / Next Lead / Preview buttons
│       ├── ManualDialModal.tsx       Radix Dialog + react-hook-form + PhoneInput + LeadSearchCombobox
│       ├── PhoneInput.tsx            libphonenumber-js formatting input; autocomplete="tel"
│       ├── LeadSearchCombobox.tsx    shadcn Command; calls GET /api/leads/lookup; debounce 300 ms
│       ├── LeadPreviewCard.tsx       pure component; parent passes lead + gates as props
│       │   ├── LeadHeader.tsx        name + formatted phone + DNC chip
│       │   ├── LeadLocation.tsx      city/state/tz/local-time + TCPA window indicator
│       │   ├── LeadHistoryList.tsx   last ≤10 calls; skeleton on load; empty state
│       │   ├── LeadCustomFields.tsx  agent_visible_keys filtered; redacted fields
│       │   ├── LeadScriptSnippet.tsx template substitution; 200-char truncation + "show full"
│       │   └── LeadComplianceFlags.tsx DNC chip, TCPA badge, recording-consent badge
│       ├── DialButton.tsx            Call button; all 6 disabled states; aria-disabled pattern
│       ├── CancelButton.tsx          in-flight cancel; shown only during CALLING
│       ├── CallStatusBadge.tsx       "Calling… / Ringing… / Bridged" live-region badge
│       ├── DialBlockedScreen.tsx     BLOCKED full-screen overlay; role="alert"; single CTA
│       ├── ComplianceWindowBanner.tsx yellow banner when outside-window (LEAD_SELECTED state)
│       ├── HotkeyCheatsheet.tsx      Radix Dialog; iterates hotkey registry; ? key opens
│       ├── DialBroadcastChannel.tsx  hook component (returns null); BroadcastChannel wiring
│       └── PreviewControls.tsx       Skip / DNC-this / Schedule-callback (preview mode only)
├── lib/
│   ├── agent/
│   │   ├── manualDial.ts            fetch wrapper + Zod response schema + 503-retry
│   │   ├── cancelDial.ts            fetch wrapper + idempotency
│   │   ├── nextLead.ts              fetch wrapper + AbortController support
│   │   └── previewSkip.ts           fetch wrapper
│   ├── compliance/
│   │   ├── windowMirror.ts          TanStack Query hook for GET /api/compliance/window
│   │   ├── dncMirror.ts             TanStack Query hook for GET /api/dnc/check
│   │   └── consentMatrix.ts         vendored 12-state recording-consent table (client-side)
│   ├── hotkeys/
│   │   └── dialPageBindings.ts      registers §11.1 bindings via react-hotkeys-hook v4
│   └── stores/
│       └── call.ts                  A01-owned; A04 appends §4.1 fields + §4.3 actions
└── test/
    ├── unit/
    │   ├── dial.state-machine.test.ts
    │   ├── DialButton.test.tsx
    │   ├── LeadPreviewCard.test.tsx
    │   ├── consentMatrix.test.ts
    │   ├── manualDial.api.test.ts
    │   ├── nextLead.api.test.ts
    │   ├── hotkeys.test.ts
    │   └── multiTab.test.ts
    ├── e2e/
    │   ├── manual-dial.spec.ts
    │   ├── dial-next-lead.spec.ts
    │   ├── preview-mode.spec.ts
    │   ├── compliance-block.spec.ts
    │   ├── dnc-block.spec.ts
    │   ├── refresh-resilience.spec.ts
    │   ├── multi-tab.spec.ts
    │   ├── hotkeys.spec.ts
    │   └── screen-reader.spec.ts
    └── msw/
        └── handlers/
            └── agent-dial.ts        MSW request handlers for unit + component tests
```

### 13.1 Component responsibilities (key decisions)

- **`DialShell`** is the only WS subscriber on this page. All children read from `useCallStore`; none talk to WS directly. `DialShell` also owns the 60-s no-event safety timer.
- **`LeadPreviewCard`** is a pure presentation component. Parent fetches all data and passes props. This makes it trivially testable and Storybook-able.
- **`DialButton`** is the single source of truth for "can the agent click Call." It derives `canDial` from `clientGates` in the store and renders the appropriate disabled state.
- **`DialBlockedScreen`** is a `fixed inset-0` overlay (`z-50`) because BLOCKED is rare and critical — it must not compete for attention with other UI elements.
- **`DialBroadcastChannel`** renders null; it exists only for its side-effectful `useEffect` (BroadcastChannel setup).

---

## 14. State management summary

| State type | Tool | Slice / key | Persisted? |
|---|---|---|---|
| Cross-page call state (`phase`, `lead`, `attemptUuid`, `blockReason`, `clientGates`, `hopperClaimToken`) | Zustand `useCallStore` | `call` slice (A01 extended by A04) | No (session only) |
| Agent status (ready/paused) | Zustand `useAgentStore` | `agent` slice (A01 owned; A04 reads) | No |
| UI preferences (sidebar, density, hotkey overrides) | Zustand `useUiStore` | `ui` slice | Yes (`localStorage` via Zustand `persist`) |
| Lead data (full record) | TanStack Query | `['leads', id]` | No (in-memory cache, 30 s stale) |
| Lead history | TanStack Query | `['leads', id, 'history']` | No |
| Compliance window hint | TanStack Query | `['compliance', 'window', phone, campaignId]` | No |
| DNC hint | TanStack Query | `['dnc', 'check', phone, campaignId]` | No |
| Campaign script | TanStack Query | `['campaigns', id, 'script']` | No (5-min stale) |
| Phone input form state | react-hook-form | `ManualDialModal` local | No |

---

## 15. Accessibility (WCAG 2.2 AA)

### 15.1 Criterion mapping

| Criterion | How A04 satisfies |
|---|---|
| 1.1.1 Non-text Content | Icons (`🕒 🚫 ⏸`) have `aria-label` or adjacent visible text. Avatar initials have `alt`. |
| 1.3.1 Info & Relationships | Lead card fields use `<dl><dt><dd>`. History rows use `<ul><li>` with structured text. |
| 1.3.5 Identify Input Purpose | Phone input: `autocomplete="tel"`. Lead search: `autocomplete="off"` (intentional). |
| 1.4.3 Contrast (minimum) | Disabled-state text ≥ 4.5:1. Amber-700 error text meets 4.5:1 on white. Audited via Storybook axe-plugin. |
| 1.4.11 Non-text Contrast | Button borders + focus rings ≥ 3:1. Tailwind `ring-2 ring-offset-2` tokens verified. |
| 1.4.13 Content on Hover or Focus | Tooltips dismissible via Esc, hoverable, persistent. shadcn `<Tooltip>` satisfies all three. |
| 2.1.1 Keyboard | All actions reachable via Tab + Enter/Space. Hotkeys documented (§11). |
| 2.1.2 No Keyboard Trap | Radix Dialog traps focus within modal; Esc always closes. |
| 2.4.3 Focus Order | Logical per §11.5. Focus moves to the primary action on each state transition. |
| 2.4.7 Focus Visible | shadcn `focus-visible:ring-2 ring-ring ring-offset-2` on all interactive elements. |
| 2.4.11 Focus Not Obscured (2.2) | `ComplianceWindowBanner` is `sticky top-0` with explicit padding to clear focus rings. |
| 2.5.7 Dragging Movements (2.2) | No drag-required interactions in A04. |
| 2.5.8 Target Size (2.2) | Call button ≥ 44×44 CSS px. Disabled mini-icons ≥ 24×24 with 44×44 touch hit area via padding. |
| 3.1.2 Language of Parts | All strings from `next-intl` (Phase-1: English pass-through); `lang` attr on `<html>` set by A01. |
| 3.2.6 Consistent Help (2.2) | `?` cheatsheet hotkey is consistent; will be inherited by A05/A06. |
| 3.3.1 Error Identification | Phone input: `aria-invalid="true"` + `aria-describedby` pointing to error message. |
| 3.3.3 Error Suggestion | TCPA blocked: "Re-opens at 8:00 AM PST (in 4h 12m)." DNC: "Contact supervisor to request bypass." |
| 3.3.7 Redundant Entry (2.2) | No multi-step forms in A04. N/A. |
| 4.1.2 Name, Role, Value | `DialButton` has `role="button"`, `aria-disabled`, `aria-describedby`. `CallStatusBadge` has `role="status"`. |
| 4.1.3 Status Messages | `role="status"` on Calling/Ringing badge (`aria-live="polite"`). `role="alert"` on `DialBlockedScreen`. |

### 15.2 Screen-reader test rehearsal

Using NVDA + Chrome (WebAIM 2024: 41.9% market share pairing):

1. Tab to Dial page → "Manual Dial, button."
2. Enter → modal opens; SR: "Manual Dial dialog. Phone number, telephone, edit text, blank."
3. Type number → SR echoes typed chars; on valid: "Phone, +1 415 555 1234."
4. Enter → modal closes; focus moves to Call button; SR: "Call Jane Doe at +1 415 555 1234, button, press Enter to dial."
5. Enter → SR: "Calling Jane Doe. Cancel button." (polite live region).
6. `call.bridged` → `/call`; A05 SR contract takes over.

No SR silence > 1 s; no blank announcements; no internal IDs.

### 15.3 Forced-colors / High-contrast

`@media (forced-colors: active)`: use `ButtonText`, `Canvas`, `CanvasText`, `Highlight`, `LinkText`. No Tailwind tone colors in forced-colors context. Focus rings use `Highlight` system color. Cancel button uses `ButtonText` on `Canvas`.

### 15.4 Reduced motion

`@media (prefers-reduced-motion: reduce)`: count-up timer becomes a static "Calling…" string. Sonner toasts skip slide-in animation. Call button spinner is static.

---

## 16. Test plan

### 16.1 Unit (Vitest + React Testing Library + MSW)

| File | Coverage target |
|---|---|
| `test/unit/dial.state-machine.test.ts` | All 7 states × all transitions; invalid transitions throw; idempotency of `setPhase` |
| `test/unit/DialButton.test.tsx` | All 6 disabled states: correct tooltip, `aria-describedby`, inline error, and toast-on-click |
| `test/unit/LeadPreviewCard.test.tsx` | Full lead, missing name, no history, DNC-hit, outside-window, redacted PII, 47 custom fields, `agent_visible_keys` filtering |
| `test/unit/consentMatrix.test.ts` | All 12 state rows return correct `consent_required` boolean; non-listed states default to one-party |
| `test/unit/manualDial.api.test.ts` | MSW returns 200/400/403/503; client handles each; idempotency on duplicate `attempt_uuid` |
| `test/unit/nextLead.api.test.ts` | 200 + lead, 404 `NO_LEAD`, 409 `AGENT_NOT_READY`, AbortController cancels in-flight |
| `test/unit/hotkeys.test.ts` | n/m/Enter/Esc fire on correct scope; do NOT fire when input is focused |
| `test/unit/multiTab.test.ts` | `BroadcastChannel` message disables Call in receiving tab; server 409 shows BLOCKED |

### 16.2 Component (Storybook + axe-storybook)

Stories with `play` functions for every component. `axe-storybook` runs on every story; CI fails on AA violation. Stories include:
- `DialButton`: enabled, 6 disabled states, loading.
- `LeadPreviewCard`: full, missing-name, DNC-hit, outside-window, redacted-PII, no-history, 47 custom fields.
- `DialBlockedScreen`: TCPA, DNC, gateway-503, agent-not-ready, campaign-paused.
- `ManualDialModal`: empty, typing, search results, validation error, submitting.

### 16.3 E2E (Playwright)

WS is injected via `page.addInitScript()` test double (lib/ws.ts swapped for a controllable mock). HTTP boundary is intercepted with MSW via Playwright's `route`. Real frontend state machine, no FS.

| File | Scenario |
|---|---|
| `test/e2e/manual-dial.spec.ts` | Open modal → type phone → validate → submit → CALLING → mock WS bridge → navigate to /call |
| `test/e2e/dial-next-lead.spec.ts` | Click Dial Next Lead → lead in preview → click Call → CALLING → cancel mid-ring → back to LEAD_SELECTED |
| `test/e2e/preview-mode.spec.ts` | Skip, DNC-this-number, Schedule-callback — all three actions release hopper claim |
| `test/e2e/compliance-block.spec.ts` | CA lead at 3 AM Pacific → C01 returns `SKIP_UNTIL` → BLOCKED screen with next-open-at |
| `test/e2e/dnc-block.spec.ts` | Federal DNC lead → POST 403 → BLOCKED screen; no override button visible |
| `test/e2e/refresh-resilience.spec.ts` | Submit → refresh during CALLING → state restores from `/current_call` |
| `test/e2e/multi-tab.spec.ts` | Two Playwright pages (same origin) → submit in tab A → tab B Call button disabled via BroadcastChannel |
| `test/e2e/hotkeys.spec.ts` | Drive full flow keyboard-only: n → Enter → Esc → m → type → Enter → Enter → Esc |
| `test/e2e/screen-reader.spec.ts` | Playwright accessibility-tree queries verify announcement chain per §15.2 |

### 16.4 Visual regression (Chromatic)

Snapshot on every Storybook story. 0.1 % pixel-diff threshold. PR review surfaces visual diffs.

### 16.5 Performance budget (CI-gated, inherits A01 §0.9)

| Metric | Budget |
|---|---|
| TTI on `(agent)/dial` page | ≤ 1.5 s on cable (Lighthouse CI) |
| Agent-route bundle size | ≤ 250 KB gzipped (incremental from A01; `@next/bundle-analyzer`) |
| Phone validation render lag | ≤ 50 ms p95 (`useDeferredValue` on phone field) |
| Lead preview card paint after `/leads/:id` response | ≤ 200 ms p95 |
| Call button disabled → enabled update on form change | ≤ 16 ms (one frame) |

### 16.6 Compliance audit verification

- Every `POST /manual_dial` writes an `originate_audit` row (integration test reads MySQL after POST, asserts row exists with correct `tenant_id`, `user_id`, `attempt_uuid`, gate outcomes).
- `consent_attested=true` in request body persists to `originate_audit.consent_attested=true`.
- BLOCKED screen's `request_id` matches the `X-Request-ID` header in the server log.

---

## 17. Acceptance criteria

Mapped to A04.md verification scenarios:

| Scenario | Criterion | How verified |
|---|---|---|
| V1: Manual dial of a known number | Agent opens modal, enters `+14155551234`, lead auto-matches from D01, agent sees preview card, clicks Call, state → CALLING within 200 ms of HTTP 200 | E2E `manual-dial.spec.ts` |
| V2: Manual dial of an unknown number | Same flow; zero search results; "Create lead in list X" hint shown; dial proceeds; new lead row created in DB | E2E `manual-dial.spec.ts` step 4 variant |
| V3: Dial Next Lead | Click button → lead appears in ≤ 1 s; agent calls; lead's `called_count` incremented in MySQL | E2E `dial-next-lead.spec.ts`; integration test |
| V4: TCPA compliance block | Lead in California; server time 03:00 AM PST; `POST /manual_dial` returns 403 `TCPA_BLOCKED`; BLOCKED screen shows "Re-opens at 8:00 AM PST" with `nextOpenAt`; no override button visible | E2E `compliance-block.spec.ts` |
| V5: DNC block | Lead's phone in federal DNC; POST returns 403 `DNC_BLOCKED`; BLOCKED screen; no override; "Contact supervisor" link visible | E2E `dnc-block.spec.ts` |
| V6: In-flight cancel | Agent clicks Cancel during CALLING; `POST /cancel_dial` succeeds; state returns to `LEAD_SELECTED`; lead preserved | E2E `dial-next-lead.spec.ts` cancel variant |
| V7: Cancel race (bridge beats cancel) | `/cancel_dial` returns 409 `ALREADY_BRIDGED`; page navigates to `/call`; A05 shows active call | E2E multi-event Playwright test |
| V8: Refresh during CALLING | Reload → `/current_call` → state restores; "Calling…" banner; Cancel available | E2E `refresh-resilience.spec.ts` |
| V9: Multi-tab lock | Two tabs; Tab A submits; Tab B's Call button disabled; Tab B shows toast "Another tab is dialing" | E2E `multi-tab.spec.ts` |
| V10: Keyboard-only flow | Full flow via keyboard; zero mouse events; axe zero violations | E2E `hotkeys.spec.ts` + Storybook axe |
| V11: Handoff to A05 | On `call.bridged`, `router.push('/call')` fires; A04 unmounts; A05 renders with correct `lead` + `callUuid` from store | E2E `manual-dial.spec.ts` final assertion |
| V12: Preview mode skip | Agent in preview campaign; lead shown; clicks Skip; hopper claim released; next lead fetched automatically | E2E `preview-mode.spec.ts` |

---

## 18. Dependencies and risks

### 18.1 Hard dependencies (blocks IMPLEMENT)

| Dependency | Status | A04 wait for |
|---|---|---|
| A01 PLAN | PROPOSED | `(agent)/dial/` route slot, `useCallStore` base shape, `lib/ws.ts` API, `KeyboardListenerProvider` slot |
| A02 PLAN | PROPOSED | `useSoftphone()` hook — A04 doesn't call it directly in Phase 1 (no audio leg pre-bridge), but the `post_answer_digits` channel-var handoff uses T04's interface which A02 informs |
| T04 PLAN | PROPOSED | `OriginateRequest` shape, typed error enum, `originate_audit` row contract |
| F05 PLAN | PROPOSED | `requireAuth`, `requireAgent` guards; error envelope shape |
| C01 TS mirror | C01 PLAN PROPOSED | `/api/compliance/window` endpoint availability |
| D05 Bloom mirror | D05 PLAN PROPOSED | `/api/dnc/check` endpoint availability |
| D01 lead REST | D01 PLAN PROPOSED | `/api/leads/:id`, `/api/leads/lookup`, `/api/leads/:id/history` |

### 18.2 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Client TCPA hint stale → BLOCKED on server despite "ALLOW" shown | Medium | Low (UX hiccup; server is authoritative) | 30-s stale time; `compliance.window_changed` WS invalidates; mismatch metric to O01 |
| Agent double-clicks Call (double-submit) | High | Medium (duplicate originate) | Button disabled on first click; `attempt_uuid` idempotency on server |
| `BroadcastChannel` unavailable on Safari < 15.4 | Low | Low | Feature-detect; server SETNX lock is the safety net |
| `useCallStore` corrupts across A04 → A05 boundary | Low | High (wrong lead in call panel) | Strict TypeScript; defensive copies in `restoreFromServer`; integration test asserts handoff |
| WS reconnect > 60 s → stuck CALLING UI | Medium | Medium | 60-s hard timeout fires "Lost connection — refresh" overlay; `/current_call` recovers |
| `consent_attested` button mis-used → false consent attestation | Medium | High (TCPA liability) | Per-campaign `consent_attestation_allowed=false` default; per-user-group permission; full audit trail |
| Phone paste with non-printing chars (ZWSP, RLM) | Medium | Low | Normalize via `parsePhoneNumberFromString` before validation; strip non-printing chars |
| `Dial Next Lead` returns same lead twice on network retry | Medium | Medium | Valkey 30-s per-agent claim prevents; SKIP LOCKED avoids concurrent duplicate |
| `lead.custom_data` with 200+ keys causes render jank | Low | Low | `agent_visible_keys` filter; lazy `<details>` render |

---

## 19. Open questions resolved (all 14 from RESEARCH §16)

| # | Resolution |
|---|---|
| 1 | **Valkey advisory lock** (`t:{tid}:lead_claim:{lead_id}`, TTL 30 s) for per-agent claim; `FOR UPDATE SKIP LOCKED` handles DB-level concurrency. |
| 2 | **No auto-fetch** on campaign join — explicit click only. |
| 3 | **Lead's timezone** for all time display; agent-local tz subscript deferred to Phase 4. |
| 4 | **Cancel NOT allowed after `call.bridged`** — the race is handled by checking `phase === 'active'` in `onCancel()`; if so, navigate to `/call` instead. |
| 5 | **No agent-side DNC bypass** — "Contact supervisor" link only; M06 ticket modal out of scope. |
| 6 | **Hand-rolled discriminated-union reducer** — 7 states is below XState complexity threshold. |
| 7 | **No wrap-up timer in A04** — A06 owns that display; A04 only respects `phase === 'idle'` arrival. |
| 8 | **Ctrl+P owned by A09**; A04 only declares it in the registry (so cheatsheet shows it); A09 implementation wins at runtime. |
| 9 | **Preview Skip is recyclable** per `campaigns.skip_recycle_minutes` (default 1440 min). |
| 10 | **`BroadcastChannel`** for multi-tab coordination; localStorage-event fallback deferred to Phase 2 if needed. |
| 11 | **Allow dial even if WS is reconnecting** — originate is HTTP-driven; show "Live updates paused" banner; do not block. |
| 12 | **`consent_attested` button**: visible when (C01 `BLOCK_INVALID` with `consent_required`) AND (`agent.role === 'agent'`) AND (`user_group.can_attest_consent === true`) AND (`campaign.consent_attestation_allowed === true`). All four conditions required. Default = `consent_attestation_allowed=false`. |
| 13 | **Auto-create lead on unknown manual-dial phone is ON by default** for `role === 'agent'`; configurable per-campaign via `campaign.auto_create_lead` (default `true`). |
| 14 | **Call queue depth / ready-agent count** is out of A04 scope — it lives in A01's `<AgentShell/>` bottom bar. A04 must not paint over it. |

---

## 20. What IMPLEMENT must NOT do

- Do not import `sip.js` or `@/lib/sip/` inside any A04 component (ESLint `no-restricted-imports` rule from A02 PLAN; SIP.js access is via `useSoftphone()` only, and A04 Phase 1 does not need direct softphone calls — T04's originate drives the call from the server).
- Do not write to the hopper ZSET directly — all hopper interaction is via `GET /api/agent/next_lead` and `POST /api/agent/preview_skip`.
- Do not render Hangup, Hold, or Mute controls (A05 owns these).
- Do not use native HTML `disabled` on the Call button — always `aria-disabled`.
- Do not add a DNC bypass button under any condition.
- Do not persist JWT or SIP credentials in localStorage, sessionStorage, or Zustand `persist`.

---

*End of A04 PLAN.*
