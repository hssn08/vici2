# I04 — Inbound Callback Queue — RESEARCH

| Field | Value |
|---|---|
| **Module** | I04 — Inbound callback queue ("press 1 to receive a callback") |
| **Author** | I04-PLAN sub-agent (Claude Sonnet 4.6, 1M ctx) |
| **Date** | 2026-05-13 |
| **Status** | RESEARCH — companion to PLAN.md |
| **Phase** | 3 (Inbound/Blended) |

---

## 1. Problem statement

Callers waiting in an I01 in-group queue face two choices today: wait or hang up. Both outcomes are negative. Inbound callback queue (I04) adds a third path: the caller accepts a callback, hangs up satisfied, and receives an outbound call when an agent becomes ready for that in-group. This is the canonical "virtual hold" pattern used by every major contact-center platform (Genesys, Five9, NICE, Avaya).

There are two separate entry paths that both produce the same artifact — an inbound callback row:

1. **I01 queue overflow** (`callback_offer` overflow action): triggered when the caller has waited past `callback_offer_after_seconds` in a live queue. The dispatcher plays a DTMF offer and accepts press-1.
2. **I02 IVR terminal node** (`terminal_callback`): a dedicated IVR branch presents the callback offer before the caller ever enters the queue. The eslbridge picks up the hang-up event and calls the API.

Both paths create a `callbacks` row with `source=INBOUND` (a new discriminator I04 adds to the existing D06 schema). Both rows are fired by the same picker extension that already handles D06 AGENT/GLOBAL callbacks.

---

## 2. UX flow — step by step

### 2.1 Path A: offer while in queue (I01)

```
Caller dials DID → I02 routes to ingroup_SUPPORT → I01 enqueues
  [After callback_offer_after_seconds elapses (default 90 s)]
  Dispatcher: uuid_broadcast → play_and_get_digits callback_offer.wav
  Caller presses 1
  System captures callback number (ANI by default; DTMF override described in §3)
  System:
    1. Validates number format (E.164 or 10-digit NANP)
    2. POST /internal/queue/exit_callback (existing I01 hook — extended for I04)
    3. Creates callbacks row (source=INBOUND, status=PENDING, preserve-position metadata)
    4. ZREM call from ingroup queue (caller hangs up, slot freed)
    5. Plays confirmation: "We'll call you back at [number]. Goodbye."
    6. uuid_kill
```

### 2.2 Path B: IVR terminal_callback (I02)

```
Caller dials DID → I02 IVR menu → presses digit for "request a callback"
  [I02 terminal_callback node]
  play_and_get_digits callback_offer.wav (press 1 to confirm)
  Caller presses 1
  Channel vars set: vici2_callback_ingroup, vici2_callback_requested=1
  Caller hangs up
  eslbridge HANGUP_COMPLETE handler:
    POST /internal/ivr/callback_accept/{uuid}  (I02 hook — extended for I04 source)
    API creates callbacks row (source=INBOUND)
```

### 2.3 Agent side — callback fires

```
Agent becomes READY for ingroup_SUPPORT
  Picker (I01 dispatcher) detects INBOUND callback with queue_position priority
  Picker fires callback:
    - Originate outbound call to callbacks.callback_number (not lead phone)
    - From-CLI = ingroup.outbound_cli (the in-group's published outbound caller ID)
    - On answer: uuid_transfer to agent conference (T03 conference-per-agent)
    - WS event to agent: inbound_callback_offer { ingroup, wait_seconds, original_position }
  Agent answers, speaks to customer
  Disposition: same D04 dispo flow; lead status updated
```

---

## 3. ANI capture and confirmation

### 3.1 Default: use caller's ANI

The caller's CLI/ANI (`Caller-ANI` FreeSWITCH channel header) is used as the callback number. This is E.164 when the carrier delivers it, or 10-digit NANP without country code from most US carriers.

### 3.2 DTMF-entered number override

