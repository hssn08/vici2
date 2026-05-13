# E04 — Picker (Lead-Claim + Dispatch + Agent/Lead Pairing) — PLAN

| Field | Value |
|---|---|
| **Module** | E04 — the picker: claim leads, dispatch to T04, pair answered calls to agents |
| **Author** | E04-PLAN sub-agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator review |
| **Companion** | [RESEARCH.md](./RESEARCH.md) — 52 citations |
| **Module spec** | `spec/modules/E04.md` (superseded by this PLAN — see MODULE_SPEC_UPDATE note at end) |
| **Depends on (FROZEN upstream)** | T04 PLAN §3/§4/§7/§8 (5-gate pipeline, Mode→DialTarget, attempt_uuid rule, typed errors); T03 PLAN §1.2 (`ConferenceFQN`, `+flags{join-only}` mandatory); T01 PLAN §17.5 (E04 may call T01.UUIDTransfer directly); F04 HANDOFF §2 (Lua scripts: `claim_lead_from_hopper.v1`, `release_hopper_lock.v1`, `pick_agent_for_call.v1`); F02 PLAN §4 + F02 AMENDMENTS A1/T04.1–T04.4; D01 PLAN (lead model); C01 PLAN §2/§7 (TCPA gate owns last-chance check — T04 calls it, E04 does not); E01 PLAN §1.3/§6/§7/§8 (Consumer.Claim, Release, refill_request, freq-cap owner); E02 RESEARCH §1/§3 (pacing publishes dispatch_tokens; E04 owns claim+dispatch loop) |
| **Blocks** | E02 (pacing integration — must understand dispatch_tokens contract before E02 IMPLEMENT); E05 (drop-gate — depends on events:vici2.call.dropped XADD shape from E04); E06 (janitor — calls picker.SweepOrphans); A04 (manual dial — calls T04 directly, but MANUAL mode dispatch flows through E04's tick when campaign-initiated); O01 (metrics wiring) |

This PLAN turns the E04 RESEARCH into the exact Go package layout, public API
surface, Valkey contract, pairing-model logic, retry policy, concurrency model,
and test plan that IMPLEMENT will deliver. Once approved, the following are
FROZEN: the `dispatch_tokens` STRING DECR contract, the pre-pair/dial-then-pair
pairing model semantics, the `DialOutcome` enum and its `D04 status + requeue-
hint` mapping, the `OriginateRequest` fields E04 fills, the Prometheus metric
names, and the `dialer/internal/picker/` package boundary. Gate internals,
concurrency tuning, and log sampling can change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **E04 is the picker — "who and how" of every outbound dial.** E02 publishes
   the budget (`dispatch_tokens`); E04 claims leads, optionally reserves agents,
   calls T04.Originate, and maps outcomes to E01.Release. E02 never touches the
   hopper. This is the redrawing agreed in the RESEARCH §3 boundary rewrite,
   superseding E02 RESEARCH §3.7's inline claim+dispatch loop.

2. **Two pairing models share one dispatch goroutine.** PROGRESSIVE / MANUAL /
   PREVIEW: agent reserved *before* originate (pre-pair — zero abandonment
   risk). PREDICTIVE: AgentID=0, originate to PARK, then a separate answer-
   handler goroutine picks an agent on `events:vici2.call.answered` within
   ≤ 250 ms of customer answer (FCC 2 s safe-harbor leaves 1 750 ms for E05).

3. **Lead-claim concurrency uses three layers.** Layer 1 = atomic Lua ZPOPMIN
   (`claim_lead_from_hopper.v1.lua`). Layer 2 = lock STRING fence token (30 s
   TTL; protects against E04 crash between claim and T04 call). Layer 3 =
   `in_flight` HASH for operator visibility and E06 janitor sweep. No `LOCK
   TABLES`, no leader election — Lua atomicity is sufficient.

4. **`dispatch_tokens` STRING DECR is the E02↔E04 contract.** E02 writes
   `SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2` each tick; E04
   atomically DECRs per dispatch, refuses when result ≤ 0, and INCR-backs on
   over-decrement. TTL = 2 s ensures no dispatches when E02 is down (correct
   safety posture).

5. **Agent-pick strategy default = `longest_wait`.** F04's `pick_agent_for_call.
   v1.lua` implements this via ZRANGE 0 0 on the READY ZSET scored by join_ts.
   Other strategies (random, fewest_calls, rank) are Phase 3 enhancements;
   tracked in HANDOFF.

6. **Pre-T04 checks are minimal.** E04 runs only two cheap checks: campaign
   still active (process-cache ~50 ns) and lead still dial-eligible (Valkey
   HGET ~50 µs). TCPA, DNC, gateway-cap, drop-cap, and consent all run inside
   T04's 5-gate pipeline. No duplication of T04 logic.

7. **Retry policy maps `DialOutcome` → D04 status + requeue hint.** E04 holds
   the 16-row outcome table (§6) and passes the right enum to
   `E01.Consumer.Release`. E04 never computes `recycle_delay_seconds` itself;
   E01 owns that merge logic.

8. **Callbacks need no special E04 code path.** D06 calls `E01.ScheduleImmediate`
   → high-priority ZADD into hopper; E04's ZPOPMIN naturally pops callbacks
   first. E04 only emits `vici2_picker_callback_dispatched_total` on claims
   that have `claim.IsCallback == true`.

9. **Two goroutines per campaign per pod; no leader-election.** Dispatch loop
   (100 ms ticker) and answer handler (XREADGROUP BLOCK 5000 on `events:vici2.
   call.answered`) are fully independent. Multi-pod safety: Lua atomicity
   prevents double-claim; consumer group prevents double-answer-pick.

10. **MODULE_SPEC_UPDATE required.** The original `spec/modules/E04.md` scopes
    E04 to "pick a READY agent on CHANNEL_ANSWER only." This PLAN expands E04
    to own lead-claim concurrency, originate dispatch to T04, retry logic,
    callback integration, and both pairing models. File the MODULE_SPEC_UPDATE
    patch before or during IMPLEMENT.

---

## 1. Goals + Non-Goals

### 1.1 Goals

- **Lead-claim**: atomically pop the highest-priority lead from the per-campaign
  hopper ZSET via `claim_lead_from_hopper.v1.lua`, setting a 30 s lock and
  writing the `in_flight` HASH entry.
- **Dispatch**: for each claimed lead, DECR the `dispatch_tokens` budget, run
  two pre-T04 checks, build an `OriginateRequest`, and call T04.Originate.
- **Pre-pair (PROGRESSIVE/MANUAL/PREVIEW)**: reserve an agent via
  `pick_agent_for_call.v1.lua` *before* calling T04; the Mode routes the
  customer to `conference:agent_t<tid>_u<uid>@default` on answer.
- **Dial-then-pair (PREDICTIVE)**: call T04 with AgentID=0; subscribe to
  `events:vici2.call.answered` consumer group; on answer, pick an agent via
  Lua and issue T01.UUIDTransfer within ≤ 250 ms.
- **Outcome handling**: map every T04 typed error + T01 hangup_cause to a
  `DialOutcome` enum; call `E01.Consumer.Release(claim, outcome)` with the
  right enum; INCR `t:{tid}:freq:{phone}:{cid}` on `OutcomeBridged`.
- **AMD handling**: subscribe to `events:vici2.call.amd_detected`; dispatch
  per-list `amd_action` (drop / transfer / message / park).
- **Callback attribution**: detect `claim.IsCallback` and emit the callback
  metric.
- **Observability**: emit all metrics in §11, structured per-dispatch log
  lines, and OpenTelemetry spans per dispatch.
- **Janitor entrypoint**: expose `picker.SweepOrphans(ctx)` for E06 to call
  every 60 s; sweeps `in_flight` HASH entries older than 5 min.

### 1.2 Non-Goals (explicit hand-offs)

| Concern | Owner |
|---|---|
| "How many lines should be in flight?" | **E02** — writes `dispatch_tokens` |
| ESL transport, reconnect, circuit breaker, BACKGROUND_JOB correlation | **T01** |
| 5 compliance gates (TCPA, DNC, consent, drop-cap, gateway-cap) | **T04** |
| TCPA window math, DST, state holidays | **C01** |
| DNC Bloom filter, bypass token | **D05** |
| Hopper fill from MySQL | **E01** (filler) |
| Dial-level calculation | **E03** |
| Safe-harbor playback on dropped call | **E05** |
| Agent state ZSET maintenance | **A01** |
| `originate_audit` row lifecycle | **T04** |
| `calls.status` + `leads.status` writes | **E01.Release** (downstream of E04's Release call) |
| Callback scheduling / agent-only callback UI notification | **D06** |
| Multi-FS host affinity | **X03** (Phase 3.5) |
| Per-campaign list-mix weighting | **E01** (list-blind ZPOPMIN in E04) |

### 1.3 What changed vs. RESEARCH open questions

All 12 open questions from RESEARCH §13 are resolved here:

| Q | Decision |
|---|---|
| Q1 — tokens shape | **STRING DECR** with `SET ... EX 2` (see §3) |
| Q2 — pre-T04 lead status check | **Yes** — one Valkey HGET (~50 µs); avoids wasted T04 audit INSERT for a lead that became DNC since hopper-fill |
| Q3 — agent-before-lead for PROGRESSIVE | **Yes** — reserve agent first; if no READY agent, skip; if no lead in hopper, release agent and refill-wake E01 |
| Q4 — pick strategy default | **`longest_wait`** only in Phase 2; others in Phase 3 HANDOFF |
| Q5 — answer handler in-proc or gRPC | **In-process** — same binary, separate goroutine per campaign; avoids ~1 ms gRPC overhead inside 2 s FCC window |
| Q6 — E04 exposes gRPC service? | **No** — E04 is purely internal; cross-process callers (A04) call T04 directly |
| Q7 — RESERVED→INCALL transition | **Yes** — F04's `agent_state_transition.v1.lua` RESERVED→INCALL fires when T01 CHANNEL_ANSWER confirms bridge; supervisors see intermediate state |
| Q8 — token leakage on dispatch-deadline timeout | **Accept** with `vici2_picker_token_leaked_total` metric; recovery code is race-prone |
| Q9 — agent-only callback auto-dial | **Never** — D06 surfaces UI notification; agent clicks "Dial now" → A04 MANUAL flow → E04 dispatches with specific AgentID |
| Q10 — AMD action per-list vs per-campaign | **Per-list** — F02 already pins `lists.amd_action`; Phase 3 can add per-campaign fallback |
| Q11 — drop event to E05 via XADD or PUBSUB | **XADD to `events:vici2.call.dropped`** — durable, ordered, consumer-group; drops are FCC-counted, cannot lose |
| Q12 — E04 multi-list "weighted pop" | **List-blind** — E04 pops by score; list_id is metadata only; weighted pop is an E01 filler concern |

---

## 2. The E02↔E04 Boundary (FROZEN)

### 2.1 Architecture diagram

```
   ┌─────────────────────────────────────────────────────────────────┐
   │ MySQL: leads, callbacks, call_log, originate_audit              │
   └─────────────────────────────┬───────────────────────────────────┘
                                  │ SELECT (E01 filler)
                                  ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ E01 Filler (cron 30 s + pubsub trigger)                         │
   │  - SQL → gates (status, called_count, freq-cap, DNC, TZ) →     │
   │  - ZADD into t:{tid}:campaign:{cid}:hopper                      │
   └─────────────────────────────┬───────────────────────────────────┘
                                  │ ZADD
                                  ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ Valkey ZSET  t:{tid}:campaign:{cid}:hopper                       │
   └─────────────────────────────┬───────────────────────────────────┘
                                  │ EVALSHA claim_lead_from_hopper.v1.lua
                                  │ (driven by E04 — NEVER by E02)
                                  ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ E04 Picker — dispatch loop (this module)                         │
   │  1. DECR t:{tid}:campaign:{cid}:dispatch_tokens                  │
   │  2. Claim lead via Lua → LeadClaim                               │
   │  3. PROGRESSIVE: reserve agent via pick_agent_for_call.v1.lua   │
   │  4. Build OriginateRequest{Mode, AgentID, LeadID, ...}           │
   │  5. T04.Originate(ctx, req) — FROZEN T04 PLAN §3 pipeline       │
   │  6. Map outcome → E01.Consumer.Release(claim, outcome)           │
   │  7. INCR freq-cap on OutcomeBridged                              │
   └─────────────────────────────┬───────────────────────────────────┘
                                  │ T04 returns (or errors)
                                  ▼
                              T04 → T01 (ESL) → FreeSWITCH

   ┌─────────────────────────────────────────────────────────────────┐
   │ events:vici2.call.answered STREAM (T01 writes on CHANNEL_ANSWER) │
   └─────────────────────────────┬───────────────────────────────────┘
                                  │ XREADGROUP picker-<pod>
                                  ▼
   ┌─────────────────────────────────────────────────────────────────┐
   │ E04 Picker — answer handler (separate goroutine per campaign)    │
   │  - Filter: PREDICTIVE mode only                                  │
   │  - EVALSHA pick_agent_for_call.v1.lua → agent_id or nil          │
   │  - nil → XADD events:vici2.call.dropped (E05 safe-harbor)       │
   │  - agent found → T01.UUIDTransfer(callUUID,                      │
   │      "conference:agent_t<tid>_u<agent_id>@default+flags{join-   │
   │       only}", "inline", "default")                               │
   └─────────────────────────────────────────────────────────────────┘

   E02 Pacing (parallel; NEVER touches hopper)
   ┌─────────────────────────────────────────────────────────────────┐
   │  - 1 Hz tick: decide_desired_new_originates(snapshot)            │
   │  - SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2           │
   │  - That is all. E02 never claims leads, never calls T04.         │
   └─────────────────────────────────────────────────────────────────┘
```

### 2.2 Responsibility table

| Concern | Owner | Mechanism |
|---|---|---|
| "How many new originates this tick?" | **E02** | Reads agent ZCARD + active SCARD + dial_level + clamps; writes `dispatch_tokens` STRING |
| "Which lead to dial next?" | **E04** | ZPOPMIN via `claim_lead_from_hopper.v1.lua` |
| "Which agent for PROGRESSIVE call?" | **E04** | `pick_agent_for_call.v1.lua` BEFORE T04.Originate |
| "Which agent for PREDICTIVE answered call?" | **E04** | `pick_agent_for_call.v1.lua` AFTER `events:vici2.call.answered` |
| "Issue `bgapi originate`" | **T01** | Via T04 policy wrapper |
| "Run 5 compliance gates" | **T04** | T04 PLAN §3 — E04 does not re-run |
| "Release hopper lock + write lead status" | **E04** → **E01** | E04 calls `E01.Consumer.Release(claim, outcome)` |
| "Increment freq-cap on bridged" | **E04** | `INCR t:{tid}:freq:{phone}:{cid}` after T04 returns OutcomeBridged |
| "Fire due callbacks into hopper" | **D06** | D06 calls `E01.ScheduleImmediate`; E04 picks naturally |
| "Play safe-harbor on no-agent abandon" | **E05** | E05 subscribes to `events:vici2.call.dropped`; E04 XADDs |
| "Adjust dial_level on drop%" | **E03** | Independent; E04 unaffected |

### 2.3 Why this boundary is cleaner

1. **E02 is a pure decision function** — testable, swappable (Vicidial math vs Erlang A), zero side effects.
2. **Both pairing models live together in E04** — pre-pair (PROGRESSIVE) and dial-then-pair (PREDICTIVE) share `pick_agent_for_call.v1.lua`, `DialOutcome`, and metric names.
3. **Multi-pod CPS control via shared Valkey counter** — no in-process token bucket arbitration; three pods aggregate naturally via DECRs.

---

## 3. `dispatch_tokens` Contract (FROZEN)

### 3.1 Wire form

E02 writes (once per tick, 1 Hz):

```
SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2
```

- `<n>` = desired new originates for this tick (result of E02's pacing formula after clamps; minimum 0, maximum `campaigns.max_calls_per_second`).
- `EX 2` = 2-second TTL. If E02 dies, the key expires within 2 s and E04 sees nil on DECR → no dispatches (correct safety posture).

E04 consumes (once per dispatch attempt):

```go
// tokens.go
func (t *TokenBucket) Acquire(ctx context.Context, key string) (ok bool, err error) {
    val, err := t.valkey.Decr(ctx, key)
    if err != nil {
        // Key missing (expired/E02 down): ErrNoTokens
        return false, ErrNoTokens
    }
    if val < 0 {
        // Over-decremented (race with another pod or TTL flip)
        _, _ = t.valkey.Incr(ctx, key) // restore; best-effort
        t.metrics.TokensOverDecremented.Inc()
        return false, nil
    }
    t.metrics.TokensConsumed.Inc()
    return true, nil
}
```

`DECR` is atomic in Valkey; two pods DECRing simultaneously each see their own unique result. Aggregate decrements across all pods equal aggregate dispatches.

### 3.2 Trade-offs accepted

- **+50 µs per dispatch** (one extra Valkey op) vs E02's original design of an in-process token bucket. Accepted: 50 µs is invisible against the ~50 ms T04 pipeline.
- **Token leakage** on dispatch-deadline timeout (§9.7) accepted; `vici2_picker_token_leaked_total` counter monitors it.
- **Optional pubsub wake** `t:{tid}:broadcast:campaign:{cid}:tokens_replenished` from E02 can interrupt the 100 ms poll for immediate dispatch on token replenishment. Phase 2 ships the pubsub subscription; fall-back is the 100 ms ticker.

### 3.3 F02 amendment for `campaigns.lead_lock_ttl_seconds`

The campaign-level lock TTL override (`lead_lock_ttl_seconds INT NOT NULL DEFAULT 30`) is not in F02's current schema. E04 IMPLEMENT MUST file an F02 amendment for this column before shipping. Validator in M02: value ≥ `dial_timeout_sec + 5`. Default 30 s covers: T04 5-gate pipeline (~10 ms) + T01 ESL roundtrip (~50 ms) + ring timeout (up to 22 s) + 7 s safety margin.

Also file F02 amendment for `campaigns.call_strategy` (Vicidial `next_agent_call`: `longest_wait` | `random` | `fewest_calls` | `rank`; default `longest_wait`). Phase 2 ships only `longest_wait`; column exists for Phase 3.

---

## 4. The Two Pairing Models

### 4.1 Pre-pair (PROGRESSIVE / MANUAL / PREVIEW)

Agent is reserved *before* the customer phone rings. Zero abandonment risk.

**Dispatch tick pseudocode:**

```go
func (l *DispatchLoop) tickProgressive(ctx context.Context, cfg CampaignConfig) error {
    // 1. Acquire token
    ok, err := l.tokens.Acquire(ctx, l.tokenKey)
    if !ok || err != nil {
        return nil // no budget; wait
    }
    defer func() {
        if !dispatched { l.tokens.Release(ctx, l.tokenKey) }
    }()

    // 2. Reserve agent first (agent-before-lead — cheaper to undo if no lead)
    agentID, agentLockVal, err := l.valkey.Agents().PickForCall(
        ctx, cfg.CampaignID, uuid.New().String(), nowMs)
    if err != nil || agentID == 0 {
        l.metrics.NoReadyAgent.Inc()
        return nil // no READY agent; token returned by defer
    }

    // 3. Claim lead
    leadID, lockVal, err := l.valkey.Hopper().Claim(
        ctx, cfg.CampaignID, l.instanceID, cfg.LeadLockTTL, nowMs)
    if err != nil || leadID == 0 {
        l.valkey.Agents().ReleaseReservation(ctx, cfg.CampaignID, agentID, agentLockVal)
        l.wakeRefill(ctx, cfg.CampaignID)
        return nil
    }

    // 4. Pre-T04 checks
    if !l.campaignCache.IsActive(cfg.CampaignID) {
        l.release(ctx, cfg.CampaignID, leadID, lockVal, OutcomeCampaignPaused, false)
        l.valkey.Agents().ReleaseReservation(ctx, cfg.CampaignID, agentID, agentLockVal)
        return nil
    }
    if !l.isLeadDialEligible(ctx, leadID) {
        l.release(ctx, cfg.CampaignID, leadID, lockVal, OutcomeLeadIneligible, false)
        l.valkey.Agents().ReleaseReservation(ctx, cfg.CampaignID, agentID, agentLockVal)
        return nil
    }

    // 5. Build request
    req := OriginateRequest{
        AttemptUUID: uuid.New().String(), // one-UUID rule (T04 PLAN §4)
        Mode:        ModeProgressive,
        AgentID:     agentID,
        LeadID:      leadID,
        CampaignID:  cfg.CampaignID,
        ListID:      lead.ListID,
        DestNumber:  lead.PhoneE164,
    }

    // 6. Originate (sync; ~50 ms on ALLOW path)
    dispatched = true
    result, err := l.t04.Originate(ctx, req)
    l.processOutcome(ctx, cfg, leadID, lockVal, agentID, agentLockVal, result, err)
    return nil
}
```

**Wire form via T04→T01:**
`execute_on_answer=transfer:agent_t<tid>_u<agentID>@default XML default`

On customer answer, FreeSWITCH atomically transfers the customer leg into the agent's conference. Bridging latency ≤ 5 ms post-answer.

### 4.2 Dial-then-pair (PREDICTIVE)

No agent is reserved at originate time. Agent is picked after CHANNEL_ANSWER within ≤ 250 ms. FCC 3% rolling-30-day abandonment ceiling applies.

**Dispatch tick:**

```go
func (l *DispatchLoop) tickPredictive(ctx context.Context, cfg CampaignConfig) error {
    ok, _ := l.tokens.Acquire(ctx, l.tokenKey)
    if !ok { return nil }
    defer func() {
        if !dispatched { l.tokens.Release(ctx, l.tokenKey) }
    }()

    leadID, lockVal, err := l.valkey.Hopper().Claim(
        ctx, cfg.CampaignID, l.instanceID, cfg.LeadLockTTL, nowMs)
    if err != nil || leadID == 0 {
        l.wakeRefill(ctx, cfg.CampaignID)
        return nil
    }

    if !l.campaignCache.IsActive(cfg.CampaignID) {
        l.release(ctx, cfg.CampaignID, leadID, lockVal, OutcomeCampaignPaused, false)
        return nil
    }
    if !l.isLeadDialEligible(ctx, leadID) {
        l.release(ctx, cfg.CampaignID, leadID, lockVal, OutcomeLeadIneligible, false)
        return nil
    }

    req := OriginateRequest{
        AttemptUUID: uuid.New().String(),
        Mode:        ModePredictive,
        AgentID:     0,   // park; agent picked post-answer
        LeadID:      leadID,
        CampaignID:  cfg.CampaignID,
        ListID:      lead.ListID,
        DestNumber:  lead.PhoneE164,
    }

    dispatched = true
    result, err := l.t04.Originate(ctx, req)
    // T04 returns BACKGROUND_JOB ack immediately for PREDICTIVE (non-blocking)
    if err != nil {
        l.processOutcome(ctx, cfg, leadID, lockVal, 0, "", result, err)
    }
    // BRIDGED outcome arrives via events:vici2.call.answered → answer handler
    return nil
}
```

**Wire form:** `execute_on_answer=park` — FS parks customer (silence/MOH) and emits CHANNEL_ANSWER event.

**Answer handler goroutine:**

```go
func (h *AnswerHandler) Run(ctx context.Context, campaignID int64) {
    for {
        entries, err := h.valkey.State.XReadGroup(ctx, &redis.XReadGroupArgs{
            Group:    "picker-" + h.podID,
            Consumer: fmt.Sprintf("c-%d", campaignID),
            Streams:  []string{"events:vici2.call.answered", ">"},
            Count:    10,
            Block:    5 * time.Second,
        })
        for _, entry := range entries {
            if entry.CampaignID != campaignID { continue }
            if entry.Mode != ModePredictive { continue }
            h.handleAnswer(ctx, entry)
        }
    }
}

func (h *AnswerHandler) handleAnswer(ctx context.Context, ev AnsweredEvent) {
    start := time.Now()
    agentID, _, err := h.valkey.Agents().PickForCall(ctx, ev.CampaignID, ev.CallUUID, nowMs)
    if err != nil || agentID == 0 {
        // No agent available — emit drop event; E05 plays safe-harbor
        h.valkey.State.XAdd(ctx, &redis.XAddArgs{
            Stream: "events:vici2.call.dropped",
            Values: map[string]interface{}{
                "call_uuid":    ev.CallUUID,
                "campaign_id":  ev.CampaignID,
                "tenant_id":    ev.TenantID,
                "reason":       "no_agent",
                "ts_ms":        nowMs,
            },
        })
        h.metrics.PredictiveDrop.WithLabelValues(ev.CampaignID, "no_agent").Inc()
        return
    }

    confFQN := conference.ConferenceFQN(ev.TenantID, agentID, "default") + "+flags{join-only}"
    if err := h.t01.UUIDTransfer(ctx, ev.CallUUID, "conference:"+confFQN, "inline", "default"); err != nil {
        h.valkey.Agents().ReleaseReservation(ctx, ev.CampaignID, agentID, "")
        h.emitDrop(ctx, ev, "agent_transfer_failed")
        return
    }
    h.metrics.AnswerHandlerLatency.Observe(time.Since(start).Seconds())
    // ConferenceFQN usage mandatory per T03 RFC-002 lint — no inline "agent_" assembly
}
```

Answer handler p99 latency budget:
- XREADGROUP delivery: ~50 ms
- `pick_agent_for_call.v1.lua`: ~200 µs
- `T01.UUIDTransfer` ESL roundtrip: ~100 ms
- **Total p99 budget: ≤ 250 ms** (well within FCC 2 s; 1 750 ms remains for E05 safe-harbor)

### 4.3 Pairing model selection

| Campaign profile | Recommended mode | Rationale |
|---|---|---|
| < 10 agents, sales | PROGRESSIVE | Zero abandonment; full pre-answer agent prep |
| 10–50 agents, sales | PREDICTIVE w/ ADAPT_TAPERED | Higher utilisation; E03 adaptive keeps drops < 1% |
| 50+ agents, surveys | PREDICTIVE w/ ADAPT_AVERAGE | Max throughput; survey AHT favours overdial |
| Compliance-sensitive (collections, regulated) | PROGRESSIVE | Zero abandon exposure |
| Callbacks (anyone) | PROGRESSIVE forced even if campaign is PREDICTIVE | Intentional pairing; cannot abandon a callback |
| Manual click-to-dial | MANUAL | Agent-initiated; same pre-pair wire as PROGRESSIVE |

### 4.4 Race conditions

| # | Race | Frequency | Mitigation |
|---|------|-----------|------------|
| R1 | Two pods pop same lead | Never | Atomic Lua ZPOPMIN |
| R2 | Two pods reserve same agent | Never | Atomic Lua ZREM in `pick_agent_for_call.v1.lua` |
| R3 | Agent logs out between PROGRESSIVE reservation and customer answer | ~0.1% | FS bridges into empty conf; E05 safe-harbor via `+flags{join-only}` |
| R4 | All agents WRAPUP when PREDICTIVE customer answers | < 1% (well-paced) | Answer handler emits drop event; E05 plays safe-harbor |
| R5 | T04 ALLOW but BACKGROUND_JOB never resolves | Rare | E06 janitor sweeps `originate_audit WHERE outcome='OTHER' AND originated_at < NOW()-5min` |
| R6 | E04 crashes between claim and T04.Originate | Rare | Lead-lock TTL 30 s; E06 reads `in_flight` HASH; calls JanitorRelease |
| R7 | Answer handler crashes between PickAgent and UUIDTransfer | Rare | Agent stuck RESERVED → F04 janitor reverts after 30 s; FS park-timeout 30 s → hangup |
| R8 | Two answer handler pods read same event | Never | Consumer group + XACK; one consumer per event |
| R9 | Config flips PROGRESSIVE→PREDICTIVE mid-tick | < 0.1% | Dispatches PROGRESSIVE for ≤ 1 tick; harmless; hot-reload fires within 100 ms |
| R10 | T04 ErrGatewayLimit fires after agent already reserved | Rare | E04 catches error, releases agent + claim, INCR token back |

---

## 5. Lead-Claim Atomicity (Three Layers)

### 5.1 Layer 1 — `claim_lead_from_hopper.v1.lua` (F04 HANDOFF §2)

Script KEYS:
- `KEYS[1]` = `t:{tid}:campaign:{cid}:hopper` (ZSET)
- `KEYS[2]` = `t:{tid}:lead_lock:{cid}:` (lock prefix; script appends lead_id)
- `KEYS[3]` = `t:{tid}:campaign:{cid}:in_flight` (HASH)

ARGV: `[lock_ttl_sec, instance_id, now_ms]`

Three atomic effects per EVALSHA:
1. **ZPOPMIN** — pop the lowest-score member (highest priority → next due).
2. **SET NX EX** — create the lock string with fence token value `instance_id:now_ms`. If NX fails (collision, shouldn't happen), ZADD the lead back and return nil.
3. **HSET** in_flight tracking for E06 visibility.

Total Valkey round-trip: ~150 µs local, ~250 µs remote. Atomic across all pods.

### 5.2 Layer 2 — fence token in `release_hopper_lock.v1.lua` (F04 HANDOFF §2)

On `E01.Consumer.Release(claim, outcome)`, the script:
1. Gets the current lock value.
2. If value ≠ the fence token we hold: **no-op** (another E04 instance reclaimed the lead after our TTL expired; do not interfere).
3. If value matches: DEL the lock, HDEL the in_flight entry, optionally ZADD back to hopper with score offset from recycle_delay.

This protects against the expiry+reclaim scenario described in RESEARCH §5.2.

### 5.3 Layer 3 — `in_flight` HASH for janitor and observability

`t:{tid}:campaign:{cid}:in_flight` HASH `lead_id → instance_id:claim_ts_ms`

E06 calls `picker.SweepOrphans(ctx)` every 60 s:

```go
func (p *Picker) SweepOrphans(ctx context.Context) {
    for _, cid := range p.activeCampaigns() {
        key := fmt.Sprintf("t:%d:campaign:%d:in_flight", p.tenantID, cid)
        entries, _ := p.valkey.HGetAll(ctx, key)
        for leadID, val := range entries {
            claimTs := parseClaimTs(val)
            if time.Since(claimTs) > 5*time.Minute {
                p.e01.JanitorRelease(ctx, cid, leadID)
                p.metrics.OrphanedClaim.Inc()
            }
        }
    }
}
```

### 5.4 Lock TTL sizing

| Context | TTL | Rationale |
|---|---|---|
| Dispatch claim (E04 → T04 ALLOW) | `campaigns.lead_lock_ttl_seconds` (default 30 s) | Covers T04 pipeline (~10 ms) + T01 ESL (~50 ms) + ring timeout (22 s default) + 7 s safety margin |
| PREDICTIVE agent RESERVED state | 15 s (in `pick_agent_for_call.v1.lua`) | UUIDTransfer completes in ~100 ms; 15 s is generous safety |

### 5.5 Claim collision metric

`vici2_picker_claim_total{result="lead_lock_collision"}` increments only when Lua's `SET NX` fails after ZPOPMIN (the ZADD-back path). In steady state this should be **zero**. Non-zero sustained rate = PAGE (clock skew or janitor bug).

---

## 6. Retry Policy (DialOutcome → D04 Status + Requeue Hint)

### 6.1 DialOutcome enum

```go
// dialer/internal/picker/retry_policy.go
type DialOutcome int

const (
    OutcomeBridged            DialOutcome = iota // T01 BACKGROUND_JOB + CHANNEL_BRIDGE
    OutcomeNoAnswer                              // NO_ANSWER / NO_USER_RESPONSE
    OutcomeBusy                                  // USER_BUSY / CALL_REJECTED
    OutcomeAMD                                   // post-bridge AMD detector
    OutcomeInvalidNumber                         // UNALLOCATED_NUMBER / INVALID_NUMBER_FORMAT
    OutcomeCarrierFail                           // NETWORK_OUT_OF_ORDER / NORMAL_TEMPORARY_FAILURE
    OutcomeGatewayLimit                          // T04.ErrGatewayLimit
    OutcomeTCPABlocked                           // T04.ErrTCPABlocked
    OutcomeDNCBlocked                            // T04.ErrDNCHit
    OutcomeConsentBlocked                        // T04.ErrConsentBlocked
    OutcomeCircuitOpen                           // T04.ErrCarrierFail (sub: circuit breaker)
    OutcomeRateLimited                           // T04.ErrRateLimited (drop-cap gate)
    OutcomeMediaTimeout                          // MEDIA_TIMEOUT hangup
    OutcomeTimeout                               // originate_timeout fired
    OutcomeDropAbandon                           // PREDICTIVE: answered but no agent
    OutcomeAgentDisconnect                       // PREDICTIVE: agent leg dropped pre-bridge
    OutcomeCampaignPaused                        // pre-T04 check: campaign paused
    OutcomeLeadIneligible                        // pre-T04 check: lead became DNC/dropped
)
```

### 6.2 Outcome → D04 status → requeue policy

| DialOutcome | D04 status code | Requeue? | Recycle source | Notes |
|---|---|---|---|---|
| `Bridged` | `A` (machine) or agent dispo terminal | No (terminal) | Agent dispo overrides | E01.Release receives final agent dispo from A06 later |
| `NoAnswer` | `NA` | Yes, delayed | 300 s default (D04 RESEARCH §3.4) | Configurable per status |
| `Busy` | `B-CAR` | Yes, delayed | 180 s default | Carrier busy |
| `AMD` | `A` | Conditional | -1 if `drop`; recycle if `transfer` | Per-list `lists.amd_action` |
| `InvalidNumber` | `INVALID` | No (terminal) | -1 | Dead number; never re-dials |
| `CarrierFail` | `CARRIER_FAIL` | Yes, immediate | 0 | Not a lead problem; gateway problem |
| `GatewayLimit` | `GATEWAY_LIMIT_TRY_LATER` | Yes, immediate | 0 | T02 routing may try sibling |
| `TCPABlocked` | `TCPA` | Yes, delayed | `tcpa.NextOpen()` (~9 AM local next day) | C01 owns nextOpen calculation |
| `DNCBlocked` | `DNC` | No (terminal) | -1 | Permanently flagged |
| `ConsentBlocked` | `CONSENT_NOT_OBTAINED` | No (terminal) | -1 | Reserved for state recording bans |
| `CircuitOpen` | (no status change) | Yes, after 30 s | 30 s freeze | T01 circuit breaker for FS pod |
| `RateLimited` | (no status change) | Yes, delayed | 300 s campaign-wide | Drop-cap gate fired |
| `MediaTimeout` | `MEDIA_TO` | Yes, delayed | 300 s | RTP path broken |
| `Timeout` | `TIMEOT` | Yes, delayed | 900 s | originate_timeout (22 s default) fired |
| `DropAbandon` | `DROP` | Yes, delayed | 300 s | FCC 3% window; E05 records |
| `AgentDisconnect` | `ADC` | Yes, immediate | 0 | Agent browser closed mid-bridge |
| `CampaignPaused` | (no change) | Yes, immediate | 0 | Re-enters hopper when campaign resumes |
| `LeadIneligible` | (no change) | No | -1 | Lead became DNC/dropped between fill and pop |

### 6.3 Outcome processing

E04 never computes `recycle_delay_seconds` — it passes the `DialOutcome` enum to `E01.Consumer.Release`. E01's release implementation (E01 PLAN §7) reads the `statuses` row + `campaign_status_overrides` + applies merge precedence (D04 RESEARCH §6) to compute the actual delay. The score offset for hopper re-ZADD is computed by E01. Single source of truth; E04 remains stateless w.r.t. D04 schema.

### 6.4 AMD post-BRIDGED handling

AMD events arrive on `events:vici2.call.amd_detected`. E04's AMD handler:

```go
func (a *AMDHandler) handle(ctx context.Context, ev AMDEvent) {
    list := a.listCache.Get(ev.ListID)
    switch list.AmdAction {
    case "drop":
        a.t01.UUIDKill(ctx, ev.CallUUID, "NORMAL_CLEARING")
        a.release(ctx, ev, OutcomeAMD)
    case "transfer":
        a.t01.UUIDTransfer(ctx, ev.CallUUID,
            "ingroup:"+list.AmdTransferGroup, "inline", "default")
    case "message":
        a.t01.UUIDBroadcast(ctx, ev.CallUUID,
            "play_and_hangup,/var/lib/vici2/audio/amd_msg.wav")
    case "park":
        // Phase 3 voicemail-drop — no-op in Phase 2
    }
    a.metrics.AMDAction.WithLabelValues(ev.CampaignID, ev.ListID, list.AmdAction).Inc()
}
```

AMD action is **per-list** (not per-campaign) per F02 schema. Process-cache on `lists` table (invalidated via pubsub on M02 save).

---

## 7. Callback Firing (D06 Integration)

### 7.1 Flow overview

D06 worker (every 60 s):
1. `SELECT id, lead_id, campaign_id, agent_only FROM callbacks WHERE status='PENDING' AND callback_at <= NOW()`
2. **Agent-only callbacks**: emit `events:vici2.callback.due.agent`; A08 UI notification; agent clicks "Dial now" → A04 MANUAL flow → **E04 dispatches with `OriginateRequest.AgentID = callback.AgentUserID`**. E04 has no special path for this; it is an ordinary MANUAL dispatch from A04's perspective.
3. **Anyone callbacks**: D06 calls `E01.ScheduleImmediate(ctx, campaignID, leadID, priority=HIGH)`. E01 runs all gates (TCPA still applies for callbacks!) and ZADDs with priority=HIGH score prefix (`0 * 1e10 + entry_ts`).

### 7.2 E04 picks callbacks naturally

Hopper score formula (F04 PLAN §4.1):

```
score = (MAX_PRIO - priority) * 1e10 + entry_ts_ms
```

`priority=HIGH` → score prefix `0`. Normal leads → score prefix `9e10+`. ZPOPMIN always delivers callbacks before normal leads. **Zero callback-specific code in E04's dispatch loop.**

### 7.3 Callback metric attribution

E01.Claim returns a `LeadClaim` struct. When D06 called `ScheduleImmediate`, E01 tags the hopper entry with metadata. E04 reads `claim.IsCallback bool`:

```go
if claim.IsCallback {
    l.metrics.CallbackDispatched.WithLabelValues(cfg.CampaignID).Inc()
}
```

Two lines of E04 code; everything else is generic.

### 7.4 Callback failure modes

| Scenario | Behaviour |
|---|---|
| TCPA blocks callback at ScheduleImmediate | D06 receives SKIP_UNTIL error; responsibility to update `callbacks.callback_at` to TCPA `nextOpen` (D06 RESEARCH §4) |
| Mass callback at 9 AM (1000 entries) | Hopper ZSET grows by 1000; E04 drains at campaign CPS (~3 min at 5 CPS); expected |
| Anyone-callback lead's assigned agent not READY | PROGRESSIVE picks longest-wait READY agent; screen pop shows callback metadata regardless of which agent gets it |
| Agent-only callback, target agent logged out | A08 delivers notification to supervisor; E04 unaffected |

---

## 8. Tick Model + Concurrency

### 8.1 Per-campaign goroutine pair

```
E04 process on dialer pod
  │
  ├─ Supervisor goroutine (singleton)
  │    - Subscribes to t:{tid}:broadcast:campaign:*:config_changed
  │    - Spawns/kills per-campaign goroutine pairs on campaign activate/deactivate
  │
  ├─ [Campaign 42] Dispatch loop goroutine
  │    - 100 ms ticker (10 Hz sub-tick)
  │    - On tick: DECR tokens → if > 0: claim + (pre-pair) + T04.Originate + outcome
  │    - On pubsub config_changed: reload CampaignConfig snapshot
  │    - On pubsub tokens_replenished: interrupt sleep → immediate tick attempt
  │
  ├─ [Campaign 42] Answer handler goroutine (PREDICTIVE only; no-op for other modes)
  │    - XREADGROUP GROUP picker-<podID> COUNT 10 BLOCK 5000
  │    - On event: pick_agent_for_call.v1.lua → UUIDTransfer or emit drop
  │
  ├─ [Campaign 42] AMD handler goroutine
  │    - XREADGROUP on events:vici2.call.amd_detected
  │    - On event: dispatch per-list amd_action
  │
  ├─ [Campaign 43] ... (same pattern)
  └─ ...
```

### 8.2 Dispatch loop tick rate

E02 paces at 1 Hz (one token SET per second). E04 polls at 10 Hz (100 ms ticker) to spread token consumption smoothly across each second. At 50 campaigns × 3 pods × 10 polls/s = 1 500 Valkey DECR/s — trivial (Valkey handles 100 k+/s single-node).

If T04 is slow for campaign 42 (e.g., 5 s latency), the goroutine simply dispatches one per tick — backpressure flows naturally through the DECR protocol without blocking other campaigns.

### 8.3 XREADGROUP cadence

```
XREADGROUP GROUP picker-<podID> <consumer-id> COUNT 10 BLOCK 5000
  STREAMS events:vici2.call.answered >
```

`BLOCK 5000` = wait up to 5 s for a new entry. Idle cost ≈ zero. Under load, returns immediately. Per-pod consumer ID ensures exactly-one delivery per event. `XAUTOCLAIM` (F04 PLAN §5.3) reclaims stuck PEL entries after 60 s on sibling pod failure.

### 8.4 Dispatch deadline

A single dispatch attempt (T04.Originate) has a 200 ms wall-clock soft cap. If T04 hasn't returned in 200 ms, the goroutine logs a `pick_deadline_exceeded` event, moves on to the next tick, and increments `vici2_picker_token_leaked_total`. The T04 call is not cancelled (audit row already INSERTed). The leaked token is bounded and monitored rather than recovered (Q8 decision).

### 8.5 Hot-config reload

Subscribe to `t:{tid}:broadcast:campaign:{cid}:config_changed`. Reload `CampaignConfig` from `t:{tid}:campaign:{cid}:config_snapshot` (JSON STRING set by M02 on campaign save). Worst-case staleness: 100 ms (one tick).

Mode-change handling:
- MANUAL → PROGRESSIVE: dispatch loop activates (was no-op for MANUAL).
- PROGRESSIVE → PREDICTIVE: skip agent-reservation in next tick; answer handler goroutine already running.
- Any → MANUAL: tokens drop to 0 via E02; dispatch loop dormant.

### 8.6 Event-driven sub-tick triggers

Three pubsub events can wake the dispatch loop before the 100 ms ticker fires:
1. `tokens_replenished` — E02 just wrote new tokens (optional, Phase 2).
2. `agent_state_changed{to=READY}` — new agent available; PROGRESSIVE can pair immediately.
3. `hopper_refilled` — E01 filler just ZADDed new leads (optional; reduces idle latency).

All three are opportunistic; 100 ms ticker is the steady-state backstop.

---

## 9. Multi-Pod Concurrency Model

### 9.1 No leader-election required

Unlike E02 (which uses `SET NX EX 1` tick-lock to ensure exactly-one-tick-per-second), E04 requires **no leader election**. The Lua claim atomicity ensures that across N pods, each lead is claimed exactly once. The DECR-tokens counter enforces aggregate CPS without a lock. Two E04 goroutines on different pods popping the same hopper get two *different* leads.

This is a major improvement over Vicidial's `LOCK TABLES vicidial_hopper WRITE` (RESEARCH §2.1 cite [3]).

### 9.2 Sharding

| Phase | Agents | Campaigns | Pods | Valkey ops/s | T04 calls/s |
|---|---|---|---|---|---|
| Phase 2 demo | 30 | 5 | 1 | ~150 | 25 |
| Phase 3 | 100 | 20 | 1 | ~600 | 100 |
| Phase 4 | 500 | 100 | 3 | ~5 000 | 500 |

Phase 2 is single-pod; Phase 4 horizontal scale with no campaign affinity (consistent-hash sharding deferred to HANDOFF).

### 9.3 Pod failure handling

| Failure | Recovery |
|---|---|
| Pod crashes mid-dispatch (claim → T04) | Lead-lock TTL fires; E06 janitor reaps `in_flight` entry; lead re-queues |
| Pod crashes mid-answer-pick (PickAgent → UUIDTransfer) | Agent stuck RESERVED → F04 janitor reverts to READY after 30 s; FS park-timeout 30 s → hangup; lead recycled |
| Pod crashes mid-XREADGROUP | XPENDING entry; sibling pod XAUTOCLAIM after 60 s |
| All pods crash | Hopper accumulates; dispatch resumes on restart; backlog drains in 1–2 ticks |
| Valkey unavailable | Dispatch loop sleeps with exponential backoff; emits `vici2_picker_valkey_unavailable_seconds`; zero originates (correct safety) |
| T04 unavailable | E04 catches gRPC error, releases claim with re-queue delayed, backs off |

### 9.4 Sudden agent logout mid-dispatch (PROGRESSIVE)

Race: E04 reserves agent A → agent A's browser closes (A01 sends LOGOUT) → `agent_state_transition.v1.lua` moves A to LOGOUT (RESERVED→LOGOUT) → E04 calls T04.Originate(AgentID=A) → customer answers → FS tries conference transfer → conference empty.

Mitigation: E04 subscribes to `events:vici2.agent.state_changed`. If a LOGOUT event arrives for a currently-reserved agent, E04 attempts best-effort cancel of the pending originate. If T04 call already returned OK (originate sent), E05 plays safe-harbor when customer answers an empty conference. Frequency < 0.1%; acceptable abandon vector.

---

## 10. Pre-T04 Checks

### 10.1 Check 1 — Campaign still active?

```go
if !l.campaignCache.IsActive(cfg.CampaignID) {
    l.release(ctx, cfg.CampaignID, leadID, lockVal, OutcomeCampaignPaused, false)
    l.metrics.DispatchAborted.WithLabelValues(cfg.CampaignID, "campaign_paused").Inc()
    return nil
}
```

`campaignCache.IsActive` is a `sync.Map[campaignID]CampaignState` updated via pubsub `config_changed`. Read latency: ~50 ns.

### 10.2 Check 2 — Lead still dial-eligible?

```go
status, _ := l.valkey.HGet(ctx, fmt.Sprintf("t:%d:lead:%d", l.tenantID, leadID), "status")
if !d04.IsDialEligible(status) {
    l.release(ctx, cfg.CampaignID, leadID, lockVal, OutcomeLeadIneligible, false)
    return nil
}
```

One Valkey HGET, ~50 µs. Catches leads that became DNC or DROPPED in the seconds between E01 hopper-fill and E04 pop. Avoids a wasted T04 audit-row INSERT.

### 10.3 What E04 explicitly does NOT check

- TCPA window → **T04 gate 3** (C01.Check at `originate_path` enforcement point)
- DNC → **T04 gate 4** (D05.IsDnc)
- Gateway capacity → **T04 gate 1**
- Drop-rate → **T04 gate 2**
- Consent → **T04 gate 5**
- Frequency cap → **E01 filler** (filler-time check per E01 PLAN §3.5)

### 10.4 Per-dispatch budget

| Step | Latency budget |
|---|---|
| DECR dispatch_tokens | 50 µs |
| pick_agent_for_call.v1.lua (PROGRESSIVE only) | 200 µs |
| claim_lead_from_hopper.v1.lua | 250 µs |
| Campaign-active check | 50 ns |
| Lead-status HGET | 50 µs |
| Build OriginateRequest | 5 µs |
| **Subtotal pre-T04** | **~600 µs** |
| T04.Originate (ALLOW path: 5 gates + audit INSERT + T01 ack) | ~50 ms |
| **Total per dispatch** | **~51 ms** |

At 5 CPS per campaign × 50 campaigns = 250 dispatches/s × 51 ms = ~13 goroutines worth. Fits comfortably on one pod.

---

## 11. Valkey Schema

### 11.1 Inputs (E04 reads)

| Key | Type | Purpose | Writer |
|---|---|---|---|
| `t:{tid}:campaign:{cid}:hopper` | ZSET | Lead claim via ZPOPMIN | E01 |
| `t:{tid}:campaign:{cid}:dispatch_tokens` | STRING | Budget per tick | E02 |
| `t:{tid}:agents:by_campaign:{cid}:by_status:READY` | ZSET | Agent pick | A01 |
| `t:{tid}:agent:{uid}` | HASH | Agent metadata | A01 |
| `t:{tid}:lead:{lid}` | HASH | Pre-T04 status check | D01/D04 |
| `t:{tid}:campaign:{cid}:config_snapshot` | STRING (JSON) | Mode, lock TTL, list IDs | M02 |
| `events:vici2.call.answered` | STREAM | Answer handler consumer | T01 |
| `events:vici2.call.amd_detected` | STREAM | AMD action consumer | T01 + AMD detector |
| `t:{tid}:broadcast:campaign:{cid}:config_changed` | PUBSUB | Hot-reload trigger | M02 |
| `t:{tid}:broadcast:campaign:{cid}:tokens_replenished` | PUBSUB | Early dispatch wake | E02 (optional) |
| `t:{tid}:broadcast:agent:{uid}:state_changed` | PUBSUB | Agent logout detection | A01 |

### 11.2 Outputs (E04 writes)

| Key | Type | Operation | Purpose |
|---|---|---|---|
| `t:{tid}:lead_lock:{cid}:{lid}` | STRING | SET NX EX (via Lua) | Claim lock (fence token) |
| `t:{tid}:campaign:{cid}:in_flight` | HASH | HSET (via Lua) / HDEL (via Release) | Janitor visibility |
| `t:{tid}:campaign:{cid}:dispatch_tokens` | STRING | DECR / INCR | Token consumption |
| `t:{tid}:agents:by_campaign:{cid}:by_status:READY` | ZSET | ZREM (via pick_agent Lua) | Agent reservation |
| `t:{tid}:agents:by_campaign:{cid}:by_status:RESERVED` | ZSET | ZADD (via pick_agent Lua) | Reserved tracking |
| `t:{tid}:freq:{phone}:{cid}` | STRING | INCR + EXPIRE on OutcomeBridged | Frequency cap counter (E04 owns per E01 PLAN §8.2) |
| `events:vici2.call.dropped` | STREAM | XADD on PREDICTIVE no-agent | E05 safe-harbor trigger |
| `events:vici2.picker.dispatched` | STREAM | XADD per successful dispatch | O01 audit trail |
| `t:{tid}:campaign:{cid}:picker_metrics` | HASH | HINCRBY per outcome | Live operator view (S01) |

### 11.3 Keys E04 does NOT write

- No `t:{tid}:picker:audit:{cid}` — T04's `originate_audit` MySQL row is the forensic record; not duplicated.
- No `leads.called_count` — E01.Release owns the UPDATE.
- No drop_window stream — E05 reads `events:vici2.call.dropped` (written by E04) and owns the 30-day window accounting.

---

## 12. Go Package Layout

### 12.1 File tree

```
dialer/cmd/dialer/
  main.go                           -- spawn picker.Supervisor on startup (existing binary)

dialer/internal/picker/
  supervisor.go                     -- per-campaign goroutine spawn/kill; pubsub config-change listener
  dispatch_loop.go                  -- 100 ms tick; PROGRESSIVE / MANUAL / PREVIEW / PREDICTIVE dispatch
  answer_handler.go                 -- XREADGROUP on events:vici2.call.answered (PREDICTIVE pairs here)
  amd_handler.go                    -- XREADGROUP on events:vici2.call.amd_detected
  claim.go                          -- thin wrapper around F04 valkey.Hopper().Claim / Release
  pair.go                           -- thin wrapper around F04 valkey.Agents().PickForCall / ReleaseReservation
  retry_policy.go                   -- DialOutcome enum + outcome→D04 status table (§6.2)
  pre_t04_checks.go                 -- IsActive (campaign cache) + IsDialEligible (lead HGET)
  tokens.go                         -- DECR / INCR dispatch_tokens; ErrNoTokens sentinel
  freq_cap.go                       -- INCR t:{tid}:freq:{phone}:{cid} on OutcomeBridged
  config.go                         -- CampaignConfig snapshot; hot-reload from config_snapshot STRING
  metrics.go                        -- all Prometheus counters/histograms/gauges (§13.1)
  janitor.go                        -- SweepOrphans(ctx); called by E06
  types.go                          -- DialOutcome, OriginateRequest builder, LeadClaim adapter
  errors.go                         -- ErrNoTokens, ErrHopperEmpty, sentinel wrappers

  dispatch_loop_test.go             -- unit: 24+ (mode × outcome) table-driven cases
  answer_handler_test.go            -- unit: PREDICTIVE answer, no-agent, transfer-fail paths
  amd_handler_test.go               -- unit: drop/transfer/message/park per amd_action
  retry_policy_test.go              -- unit: all 18 DialOutcome → D04 status rows
  pre_t04_checks_test.go            -- unit: paused/eligible/ineligible × PROGRESSIVE/PREDICTIVE
  tokens_test.go                    -- unit: acquire, over-decrement restore, ErrNoTokens
  concurrency_test.go               -- 100 goroutines × 100 dispatches; mock Valkey; assert no double-claim
  integration_test.go               -- testcontainers: Valkey + MySQL + mock-T04 gRPC stub
  bench_test.go                     -- p50/p99 benchmarks; CI-enforced budget
```

Total production: ~1 100 LOC. Test: ~900 LOC. **No new Lua** — all scripts reused from F04 HANDOFF §2.

### 12.2 Package dependencies

```
dialer/internal/picker
  ├─ imports dialer/internal/valkey       (F04 Go helpers — Hopper, Agents, Scripts)
  ├─ imports dialer/internal/originate    (T04 Go SDK — Originate function)
  ├─ imports dialer/internal/conference   (T03 ConferenceFQN helper — RFC-002 lint enforced)
  ├─ imports dialer/internal/compliance/tcpa (C01 — ONLY for pre-T04 check? No — T04 owns it)
  ├─ imports shared/proto/dialer          (T04 OriginateRequest/OriginateResult gRPC types)
  └─ imports dialer/internal/e01client    (Consumer.Release, ScheduleImmediate, JanitorRelease)

  NEVER imports:
  ├─ e02/* (pacing — E04 reads dispatch_tokens via Valkey; no Go import)
  ├─ e03/* (adaptive dial-level — E04 is blind to level; E02 reads it)
  └─ e05/* (safe-harbor — E04 only XADDs drop event; no Go import)
```

CI grep: `grep -r '".*e02"' dialer/internal/picker/` must return empty.

### 12.3 gRPC posture

E04 is **not** a gRPC server. It calls T04's gRPC service (or imports the Go package directly for in-process calls). The in-process import path is used in Phase 2; the gRPC path is available for future cross-process callers (N01 Phase 4). This matches T04 PLAN §1 bullet 10.

---

## 13. Metrics + Observability

### 13.1 Prometheus metric set

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `vici2_picker_dispatch_total` | counter | `{tenant, campaign, mode, outcome}` | All dispatches by outcome |
| `vici2_picker_claim_total` | counter | `{tenant, campaign, result}` | result: `success\|empty_hopper\|lead_lock_collision` |
| `vici2_picker_no_ready_agent_total` | counter | `{tenant, campaign, mode}` | PROGRESSIVE skipped — no READY agent |
| `vici2_picker_pick_latency_seconds` | histogram | `{tenant, campaign, mode, phase}` | phase: `claim\|pick_agent\|t04\|total`; buckets 0.001/0.01/0.1/1 |
| `vici2_picker_retry_total` | counter | `{tenant, campaign, outcome, recycled}` | recycled: `true\|false` |
| `vici2_picker_callback_dispatched_total` | counter | `{tenant, campaign}` | Callbacks fired via E04 |
| `vici2_picker_predictive_answered_total` | counter | `{tenant, campaign}` | PREDICTIVE customer answers received by answer handler |
| `vici2_picker_predictive_drop_total` | counter | `{tenant, campaign, reason}` | reason: `no_agent\|agent_transfer_failed\|agent_logged_out` |
| `vici2_picker_amd_action_total` | counter | `{tenant, campaign, list, action}` | AMD detected → action taken |
| `vici2_picker_tokens_consumed_total` | counter | `{tenant, campaign}` | Successful token DECR |
| `vici2_picker_tokens_over_decremented_total` | counter | `{tenant, campaign}` | Over-decrement race; INCR restored |
| `vici2_picker_token_leaked_total` | counter | `{tenant, campaign}` | T04 deadline timeout; token not restored (Q8) |
| `vici2_picker_orphaned_claim_total` | counter | `{tenant, campaign}` | E06 janitor reaped orphan |
| `vici2_picker_active_inflight` | gauge | `{tenant, campaign}` | HLEN of in_flight HASH |
| `vici2_picker_answer_handler_latency_seconds` | histogram | `{tenant, campaign}` | XREADGROUP-to-UUIDTransfer latency; buckets 0.01/0.05/0.1/0.25/0.5/2.0 |
| `vici2_picker_valkey_unavailable_seconds` | gauge | `{tenant}` | Seconds Valkey unreachable |

### 13.2 Alert rules (to O01)

| Condition | Severity | Action |
|---|---|---|
| `vici2_picker_claim_total{result="lead_lock_collision"}` rate > 0 sustained ≥ 5 min | **PAGE** | Clock skew or janitor bug; leads may be double-dispatched |
| `vici2_picker_predictive_drop_total{reason="no_agent"}` rate > 1/s sustained | **WARN** | Pacing too aggressive; check E03 adaptive dial-level |
| `vici2_picker_no_ready_agent_total` rate > 5/s | **INFO** | Campaign mismatched to staffing; M02 admin alert |
| `vici2_picker_orphaned_claim_total` rate > 0 ongoing | **WARN** | E04 crashing or T04 wedging; investigate |
| `vici2_picker_pick_latency_seconds{phase="total"}` p99 > 200 ms sustained | **WARN** | T04 slow; check carrier health |
| `vici2_picker_valkey_unavailable_seconds` > 5 | **PAGE** | No dispatches possible; call center down |

### 13.3 Per-dispatch log line

```json
{
  "ts": "2026-05-13T19:23:45.123Z",
  "level": "info",
  "msg": "picker_dispatch",
  "tenant_id": 1,
  "campaign_id": "SOLAR_Q2",
  "mode": "PREDICTIVE",
  "attempt_uuid": "9e5d8c3a-...",
  "lead_id": 1234567,
  "phone_e164": "+14155551111",
  "agent_id": 0,
  "is_callback": false,
  "claim_latency_ms": 0.31,
  "pick_agent_latency_ms": 0.0,
  "t04_latency_ms": 48.2,
  "outcome": "BACKGROUND_JOB_ACK",
  "pod_id": "e04-pod-a"
}
```

Sampling: 100% at debug, 1% at info under load (configurable via `PICKER_LOG_SAMPLE_RATE` env).

### 13.4 OpenTelemetry tracing

Each dispatch is a span: `picker.dispatch` with children `picker.claim`, `picker.pick_agent` (optional), `t04.originate`. W3C TraceContext propagated via `attempt_uuid` as the span's root trace ID. `originate_audit.trace_id` stores it for operator jump-to-trace in Jaeger.

Answer handler events: `picker.answer_handler` span with `picker.pick_agent` + `t01.uuid_transfer` children.

---

## 14. Failure Modes Matrix

| # | Failure | Detection | E04 action | Metric | Severity |
|---|---|---|---|---|---|
| 1 | `dispatch_tokens` missing/expired (E02 down) | `DECR` returns nil (Valkey) | No-op; do not originate without budget | `vici2_picker_tokens_over_decremented_total` (nil→no-op) | PAGE if persistent |
| 2 | Token over-decrement (race) | DECR returns < 0 | INCR-back; skip tick | `tokens_over_decremented_total` | Info |
| 3 | Hopper empty | Lua claim returns nil | Publish refill_request; release agent (PROGRESSIVE); skip | `claim_total{result="empty_hopper"}` | Info |
| 4 | Lead-lock collision (Lua ZADD-back) | Lua returns nil after pop | Skip | `claim_total{result="lead_lock_collision"}` | PAGE if non-zero sustained |
| 5 | No READY agent (PROGRESSIVE) | pick_agent Lua returns 0 | Skip dispatch; INCR token back | `no_ready_agent_total` | Info |
| 6 | T04 ErrTCPABlocked | gRPC typed error | Release agent (PROGRESSIVE) + Release claim TZ-delayed | `dispatch_total{outcome="tcpa_blocked"}` | Info |
| 7 | T04 ErrDNCHit | gRPC typed error | Release agent + Release claim terminal | `dispatch_total{outcome="dnc_blocked"}` | Info |
| 8 | T04 ErrGatewayLimit | gRPC typed error | Release agent + Release claim immediate; INCR token back | `dispatch_total{outcome="gateway_limit"}` | WARN |
| 9 | T04 ErrCarrierFail (circuit open) | gRPC typed error | Freeze campaign 30 s; release agent + claim re-queue delayed | `dispatch_total{outcome="circuit_open"}` | PAGE if persistent |
| 10 | T01 BACKGROUND_JOB never resolves | T04 reports OTHER (60 s timeout) | E06 sweeps originate_audit → JOB_ORPHANED; lead re-queues | `orphaned_claim_total` | WARN |
| 11 | Agent logout mid-pre-pair | events:vici2.agent.state_changed | Best-effort cancel; if can't → E05 safe-harbor | `dispatch_total{outcome="pre_pair_lost_agent"}` | Info |
| 12 | PREDICTIVE answer: no available agent | pick_agent_for_call returns 0 | XADD drop event → E05 plays safe-harbor | `predictive_drop_total{reason="no_agent"}` | WARN |
| 13 | PREDICTIVE: UUIDTransfer fails | T01.UUIDTransfer returns error | Release agent to READY; emit drop event | `predictive_drop_total{reason="transfer_failed"}` | WARN |
| 14 | E04 pod crashes mid-dispatch | in_flight HASH entry lingers | E06 janitor reaps after 5 min; lead re-queues | `orphaned_claim_total` | Info |
| 15 | Answer handler crashes mid-pick | XPENDING accumulates | Sibling pod XAUTOCLAIM after 60 s | Consumer group PEL metric | Info |
| 16 | Valkey unavailable | Helper error on DECR | Sleep exp-backoff; never originate blind | `valkey_unavailable_seconds` | PAGE |

---

## 15. Test Plan

### 15.1 Unit tests (per file)

- **`dispatch_loop_test.go`** — table-driven, 24+ (mode × outcome) tuples; mock T04 returning each typed error; mock E01.Release; assert OriginateRequest fields, Release calls, metric increments.
- **`retry_policy_test.go`** — table-driven over all 18 DialOutcome rows in §6.2; asserts D04 status + requeue bool.
- **`answer_handler_test.go`** — mock `pick_agent_for_call.v1.lua` returning agent / nil; mock T01.UUIDTransfer; assert UUIDTransfer called with `+flags{join-only}`, drop event XADD on no-agent.
- **`amd_handler_test.go`** — all four amd_action variants (drop/transfer/message/park); assert correct T01 call per action.
- **`pre_t04_checks_test.go`** — paused campaign / eligible lead / ineligible lead × each mode.
- **`tokens_test.go`** — DECR success, over-decrement restore, ErrNoTokens on missing key.
- **`concurrency_test.go`** — 100 goroutines × 100 dispatch attempts against mock Valkey; assert zero double-claim, zero token-over-consumption > 5% drift.

Target coverage: > 85%. Goal line in CI: `go test ./dialer/internal/picker/... -coverprofile=cover.out && go tool cover -func=cover.out | grep total | awk '{print $3}'` ≥ 85%.

### 15.2 Integration tests (testcontainers)

```
docker-compose (test): valkey:8.0-alpine + mysql:8.0.40 + mock-T04 (gRPC stub)
Tag: //go:build integration
Command: go test -tags=integration ./dialer/internal/picker/...
```

Scenarios:

1. **Smoke PROGRESSIVE** — 10 leads in hopper, 5 agents READY, PROGRESSIVE mode → all 10 dispatched, correct OriginateRequest.AgentID, BRIDGED outcomes, agents transition RESERVED→INCALL.
2. **PREDICTIVE answer happy-path** — 5 leads, 5 agents; mock T04 returns BACKGROUND_JOB_ACK; inject 5 `events:vici2.call.answered` entries; assert 5 UUIDTransfer calls issued within 250 ms each.
3. **PREDICTIVE drop** — 5 leads, 0 agents; inject 5 answer events; assert 5 `events:vici2.call.dropped` XADD entries, 0 UUIDTransfer calls.
4. **NO_ANSWER retry** — lead gets NO_ANSWER outcome → E01.Release called with OutcomeNoAnswer → lead appears in hopper (delayed score offset ≥ 300 s).
5. **TCPA block** — mock T04 returns ErrTCPABlocked → lead released to delayed-set; never re-dispatched within 1 min window.
6. **Campaign pause** — claim lead, then set campaign inactive in cache before dispatch; assert OutcomeCampaignPaused, lead returned to hopper.
7. **Pod crash recovery** — kill E04 mid-dispatch (mock: claim lead, don't call T04); wait for lead-lock TTL (use short 5 s TTL in test); call SweepOrphans; assert lead re-enters hopper.
8. **Token over-consumption guard** — 3 simulated pods each polling 100 ms; E02 sets tokens=5; assert aggregate dispatches ≤ 6 over 1 s (5 ± 1 for race tolerance).
9. **Callback priority** — insert 1 callback lead (HIGH priority) + 5 normal leads; assert callback lead is the first dispatched.
10. **AMD drop** — mock AMD event with `amd_action=drop`; assert T01.UUIDKill called; OutcomeAMD with terminal release.

### 15.3 Load test — 100 agents × 10k leads

```
Scenario:
  - 1 campaign, PREDICTIVE mode, dial_level=2.0, drop_target=2%
  - 100 agents cycling INCALL → WRAPUP (30 s) → READY (simulated)
  - 10 000 leads seeded in MySQL → E01 fills hopper to ~3 000 entries
  - Mock T04: 60% BRIDGED, 20% NO_ANSWER, 10% BUSY, 5% INVALID, 5% CARRIER_FAIL
  - Mock FS event stream: answer events for 60% of dispatches
  - Run: 10 minutes (~6 000 dispatches at 10 CPS)

Assertions:
  - Aggregate dispatch CPS = E02-published token rate ± 5%
  - Drop rate < 3% (FCC ceiling)
  - Zero double-dispatch (zero duplicate originate_audit rows by attempt_uuid)
  - pick_latency p99 < 250 ms (claim + pick + T04)
  - answer_handler_latency p99 < 250 ms (XREADGROUP → UUIDTransfer)
  - Zero orphaned claims after run
  - Hopper depletes, refill events fire, E01 stays caught up
```

CI hook: `make load-test-picker` (runs in background, results in `test/reports/`; non-blocking on PRs; blocking on `main` merge).

### 15.4 Chaos tests

- Kill Valkey 5 s mid-run: assert E04 sleeps, zero originates, recovers within one tick on restart.
- Kill T04 10 s: assert E04 catches gRPC errors, releases claims, retries with backoff.
- Kill one of three E04 pods: assert no work lost (sibling XAUTOCLAIM reclaims within 60 s).
- Inject 100 simultaneous agent un-pause events: assert no dispatch storm (dispatch_tokens cap enforces aggregate CPS).

### 15.5 Performance baseline (CI-enforced)

| Metric | Target |
|---|---|
| Dispatch p50 (mock T04) | < 5 ms |
| Dispatch p99 (mock T04) | < 50 ms |
| Dispatch p99 (real T04 + Valkey) | < 250 ms |
| Answer handler p99 (XREADGROUP → UUIDTransfer) | < 250 ms |
| Goroutine count at steady-state (50 campaigns) | ≤ 250 |
| Valkey ops/s per E04 pod (50 campaigns) | ≤ 5 000 |
| Memory per E04 pod | < 200 MB |

Benchmarks via `go test -bench=. -benchtime=30s ./dialer/internal/picker/...` on the hot path (dispatch token + claim + OriginateRequest build).

---

## 16. Public API

### 16.1 Go SDK (in-process callers: E02 supervisor, E06 janitor)

```go
// Package picker provides lead-claim, dispatch, and pairing for outbound campaigns.
package picker

// Supervisor manages per-campaign dispatch loops and answer handlers.
type Supervisor struct { /* ... */ }

