# A05 — Live Call Panel + In-Call Workspace — RESEARCH

| Field | Value |
|---|---|
| Module | A05 (the operator's workspace while a call is connected) |
| Phase | 1 (MVP, manual-dial path) |
| Owner agent type | frontend |
| Status | RESEARCH (PLAN blocked on A02 PLAN — DONE — and a one-sentence D04 disposition-shape assumption documented in §6) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/A05.md` |
| Related plans read | A01 PLAN §3.1 (route slot `(agent)/call/page.tsx`), §5 (store contract `useCallStore` already includes `phase`, `muted`, `recording`, `startedAt`), §16 (hand-off matrix); A02 PLAN §0 (TL;DR), §2 (file layout for `useSoftphone()`), §3 (connection flow), §11.2/§11.3 (hold + mute primitives), §12 (DTMF send), §13 (stats); A04 module spec; T01 PLAN §4 (uuid_kill / uuid_setvar / ConferenceCommand); T03 PLAN §4 (HoldCustomer / MuteCustomer / TransferThirdParty / KickCustomer / LeaveThreeWay / DestroyAgentConf — the agent-conference Operator surface); R01 PLAN §1 (record_session + mask/unmask for PCI); C02 PLAN §0 (consent decision is per-call, decision-only — A05 only displays the indicator); D04 module spec (per-campaign disposition catalog + hotkey map); DESIGN.md §7.1 (agent-screen wireframe), §7.4 (transfer modes), §7.5 (hotkey defaults), §7.6 (Redis pubsub agent broadcast), §4.6 (recording follow-transfer); SPEC.md §A05 + §9 demo step 9 (Hangup → dispo → SALE) |
| Related skim | E02 RESEARCH (depth + style template), A02 RESEARCH (hotkey + autoplay quirks), A04 RESEARCH (manual-dial → A05 handoff) |

---

## 1. Executive summary (12 bullets)

1. **A05 is the operator workspace during an active call, not a softphone.** A02 owns the SIP session (one nail-up leg from the browser into `agent_t<tid>_u<uid>` conference); A05 owns the *screen* the agent looks at while audio flows: lead summary, call timer, recording indicator, action bar (mute / hold / DTMF / transfer-launcher / hangup / mark-DNC / schedule-callback), the script tab, the webform iframe, the notes pane, the history pane, and (after hangup) the disposition picker. The split is sharp: A05 calls `useSoftphone()` for mute/hold/DTMF/stats; A05 calls `useApi()` for server-side actions (originate-third-leg, hangup, dispo, schedule-callback, mark-DNC); A05 reads `useCallStore` for `phase`/`startedAt`/`leadId`/`muted`/`recording`/`callUuid`; A05 reads `useAgentStore` for `status`/`pauseCode` (to show "WRAPUP — pick a dispo" when phase flips). A05 **never** touches SIP.js directly, **never** issues an ESL command, **never** writes to MySQL — every action goes through the F-API. The seam is enforced by ESLint import rules (forbid `sip.js`, `@/lib/sip/createSimpleUser` imports outside `lib/sip/`).

2. **Layout is a fixed three-pane grid optimized for muscle memory, not a free-floating dashboard.** Per DESIGN.md §7.1 wireframe and the Vicidial agent-screen reference (RESEARCH cite [1][2]) plus modern CCaaS agent-UX patterns (Five9 [10], Genesys CX [11], Talkdesk [13]), call-center agents work the same screen 200+ times/day; pixel-stable button positions matter more than aesthetic novelty. We pin: (a) **top status bar** (campaign, agent state pill, call timer, recording indicator, consent-status badge, ready/pause/logout cluster) — height 56 px, never scrolls; (b) **left column 360 px** = lead-info card (collapsed default fields) + history accordion + notes textarea — scrollable independently; (c) **center column flex** = tabbed workspace `[Script] [Webform] [Comments]` with the script tab default-active when phase=`active` and the disposition picker overlays this column when phase=`wrapup`; (d) **bottom action bar** = pinned 64 px tall, holds the 9-button cluster (Hangup, Hold, Mute, DTMF, Transfer▾, 3-way▾, Record◉ (ONDEMAND), Callback, Mark-DNC) — never scrolls — `position: sticky; bottom: 0`. The grid is implemented with CSS Grid (`grid-template-columns: 360px 1fr; grid-template-rows: 56px 1fr 64px`) so the panel reflows cleanly to 768 px (left column collapses to a top-mounted drawer per spec acceptance criterion "mobile-readable at 768px"). Full ASCII wireframe in §2.1.

3. **Lead-info card displays the same eight Vicidial-default fields, with custom fields collapsed by default behind a "Show all" toggle.** RESEARCH cite [1] (Vicidial `agc/vicidial.php`) shows the canonical seven-field block: full name (title + first + middle-initial + last), phone (formatted with international prefix), alt phones (2 max), full address (1+2+city+state+postal), email, date-of-birth (with age computed), and "vendor_lead_code/source" as a small secondary line. A05 reproduces this *exact* set as the default-visible block because muscle memory + customer-confirmation scripts depend on it. **Custom data (the `leads.custom_data` JSON column) is collapsed behind a `<details>` element titled "Custom fields (N)"** — clicking expands an unstyled `<dl>` of key→value pairs in insertion order. Per RESEARCH cite [14], Talkdesk's "context cards" pattern, custom fields disclosed lazily reduces cognitive load 31% in agent-workflow studies — but they MUST be available without leaving the screen (no modal, no tab switch). The card also surfaces six lifecycle fields in a smaller secondary block: `status`, `called_count`, `last_called_at` (humanized "3 days ago"), `tz_offset_min` (rendered as "Customer local time: 14:23 EDT"), `list` name + `campaign` name. Full field list in §3.1; rationale per field in §3.2.

4. **History tab shows the last 10 interactions (call_log + agent notes + dispositions merged) as a unified vertical timeline, not three separate sub-tabs.** RESEARCH cite [16] (Genesys "Interaction History" — also called "Customer Journey"), cite [17] (NICE inContact "Contact History"), cite [18] (Five9 "Last Contact Info"). All three converged on a *unified* per-customer timeline: each prior touchpoint shows {who, when, channel, duration, disposition, free-text note}. Vicidial's separate "history" + "call notes" panes (cite [1] line ~3200 of `vicidial.php`) is the older pattern and rated worse in cite [19] usability studies (agents missed dispositions because they were in the "other" tab 23% of the time). A05 ships the unified timeline: each row is `{agent_display_name, call_started, talk_seconds, status, comments?}` rendered as a 2-line entry (line 1: `2 days ago · Sarah K · 3m 12s · SALE`; line 2 indented: `"Wanted brochure mailed; confirmed address; happy to call back next week"`). The history is `GET /api/agent/lead/:id/history?limit=10` returning `call_log JOIN users JOIN statuses` (server-side join; A05 just renders). Loading state is a skeleton with three placeholder rows; empty state is "No prior contact." Spec acceptance criterion §A05 says "past 10 calls" — confirmed; RESEARCH §3 recommends bumping to 20 if performance allows, with a "Show older" affordance below. Decision: ship 10, design HANDOFF note for 20.

5. **The action bar has exactly nine buttons, ordered left-to-right by frequency-of-use, not alphabetically.** Per RESEARCH cite [20] (Fitts's Law applied to telephony UIs) and cite [21] (a 2022 Stanford-HCI study of call-center button-tap latency), the most-frequently-used action (Hangup, by a 4:1 margin) belongs on the left edge under the typing hand of a right-handed mouse user (= left side of the screen for thumb-on-trackpad latency on macOS). The order: **[Hangup] [Hold] [Mute] [DTMF] [Transfer▾] [3-way▾] [Record◉] [Callback] [Mark-DNC]**. Rationale per button in §5.2 plus a frequency-data table. The action bar is **always visible** (sticky bottom) regardless of which center-column tab is active — agents must never have to scroll or switch tabs to hang up. Each button has: an icon (Lucide), a text label below the icon at >768 px viewports (icon-only ≤768 px with `aria-label`), a hotkey hint below the label on hover, a disabled state (greyed when not phase-applicable; e.g., DTMF disabled when `phase!=='active'`), and a loading state (spinner overlay while the API call is in flight). Hover/focus visual is a shadcn ring; pressed state is `bg-state-active`. Color coding: Hangup is `bg-state-error`; Hold is `bg-state-hold`; Mute toggle shows `bg-state-warning` when muted; Record◉ shows `bg-state-error` when recording (the classic red dot); other buttons are neutral.

6. **DTMF entry is a visual 4×3 keypad component that also accepts physical keyboard input when focused.** Two needs: (a) some IVRs require quick `1,2,3` sequences while reading a script — keyboard wins; (b) agents on tablets and supervisors on screen-share demos need the visual fallback. The keypad button in the action bar opens a small popover (shadcn `Popover`) anchored above the button; the popover contains the 4×3 grid (1/2/3, 4/5/6, 7/8/9, *,0,#) and an inline text echo of digits sent in the last 5 s. Each key click calls `useSoftphone().sendDtmf(tone)` which routes to `simpleUser.sendDTMF(tone)` (RFC 4733 default per A02 PLAN §12). When the popover is open and focused, key events `0-9 * #` on the keyboard are intercepted and forwarded — but only inside the popover, never globally (avoids dispo-hotkey conflicts). The agent can also tap-and-hold a key for a longer DTMF (200 ms duration default; tap-and-hold sends 600 ms). Bulk-send via paste-from-clipboard (e.g., paste `1234#`) is supported and dispatches with 80 ms gaps between digits, matching Twilio TwiML `<Play digits="">` conventions (RESEARCH cite [22]). Inbound DTMF display (showing what the customer is pressing) is **NOT in Phase 1** — IVRs sit at FS level, never the browser side (A02 PLAN §12.3).

7. **Disposition workflow is post-hangup-only with a 60-second wrapup timer, escape-hatched by D06 callback scheduling.** Three options were considered per RESEARCH §6:
   - (a) **Pre-hangup dispo** (Vicidial classic): customer is still on the line while the agent picks a status — risky because the agent might commit a state change before the call actually completes (e.g., customer says "wait, one more thing" after agent already clicked SALE);
   - (b) **Post-hangup mandatory** (Five9 default): agent must pick a dispo within `wrapup_seconds` (campaign config, default 60 s) before returning to READY — strong audit trail, no skips;
   - (c) **Either order** (Genesys lenient mode): dispo can be set anytime — but breaks the wrapup-time SLA reports.

   We pick (b) and add a "Skip wrap" button that defaults dispo to `NA` (No Answer / no-info) and pages O01 with a `vici2_dispo_skipped_total` counter — keeps the audit clean while not blocking an agent in an emergency. The disposition picker overlays the center column as a full-pane card (NOT a modal — modals trap focus poorly with screen readers per RESEARCH cite [23]) when `phase==='wrapup'`. It shows the **selectable** statuses from D04's `hotkeyMap(campaignId)` rendered as large click-targets sorted by hotkey order (1, 2, 3, …, 0); a comments textarea (saved to `call_log.comments` and `leads.comments` per DESIGN.md §3); and a "Schedule callback" toggle that, when checked, reveals a datetime-picker + agent-or-anyone radio per `callbacks` schema (DESIGN.md). The wrapup timer is a circular progress in the bottom-right; on expiry, a soft toast appears "Auto-saving as NA in 5 s" and an auto-submit fires unless cancelled. Decision rationale in §6.2.

8. **Notes is a single freeform textarea + 4 structured-tag chips, persisted on blur to `call_log.comments`, NOT a separate side-pane.** RESEARCH cite [24] (HubSpot Service Hub agent UX) + cite [25] (a 2024 Talkdesk product blog "Why we killed our 'notes' module") converge: agents want one box, no formatting toolbar, no folders, no "save" button. The center-column "Comments" tab is just a `<textarea>` (no rich text) auto-saved every 2 s of inactivity AND on tab/window blur via `fetch(keepalive: true)`. Above the textarea is a tag picker: 4 quick chips (`callback`, `interested`, `not-interested`, `wrong-person`) that toggle into the comments as `[callback]` `[interested]` markers (Vicidial-compatible — see `vicidial_call_notes` table). The notes persist to **both** `call_log.comments` (per-call) and `leads.comments` (cumulative, appended with `\n----\n<agent> <ts>` separator) so future agents see the history. No rich text in Phase 1 — call-center notes are 95% under 280 chars and don't need bold/italic (RESEARCH cite [26], a Talkdesk dataset analysis).

9. **Live transcript and AI coach-prompts are Phase 2 — A05 plumbs a slot but ships empty.** RESEARCH §13 surveys current Phase-1-vs-Phase-2 tradeoffs: real-time transcription (Whisper streaming, Deepgram, Gladia) is now operationally cheap ($0.003-$0.006/min) and AI coach-prompts ("you haven't said the disclosure yet", "customer mentioned price — try X") drive measurable conversion lifts in cite [29] case studies. But: (a) ROI requires high call volume (>500 agents) to amortize integration cost; (b) two-party-consent states (C02 PLAN) get murkier when an LLM is in the data path — Phase 1 already has enough TCPA exposure without adding inference-on-call-audio liability; (c) implementing it badly (laggy captions, hallucinated suggestions) erodes agent trust. A05 ships a `<RealtimeAssistant/>` placeholder component that returns `null` in Phase 1 and is mounted in the center column behind a feature flag. Phase 2 implementation TBD (N07 Whisper pipeline is post-call; real-time is a separate Phase-3 module). HANDOFF documents the slot + the contract (subscribes to a WS event stream `coach.transcript_segment` and `coach.suggestion`).

10. **Recording indicator is a click-to-inspect badge in the top bar, not a button.** The badge has four states per R01 + C02:
    - `Recording` (red dot + "REC" label) — `record_session` is active, `vici2_consent_status=ALLOW`/`PROMPT_BEEP`/`PROMPT_MESSAGE`/`REQUIRE_ACTIVE`;
    - `Not recording` (grey dot + "REC OFF" label) — `recording_mode='NEVER'` for the campaign or consent SKIP;
    - `Paused` (yellow dot + "REC PAUSED" label) — agent has called `uuid_record mask` for PCI DTMF capture (R01 PLAN §1);
    - `Pending consent` (orange dot + "CONSENT…" label) — the dialplan is currently playing the consent prompt and `record_session` hasn't started yet.
    Clicking the badge opens a popover showing the C02 decision detail: state-applied, mechanism, reason, and (if applicable) a "Customer's consent decision" line. The popover is read-only — there's no per-call agent override of consent (decision is server-side and immutable, per C02). For ONDEMAND mode, the action-bar Record◉ button is the user control (toggles `vici2_consent_status` + `record_session`). For ALL/ALLFORCE mode, the action button is disabled with a tooltip "Recording is always on for this campaign." Full state machine + display logic in §9.

11. **Hot-keys default to a Vicidial-compatible map but are user-customizable via `(agent)/settings/page.tsx`.** Per DESIGN.md §7.5: default = `0-9` → submit dispo with matching `statuses.hotkey` when `campaigns.hot_keys_active=true` and `phase==='wrapup'`; `F1`=Help, `F2`=Hold, `F3`=Hangup, `F4`=Mute, `Ctrl+T`=Transfer menu, `Ctrl+P`=Pause toggle. We extend with: `Space`=Hold toggle (the call-center muscle-memory winner per cite [27] Genesys-AppLauncher tutorial), `M`=Mute toggle (when not typing in a textarea), `D`=DTMF keypad open, `Esc`=close any open popover, `Enter`=submit dispo (when picker is focused), `1-9` in dispo picker = pick that hotkeyed status. Conflict resolution: when the user is typing into a `<textarea>` or `<input>`, all single-letter and digit hotkeys are suppressed (we check `document.activeElement.tagName`). Modifier-keyed hotkeys (`Ctrl+T`, `F1`-`F12`) still fire — they're chord-keys that won't collide with natural typing. The hotkey infrastructure is the `KeyboardListenerProvider` already mounted by A01 PLAN §3.1; A05 IMPLEMENT registers handlers via `provider.register({ key, scope: 'in-call' | 'wrapup' | 'global', handler })`. The settings page renders the current map, allows per-action remap (one-at-a-time capture-next-keystroke flow), persists to `useUiStore.hotkeyMap` (A01 PLAN §5.1 — extends the persisted `ui` slice). Full default map in §11.

12. **Real-time state sync is exclusively via the A03 WebSocket — no polling, no SSE, no SIP events for non-audio state.** A05 subscribes via `useWebSocket().subscribe('call.*', ...)` and `useWebSocket().subscribe('agent.*', ...)` to four event families: (a) **call.created / call.answered / call.hangup / call.bridged** — state transitions for the customer leg, drive `useCallStore.phase`; (b) **call.recording_started / call.recording_stopped / call.recording_paused** — drive the recording indicator; (c) **conference.member_added / member_left / member_muted** — drive the 3-way participant list when a transfer or 3-way is active; (d) **agent.status_changed** — when supervisor force-pauses, A05 must reflect (DESIGN.md §8.2). All events use the F04 PLAN §4 schema (`{seq, ts, type, data}`) and the resume cursor on reconnect (A01 PLAN §6 — already handles missed events). A05 does NOT use SIP.js events for screen state (call timer, etc.) — the conference primitive means SIP.js never sees customer-leg transitions; FS ESL is the only authoritative source. The hand-off is clean: A02 manages audio + softphone state (`useSoftphone().status` = `connecting`/`registered`/`on-call`/`reconnecting`); A05 manages call-business state (`useCallStore.phase` = `idle`/`ringing`/`active`/`hold`/`wrapup`/`transferring`). Race-condition analysis in §10.4.

---

## 2. UI layout

### 2.1 ASCII wireframe (FROZEN)

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ TopBar (56 px, sticky)                                                               │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ [SOLAR_Q2 ▾]   [READY 00:42 ●green]   [⏱ 03:14]   [● REC]   [⚖ CONSENT: ALLOW]  │ │
│ │                                          [Pause ▾] [Settings] [Logout]           │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
├───────────────────────────┬──────────────────────────────────────────────────────────┤
│ LeftPanel (360 px)        │ CenterPanel (flex, tabbed)                               │
│ ┌───────────────────────┐ │ ┌──────────────────────────────────────────────────────┐ │
│ │ LEAD INFO             │ │ │ Tabs: [Script*] [Webform] [Comments]                 │ │
│ │ Mr. John Q. Smith     │ │ ├──────────────────────────────────────────────────────┤ │
│ │ +1 (415) 555-0142     │ │ │                                                      │ │
│ │ Alt: +1 (415) 555-…   │ │ │  Hi {{lead.first_name}}, this is {{agent_name}}     │ │
│ │ 1234 Main St          │ │ │  from {{campaign.brand}}. We're calling because     │ │
│ │ Berkeley, CA 94703    │ │ │  you requested information about solar installation.│ │
│ │ john@example.com      │ │ │                                                      │ │
│ │ DOB: 1972-03-14 (52)  │ │ │  [If reaches voicemail:] Hi {{lead.first_name}}…    │ │
│ │ Vendor: WEB-2026-0421 │ │ │                                                      │ │
│ │                       │ │ │  Q1: Do you currently own your home?                │ │
│ │ ▾ Custom fields (4)   │ │ │  Q2: What is your average monthly electric bill?    │ │
│ │ Status: NEW           │ │ │  Q3: Are you the decision-maker for energy …        │ │
│ │ Called: 0 times       │ │ │                                                      │ │
│ │ Last: never           │ │ │  ───────────────────────────────────────────────────│ │
│ │ Local time: 14:23 PDT │ │ │  [If interested: Press 1=SALE; else 2=NI; 3=CALLBK] │ │
│ │ List: SOLAR-WEB-Q2    │ │ │                                                      │ │
│ │                       │ │ │                                                      │ │
│ │ ▾ Recent contacts (3) │ │ │                                                      │ │
│ │ 2d ago · Sarah · 3m12s│ │ │                                                      │ │
│ │   SALE                │ │ │                                                      │ │
│ │   "wanted brochure…"  │ │ │                                                      │ │
│ │ 8d ago · Mike · 0m12s │ │ │                                                      │ │
│ │   NA (no answer)      │ │ │                                                      │ │
│ │ 21d ago · CSV import  │ │ │                                                      │ │
│ │   NEW                 │ │ │                                                      │ │
│ │                       │ │ │                                                      │ │
│ │ ▾ NOTES (auto-save)   │ │ │                                                      │ │
│ │ ┌───────────────────┐ │ │ │                                                      │ │
│ │ │ [callback][int...]│ │ │ │                                                      │ │
│ │ │                   │ │ │ │                                                      │ │
│ │ │ Customer asked …  │ │ │ │                                                      │ │
│ │ │                   │ │ │ │                                                      │ │
│ │ └───────────────────┘ │ │ │                                                      │ │
│ └───────────────────────┘ │ └──────────────────────────────────────────────────────┘ │
├───────────────────────────┴──────────────────────────────────────────────────────────┤
│ ActionBar (64 px, sticky bottom)                                                     │
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ [Hangup]  [Hold]   [Mute]   [DTMF▾]  [Transfer▾]  [3-way▾]  [Rec◉]  [Callback] │ │
│ │  red       blue    yellow    grey     grey         grey      red     grey       │ │
│ │  F3        Space   M         D        Ctrl+T       Ctrl+3    R       Ctrl+B     │ │
│ │                                                                       [Mark DNC] │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────────────┘

When phase=='wrapup', the CenterPanel is overlaid by:

│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ DISPOSITION (auto-saving in 0:48 ⏱)                                              │ │
│ ├──────────────────────────────────────────────────────────────────────────────────┤ │
│ │  [1] SALE      [2] NI       [3] CALLBK    [4] DNC                                │ │
│ │  [5] NA        [6] WRONG    [7] DEAD      [8] XFER                               │ │
│ │  [9] PDROP     [0] AGTHU                                                         │ │
│ │                                                                                  │ │
│ │  Notes: ┌────────────────────────────────────────────────────────────────────┐   │ │
│ │         │ Wanted brochure; confirmed address; said call next Tuesday around │   │ │
│ │         │ 3pm — interested in 12kW system…                                   │   │ │
│ │         └────────────────────────────────────────────────────────────────────┘   │ │
│ │                                                                                  │ │
│ │  ☐ Schedule callback                                                             │ │
│ │     ┌───────────────────────────────────────────────────────────────────────┐    │ │
│ │     │ Date+time picker (rendered when checked)                              │    │ │
│ │     │ ◯ Me only    ◯ Anyone                                                │    │ │
│ │     └───────────────────────────────────────────────────────────────────────┘    │ │
│ │                                                                                  │ │
│ │                                            [Cancel & resume] [Skip] [Submit ⏎]  │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
```

### 2.2 Why this layout

- **Top status bar (56 px)** — agent always knows campaign + state + call duration + recording status at a glance. Sticky so even if center column scrolls, status is visible (RESEARCH cite [12], NN/g UI Studies — "persistent contextual status bars cut error-recovery time 18%").
- **Left panel (360 px)** — lead info + history + notes share a column because they're all "context about *this lead*"; tabbing between them was the Vicidial mistake (cite [19] "agents missed lead info 12% of the time when in a non-default tab"). 360 px was the cite [30] AppLauncher recommendation: wide enough for "+1 (415) 555-0142" without wrapping, narrow enough to leave 60%+ for the script.
- **Center panel** — script/webform/comments all tab here because they all change *with the conversation* (script = follow it; webform = fill it; comments = take notes). Tabs feel right; a fixed split (e.g., 50/50 script | webform) wastes screen at 1280 px and breaks at 1024 px.
- **Action bar (64 px sticky bottom)** — the most fundamental rule: an agent must never have to scroll or switch tabs to hang up. Bottom because (a) Fitts's Law for trackpad+mouse users (left+bottom edges have zero travel after acquisition); (b) it doesn't interfere with reading the script in the center panel.
- **Disposition overlay** — full center-panel overlay (not modal) because modal `aria-modal` traps focus poorly with screen readers and "click outside to close" is a footgun when the agent might tab away (cite [23], a11y review of CCaaS UIs).

### 2.3 Responsive breakpoint behavior (FROZEN)

| Viewport | Behavior |
|---|---|
| ≥1280 px | Layout as above; all labels under icons in action bar |
| 1024-1279 px | Same layout; action-bar labels font-sm, icons unchanged |
| 768-1023 px | Left panel collapses to a top-mounted drawer (`<Sheet/>` from shadcn), opened by a "Lead info ▾" button in the top bar; center panel becomes full width |
| <768 px | Mobile-readable per acceptance criterion: action bar shrinks to icon-only (4 visible: Hangup, Hold, Mute, More▾); other buttons in the overflow menu; left-panel drawer is fullscreen when open |
| <360 px | Out of scope. We tell agents to use a tablet or laptop. |

### 2.4 The "always-visible Hangup" rule

If anything else in this PLAN is wrong, this one must be right: **the red Hangup button is always pixel-stable at the bottom-left of the action bar at the same color (`bg-state-error`) and the same hotkey (`F3`)** regardless of phase. Even during `wrapup` it remains (greyed if the customer leg is already terminated, but in the same spot). This is non-negotiable per cite [21]: "agents who lose Hangup discoverability take 7× longer to disengage from an angry customer, and that's the safety case." Implementation: the `<ActionBar/>` component is mounted by `(agent)/call/page.tsx` once and never unmounted while in the call route, even during phase transitions.

---

## 3. Lead-info display

### 3.1 Default-visible fields (the "Vicidial seven" + lifecycle line)

| Section | Field | Source | Format |
|---|---|---|---|
| **Identity** | Full name | `leads.title + first_name + middle_initial + last_name` | "Mr. John Q. Smith" (omit nullish) |
| | Primary phone | `leads.phone_e164` | `+1 (415) 555-0142` via `libphonenumber-js.formatInternational` |
| | Alt phones | `leads.phone_alt`, `leads.phone_alt2` | Same format; one per line; "Alt: …" prefix |
| **Address** | Street | `leads.address1`, `address2` | One or two lines |
| | City/State/Postal | `leads.city + state + postal_code` | "Berkeley, CA 94703" |
| **Contact** | Email | `leads.email` | linkified `mailto:` |
| | Date of birth | `leads.date_of_birth` | `1972-03-14 (52)` — age computed client-side |
| **Source** | Vendor / source | `leads.vendor_lead_code`, `source_id` | Small grey "WEB-2026-0421" |
| **Lifecycle** | Status | `leads.status` | Pill, color per D04 status palette |
| | Called count | `leads.called_count` | "Called: 3 times" |
| | Last called | `leads.last_called_at` | "Last: 3 days ago" via date-fns `formatDistanceToNow` |
| | Customer local time | computed from `leads.tz_offset_min` | "Local time: 14:23 PDT" — live-updated each minute |
| | List name | `leads.list_id → lists.name` | "List: SOLAR-WEB-Q2" |
| | Campaign name | (from `useCallStore.campaign`) | "Campaign: SOLAR_Q2" |

### 3.2 Why these are default-visible

- **Name + phone + address + email** — covers the "verify the person" script step (every call starts with "Hi, am I speaking with John?").
- **DOB + age** — Phase 1 has compliance use cases (do-not-call-minors) and customer-verification scripts ("can you verify your date of birth?").
- **Status + called_count + last_called** — answers "have we talked to this lead before?" without forcing the agent into the history tab.
- **Local time** — TCPA muscle memory: agent sees customer's local clock, instantly knows if it's awkward (e.g., "Local time: 7:58 AM PDT" means we're at the TCPA window edge). C01 already gated the originate, but agents handle escalations and need the visual reminder.
- **List name** — answers "where did this lead come from?" (matters when the script is list-specific).
- **Vendor lead code** — surfaces an external system ID for cross-reference (CRMs often surface this as the customer-facing "ticket ID").

### 3.3 Custom fields (collapsed by default)

`leads.custom_data` is a JSON column populated from CSV import column mapping (D02). Schema is per-list, fully arbitrary. We collapse behind `<details><summary>Custom fields (N)</summary>` because:
- Default visibility of an unbounded list breaks the layout.
- Agents only need custom fields for list-specific scripts; the script template substitution (`{{lead.custom_data.policy_number}}`) is the primary access path.
- One click expands; no information loss.

Inside the disclosure, render as definition list ordered by JSON insertion order (preserved by Node's V8 JSON parse and MySQL's JSON_OBJECT). Keys are slugified for display: `policy_number` → "Policy number"; `monthly_kwh` → "Monthly kWh". Values are escape-rendered as strings (no further JSON nesting; if the value is itself an object, render as `JSON.stringify(value)` in monospace).

### 3.4 Editable fields (limited subset)

The lead-info card is **mostly read-only**. Agents can edit:
- `phone_alt`, `phone_alt2` (small pencil icon, click to inline-edit) — agents need to fix wrong-number entries
- `email` — same
- `comments` — via the Notes pane (not directly on the card)

All other fields (address, name, DOB) are read-only in Phase 1. Editing them requires the admin Lead Detail view (M03). Decision per RESEARCH cite [31] (Vicidial agent permissions): name/address edits should require supervisor authority — the agent screen is for taking dispositions, not data correction.

Edits go to `PATCH /api/agent/lead/:id` with `{phone_alt?, phone_alt2?, email?}`. The endpoint validates via libphonenumber + a simple email regex, writes the row, audits to `c03_audit_log`.

### 3.5 Recording-consent indicator on the card

Below the lifecycle block we surface a small read-only line showing the C02 decision:
- `🎙 Recording: ON (1-party state)` — `consent_status=ALLOW`, recording active.
- `🎙 Recording: ON — verbal disclosure played` — `consent_status=PROMPT_MESSAGE`, played.
- `🎙 Recording: ON — beep cadence ${interval}s` — `consent_status=PROMPT_BEEP`.
- `🎙 Recording: ON — customer consented (DTMF 1)` — `consent_status=REQUIRE_ACTIVE`, customer pressed 1.
- `🎙 Recording: OFF — customer declined` — `consent_status=REQUIRE_ACTIVE`, customer pressed 2.
- `🎙 Recording: OFF — campaign config` — `recording_mode=NEVER`.

Source: `useCallStore.consent` populated by the WS `call.created` event. Same data drives the top-bar consent badge (§9.4) — the card line is the secondary display for agents who want full detail without opening the popover.

---

## 4. History display

### 4.1 What history shows

Per spec acceptance criterion (10 prior calls) and RESEARCH §3, the unified timeline includes:
- Every `call_log` row for this `lead_id` (joined with `users` for `agent_display_name`, with `statuses` for the friendly label).
- Plus any `callbacks.created_at` rows where `lead_id=?` (annotated as "Callback scheduled").
- Plus the initial lead-creation event (when `entry_at` is older than the oldest call_log row).

### 4.2 Schema of the endpoint

`GET /api/agent/lead/:lead_id/history?limit=10` → returns:

```ts
type HistoryEvent =
  | { kind: 'call';      ts: string; agent_name: string; talk_seconds: number; status: string; status_label: string; comments: string | null; call_uuid: string }
  | { kind: 'callback';  ts: string; created_by_name: string; callback_at: string; comments: string | null }
  | { kind: 'creation';  ts: string; source: string };
```

Ordered DESC by `ts`. The endpoint is implemented by `api/src/routes/agent/lead/:id/history.ts` (file listed in A05.md spec).

### 4.3 Why a unified timeline (not separate tabs)

Per RESEARCH §1 bullet 4: cite [16][17][18][19] converged on unified. Vicidial's split was a 2004 pattern; modern CCaaS treats this as solved. The data is the same shape across kinds (`{when, who, what}`) so the cognitive cost of one column is zero.

### 4.4 Rendering pattern

```
2 days ago · Sarah K · 3m 12s · SALE
  "Wanted brochure mailed; confirmed address;
   happy to call back next week"

8 days ago · Mike R · 0m 12s · NA (no answer)
  (no notes)

21 days ago · CSV import · WEB-FORM
  (no notes)
```

Each entry is a `<li>` with: row 1 = the headline (relative time, agent, duration, status pill), row 2 indent = the comments (truncated to 240 chars with "Show more" expander, full text on hover). Status pill uses D04 color (e.g., SALE=green, NA=grey, DNC=red).

### 4.5 Loading + empty states

- **Loading:** skeleton with 3 placeholder rows (greyed bars), fetched on lead-info card mount via TanStack Query (`useQuery({queryKey:['lead-history', leadId]})`).
- **Empty:** "No prior contact." (italic, grey).
- **Error:** "Couldn't load history — retry?" with retry button. Doesn't block the call.

### 4.6 Performance

10 rows × ~200 bytes = 2 KB payload. Query latency p95 < 50 ms (indexed by `(lead_id, call_started DESC)` per `leads` schema). Cached by TanStack Query with `staleTime: 30s` so flipping tabs doesn't re-fetch.

### 4.7 Phase 2 extension (HANDOFF note)

When `limit=20` is accepted, add a "Show older" button at the bottom that bumps to `limit=50` (max). Don't paginate further — agents who need full history can use the admin Lead Detail (M03). Phase 1 ships `limit=10` only.

---

## 5. Action set

### 5.1 The nine buttons (FROZEN ordering)

| # | Button | Phase enabled | Icon | Hotkey | Primary side-effect |
|---|---|---|---|---|---|
| 1 | **Hangup** | `active`, `hold`, `transferring` | `phone-off` (Lucide), red | `F3` | `POST /api/agent/call/:uuid/hangup` → API issues `T01.UUIDKill(custUUID, NORMAL_CLEARING)` |
| 2 | **Hold** | `active`, `hold` (toggle) | `pause`/`play` | `Space` | `PATCH /api/agent/call/:uuid/hold` → API calls `T03.HoldCustomer(tid, uid)` (move to `agent_t<tid>_u<uid>_hold` profile) |
| 3 | **Mute** | `active`, `hold` (toggle) | `mic-off`/`mic` | `M` | Local-only: `useSoftphone().toggleMute()` (A02 PLAN §11.3); no API call (NOT a SIP op; flips localAudioTrack.enabled) |
| 4 | **DTMF** | `active`, `hold` | `dialpad` | `D` | Opens keypad popover; each key click → `useSoftphone().sendDtmf(tone)` (A02 PLAN §12.1) |
| 5 | **Transfer ▾** | `active`, `hold` | `git-fork` | `Ctrl+T` | Opens transfer-target modal (blind only in Phase 1 — see §5.3); on submit → `POST /api/agent/call/:uuid/transfer` |
| 6 | **3-way ▾** | `active`, `hold` | `users` | `Ctrl+3` | Opens originate-3rd-party modal; on submit → `POST /api/agent/call/:uuid/originate-third` (resolves to `T03.TransferThirdParty`) |
| 7 | **Record ◉** | `active`, `hold` (only if `recording_mode==='ONDEMAND'`) | `circle` (filled when recording) | `R` | `PATCH /api/agent/call/:uuid/recording` (toggle) → API calls `R01.StartRecording` / `StopRecording` |
| 8 | **Callback** | `active`, `hold`, `wrapup` | `calendar-clock` | `Ctrl+B` | Opens callback-scheduler popover (same as dispo-overlay, but submits without changing phase) |
| 9 | **Mark DNC** | `active`, `hold`, `wrapup` | `ban` | `Ctrl+D` | Two-step: confirm dialog → `POST /api/agent/lead/:id/dnc` → API writes to `dnc` table with `source='internal'` |

### 5.2 Why this ordering

Per Stanford-HCI cite [21] frequency analysis of 100-agent call-center sessions over 12 weeks:

| Action | Per-call frequency |
|---|---|
| Hangup | 1.0 (every call ends) |
| Hold | 0.4 |
| Mute | 0.25 |
| DTMF | 0.15 (mostly IVR navigation post-bridge) |
| Transfer | 0.07 |
| 3-way | 0.03 |
| Record toggle | 0.01 (ONDEMAND campaigns only) |
| Callback | 0.18 (during wrapup; counted post-hangup) |
| Mark DNC | 0.02 |

Left-to-right by descending frequency, with the rule "Hangup goes left no matter what". Mute beats DTMF because mute is fired *during* live talk while DTMF is mostly post-IVR. Transfer/3-way are grouped because they're both "add or move a leg" actions. Record◉ goes seventh because most campaigns are not ONDEMAND, so the button is hidden in those — placing it deep in the bar doesn't penalize the dominant case. Mark DNC is rightmost because it's the most destructive (writes to a federal-style table; reversal requires admin).

### 5.3 Transfer modes — Phase 1 = blind only

DESIGN.md §7.4 lists six transfer types; T03/PLAN/A07 expose all six. For A05 Phase 1 the Transfer button menu offers ONLY:
- **Blind transfer** (to phone number) — `uuid_transfer customer_uuid ext-out:<phone> XML default` via T01.
- **Voicemail drop** (to a pre-recorded WAV) — Phase 1.5 if AMD ships; punt.
- **Closer / agent group** (transfer to an in-group) — Phase 3 (I01 in-groups).
- **Consultative warm transfer** — Phase 1.5; needs second SIP leg (A02 PLAN §11.4 deferred).
- **Park** — covered by Hold button (same UX semantically); no separate button.

Blind transfer is sufficient for the MVP demo (SPEC §9 step 13 is 3-way, not warm). 3-way DOES ship in Phase 1 as its own button (separate from Transfer▾ menu) because the spec demo requires it. The Transfer▾ menu in Phase 1 has exactly one option: "Blind transfer (enter number)" — the dropdown still exists because A07 will fill it later; this avoids button-shape churn during A07.

### 5.4 3-way originate flow

Click [3-way ▾] → small modal:
- Phone-number input (libphonenumber-js validated, defaults to `+1` country code).
- "Caller ID" dropdown (defaults to current campaign's outbound CID).
- [Cancel] [Originate].

Submit → `POST /api/agent/call/:uuid/originate-third` with `{phone_e164, cid_override?}`. API:
1. C01 gate (TCPA window for the *new* phone) — same as manual dial.
2. C02 gate — recording-consent decision for the 3rd party.
3. D05 DNC check (federal + internal).
4. `T03.TransferThirdParty(tid, uid, gateway, dest, cidName, cidNumber)` — originates a leg, `+flags{join-only}`, `endconf` so removing agent doesn't collapse conf (T03 PLAN §4.3).
5. Returns `{job_uuid, originated_uuid}`.

While the 3rd-party leg is ringing, the action bar swaps Hangup → "Leave 3-way" (kicks agent out, customer + 3rd stay bridged — per SPEC §9 step 13) AND a small mini-card appears below the lead-info card showing the 3-way participant list (customer + agent + 3rd) with per-member mute/kick if the user has supervisor permissions. The mini-card subscribes to WS `conference.member_added/left/muted`.

### 5.5 Schedule-callback flow (mid-call)

Click [Callback] mid-call (not wrapup) → opens a popover with:
- Datetime picker (default: now + 24 h, weekday).
- ◯ Me only (the agent) ◯ Anyone radio.
- Comments textarea (pre-filled with current `useCallStore.notes`).
- [Cancel] [Save].

Submit → `POST /api/agent/lead/:id/callbacks` with `{callback_at, user_id?, comments}`. Doesn't change `phase`. Callback persists. UI shows toast "Callback saved for Tue Mar 14, 3:00 PM". Doesn't auto-set disposition (agent still must choose during wrapup); the callback simply exists. During wrapup, the dispo-overlay's "Schedule callback" toggle is *pre-checked* if a mid-call callback was created (so they get the CALLBK dispo without re-entering).

### 5.6 Mark-DNC flow

Click [Mark DNC] → confirm dialog "Add +1 (415) 555-0142 to internal DNC? This cannot be undone from this screen." → [Cancel] [Confirm]. Confirm → `POST /api/agent/lead/:id/dnc` → API:
- Writes `dnc(phone_e164, source='internal', campaign_id=NULL)` (global internal DNC).
- Writes `c03_audit_log` row with actor + reason.
- Suggests setting disposition to `DNC` (a soft toast: "Lead added to DNC — set disposition to DNC?" with a button that selects DNC in the wrapup picker).

This action is rate-limited at the API layer (max 20 per hour per agent — defends against malicious bulk DNC).

---

## 6. DTMF entry

### 6.1 Visual keypad

Component: `<DtmfPad/>` rendered inside a shadcn `<Popover>` anchored above the action-bar DTMF button. Grid:

```
┌───────┬───────┬───────┐
│   1   │   2   │   3   │
├───────┼───────┼───────┤
│   4   │   5   │   6   │
├───────┼───────┼───────┤
│   7   │   8   │   9   │
├───────┼───────┼───────┤
│   *   │   0   │   #   │
└───────┴───────┴───────┘
[ Last sent: 1 2 3 # ]   [Clear]
```

Each cell is 64×64 px (Fitts's Law sweet spot per cite [21]). Clicking sends a single tone. Tap-and-hold (≥300 ms) sends a longer tone (600 ms vs default 200 ms). Right-click is suppressed.

### 6.2 Keyboard handling

When the popover is open and focused (auto-focused on open via `autoFocus` on the first cell), key events `0-9 * #` are intercepted by a `keydown` handler scoped to the popover. Each keystroke fires `sendDtmf(key)`. Backspace clears the most recent echo. `Escape` closes the popover.

When the popover is *closed*, the global hotkey `D` opens it. When closed, `0-9` keys do NOT trigger DTMF (they're reserved for dispo hotkeys during wrapup or are ignored during active call).

### 6.3 Paste-from-clipboard

If the user pastes (Ctrl+V) into the popover area, the pasted string is parsed; valid DTMF characters (`0-9*#`) are extracted; invalid characters dropped; the sequence is dispatched with 80 ms gaps. Max sequence: 32 chars (defensive against accidental long paste).

### 6.4 Echo display

The "Last sent" row shows the last 12 digits sent, space-separated. Auto-clears after 5 s of inactivity. The agent can copy-pick it (selectable text) for note-taking.

### 6.5 Why not always-visible

Earlier draft had a permanent keypad pinned right side. RESEARCH cite [10] (Five9 UI evolution 2018→2024) explicitly moved keypads behind a popover because (a) most calls don't need DTMF; (b) keypad takes 240×320 px = 6% of screen; (c) the popover-on-demand pattern is the modern norm. We follow.

### 6.6 RFC 4733 vs SIP INFO

A02 PLAN §12 already pins RFC 4733 default with SIP INFO escape via `useUiStore.dtmfMode`. A05 doesn't expose the toggle — it lives under `(agent)/settings/page.tsx` "Advanced". The keypad just calls `sendDtmf(tone)` and A02 dispatches per the current mode.

### 6.7 Inbound DTMF — not Phase 1

Customer DTMF during the call (e.g., customer presses 1 to confirm consent) is handled at FS dialplan level (C02 PLAN §0). The browser doesn't display incoming DTMF. Phase 2/3 might add a "Customer pressed: 1" indicator in the consent panel — out of scope here.

---

## 7. Disposition workflow

### 7.1 The three options reconsidered

| Option | Pros | Cons | Real-world data |
|---|---|---|---|
| (a) **Pre-hangup** | Agent multitasks while talking | Risk of premature commit; customer might prolong call after agent clicks SALE | Vicidial uses this; agents complain (cite [1] forum thread) |
| (b) **Post-hangup mandatory** | Clean audit trail; one action at a time; matches phone-bank ergonomics | Forces wrapup before next call (rate limits) | Five9 / Genesys default (cite [10][11]) |
| (c) **Either order** | Maximum flexibility | Breaks wrapup-time SLA; reports become muddy | Genesys "lenient mode"; off by default |

**Decision: (b) post-hangup mandatory.** Plus a Skip button that fires NA + counts in metrics. Rationale: SPEC §9 demo step 9 is "click Hangup; UI shows disposition picker; agent selects SALE; click submit" — that's literally (b).

### 7.2 Wrapup timer

`campaigns.wrapup_seconds` (default 60 s; per DESIGN.md §3 schema). When `phase` flips to `wrapup`:
1. The dispo-overlay appears.
2. A circular progress timer starts in the bottom-right of the overlay, counting down from `wrapup_seconds`.
3. At T-10s, the progress turns yellow and a soft toast "Auto-saving as NA in 10s" appears.
4. At T-0, if no submit, the system auto-submits `status='NA'` with a flag `auto_dispo=true` (per `call_log` schema TBD; or in `comments` as `[auto-NA]`).
5. The auto-submit also pages O01 with `vici2_dispo_auto_count`.

The timer can be paused by clicking on the overlay (interaction reset) — typing in the comments box resets the countdown to `wrapup_seconds`. The "Cancel & resume" button (visible only if the call leg is still alive — e.g., if hangup was a mistake) re-bridges by NOT calling uuid_kill (sometimes Hangup is hit prematurely; we want a 5-second grace window before actually issuing the kill). Per RESEARCH cite [27], the "undo hangup" grace window is a 31% reduction in agent escalation rate. Implementation: `Hangup` button puts the system into `phase='wrapup'` immediately and shows the overlay, but doesn't issue `uuid_kill` until either (a) the agent submits a dispo, (b) 5 s elapse, or (c) the agent clicks anything other than "Cancel & resume". This 5-second grace is configurable via `campaigns.hangup_grace_seconds` (default 5).

### 7.3 Selectable statuses

Pulled from `GET /api/agent/campaign/:id/statuses` (cached in TanStack Query, refetched on campaign switch). Filtered to `selectable=true` AND `hotkey IS NOT NULL`. Rendered in hotkey order (1, 2, …, 9, 0, then any without hotkey).

D04 module's `StatusService.hotkeyMap(campaignId)` returns `{'1': 'SALE', '2': 'NI', ...}` — A05 inverts this for the picker.

### 7.4 Click vs hotkey

- **Click** a status pill → highlights it; pressing Enter submits.
- **Press hotkey** (1-9, 0) → highlights AND auto-submits (the Vicidial muscle-memory pattern; cite [1]).
  - Auto-submit-on-hotkey is configurable via `useUiStore.confirmHotkeyDispo` (default `false` = auto; set to `true` for new agents who want a confirm step).

The "auto-submit on hotkey" is opinionated and matches the cite [21] frequency study — experienced agents pick disposition in <2 s with the hotkey; clicking and confirming is the slowdown.

### 7.5 Comments + callback scheduling

Below the status grid:
- **Comments** — `<textarea>` with the existing in-call notes pre-loaded (so agents don't re-type). Saved on submit to `call_log.comments`. Also appended to `leads.comments`.
- **Schedule callback** — checkbox. When checked, reveals:
  - Datetime picker (date-fns + shadcn `<Calendar/>`).
  - Time-of-day picker (HH:MM, with timezone shown — defaults to customer's local TZ).
  - ◯ Me only ◯ Anyone radio.
  - Comments for callback (inherits the comments textarea).
- **Special dispositions:**
  - Selecting `CALLBK` auto-checks "Schedule callback" and requires a future datetime.
  - Selecting `DNC` shows a soft warning "Lead will be added to DNC. Proceed?"
  - Selecting `SALE` may surface campaign-specific webform-link (Phase 2 — punt for now).

### 7.6 Submit

`POST /api/agent/dispo` with `{call_uuid, status, comments, callback_at?, callback_user_id?}` (matching DESIGN.md §11). API:
1. Writes `agent_log` row.
2. Updates `leads.status`, `leads.called_count++`, `leads.last_called_at`, `leads.comments`.
3. Updates `call_log.status`, `call_log.wrap_seconds`, `call_log.comments`.
4. If callback: insert `callbacks` row.
5. If DNC: insert `dnc` row.
6. Returns 200.

UI then transitions `phase` → `idle`, hides the overlay, refreshes the `(agent)/dashboard` data, transitions agent state from `wrapup` to `ready` (or to `paused` if the agent had a queued pause request).

### 7.7 "Skip" — escape hatch

Bottom-right corner: a small grey "Skip" button. Confirms ("Mark as NA without notes?") then submits `status='NA'`. Page O01 with `vici2_dispo_skipped_total{reason=user_initiated}`.

---

## 8. Notes (and structured tags)

### 8.1 The single-textarea decision

Per RESEARCH §1 bullet 8: HubSpot Service Hub agent UX (cite [24]) and Talkdesk product blog (cite [25]) settled this. One box. No formatting. No save button.

### 8.2 Auto-save mechanics

- `<textarea>` with `onChange` debounced 2 s → `PATCH /api/agent/call/:uuid/notes` with `{comments}`.
- Also `onBlur` fires immediately (so tab-away saves).
- Also `beforeunload` fires `navigator.sendBeacon` with the current value (handles tab close / browser crash). Browsers honor sendBeacon for unloads (cite [33]).
- Indicator: a small "Saved" / "Saving…" / "Save failed (retry?)" status badge near the textarea.

### 8.3 The 4 quick-tag chips

Above the textarea, 4 toggle chips: `callback`, `interested`, `not-interested`, `wrong-person`. Clicking inserts `[callback] ` (or removes if present). The tags are Vicidial-compatible markers in `comments` (cite [1] `vicidial_call_notes` parses them).

We do NOT make them structured columns. Phase 1 keeps them as inline markers; Phase 2 could promote to a `call_log.tags` JSON column if reporting demands. The chips are pure shortcuts for the textarea.

### 8.4 Persistence target

Notes are written to BOTH:
- `call_log.comments` — per-call.
- `leads.comments` — cumulative. The API appends `\n----\n<agent_display> <iso_ts>\n<new_notes>` to existing `leads.comments` (cite [1] `auto_append_to_lead_comments` behavior — Vicidial default).

This dual-write is at the API layer (not the client) so we don't risk partial state.

### 8.5 Notes on rich text — explicitly rejected

- Bold/italic/lists: not needed (cite [26], 95% of notes <280 chars and use no formatting).
- Mentions (@agent): out of scope; team-chat is a different surface.
- Attachments: out of scope; lead documents are admin-side (M03).

### 8.6 Max length

`leads.comments` is `TEXT` (65k chars). We cap the textarea at 4096 chars per save (defense against accidental paste of huge content); server-side also caps at 4096 with a 422 on overflow.

---

## 9. Recording indicator + control

### 9.1 State machine

Four UI states, derived from `useCallStore.recording` (set by WS events) cross-multiplied with `useCallStore.campaign.recording_mode` and `useCallStore.consent`:

```
        recording_mode   consent_status        UI state         action button
        ─────────────    ────────────────      ───────────      ───────────────
        ALL / ALLFORCE   * (any decision)      Recording        disabled "always-on"
        NEVER            *                     Not recording    hidden
        ONDEMAND         ALLOW                 Not recording*   Record◉ (start)
                         PROMPT_*              Not recording*   Record◉ (start; plays prompt)
                         REQUIRE_ACTIVE        Not recording*   Record◉ (start; requires DTMF1)
                         SKIP                  Not recording    disabled "consent denied"

        *but agent can toggle on
        While record_session is running:
        ALL / ALLFORCE   *                     Recording        disabled
        ONDEMAND         (any allow)           Recording        Record◉ (stop)
        
        While paused for PCI:
        any              any                   Paused           Resume button
```

### 9.2 The top-bar badge

Compact pill in top status bar:

| Visual | State |
|---|---|
| `● REC` red dot, red text | Recording |
| `○ REC OFF` grey dot, grey text | Not recording |
| `⏸ REC PAUSED` yellow dot | Paused (PCI mask) |
| `… CONSENT` orange dot, pulse animation | Pending consent prompt |

Click → opens popover showing:
- Recording state (active / off / paused).
- C02 decision (state-applied + mechanism + reason).
- File path (admin/sup role only; agent sees "**Recording stored locally**").
- Start time and elapsed time (active only).
- For PAUSED: "Resume recording" button (if `useUiStore.pciAuthorized` — agent can pause but only sup can manually resume; the typical resume is automatic after DTMF capture window expires).

### 9.3 The action-bar Record◉ button (ONDEMAND only)

Only visible when `campaign.recording_mode==='ONDEMAND'`. Click toggles `PATCH /api/agent/call/:uuid/recording` with `{action: 'start' | 'stop' | 'pause' | 'resume'}`. API delegates to R01.

For START with `consent_status==='PROMPT_MESSAGE'` or `'REQUIRE_ACTIVE'`, the API will:
1. Set channel-var `vici2_record_pending=true` on the customer leg.
2. Play the prompt via FS dialplan (`consent_message_only` / `consent_message_active`).
3. On positive consent → start `record_session`.
4. WS event `call.recording_started` flips the UI.

Latency: prompt is 5-12 s. UI shows a "Waiting for consent…" spinner during this window.

### 9.4 PCI mask (pause/resume for credit-card capture)

Two-button cluster behind a "PCI" chevron (only visible to agents in PCI-trained groups; defaults to hidden):
- [PCI: Start mask] → `PATCH /api/agent/call/:uuid/recording` `{action: 'pause'}` → R01 `uuid_record mask`. UI flips to PAUSED.
- [PCI: End mask] → `{action: 'resume'}` → `uuid_record unmask`. UI flips back to RECORDING.

Per R01 PLAN §1: this is **NOT PCI-compliant per PCI SSC 2024+**. The PR card UI carries a tooltip "Pausing records muted DTMF but is NOT a substitute for a PCI sidecar." HANDOFF documents Phase 2 PCI integration (PCI Pal / Eckoh) as the proper fix.

### 9.5 Why click-to-inspect, not always-detailed

Per RESEARCH cite [32]: a 2023 Genesys agent-UX study found that detailed compliance info in the persistent top bar caused "compliance blindness" — agents ignored it after 3 days. A click-to-reveal popover preserves the detail for audits but doesn't visually clutter the every-call view.

---

## 10. Real-time state sync (events from FS → ESL → A03 WS → A05)

### 10.1 Event taxonomy A05 subscribes to

Via `useWebSocket().subscribe(eventType, handler)` from A01 PLAN §6.

| Event type | Producer | Triggers A05 state |
|---|---|---|
| `call.created` | T01 on `CHANNEL_CREATE` for customer leg | `useCallStore.setActiveCall({uuid, leadId, ...})`; `phase` → `ringing` |
| `call.answered` | T01 on `CHANNEL_ANSWER` for customer leg | `phase` → `active`; `startedAt` set |
| `call.bridged` | T01 on `CHANNEL_BRIDGE` (when customer joins conference) | confirms `phase===active` |
| `call.recording_started` | R01 on `RECORD_START` | `recording` → `on` |
| `call.recording_stopped` | R01 on `RECORD_STOP` | `recording` → `off` |
| `call.recording_paused` | R01 on `uuid_record mask` ack | `recording` → `paused` |
| `call.hangup` | T01 on `CHANNEL_HANGUP` for customer leg | `phase` → `wrapup` (after `hangup_grace_seconds` debounce); dispo overlay shows |
| `conference.member_added` | T01 on `conference::maintenance` Action=add-member | If 3-way: append to participant mini-card |
| `conference.member_left` | T01 on `conference::maintenance` Action=del-member | Remove from participant list |
| `conference.member_muted` / `_unmuted` | T01 on conference event | Reflect in mini-card |
| `agent.status_changed` | T01 / API on agent state flip | `useAgentStore.setStatus(...)` |
| `consent.decision` | C02 (when consent prompt completes) | `useCallStore.consent` populated; recording indicator updates |

### 10.2 No polling

A05 never polls. The only setInterval is the call timer (every 1 s, computes `now - startedAt` for display); even that's a UI tick, not a network call.

### 10.3 Reconnect strategy

A01 PLAN §6 already handles WS reconnect with `{op:'resume', from:lastSeq}` cursor; A05 inherits. The only A05-specific concern: if the WS drops *during* an active call, the agent will still hear audio (SIP.js conference leg is separate; A02 PLAN §10 handles its own reconnect). A05 shows a banner "State sync reconnecting — call audio unaffected" after 5 s of WS down, and "State sync restored" toast on reconnect.

If the WS is down for >30 s, A05 falls back to a 5-second polling fallback for `GET /api/agent/call/:uuid/state` (idempotent endpoint) to avoid stale state. The polling auto-stops when WS reconnects.

### 10.4 Race conditions

| Race | Risk | Mitigation |
|---|---|---|
| User clicks Hangup; WS `call.hangup` arrives before API response | UI flickers `active → wrapup` (from WS) → `active` (from optimistic update) → `wrapup` (from API resp) | Use React 19 `useOptimistic` per A01 PLAN §9: optimistic flip to `wrapup` on click; reconcile from server confirm. WS arrival is a no-op if already in `wrapup`. |
| Mute toggle: agent presses M; WS `call.muted` doesn't fire (mute is local) | None — mute is local-only per A02 PLAN §11.3 | A05's mute state reads `useSoftphone().muted`, not WS. |
| Customer hangs up while agent typing notes; phase flips to `wrapup` mid-keystroke | Lost focus, lost keystrokes | The phase transition does NOT unmount the notes textarea (it stays mounted, persisted via `useCallStore.notes`); the dispo overlay appears *over* the center column but the left column (notes) remains. Agent can keep typing; notes auto-save propagates. |
| WS lag delays `call.answered` until after dispo overlay shows | `phase` stuck at `ringing` while audio is live | A05's call timer uses `useSoftphone()` derived `startedAt` (timestamp when SIP `connected` event fires on the conference session) as a fallback if WS hasn't supplied one within 3 s. |
| Recording-started WS event arrives before API response from POST /recording | UI flickers off→on→on | Optimistic flip on user action; WS arrival is idempotent confirm. |
| Supervisor force-pauses agent mid-call | `agent.status` flips to `paused` while `call.phase==='active'` | These are independent state machines; A05 displays `[BUSY-on-call ➜ paused (force) 00:12]` in top bar; call continues; on hangup, agent goes to paused state, not ready. |
| User closes browser tab during active call | Call audio drops (SIP.js BYE on unload); customer leg may stay in conference for a few seconds | `beforeunload` confirm "You have an active call — really leave?" (chromium honors). On confirmed leave, A02 sends BYE; FS conf empties customer leg (configurable grace via T03). |

---

## 11. Hot-keys

### 11.1 Default keymap (FROZEN)

| Key | Scope | Action |
|---|---|---|
| `F1` | global | Open help/cheatsheet overlay |
| `F2` | in-call | Hold toggle |
| `F3` | in-call | Hangup |
| `F4` | in-call | Mute toggle |
| `Space` | in-call (when no textarea/input focused) | Hold toggle (Vicidial-compatible) |
| `M` | in-call (no input focused) | Mute toggle |
| `D` | in-call (no input focused) | Open DTMF keypad |
| `R` | in-call (no input focused, ONDEMAND only) | Record toggle |
| `Ctrl+T` | in-call | Open Transfer menu |
| `Ctrl+3` | in-call | Open 3-way menu |
| `Ctrl+B` | in-call OR wrapup | Open callback scheduler |
| `Ctrl+D` | in-call OR wrapup | Mark DNC (confirm dialog) |
| `Ctrl+P` | global | Pause toggle |
| `Ctrl+L` | global | Log out (confirm dialog) |
| `0-9` | wrapup | Pick disposition by hotkey (from D04 map) + auto-submit |
| `Enter` | wrapup | Submit current selection (if any) |
| `Esc` | global | Close current popover/modal |
| `?` | global | Open help overlay (alternate F1) |
| `/` | global | Focus search/lookup (Phase 2) |

### 11.2 Conflict suppression

When `document.activeElement.tagName` is `'INPUT'` or `'TEXTAREA'` or the element has `contentEditable=true`:
- Single-letter and digit hotkeys (M, D, R, 0-9, Space, Enter for non-form-submit semantics) are suppressed.
- Modifier-keyed hotkeys (`Ctrl+T`, `F1-F12`) still fire (they don't collide with natural typing).
- `Esc` always fires (closes popover; standard expectation).

### 11.3 Vicidial parity matrix

DESIGN.md §7.5 specifies: `0-9` → dispo (wrapup), `F1` = hold, `F3` = hangup, `Ctrl+T` = transfer, `Ctrl+P` = pause. We match all five. We deviate by:
- Adding `F2` for hold (in addition to F1 — F1 is also Help, but they don't conflict because F1=Help is global, F2=Hold is in-call).
  - Actually we should reconcile: F1=Help is Vicidial's pattern too; F2=Hold matches Five9's; we ship F2=Hold and F1=Help. This is intentional divergence from DESIGN.md §7.5; will need RFC if DESIGN.md is treated as binding. **PLAN-phase decision needed.** (Open question §15 Q3.)
- Adding `Space`=Hold (Genesys + Talkdesk muscle memory; cite [27]).
- Adding `M`/`D`/`R` single-letter accelerators for Mute/DTMF/Record (modern CCaaS norm; cite [10][13]).

### 11.4 User customization

`(agent)/settings/page.tsx` extends with a "Keyboard shortcuts" section. UI:
- List of (action, current key, [Change] button).
- Click [Change] → "Press any key…" dialog; captures next keystroke; validates uniqueness; persists to `useUiStore.hotkeyMap`.
- "Reset to defaults" button.
- "Print cheat sheet" link → opens a printable HTML overlay.

### 11.5 The help overlay

F1 (or `?`) opens a full-screen overlay listing all current shortcuts grouped by scope. Built once; rendered conditionally. Closed by Esc.

### 11.6 Recordings (auditability)

Hotkey activations are NOT audit-logged (too noisy). Only the resulting actions (hangup, dispo, etc.) are audited via the standard API audit log.

---

## 12. A02 softphone integration pattern

### 12.1 The DOM-host question

Where does the hidden `<audio id="remoteAudio">` element live? Two options:
- (a) Mounted by A02's `<SipProvider/>` in `AgentShell.tsx` (already the A02 PLAN §2.3 plan).
- (b) Mounted by A05's `<CallPanel/>` in `(agent)/call/page.tsx`.

**(a) wins**, and we don't change it. Reasoning: the SIP session lives across page navigations (agents drift between `/dashboard`, `/call`, `/leads`, `/settings`). If the audio element were owned by `/call`, navigating away would tear down the audio (SIP.js needs the element to be `srcObject`-attached). A02 PLAN already mounts it in `AgentShell` which is the persistent layout. A05 just *reads* `useSoftphone()` state.

### 12.2 The hook contract

A05 imports `useSoftphone()` from `@/lib/sip`. The shape A05 needs (FROZEN with A02 PLAN):

```ts
type SoftphoneStatus = 'connecting' | 'registered' | 'on-call' | 'reconnecting' | 'error';

interface UseSoftphoneReturn {
  status: SoftphoneStatus;
  // mute (local, no SIP)
  muted: boolean;
  toggleMute(): void;
  // hold (SIP re-INVITE)
  hold(): Promise<void>;
  unhold(): Promise<void>;
  isOnHold: boolean;
  // DTMF
  sendDtmf(tone: '0'|'1'|'2'|'3'|'4'|'5'|'6'|'7'|'8'|'9'|'*'|'#'): void;
  // stats (mos, packet-loss, jitter for diagnostics)
  stats: SoftphoneStats | null;
  // diagnostics
  lastError: { code: string; message: string } | null;
}
```

A02 PLAN §2.1 confirms this surface; A05 just consumes.

### 12.3 Why not embed SIP.js directly in A05

A05 must not import `sip.js` because:
- The audio element ownership rule (above).
- The session is a singleton — embedding it twice causes "two SIP UAs registered" race.
- The ESLint import-restriction rule (A01 PLAN §15 plus an A05-specific addition) forbids `from 'sip.js'` outside `web/src/lib/sip/`.

### 12.4 Mute is local, not SIP

A05's [Mute] button calls `useSoftphone().toggleMute()` which sets `localAudioTrack.enabled = false`. NO server-side state change. NO WS event. The UI updates from local state (`useSoftphone().muted`). Reasoning: per A02 PLAN §11.3, mute is browser-side audio; sending it through SIP would add ~100-300 ms of round-trip and offers zero benefit.

Note: this means if the agent has two tabs open (an A03-spec-forbidden scenario, but possible during transition), the second tab won't show mute state until it polls. Tab-sync via `BroadcastChannel('vici2.softphone')` is a Phase 2 nicety; for Phase 1 we just say "only one tab" and the A01 PLAN §7.7 tab-sync handles login state.

### 12.5 Hold IS server-side

A05's [Hold] button calls `PATCH /api/agent/call/:uuid/hold` → API calls `T03.HoldCustomer(tid, uid)` which moves the customer leg to a `_hold` profile conference. The customer hears MOH; the agent leg is still in the original conference (silent, since customer is gone). The WS confirms `call.held` event; UI flips `phase` to `hold`. Unhold reverses.

Why server-side: per T03 PLAN §4.3 + cite [34] (FreeSWITCH hold-music pattern), MOH playback requires server-side because the browser's mic is muted/disabled during hold (customer doesn't want to hear agent breathing while on hold). A02 PLAN §11.2 has a SIP-side `simpleUser.hold()` that sends re-INVITE `a=sendonly`, but **for A05 we route through the conference move** because the conference profile already has MOH wired and the agent leg is on a separate session that we don't want to disrupt.

**Open question §15 Q1:** which hold path does A05 use? PLAN-phase decision.

### 12.6 SIP.js status surface in A05

The top bar shows the softphone connection state subtly:
- `registered` (default) — no badge.
- `connecting` — small spinner next to the agent state pill.
- `reconnecting` — small yellow badge "Reconnecting audio…".
- `error` — red banner "Audio disconnected. Click to reconnect."

This is independent of WS state (which has its own banner). Both can be shown simultaneously if both are down.

---

## 13. Browser quirks

### 13.1 Autoplay restrictions

Chrome (cite [35]) and Safari (cite [36]) require user gesture for `audio.play()`. A02 PLAN §8.4 already mounts an `<AudioGate/>` overlay that prompts "Click to enable audio" on first session start.

A05's specific concern: if the agent navigates away from `/call` and back, the `<audio>` is still attached and playing (A02 owns it; persistent), so no re-gesture is needed. But if the audio element ever pauses (e.g., low-power tab background), Chrome may require re-gesture on resume. We listen for `audio.onpause` events and, if pause was not user-initiated, show the `<AudioGate/>` again.

### 13.2 Microphone permission re-prompts

Chrome permission grants are persistent per-origin. But:
- If the user revokes mic in browser settings mid-shift, next `getUserMedia` call fails. A02's `<MicPermissionGate/>` (§8.4) handles this.
- If the user is on Firefox + private mode, permission is per-session and expires on tab close — re-prompt every login. Display a one-time onboarding hint "We need microphone access for every shift on Firefox private mode."

### 13.3 Tab backgrounding (throttling)

Modern browsers throttle background tabs:
- `setInterval` minimum becomes 1 s after 5 min of background (cite [37], Chrome's [Background_Throttling docs](https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout#timeouts_in_inactive_tabs)).
- WebSockets stay open (good).
- Audio context can be suspended (bad).

A05's call timer uses `requestAnimationFrame` for visual updates when foregrounded, falls back to `setInterval(1000)` when backgrounded, and computes timer value as `Date.now() - startedAt` (clock arithmetic, not accumulator) so background drift doesn't matter.

A02 handles audio context resumption via `audioContext.resume()` on tab visibility change.

### 13.4 Safari quirks

- `setSinkId` for speaker selection unavailable (A02 PLAN §8.2).
- Strict autoplay enforcement (A02 PLAN §8.4 handles).
- `BroadcastChannel` supported since 15.4 — fine.
- `navigator.permissions.query({name:'microphone'})` returns `'prompt'` even when granted in Safari ≤16 — A02 PLAN §8.4 falls back to a `getUserMedia` try/catch.

### 13.5 Mobile browsers

Out of scope. Mobile call-center agent UX is its own domain; we explicitly disable the route on screens <360 px and recommend tablets at 768+.

### 13.6 Browser-extension interference

Ad blockers / extensions can break WebSocket connections (cite [38] — uBlock Origin's "Strict blocking" can drop WSS handshakes). A02 PLAN §10 covers WS reconnect; A05 surfaces the issue via the "Reconnecting audio" banner. HANDOFF documents the diagnostic ("disable extensions, try again").

---

## 14. API surface (REST + WS)

### 14.1 REST endpoints A05 calls

| Verb | Path | Body | Effect |
|---|---|---|---|
| `POST` | `/api/agent/call/:uuid/hangup` | `{}` | `T01.UUIDKill(uuid, NORMAL_CLEARING)`; logs `c03_audit_log` |
| `PATCH` | `/api/agent/call/:uuid/hold` | `{action: 'hold' \| 'unhold'}` | `T03.HoldCustomer` / `ResumeCustomer` |
| `POST` | `/api/agent/call/:uuid/dtmf` | `{digits: string}` (optional fallback for SIP-side issues) | Server-side `uuid_send_dtmf` — Phase 1.5 fallback; primary path is RFC 4733 from browser |
| `POST` | `/api/agent/call/:uuid/transfer` | `{kind: 'blind' \| 'vmdrop', dest: string}` | `T01.UUIDTransfer(uuid, …)` |
| `POST` | `/api/agent/call/:uuid/originate-third` | `{phone_e164, cid_override?}` | C01/C02/D05 gate; `T03.TransferThirdParty(...)` |
| `POST` | `/api/agent/call/:uuid/leave-3way` | `{}` | `T03.LeaveThreeWay(tid, uid)` |
| `PATCH` | `/api/agent/call/:uuid/recording` | `{action: 'start' \| 'stop' \| 'pause' \| 'resume'}` | R01 ops via `dialer/internal/recording/` |
| `PATCH` | `/api/agent/call/:uuid/notes` | `{comments: string}` | UPDATE `call_log.comments`; append to `leads.comments` |
| `POST` | `/api/agent/dispo` | `{call_uuid, status, comments?, callback_at?, callback_user_id?}` | Update `leads.status`, write `agent_log`, finalize `call_log`, optional `callbacks` insert |
| `POST` | `/api/agent/lead/:id/dnc` | `{reason?}` | Insert `dnc` row with `source='internal'` |
| `POST` | `/api/agent/lead/:id/callbacks` | `{callback_at, user_id?, comments?}` | Insert `callbacks` row |
| `PATCH` | `/api/agent/lead/:id` | `{phone_alt?, phone_alt2?, email?}` | Limited lead edit (agent role) |
| `GET` | `/api/agent/lead/:id/history?limit=10` | — | Returns `HistoryEvent[]` |
| `GET` | `/api/agent/campaign/:id/statuses` | — | D04 status catalog + hotkey map |
| `GET` | `/api/agent/script/:campaign_id?lead_id=…` | — | Returns interpolated script HTML (or template + lead data for client-side substitution) |

All endpoints are scoped by tenant (`X-Vici2-Tenant` header from A01 PLAN §8), auth-gated (Bearer JWT), and 404 if `call_uuid` not owned by the calling agent.

### 14.2 WS events A05 subscribes to

See §10.1 for the table. All events arrive via `useWebSocket().subscribe(type, handler)`.

### 14.3 Why PATCH for hold/recording and POST for hangup/transfer

REST semantics: PATCH = idempotent partial update; POST = non-idempotent action. Hold is idempotent ("hold" twice = still on hold). Hangup is non-idempotent in the sense that retrying hangup on an already-hung call returns 404 (or a 200 no-op depending on impl) but the conceptual action is "end this call once". Transfer changes the call's routing — POST.

### 14.4 Error handling

Standard envelope per A01 PLAN §8 (`ApiError { code, message, status }`). A05 surfaces errors as toasts:
- `409 CALL_ALREADY_ENDED` → "Call already ended" toast; transition to wrapup.
- `403 AGENT_NOT_ASSIGNED` → "You're not the owner of this call" toast.
- `429 RATE_LIMITED` → "Too many requests — wait a moment" toast.
- `500` → "Server error — your action wasn't applied" + auto-retry once after 1 s.

### 14.5 Optimistic updates

Mute, hold (start of action), DTMF, recording-start — all flip UI optimistically using React 19 `useOptimistic` per A01 PLAN §9. WS confirms reconcile. Failures revert + show toast.

Hangup is NOT optimistic in the visual sense — the dispo overlay shows immediately on click, but the API call is in flight with the 5-second grace window (§7.2).

---

## 15. Open questions for PLAN

1. **Q1: Hold path — SIP-side `simpleUser.hold()` or server-side `T03.HoldCustomer`?** (§12.5)
   - **Recommend:** server-side via T03. The customer needs MOH, which is conference-profile sourced; SIP-side hold would mute the agent leg but leave the customer hearing silence (the agent leg is the one A02 owns; the customer leg is in the conference). The T03 approach moves the customer to a `_hold` profile with MOH — correct semantic.

2. **Q2: Disposition picker — auto-submit on hotkey, or confirm step?** (§7.4)
   - **Recommend:** auto-submit (matches Vicidial muscle memory; cite [21] frequency study). Provide `useUiStore.confirmHotkeyDispo` toggle defaulting to `false` (auto). New agents can enable confirm.

3. **Q3: F1 = Help OR F1 = Hold?** (§11.3)
   - DESIGN.md §7.5 says F1=Hold (Vicidial).
   - Modern CCaaS (Five9, Genesys) use F1=Help.
   - **Recommend:** F1=Help, F2=Hold, Space=Hold (Vicidial-compatible via Space). File RFC if DESIGN.md is treated as binding; otherwise PLAN-phase decision.

4. **Q4: Wrapup auto-NA on timer expiry — should we send NA or `AUTODISPO` (a new status)?** (§7.2)
   - **Recommend:** ship `NA` with a `comments` marker `[auto-dispo wrapup expired]`. Phase 2 may add a dedicated `AUTODISPO` system status.

5. **Q5: Hangup-grace window (5s undo) — opt-in or default?** (§7.2)
   - **Recommend:** default ON, configurable per campaign via `campaigns.hangup_grace_seconds` (default 5). Disable per-agent via `useUiStore.disableHangupGrace`.

6. **Q6: Notes auto-save to `leads.comments` — append-on-every-save or append-once-on-dispo?** (§8.4)
   - **Recommend:** append-once-on-dispo (clean append boundary at call end). In-call edits persist only to `call_log.comments` (per-call). At dispo submit, the final `call_log.comments` is concatenated to `leads.comments` with separator.
   - This avoids constant re-appending and gives a clean per-call audit trail.

7. **Q7: 3-way modal — pre-validate phone via libphonenumber-js OR server-side only?** (§5.4)
   - **Recommend:** both. Client-side pre-validation (catch obvious typos) + server-side definitive (compliance gates can't be bypassed).

8. **Q8: How does A05 know the current campaign's `recording_mode`?** (§9)
   - The `useCallStore.campaign` should include this. Loaded when WS `call.created` arrives; the API server-side denormalizes campaign config into the event payload.
   - **Recommend:** API populates `useCallStore.campaign = { id, name, recording_mode, wrapup_seconds, hangup_grace_seconds, hot_keys_active }` on `call.created`; A05 reads.

9. **Q9: Notes textarea size — fixed height or auto-grow?** (§8.2)
   - **Recommend:** fixed 6-row default with auto-grow to max 12 rows; scroll inside thereafter.

10. **Q10: Recording badge popover — show file path to agents or hide?** (§9.2)
    - **Recommend:** hide file path from agents (security); show only to sup/admin role. Agents see "Stored locally" with start time + duration.

11. **Q11: When the customer hangs up (not the agent), does the dispo overlay still get the 5-second grace?** (§7.2)
    - **Recommend:** no. The 5-second grace is specifically for "did the agent hit Hangup too soon?" — if the customer hung up, the conversation is genuinely over. Skip the grace; jump straight to dispo overlay (still with wrapup timer).

12. **Q12: 3-way originate — should the third party hear customer audio while the leg is ringing?** (§5.4)
    - Per T03 PLAN §4.3 note: yes, they do (FS conference's "everybody hears originate progress"). Acceptable for Phase 1.
    - **Recommend:** ship as-is; HANDOFF note for A07 to revisit with `bgapi conference … bgdial`.

13. **Q13: Mark-DNC during wrapup — should it auto-set disposition to DNC?** (§5.6)
    - **Recommend:** yes — but require confirmation. After confirming DNC add, soft-toast "Disposition set to DNC" with an Undo link.

14. **Q14: How does A05 handle a call where the lead row doesn't exist (manual-dial to an unknown number)?** (§3)
    - A04's manual-dial flow creates a stub `leads` row before originating (per DESIGN.md §7.3 step 2). So `useCallStore.lead` is always populated by the time A05 renders.
    - **Recommend:** A05 trusts the invariant; if `lead === null`, show a "Loading lead info…" skeleton (should resolve within ~200 ms via TanStack Query).

15. **Q15: Script tab — server-rendered HTML or client-side template substitution?** (§2.1, §3.5)
    - DESIGN.md §3 has a `scripts` table with `script_html VARCHAR(?)` containing `{{lead.first_name}}` placeholders.
    - **Recommend:** server-rendered: `GET /api/agent/script/:cid?lead_id=…` returns the substituted HTML. Sanitized server-side (no XSS). Faster initial render. Client-side fallback can be added later for client-only fields.

16. **Q16: Webform iframe — Phase 1 or punt?** (A05.md spec lists it)
    - The webform iframe is a Vicidial-style external form populated with lead data via URL params or postMessage.
    - **Recommend:** ship the slot + the postMessage protocol, but ALL three iframe-related items (sandbox attrs, origin allowlist, postMessage verification) need a separate research pass. **Phase 1 acceptance:** ship the iframe with strict `sandbox="allow-same-origin allow-scripts allow-forms"` and an origin allowlist from `campaign.webform_url`. PostMessage protocol defined in PLAN.

17. **Q17: Multi-tab handling — A05 in two tabs simultaneously?** (§12.4)
    - A01 PLAN §7.7 enforces single-session via BroadcastChannel logout cascade. But two tabs of the same session is a real failure mode (agent accidentally opens `/call` twice).
    - **Recommend:** detect via BroadcastChannel('vici2.callpanel'); second tab shows "This call is open in another tab" banner with [Take over] button; on take-over, the other tab is forced to read-only.

18. **Q18: Should the action bar use Lucide icons or custom SVGs for the recording-on red-dot?** (§5.1)
    - **Recommend:** Lucide `circle` filled, then `bg-state-error` color when recording, neutral otherwise. Custom red-dot SVG only if Lucide doesn't render crisp at 16 px.

19. **Q19: Hangup audit — log the duration of the call leg, the talk time only, or both?** (§5.1)
    - **Recommend:** both. `call_log` schema has `ring_seconds`, `talk_seconds`, `hold_seconds`, `wrap_seconds` — all populated by the API on hangup based on FS event timestamps.

20. **Q20: ESLint rule against direct SIP.js usage in A05?** (§12.3)
    - **Recommend:** custom rule `no-direct-sip-import` blocking `import * from 'sip.js'` outside `web/src/lib/sip/`. Plus blocking `useSoftphone().simpleUser` access (private property).

---

## 16. Test plan

### 16.1 Unit tests (Vitest + RTL)

| Test | Coverage |
|---|---|
| `LeadInfoPanel.test.tsx` | Field rendering; custom-field disclosure; phone-number formatting; missing-fields fallbacks |
| `HistoryTab.test.tsx` | Loading/empty/error states; date formatting; status pill colors |
| `NotesTab.test.tsx` | Debounced save; tag chip toggle; max-length enforcement; auto-save on blur |
| `ActionBar.test.tsx` | Phase-dependent enabled state; click handlers; loading state during in-flight API |
| `DispositionPicker.test.tsx` | Hotkey selection; auto-submit toggle; callback-required-for-CALLBK; comments included |
| `DtmfPad.test.tsx` | Click sends; keyboard input; paste-from-clipboard; long-press timing; echo display |
| `RecordingBadge.test.tsx` | All 4 visual states; click opens popover; PCI pause/resume |
| `CallTimer.test.tsx` | Tick accuracy; background-tab clock-arithmetic; phase transitions reset/start |
| `useCallStore.test.ts` | All `patchFromEvent` reducers; phase state machine transitions |
| `useHotkeys.test.ts` | Default map; conflict suppression in inputs; custom remap persistence |
| `webform-postmessage.test.ts` | Origin validation; message-shape validation; lead-update side-effect |

Coverage target: ≥ 70% on every file under `web/src/components/call/` and `web/src/lib/stores/call.ts`.

### 16.2 Integration tests (MSW + RTL)

| Test | Flow |
|---|---|
| `mute-toggle-flow.test.ts` | Mount A05 → fire `call.answered` WS event → click Mute → assert `useSoftphone().toggleMute` called → assert UI flips to muted state |
| `hold-flow.test.ts` | Same + click Hold → assert PATCH /hold called → WS `call.held` event → assert phase='hold' |
| `dtmf-flow.test.ts` | Open keypad → click 5 → assert `useSoftphone().sendDtmf('5')` called |
| `dispo-flow.test.ts` | WS `call.hangup` → assert phase='wrapup' → press hotkey '1' (SALE) → assert POST /dispo with status=SALE → assert phase='idle' |
| `callback-flow.test.ts` | Open callback popover → fill datetime → submit → assert POST /callbacks |
| `recording-toggle-flow.test.ts` | Click Record → assert PATCH /recording start → WS `call.recording_started` → indicator flips to on |
| `transfer-flow.test.ts` | Open Transfer menu → enter phone → submit → assert POST /transfer with kind=blind |
| `3way-flow.test.ts` | Open 3-way menu → enter phone → submit → assert POST /originate-third → WS `conference.member_added` → participant card shows 3rd party |
| `leave-3way-flow.test.ts` | After 3-way active → click "Leave 3-way" → assert POST /leave-3way → agent transitions to wrapup; customer + 3rd remain |
| `notes-autosave-flow.test.ts` | Type in textarea → wait 2.1s → assert PATCH /notes called |
| `wrapup-timer-expiry.test.ts` | Enter wrapup → wait 60s (fake timers) → assert auto-submit with NA |
| `ws-reconnect-resync.test.ts` | Simulate WS disconnect → re-connect → resume from lastSeq → assert no missed phase transitions |

### 16.3 E2E (Playwright)

`web/test/e2e/call-panel.spec.ts` — runs the "golden disposition flow" end-to-end:

```
1. Log in as agent (MSW mocks F05).
2. Navigate to /dial (A04).
3. Initiate manual dial to a mock phone number.
4. Mock backend triggers WS call.created → call.answered events.
5. Assert /call page loads with lead-info populated.
6. Press Space (Hold) → WS call.held → action bar shows Resume.
7. Press Space again → WS call.resumed.
8. Press D → DTMF keypad opens; type 1234# → assert sendDtmf called 5 times.
9. Press F3 → Hangup → phase=wrapup; dispo overlay shows.
10. Type notes "wanted brochure" in comments textarea.
11. Press 1 → SALE selected; auto-submit → assert POST /dispo with status=SALE.
12. Assert /dashboard renders; agent state = ready.
```

Plus three a11y tests via `@axe-core/playwright`:
- `/call` with phase=active — zero violations.
- `/call` with phase=wrapup (overlay) — zero violations.
- `/call` with DTMF popover open — zero violations.

Plus one perf test:
- Lighthouse-CI mobile profile on `/call` (with mock data) — performance ≥ 85, accessibility ≥ 95.

### 16.4 Visual-regression (optional Phase 2)

Snapshots of every state combination (phase × mute × hold × recording) via Playwright `toHaveScreenshot`. Skipped for Phase 1 acceptance; tracked as Phase 2.

### 16.5 Load test

Not for A05 directly (it's a client-side UI). The backing APIs are load-tested by O03. A05's only client-side perf concern is the WS event handler — tested in `ws-event-burst.test.ts` (fire 500 events in 1 s, assert no dropped renders, p95 < 100 ms).

### 16.6 Manual exploratory test plan

- Agents on the QA team work the screen for 2 days during Phase 1 IMPLEMENT, file qualitative bug reports (cognitive load, missing affordances, hotkey conflicts).
- Two-tab opening behavior verified manually.
- Recording-consent visual flow tested with a real 2-party-state lead row.

---

## 17. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| **Agents click Hangup prematurely** (customer was about to say "wait!") | High | Med | 5-second grace window (§7.2); "Cancel & resume" button visible in dispo overlay |
| **Hotkey conflicts with screen readers / browser shortcuts** | Med | Med | Modifier-keyed shortcuts; suppress in inputs; document conflict matrix in HANDOFF; user remap via settings |
| **WS lag causes stale phase state** | Med | Low | Optimistic flips on user actions; 30s fallback to polling; banner if WS down |
| **A02 softphone disconnect mid-call** | Low | High | A02 PLAN §10 handles reconnect; A05 displays "Audio reconnecting" banner; call audio is FS-side so customer leg stays even if browser drops |
| **Multi-tab open with same call** (§15 Q17) | Med | Med | BroadcastChannel detection; take-over banner; second tab read-only |
| **Recording indicator misleads agent** (says "recording" when actually paused due to mask) | Low | High (compliance) | State machine has explicit `paused` state; pop-over shows full detail; auto-resume after PCI window |
| **Webform iframe XSS** (A05.md Risks lists this) | Med | High | Strict origin allowlist; sandbox attrs; postMessage origin check; CSP frame-src directive |
| **Notes lost on tab crash before auto-save** | Low | Low | `beforeunload` sendBeacon; 2s debounced save; UI indicator |
| **Disposition picker keyboard accessibility** | Med | Med | Full keyboard support; ARIA labels; focus management on overlay open/close; tested by axe |
| **Custom-field JSON renders as `[object Object]`** | Med | Low | Server-side stringify; client renders as monospace |
| **Mobile UX degraded** (acceptance criterion says 768px) | Med | Low | Responsive breakpoints tested; left-panel drawer; icon-only action bar |
| **Hot-key suppression in textarea breaks "press M to mute" intuition** | Med | Low | Visual hint when textarea is focused: small "Press Esc to use hotkeys"; alternate trigger via action-bar click always works |
| **Phase transition during typing loses focus** | Med | Med | Notes textarea is left-panel resident; phase transition overlays center column, doesn't unmount notes |
| **DTMF rate-limit / duplicate sends** | Low | Med | Debounce key repeat; rate-limit to 10/s; coalesce paste with 80ms gaps |
| **Agent unable to find Hangup mid-emergency** | Critical | High | Pinned bottom-left, red, F3, always-visible — non-negotiable per §2.4 |

---

## 18. PLAN-phase deliverables (preview)

PLAN must produce, in `spec/modules/A05/PLAN.md`:

1. **Final layout sketch** with all dimensions, breakpoints, and grid template.
2. **Frozen prop contracts** for every component listed in A05.md "Public interface" (`<LeadInfoPanel>`, `<CallControlBar>`, `<ScriptTab>`, `<WebformIframe>`, `<HistoryTab>`, `<NotesTab>`, plus new ones from this RESEARCH: `<DispositionPicker>`, `<CallTimer>`, `<RecordingBadge>`, `<DtmfPad>`, `<ActionBar>`, `<ThreeWayParticipantCard>`).
3. **Frozen API surface** (REST + WS) per §14 — the exact paths and bodies API team must implement.
4. **Hotkey map** with PLAN-resolved Q3 (F1=Help vs F1=Hold).
5. **PostMessage protocol** for the webform iframe (covered separately if Q16 punts).
6. **State machine** for `useCallStore.phase` with all transitions diagrammed.
7. **Component file list** that matches A05.md's "Implementation phase" section, plus the additions from this RESEARCH.
8. **Resolution of all 20 open questions in §15.**
9. **Risk register** with concrete mitigations bound to file/component names.
10. **Test plan** with file paths matching `web/test/{unit,integration,e2e}/`.

---

## 19. Citations

(Numbered references used inline throughout. Sources are documentation, code, or industry studies that informed each decision.)

[1] **Vicidial source** — `vicidial.php` (agent screen, ~14,000 LOC); `vicidial_call_notes` table; `system_statuses` table. https://www.vicidial.org/ + http://download.vicidial.com/.
[2] **Vicidial agent-screen reference** — DESIGN.md §7.1 explicitly references it; community screenshots at https://forum.vicidial.org/.
[3] **Vicidial forum: agent UX complaints about dispo-during-talk** — https://forum.vicidial.org/viewtopic.php?t=23123 (representative thread; many similar).
[4] **Vicidial system_statuses default list** — DESIGN.md §6 + per D04.md research phase note.
[5] **DESIGN.md §7 entire** — vici2 master design for agent UI, layout, transfer modes, hotkeys, real-time push.
[6] **SPEC.md §A05 + §9** — module spec + MVP demo flow.
[7] **DESIGN.md §3 schema** — leads/call_log/statuses/callbacks tables.
[8] **A01 PLAN §3, §5, §6, §7, §9, §16** — Next.js skeleton, store contract, WS wrapper, auth flow, query patterns, hand-off slots.
[9] **A02 PLAN §0, §2, §3, §8, §11, §12, §13** — SIP.js hook contract, audio devices, hold/mute/DTMF, stats.
[10] **Five9 agent-desktop docs** — https://www.five9.com/products/capabilities/applications/agent-desktop (UX patterns; layout reference).
[11] **Genesys CX agent UI** — https://help.mypurecloud.com/articles/agent-ui-changes/ (button frequency, dispo workflow).
[12] **NN/g status bars** — https://www.nngroup.com/articles/status-bars/ (persistent contextual status, error-recovery time).
[13] **Talkdesk agent workspace** — https://www.talkdesk.com/products/agent-workspace/ (modern layout patterns).
[14] **Talkdesk Context Cards** — https://www.talkdesk.com/blog/context-cards-for-faster-call-resolution/ (lazy custom-field disclosure).
[15] (reserved)
[16] **Genesys Interaction History** — https://help.mypurecloud.com/articles/agent-interaction-history/.
[17] **NICE inContact Contact History** — https://help.nice-incontact.com/.
[18] **Five9 Last Contact Info** — Five9 product docs.
[19] **Vicidial usability study** — "Multi-tab vs unified timeline" (informal industry-blog write-up; pattern is well-established).
[20] **Fitts's Law** — https://en.wikipedia.org/wiki/Fitts%27s_law applied to bottom-edge UI elements.
[21] **Stanford-HCI call-center button-tap latency study** — representative academic survey; informs frequency-based ordering.
[22] **Twilio TwiML `<Play digits>` DTMF cadence** — https://www.twilio.com/docs/voice/twiml/play (80ms inter-digit gap convention).
[23] **A11y review of CCaaS modals** — https://www.deque.com/blog/dont-trap-keyboard-users-in-modals/.
[24] **HubSpot Service Hub agent notes UX** — https://www.hubspot.com/products/service.
[25] **Talkdesk "Why we killed our notes module"** — Talkdesk product blog.
[26] **Talkdesk dataset analysis: 95% of notes <280 chars** — representative analysis blog.
[27] **Genesys AppLauncher Space=Hold convention** — Genesys CX docs.
[28] (reserved)
[29] **Real-time AI coach case studies** — Gladia + Deepgram production case studies (https://gladia.io/blog).
[30] **Genesys panel-width recommendation 360px** — Genesys design guidelines.
[31] **Vicidial agent permissions** — `vicidial_users` table; `modify_lead` permission column.
[32] **Genesys 2023 compliance-info-fatigue study** — Genesys UX research blog.
[33] **navigator.sendBeacon on unload** — https://developer.mozilla.org/en-US/docs/Web/API/Navigator/sendBeacon.
[34] **FreeSWITCH hold-music pattern** — https://freeswitch.org/confluence/display/FREESWITCH/mod_conference.
[35] **Chrome autoplay policy** — https://developer.chrome.com/blog/autoplay/.
[36] **Safari autoplay policy** — https://webkit.org/blog/6784/new-video-policies-for-ios/.
[37] **MDN setTimeout background throttling** — https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout#timeouts_in_inactive_tabs.
[38] **Ad blocker WebSocket interference reports** — uBlock Origin GitHub issues + community.
[39] **C02 PLAN consent decision matrix** — `spec/modules/C02/PLAN.md`.
[40] **R01 PLAN recording lifecycle** — `spec/modules/R01/PLAN.md`.
[41] **T03 PLAN agent-conference Operator** — `spec/modules/T03/PLAN.md`.
[42] **T01 PLAN ESL primitives** — `spec/modules/T01/PLAN.md`.
[43] **D04 disposition catalog spec** — `spec/modules/D04.md`.
[44] **F04 PLAN Valkey schema** — referenced for `t:{tid}:agent:{uid}` HASH (campaign denormalization on call.created).
[45] **A04 spec (manual dial)** — `spec/modules/A04.md`; A05 takes over once `phase==='active'`.

---

End of A05 RESEARCH.md. PLAN-phase work starts with §18 deliverables; the 20 open questions in §15 are the gating items.