Some callers have a different callback number (office vs mobile). The offer prompt can optionally collect a 10–11 digit DTMF number before confirmation. This is controlled by `ingroups.callback_number_mode ENUM('ani','dtmf_optional','dtmf_required')`. Default: `ani`.

- `ani`: Use ANI directly; skip DTMF collection prompt.
- `dtmf_optional`: Offer "press 1 to use [ANI], press 2 to enter a different number." Press 1 = ANI; press 2 = collect 10-11 DTMF digits.
- `dtmf_required`: Always collect DTMF number (useful when ANI is not delivered or is a switchboard number).

### 3.3 Number normalization

All captured numbers pass through a normalizer before storage:
- Strip leading `+1` or `1` prefix; accept 10-digit NANP
- Accept `+{digits}` for international (stored as E.164)
- Reject strings shorter than 7 digits (invalid) or longer than 15 digits (E.164 max)
- Reject `555-1212`, `555-0100`–`555-0199` (fictional/reserved NANP ranges)

### 3.4 ANI delivery failure

If ANI is absent (empty `Caller-ANI`) and mode is `ani`:
- Fallback to `dtmf_required` for this call only
- Log `vici2_i04_ani_missing_total` metric
- Offer prompt says "Please enter the 10-digit number where we can reach you."

### 3.5 International callers

For non-NANP countries:
- Accept E.164 format from ANI if carrier delivers it
- DTMF entry: prompt "Enter your country code and number, then press #"
- Validated against E.164 pattern: `^\+[1-9]\d{6,14}$`
- C01 TCPA gate applies only for US numbers; non-US numbers pass through without window-check (TCPA is a US law). Log `vici2_i04_non_us_number_total` for monitoring.

---

## 4. Preserve-position semantics

### 4.1 The core contract

When a caller accepts a callback, they should be served in approximately the order they would have been served had they waited in queue. This is the "preserve-position" or "virtual hold" guarantee. Without it, a caller who waited 10 minutes and accepted a callback could find themselves behind callers who waited only 5 minutes — a UX betrayal.

### 4.2 Implementation: queue_position_at_offer

I01 PLAN §11.4 already defines `callbacks.queue_position_at_offer` (an integer stamped at offer time). I04 extends this with:
- `callbacks.original_wait_seconds`: seconds caller waited before accepting
- `callbacks.original_ingroup_id`: the in-group the caller was waiting in

D06 sorts priority callbacks by `queue_position_at_offer ASC` within the same `original_ingroup_id` when batching. A caller who was position 2 is dialed before a caller who was position 5. This is the preserve-position contract.

### 4.3 Priority relative to other callback types

Priority stack (higher priority fires first):
1. INBOUND callbacks with `queue_position_at_offer IS NOT NULL` (preserve-position; sorted by position)
2. INBOUND callbacks with `queue_position_at_offer IS NULL` (IVR path; no position info; sorted by `created_at`)
3. AGENT-scoped D06 callbacks (individual agent agreements)
4. GLOBAL D06 callbacks

In Valkey ZSET terms: inbound-preserve callbacks get a negative score offset from position (`score = created_at_ms - position * 60000`). This ensures position-1 fires before position-5. Tuned so even a position-10 callback fires before a GLOBAL D06 callback unless the D06 callback is very old.

### 4.4 "Position expired" degradation

If no agent was ready for the in-group during the next N minutes, the position-based priority degrades gracefully: the callback is re-inserted with a score that competes on wait time alone (essentially `created_at`). Threshold: `ingroups.callback_position_expiry_minutes` (default 60 min). After expiry, the callback is still fired — just without position priority.

### 4.5 Cross-ingroup position

The preserve-position contract is scoped to the `original_ingroup_id`. A callback for `ingroup_SUPPORT` competes only with other `ingroup_SUPPORT` callbacks on position ordering, not with `ingroup_SALES` callbacks.

---

## 5. TCPA analysis at fire time

### 5.1 Consent basis