func NewSupervisor(cfg SupervisorConfig) (*Supervisor, error)
func (s *Supervisor) Start(ctx context.Context) error  // blocks; cancels on ctx done
func (s *Supervisor) Stop(ctx context.Context) error

// SweepOrphans is called by E06 every 60 s.
// Returns the count of orphaned claims released.
func (s *Supervisor) SweepOrphans(ctx context.Context) (int, error)

// DispatchManual is called by A04 for manual / agent-only callback dials.
// Bypasses the token-bucket (MANUAL is agent-initiated, not pacing-budget-driven).
func (s *Supervisor) DispatchManual(ctx context.Context, req ManualDispatchRequest) (*ManualDispatchResult, error)
```

`ManualDispatchRequest` carries `CampaignID`, `AgentID`, `LeadID`, `CallbackID` (optional). E04 builds the OriginateRequest with `Mode=MANUAL` and the specific `AgentID`.

### 16.2 No gRPC service exposed

E04 is an internal module. E02 writes to Valkey; D06 calls E01.ScheduleImmediate; A04 calls T04 directly (or calls `picker.DispatchManual` in-process). No cross-process E04 interface in Phase 2.

---

## 17. Files to Create

| File | LOC (est.) | Description |
|---|---|---|
| `dialer/internal/picker/supervisor.go` | 120 | Per-campaign goroutine lifecycle; pubsub config-change handler |
| `dialer/internal/picker/dispatch_loop.go` | 200 | 100 ms tick loop; PROGRESSIVE/MANUAL/PREVIEW/PREDICTIVE branching |
| `dialer/internal/picker/answer_handler.go` | 120 | XREADGROUP on `events:vici2.call.answered`; PREDICTIVE agent-pick |
| `dialer/internal/picker/amd_handler.go` | 80 | XREADGROUP on `events:vici2.call.amd_detected`; per-list action |
| `dialer/internal/picker/claim.go` | 60 | Thin wrapper: `valkey.Hopper().Claim/Release` |
| `dialer/internal/picker/pair.go` | 60 | Thin wrapper: `valkey.Agents().PickForCall/ReleaseReservation` |
| `dialer/internal/picker/retry_policy.go` | 80 | `DialOutcome` enum; 18-row outcome→D04 status const map |
| `dialer/internal/picker/pre_t04_checks.go` | 50 | Campaign active cache + lead HGET eligibility |
| `dialer/internal/picker/tokens.go` | 60 | DECR/INCR dispatch_tokens; ErrNoTokens |
| `dialer/internal/picker/freq_cap.go` | 30 | INCR freq counter on OutcomeBridged |
| `dialer/internal/picker/config.go` | 80 | CampaignConfig; hot-reload from Valkey STRING |
| `dialer/internal/picker/metrics.go` | 100 | All 16 Prometheus metrics (§13.1) |
| `dialer/internal/picker/janitor.go` | 60 | SweepOrphans; HGETALL in_flight; calls E01.JanitorRelease |
| `dialer/internal/picker/types.go` | 80 | DialOutcome, OriginateRequest builder, ManualDispatchRequest/Result |
| `dialer/internal/picker/errors.go` | 30 | Sentinels: ErrNoTokens, ErrHopperEmpty |
| `dialer/internal/picker/*_test.go` (9 files) | ~900 | Unit + concurrency tests |
| `dialer/internal/picker/integration_test.go` | 250 | testcontainers integration (10 scenarios) |
| `dialer/internal/picker/bench_test.go` | 80 | Benchmarks for hot path |
| F02 amendment migration | ~20 | `campaigns.lead_lock_ttl_seconds`, `campaigns.call_strategy` |

**No new Lua scripts.** All Lua reused from F04:
- `claim_lead_from_hopper.v1.lua` (ScriptClaimLeadFromHopper)
- `release_hopper_lock.v1.lua` (ScriptReleaseHopperLock)
- `pick_agent_for_call.v1.lua` (ScriptPickAgentForCall)
- `agent_state_transition.v1.lua` (ScriptAgentStateTransition) — used by `pair.go` for RESERVED→INCALL on bridge

---

## 18. Dependencies + Risks

### 18.1 Hard dependencies (must be FROZEN before E04 IMPLEMENT starts)

| Dependency | Status | What E04 needs |
|---|---|---|
| T04 PLAN | PROPOSED | `OriginateRequest` shape, typed error set, `attempt_uuid` one-UUID rule |
| T03 PLAN §1.2 | PROPOSED | `ConferenceFQN` function signature; `+flags{join-only}` on non-agent transfers |
| T01 PLAN §17.5 | PROPOSED | Addendum permitting E04 to call `T01.UUIDTransfer` directly |
| F04 HANDOFF | DONE | Lua script registry (all three scripts used by E04 confirmed in §2) |
| E01 PLAN §6/§7/§8 | — | `Consumer.Claim` return type `LeadClaim`, `Consumer.Release` outcome enum, `JanitorRelease`, freq-cap ownership |
| F02 PLAN + AMENDMENTS A1 | DONE | Schema for `campaigns`, `lists.amd_action`, four D04 system statuses |
| F02 AMENDMENT (new) | To file | `campaigns.lead_lock_ttl_seconds`, `campaigns.call_strategy` |

### 18.2 Soft dependencies

| Dependency | Status | Notes |
|---|---|---|
| E02 IMPLEMENT | After E04 PLAN | E02 IMPLEMENT must write `dispatch_tokens` STRING per tick spec in §3 |
| E06 PLAN | — | Must call `picker.SweepOrphans(ctx)` every 60 s (janitor.go interface) |
| E05 PLAN | — | Must subscribe to `events:vici2.call.dropped` (E04 writes this stream) |
| D04 RESEARCH §3/§7 | Done | Status taxonomy + recycle_delay defaults; E04 imports status flags cache |
| D06 module spec | Done | Callback flow confirmed: D06 → E01.ScheduleImmediate → hopper → E04 pops naturally |

### 18.3 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| T04 PLAN not frozen before E04 IMPLEMENT | Medium | High | E04 IMPLEMENT is blocked until T04 PLAN is accepted; gating is hard |
| E01.Consumer.Release outcome enum shape changes | Low | Medium | E04's `retry_policy.go` is the only mapping site; change is one-file |
| FCC 2 s safe-harbor violated by slow answer-handler under load | Low | Critical | p99 budget analysis (§4.2 = 250 ms); E05 plays safe-harbor for remaining 1 750 ms; load test assertion |
| Multi-pod DECR race leads to over-dispatch (> dispatch_tokens) | Low | Low | Over-decrement detected and restored; maximum +1 dispatch per race; bounded; monitored |
| AMD detection false positives burning answer capacity | Medium | Medium | Per-list `amd_action` config; operators can set `none` to disable AMD action |
| F02 amendment for `lead_lock_ttl_seconds` delayed | Low | Low | E04 falls back to hardcoded 30 s constant if column missing (process-cache miss → default) |
| `pick_agent_for_call.v1.lua` not handling RESERVED→INCALL hop | Low | Medium | Q7 confirmed yes — pair.go fires `agent_state_transition.v1.lua` RESERVED→INCALL on CHANNEL_ANSWER; separate from pick |

---

## 19. Hand-offs to Other Modules

| Module | Hand-off |
|---|---|
| **E01** | E04 calls `Consumer.Claim(ctx, cid)` → `LeadClaim`; calls `Consumer.Release(ctx, claim, outcome)` per outcome; calls `JanitorRelease` from SweepOrphans; INCRs `t:{tid}:freq:{phone}:{cid}` on OutcomeBridged (E01 PLAN §8.2 confirms E04 owns this). E04 NEVER calls `Consumer.ScheduleImmediate` — that is D06's only call site. |
| **E02** | E02 SETs `dispatch_tokens <n> EX 2` per tick; E04 DECRs. Optional pubsub `tokens_replenished` for fast-wake. E02 NEVER claims leads. |
| **E03** | No direct interaction. E03 writes `dial_level`; E02 reads it; E04 is blind to it. |
| **E05** | E04 XADDs `events:vici2.call.dropped` on PREDICTIVE no-agent. E05 subscribes and plays safe-harbor + records drop_window entry. E04 does not reference E05 in Go imports. |
| **E06** | E06 calls `picker.SweepOrphans(ctx)` every 60 s. E04 exposes this on `Supervisor`. |
| **T01** | E04 answer handler calls `T01.UUIDTransfer(callUUID, "conference:"+confFQN+"+flags{join-only}", "inline", "default")` for PREDICTIVE post-answer. T01 PLAN §17.5 addendum permits this direct call. |
| **T03** | E04 uses `conference.ConferenceFQN(tenantID, agentID, "default")` exclusively. RFC-002 CI lint blocks any inline `"agent_"` string in E04 files. |
| **T04** | E04 calls `originate.Originate(ctx, OriginateRequest{Mode, AgentID, LeadID, AttemptUUID, ...})`. Maps typed errors per §6.2. |
| **D04** | E04 imports D04's status-flag cache for `IsDialEligible(status)` in `pre_t04_checks.go`. E04 does not write `leads.status` — E01.Release does. |
| **D06** | E04 has no direct Go import of D06. D06 calls E01.ScheduleImmediate; E04 picks the callback naturally on next tick. E04 emits `vici2_picker_callback_dispatched_total`. |
| **F04** | E04 uses `dialer/internal/valkey` (F04 HANDOFF §3): `c.Hopper().Claim/Release`, `c.Agents().PickForCall/ReleaseReservation/Transition`, `c.State.XReadGroup`, `c.State.XAdd`, `c.State.Subscribe`. |
| **F02** | E04 reads `campaigns` (dial_method, lead_lock_ttl_seconds, call_strategy, dial_timeout_sec) and `lists` (amd_action, caller_id_override). File F02 amendment for the two new campaign columns. |
| **A01** | A01 maintains agent ZSETs. E04 reads ZSET via F04 helpers; E04 never writes agent ZSETs directly. |
| **A04** | A04 calls `picker.DispatchManual` for manual / agent-only callback dials. E04 builds MANUAL OriginateRequest with specific AgentID. |
| **M02** | M02 publishes `config_changed` pubsub on campaign save. E04 supervisor hot-reloads within 100 ms. |
| **O01** | Metrics in §13.1; alert rules §13.2. |
| **S01** | Reads `vici2_picker_active_inflight` gauge + `t:{tid}:campaign:{cid}:picker_metrics` HASH for wallboard. |

---

## 20. Acceptance Criteria

E04 IMPLEMENT is DONE when:

- [ ] `go test ./dialer/internal/picker/...` passes with ≥ 85 % coverage.
- [ ] All 10 integration scenarios in §15.2 pass against testcontainers.
- [ ] `make load-test-picker` (100 agents × 10k leads) completes with: drop rate < 3%, zero double-dispatch, pick_latency p99 < 250 ms, answer_handler_latency p99 < 250 ms, zero orphaned claims after run.
- [ ] RFC-002 lint passes: zero inline `"agent_"` strings in `dialer/internal/picker/`.
- [ ] Circular import CI check passes: `dialer/internal/picker` does not import `e02`, `e03`, or `e05`.
- [ ] F02 amendment migration for `campaigns.lead_lock_ttl_seconds` + `campaigns.call_strategy` is applied and tested.
- [ ] MODULE_SPEC_UPDATE patch filed against `spec/modules/E04.md` expanding scope from "agent picker on answer" to full picker definition.
- [ ] All 16 Prometheus metrics are registered and visible in `make dev` Grafana dashboard.
- [ ] Alert rule for `lead_lock_collision` rate > 0 is wired in O01.
- [ ] Dispatch loop and answer handler run in a single E04 process in `dialer/cmd/dialer/main.go` with zero changes to T01/T04 binary layout.
- [ ] HANDOFF.md written: documents Phase 3 deferred items (additional pick strategies, campaign-affinity sharding, voicemail-drop AMD park, per-campaign safe-harbor window tuning, weighted list pop ownership by E01).

---

## MODULE_SPEC_UPDATE Required

File a `MODULE_SPEC_UPDATE` patch against `spec/modules/E04.md` before or during IMPLEMENT phase. The patch must:

1. Expand scope from "pick a READY agent on CHANNEL_ANSWER" to the full picker as defined in this PLAN.
2. Add the `dispatch_tokens` DECR contract as E04's primary integration surface with E02.
3. Document both pairing models (pre-pair / dial-then-pair).
4. Add the `DialOutcome` enum reference.
5. Update the module status from Phase 2 to Phase 2 (primary).
6. Note that E04.md's "E02 owns claim+dispatch" language is superseded by this PLAN's boundary in §2.

---

*This PLAN matches F02 PLAN depth. All 12 RESEARCH open questions resolved. All 10 RESEARCH §18 PLAN action items addressed. No git commit; no other files modified.*