The customer explicitly requested the callback by pressing 1. This is "express consent" under TCPA for this specific call. The consent is event-specific (not a blanket autodialer consent):
- Legal basis: FCC 2015 TCPA Ruling, 30 FCC Rcd 7961, ¶ 47 — express consent is inferred from customer-initiated contact and explicit callback request.
- I04 must record the consent moment in `originate_audit.consent_mode = 'INBOUND_CALLBACK_REQUESTED'`.
- This consent covers exactly one callback call attempt. It does NOT convert the lead to an opted-in marketing contact.
- Reassigned number risk: if the number has been reassigned since the callback request (rare but possible), the consent is invalidated. Phase 1: no reassigned-number scrub. Phase 2: integrate with TCPA Reassigned Numbers Database (RND).

### 5.2 Time-of-day gate (C01)

Even with express consent, TCPA 8am–9pm called-party-local-time applies to ALL outbound calls. I04 callbacks are outbound calls to US numbers and must pass C01.Check() at fire time with `enforcementPoint='callback_fire'` (same as D06 callbacks).

### 5.3 Behavior when fire-time is outside TCPA window

Two scenarios:

**Scenario A: Caller accepted callback at 8:45 PM local time.**
The callback cannot fire until next morning. I04 re-snoozes the callback to `C01.NextOpen()` (next day 8:00 AM local). The customer agreed to "we'll call you back" — they did NOT specify a time. Re-snoozed callbacks remain in PENDING; agent does not see them as due until the window opens.

**Scenario B: Caller accepted at 2:00 PM local; no agent available until 9:10 PM.**
The callback cannot fire at 9:10 PM. C01 returns SKIP_UNTIL with nextOpen = next day 8:00 AM. Re-snooze. The callback will fire next morning regardless of which agent is available then (GLOBAL scope).

Both scenarios use the same D06 `deferCallback()` path: update `callbacks.callback_at = tcpa.nextOpen`.

### 5.4 "Caller requested" does not waive time window

Despite express consent, we do NOT waive the time window. Rationale:
1. The caller's consent covered "we'll call you back" — they may have expected a call within a few minutes, not at 9:30 PM.
2. The legal exposure from a wrong call at 9:10 PM ($500–$1500 per call) is higher than the cost of re-snoozed callbacks.
3. C01 is the architectural decision for this system; all outbound calls gate through it unconditionally (C01 PLAN §0 bullet 2).

### 5.5 Expiry interaction

If a callback is re-snoozed past its `expires_at` (96 h default), O02 will mark it `DEAD`. The customer will not receive a callback. This is a limitation to document and configure appropriately: `ingroups.callback_expires_hours` should exceed the maximum expected gap-to-agent, accounting for TCPA windows.

### 5.6 Non-US numbers

Non-US callback numbers bypass TCPA. However, carrier costs and legal exposure in other jurisdictions (GDPR etc.) must be considered. Phase 1: fire non-US callbacks without C01 gate but log `vici2_i04_intl_callback_fired_total`. Phase 2: pluggable international compliance gate.

---

## 6. Schedule semantics — ASAP vs. scheduled-time

### 6.1 Phase 1 ships ASAP-only

An inbound callback is always "as soon as possible" — fire when the next agent for the in-group becomes available, subject to TCPA window. There is no UI for the caller to request "call me back tomorrow at 2 PM." That feature (customer-selected time) is Phase 2.

### 6.2 Rationale

- Operational: queue-position fairness requires ASAP semantics. A customer who waited 5 minutes and requested a callback should be served within minutes, not hours.
- UX: the callback offer prompt says "we'll call you back as soon as an agent is available." Not "schedule for a specific time."
- Phase 2: add `callback_preferred_time` DTMF collection ("press 1 for ASAP, press 2 to select a time") and a customer-facing reschedule link (SMS/email). This is complex enough to warrant its own submodule.

### 6.3 `callback_at` for ASAP callbacks

Because D06's data model requires `callbacks.callback_at`, ASAP callbacks use `NOW()` as the `callback_at` value. The D06 worker's grace-window logic (`callback_at <= NOW() + grace_window_seconds`) makes them immediately eligible. Sorting is then by `queue_position_at_offer` (lower = higher priority).

---

## 7. Agent UI: "INBOUND CALLBACK" badge

### 7.1 Distinction from D06 callbacks

Agents need to know they are calling back a customer who waited in queue, not a lead they themselves scheduled. This affects the conversation opener ("Hi, I'm calling back about your hold time" vs. "Hi, I said I'd call you back about your account").

### 7.2 Badge display

In A04/A06, when `callbacks.source = 'INBOUND'`:
- Show badge: `INBOUND CALLBACK` (orange, not green like D06 AGENT callbacks)
- Show: `Original wait: {original_wait_seconds}s` 
- Show: `Queue position: {queue_position_at_offer}` (if available)
- Show: `In-group: {original_ingroup_id}`

In A05 call panel (during the outbound callback call):
- Header: `CALLBACK — [CustomerName or number]`
- Subheader: `Was waiting {original_wait_seconds}s in {ingroup_name}`

### 7.3 Script suggestion

Phase 1: static string "You are calling back a customer who requested a callback. Original wait: Xs." Phase 2: configurable per-in-group opener script (M05 admin UI).

---

## 8. Picker integration (E04 / I01 dispatcher)

### 8.1 Who fires inbound callbacks?

The I01 queue dispatcher already runs a per-in-group loop. When an agent becomes READY for `ingroup_SUPPORT`, the dispatcher checks:
1. Are there waiting calls in the queue? If yes, dispatch next call (existing path).
2. Are there pending INBOUND callbacks for this in-group? If yes AND no waiting calls, dispatch the highest-priority callback.

This means I04 callbacks "fill the gaps" when no live calls are waiting. The ingroup dispatcher is the picker for I04, not E04 (outbound picker). E04 is for outbound campaigns; I04 integrates with I01's dispatcher.

### 8.2 Dispatcher extension for callbacks

New check in I01 dispatcher loop:
```
if ZCARD(ingroup_queue) == 0:
    cb = fetchNextInboundCallback(ingroup_id, tenant_id)  # ordered by position then created_at
    if cb is not None:
        fireInboundCallback(cb)
```

`fireInboundCallback` is the same as D06's `promoteCallback` but uses the in-group's outbound CLI as the from-number and the customer's saved callback number as the to-number.

### 8.3 Priority over D06 GLOBAL callbacks

Within an in-group context, INBOUND callbacks are prioritized over any GLOBAL D06 callbacks (which have no queue-position relationship to the in-group). D06 AGENT callbacks to specific agents are orthogonal and not affected.

### 8.4 Prevent double-dispatch (idempotency)

Valkey lock key per callback: `t:{tid}:i04:cb_fire_lock:{callback_id}` SET NX EX 120. If locked, skip. This prevents two dispatcher instances from firing the same callback. Same pattern as D06 worker Valkey lock.

---

## 9. D06 schema relationship

### 9.1 Re-use not duplication

I04 does NOT create a new `inbound_callbacks` table. It extends the existing D06 `callbacks` table with:
- `source ENUM('AGENT','GLOBAL','INBOUND') NOT NULL DEFAULT 'AGENT'` (new column)
- `original_ingroup_id VARCHAR(32) NULL` (FK to ingroups; the I01 in-group that spawned this callback)
- `original_wait_seconds INT UNSIGNED NULL` (seconds caller waited before accepting)
- `callback_number VARCHAR(20) NULL` (the number to call back; may differ from lead phone; E.164 or NANP)

`callback_number` is separate from `lead.phone` because:
1. The caller may have entered a different callback number (DTMF override).
2. We must call the consented number, not the lead's stored number.
3. If no lead record exists (anonymous caller), `lead_id` may be NULL or linked to a just-created stub lead.

### 9.2 Lead record handling for anonymous callers

If `D01.lookupLeadByPhone(ANI)` returns no match:
- Create a stub lead: `leads.first_name='Callback', last_name='', phone=ANI, status=CALLBK, source='INBOUND_CB'`
- Use this stub `lead_id` in the callback row.
- After the agent's conversation, D04 disposition should update the lead record with name/details.

### 9.3 `callback_number` vs. `lead.phone`

At fire time, the originate uses `callbacks.callback_number`, NOT `lead.phone`. If `callbacks.callback_number IS NULL`, fall back to `lead.phone`. The TCPA gate also uses `callbacks.callback_number` for TZ resolution (via D03 with the callback number's area code/state).

---

## 10. Open questions

### OQ-1: Supervisor visibility

Where do supervisors see pending INBOUND callbacks? I01 PLAN §9.3 (overflow actions) and D06 PLAN §7.4 (admin queue) both have partial views. I04 should add a dedicated inbound-callback panel to the admin UI, or extend `GET /api/admin/callbacks?source=INBOUND` (already covered by the D06 PLAN endpoint with a `source` filter — I04 just adds the INBOUND enum value).

**Decision:** Extend `GET /api/admin/callbacks?source=INBOUND` with the INBOUND source filter. No new endpoint needed.

### OQ-2: What if the caller's number is busy at callback time?

The outbound call attempt may result in busy signal, no-answer, or voicemail. The originate completes but the customer doesn't answer. Apply D06 `callback_no_answer_policy` (`leave_callbk` by default). For INBOUND callbacks specifically, `reschedule_30m` (30-minute re-schedule) is a better default than `reschedule_24h`, since the customer expected "soon." I04 introduces `ingroups.callback_no_answer_policy_inbound ENUM('leave_callbk','reschedule_30m','reschedule_24h','terminate_NA')` defaulting to `reschedule_30m`.

### OQ-3: DNC applicability

A customer calling in to request a callback is expressly consenting to this specific call. But what if that number is on the internal DNC list from a previous campaign? Resolution: because the customer initiated and explicitly requested the callback, the inbound-requested callback overrides internal DNC for this single call. D05's DNC check is bypassed for `source=INBOUND` callbacks with `consent_mode=INBOUND_CALLBACK_REQUESTED`. The National DNC is NOT bypassed (that would be illegal). Log bypasses in `originate_audit`.

**Decision:** Skip internal DNC; do NOT skip National DNC. Log in audit.

### OQ-4: Blended agents

Phase 3 agents are non-blended (outbound XOR inbound). When an agent serves an inbound callback, are they on an "inbound" or "outbound" call? From FreeSWITCH's perspective it is an originate (outbound). From the queue's perspective it is an inbound-callback fulfillment. The `call_log` should record `direction='inbound_callback'` (new direction value) so AHT for the in-group's EWT formula is computed correctly.

### OQ-5: Multiple callback rows for same caller

A caller could accept a callback from position 5 in SUPPORT and later call back and wait in SALES. Can they have two INBOUND callbacks simultaneously? Yes — different in-groups, different `callback_number` may be same. No deduplication enforced at schema level. Operator may observe this via the admin callbacks list. Phase 2: optional deduplication by `callback_number` within same `original_ingroup_id`.

### OQ-6: What if the in-group is deleted?

`callbacks.original_ingroup_id` is a nullable FK. If the in-group is deleted, the callback becomes orphaned — no dispatcher will process it. Resolution: before deleting an in-group, require reassignment of all PENDING inbound callbacks (or auto-DEAD them). Admin UI shows warning on in-group delete if pending callbacks exist. This is a Phase 1 safeguard.

### OQ-7: Metrics for SLA

Operators want to know: what fraction of inbound callbacks are fulfilled within N minutes of acceptance? This requires `callbacks.fired_at` timestamp (not in D06 Phase 1 schema). I04 migration adds `fired_at DATETIME(6) NULL` to callbacks. SLA metric: `TIMESTAMPDIFF(SECOND, created_at, fired_at)` for INBOUND callbacks.
