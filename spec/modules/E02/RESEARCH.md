# E02 — Dialer Pacing Engine — RESEARCH

| Field | Value |
|---|---|
| Module | E02 (the pacing math: how many lines to keep in flight) |
| Phase | 2 (auto-dialer) |
| Owner agent type | backend-go |
| Status | RESEARCH (PLAN blocked on E01 PLAN — LANDED — and a one-paragraph E03 dial-level write-cadence assumption documented in §11) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/E02.md` (drafted before T01/E01 boundary clarification — this RESEARCH supersedes "originate via T04" and pins the boundary at "publish desired count + atomic claim; never originate") |
| Related plans read | E01 PLAN §1–17 (filler trigger, Claim/Release contract, freq-cap counter increment owner); T04 RESEARCH §2–10 (4-mode dispatch, attempt_uuid idempotency, 5-gate compliance pipeline); F04 PLAN §4.3–4.14 (drop_window stream, dial_level STRING, agent ZSETs, in_flight HASH, tick lock); F03 PLAN §5 (single conference profile, ESL host); DESIGN.md §1.2 / §5.2 / §6.2 / §6.4 (modes, Redis live state, dialTick pseudocode, adaptive engine formulas) |

---

## 1. Executive summary (10 bullets)

1. **E02 is the pacing math, not the originate.** Per the SPEC.md §4.3 "the dialer engine is the only thing that originates calls", T04 RESEARCH §1.1 ("T04 is a thin policy wrapper"), and E01 PLAN §8.2 boundary table, E02's job is to (a) wake up on a tick, (b) read agent state + active calls + dial_level + drop_window + gateway headroom from Valkey, (c) compute `desired_new_originates = f(agents, level, active, headroom)`, (d) Claim leads from E01.Consumer.Claim, and (e) hand each claim to T04.Originate. **E02 never writes the FS `bgapi originate`; T01 does**. **E02 never runs compliance gates; T04 does**. **E02 never adjusts `dial_level`; E03 does**. **E02 never picks the agent; E04 does at answer-time.** E02's surface is roughly 600 LOC of decision logic + 400 LOC of tests + 1 Lua script for the multi-instance tick deduplicator.

2. **Tick cadence is 1 Hz per campaign (1000 ms) with adaptive sub-tick burst-spreading.** Vicidial's `AST_VDauto_dial.pl --delay=2500` is **too slow** (RESEARCH cite [14]; 2.5 s starvation on a 15-second AHT means agents idle 16 % of the time). Modern published designs (Talkdesk, Five9, Genesys ASM in [29][32]) run inner loops at 100–250 ms; Vicidial's own `AST_VDadapt.pl` reads "average over the last 15 seconds" so the **adaptive** cadence is decoupled from the **pacing** cadence. We pin **pacing = 1 Hz** (one decision per second per campaign) with **burst-spread** of the per-second originate budget across 10 × 100 ms sub-ticks so we don't slam the carrier with `desired=12` simultaneous INVITEs (CPS cap, RFC 3261 §17.1.1.2 retransmit firestorm avoidance). The 15-second adaptive window stays in E03. Justification + tradeoffs in §6.

3. **Decision formula is Vicidial-compatible plus four modern terms.** The base is `desired = round(agents × dial_level) - active_calls` (DESIGN.md §6.2 line 629; matches Vicidial `goalcalls = adlevel × count`). To this we add: (a) **min_call_buffer_clamp** — don't originate if no agent will be free within `safe_harbor_window_ms × 0.8` based on E03's published `avg_wait_to_answer_ms`; prevents pre-emptive originates that would abandon. (b) **carrier_headroom_clamp** — `desired = min(desired, gateways[].max_concurrent - gw_active)`, taken from T02 RESEARCH §9.2 Valkey counter. (c) **drop_gate_clamp** — when E05 publishes `drop_gated=true`, force `desired = min(desired, 1)` (effectively PROGRESSIVE). (d) **ramp_up_rate_clamp** — when an agent transitions PAUSED→READY, cap the new-originate burst at `max(1, ceil(level))` to avoid the Vicidial "wake-up storm" (forum-cite [16]; "30 agents un-pausing at coffee-break end causes 60 simultaneous originates → carrier rate-limits us"). Full derivation in §3.

4. **The "headroom" output is a publish, not a call.** Per the E02.md "Goal" and the SPEC.md §4.2 separation of live state in Valkey vs persistent in MySQL, E02 publishes its decision as a **Valkey gauge** `t:{tid}:campaign:{cid}:pacing_desired_new` (STRING; rewritten every tick) and a **Stream** `t:{tid}:campaign:{cid}:pacing_decisions` (XADD with MAXLEN ~ 86400 for one-day audit). The actual claim→originate work is a goroutine fan-out inside the same E02 process — but the **decision** is observable by E03 (so it can read "did pacing get throttled by carrier?") and by O01 (Grafana dashboard) and by S01 (supervisor wallboard) without re-running the math. Output schema in §7.

5. **Single E02 process per dialer pod; per-campaign goroutine; multi-pod-safe via Valkey tick-lock.** Vicidial runs one `AST_VDauto_dial.pl` per campaign per server — operationally a nightmare (forum-cite [16]; "30 campaigns × 4 servers = 120 processes; pgrep counting is part of the install guide"). Our design: **one Go process** (`dialer/cmd/dialer/main.go` — already in repo skeleton per SPEC.md §2) with one goroutine per active campaign per pod, coordinating via the F04 PLAN §4.13 `t:{tid}:dialer:tick:{cid}` STRING with `SET NX EX 1`. The lock has 1-second TTL = tick interval, so exactly one pod's tick fires per campaign-second. Lock acquisition is the first thing in `tick()`; lock failure means the goroutine returns immediately (silent no-op). Sibling pod takes over on the next tick if the leader dies. Detailed multi-pod algorithm in §8.

6. **Five dial-method behaviors collapse into one decision function with mode-specific `level` source.** Per DESIGN.md §1.2 and E02.md acceptance criteria:
   - **MANUAL:** E02 goroutine doesn't run (or runs and returns 0); A04 is the originate driver.
   - **PROGRESSIVE:** `level = 1.0` (constant); `desired = ready_agents - active_calls`.
   - **RATIO:** `level = campaigns.auto_dial_level` (static admin-set, e.g., 1.5); `desired = round(agents × 1.5) - active_calls`.
   - **ADAPT_HARD_LIMIT / ADAPT_AVERAGE / ADAPT_TAPERED:** `level = ValkeyGet(dial_level)` (E03 writes); same formula; the three ADAPT subtypes differ only in how E03 computes level — E02 is mode-agnostic past the level-read step.
   The mode dispatch is therefore a 5-line switch on `c.DialMethod`. Tabulated behaviour matrix + agent-count source per mode in §2.

7. **`agent_count` semantics follow Vicidial's `available_only_ratio_tally` knob.** Vicidial offers two count interpretations (forum-cite [15]; [PREDICTIVE.txt cite 17]): (i) `available_only_ratio_tally='Y'` → count **only READY status** (= longest-waiting, immediately answerable); (ii) `available_only_ratio_tally='N'` → count **READY + INCALL + WRAPUP** minus calls currently in DEAD/abandon state. We adopt **(i) as default** because the modern pacing literature ([29][32][35]) recommends "count only agents who will be free within the look-ahead window" — and at 1 Hz tick with sub-second sub-ticks our look-ahead **is** the inter-tick interval. Setting (ii) is preserved for Vicidial-import campaigns via the F02 PLAN `campaigns.available_only_tally_flag` column. Source-of-truth keys for each are listed in §4.1.

8. **`active_calls` is the ZCARD of an authoritative Valkey SET, not a derived counter.** F04 PLAN §4.8 already specifies `t:{tid}:campaign:{cid}:active_calls` as a SET maintained by T01's `record_call_outcome.v1.lua` (F04 PLAN §6.3) which adds on `CHANNEL_CREATE` and removes on `CHANNEL_HANGUP_COMPLETE`. **E02 reads, never writes.** A counter (`INCR`/`DECR`) would drift on T01 crashes; the SET is reconstructable from MySQL `call_log` on cold-start (E06 janitor responsibility). Sub-millisecond read. Same key includes "in-flight not yet answered" originates so we don't double-dial during the 4-second average ring-to-answer window. Schema reference in §4.2.

9. **Failure modes are eight, all observable.** (i) **Tick-lock contention** (sibling pod won the second): no-op, metric `tick_skipped_total{reason=lock_contention}`. (ii) **Stale agent state** (Valkey HASH older than 15 s — janitor will sweep): downgrade count by stale-fraction, metric `agent_state_stale_total`. (iii) **Valkey down**: E02 goroutine sleeps with backoff until F04 helper returns healthy; never originates blind; metric `valkey_unavailable_seconds`. (iv) **E01.Claim returns nil** (empty hopper): publish `pubsub:hopper:refill_request:{cid}` to wake E01 filler (E01 PLAN §1.3 contract); continue with whatever leads we got. (v) **T04.Originate returns ErrGatewayLimit**: release the E01 Claim with `re-queue_immediately=true`, reduce in-memory carrier_headroom estimate, metric `originate_gateway_limit_total`. (vi) **T04 returns ErrCircuitOpen** (T01 PLAN §13): freeze the campaign for `circuit_recovery_seconds` (default 30 s), metric `campaign_frozen_seconds_total`. (vii) **Sudden agent logout** mid-tick: race — we already issued K originates, agent count was K but now K-1; the answered-but-no-agent case is **E05's** safe-harbor abandon — E02 just trusts the next tick. (viii) **Drop% over target** mid-tick: E05 sets `drop_gated=true` Valkey gauge; next tick reads it. Full matrix in §10.

10. **Open questions for PLAN (top 7 of 14).** (i) Tick rendezvous: leader-election vs per-campaign `SET NX EX 1` race? (recommend race — simpler, no Sentinel split-brain). (ii) `desired` clamp ordering when multiple clamps fire? (recommend min-of-clamps + log which fired). (iii) Burst-spread granularity (10 × 100 ms vs token-bucket continuous)? (recommend token-bucket sized by `campaigns.calls_per_second`). (iv) ramp_up_rate per-agent or per-campaign? (recommend per-campaign max-step). (v) Should PROGRESSIVE allow `desired > ready_agents` when a callback is high-priority? (recommend NO — callbacks come through E01.ScheduleImmediate which is hopper-priority; pacing still respects 1.0 level). (vi) Multi-FS dispatch (X03): E02 picks which FS pod issues bgapi, or T04 picks? (recommend T04 — keeps E02 stateless re: telephony topology). (vii) Hot-config reload cadence: every-tick vs every-15s? (recommend every-15s with explicit `campaign_config_updated` pubsub for stop/start). Full list of 14 + recommendations in §11.

---

## 2. Mode taxonomy and decision-function dispatch

The five dial methods from DESIGN.md §1.2 and E02.md acceptance criteria collapse cleanly into one decision function. The dispatch table:

### 2.1 Behaviour matrix

| Mode | `level` source | `agent_count` source (default) | `desired` formula | Special behaviour |
|---|---|---|---|---|
| `MANUAL` | n/a | n/a | always 0 | Goroutine returns immediately. A04 manual-dial endpoint is the originate driver. |
| `PROGRESSIVE` | constant `1.0` | `READY` only (`available_only_tally=Y`) | `ready - active` | One line per ready agent; zero overdial; zero drop-rate exposure. |
| `RATIO` | static `campaigns.auto_dial_level` (e.g., 1.5) | `READY + INCALL + WRAPUP` (`available_only_tally=N` — Vicidial default) | `round(agents × level) - active` | Operator picks the overdial multiplier; no feedback control. |
| `ADAPT_HARD_LIMIT` | `Valkey.Get(dial_level)` (E03 writes) | `READY` only (recommend) | `round(ready × level) - active` | E03 caps level at `adaptive_max_level` (default 3.0) and resets to 1.0 the instant `drop_pct ≥ adaptive_drop_pct`. E02 doesn't know — just reads. |
| `ADAPT_AVERAGE` | `Valkey.Get(dial_level)` | `READY` only | same | E03 maintains running-average drop; level oscillates above + below target. E02 doesn't know. |
| `ADAPT_TAPERED` | `Valkey.Get(dial_level)` | `READY` only | same | E03 multiplies a shift-progress weight (`1 + (1 - elapsed/total)`) onto the level; lenient early, strict late. E02 doesn't know. |

### 2.2 Why the three ADAPT variants are indistinguishable to E02

E03 owns the per-mode math (E03.md plan phase). E02 only needs to **read** the `dial_level` STRING that E03 writes. This separation has three benefits:

1. **Testability:** E02's unit tests stub `dial_level` to a fixed decimal; no E03 dependency.
2. **A/B'ability:** swapping `ADAPT_TAPERED` → `ADAPT_AVERAGE` is a campaigns-table flip with no E02 code change.
3. **Custom modes:** Phase 3+ "ML-driven dial_level" or "operator manual override" mode just needs to write the `dial_level` STRING; E02 honors it unchanged.

The cite is [14] (the original Vicidial code) which conflates `dial_level` math with originate dispatch — our split is cleaner.

### 2.3 PROGRESSIVE vs RATIO=1.0 — a subtle distinction

These look identical (`level = 1.0`) but differ in **agent_count** convention:

- `PROGRESSIVE`: count `READY` only. If 5 READY + 3 INCALL → desired = 5 - active. Hard 1:1.
- `RATIO=1.0`: count `READY + INCALL`. If 5 READY + 3 INCALL → desired = 8 - active. Overdials onto INCALL agents (they'll be free by ring-time).

Default for Phase 2 ship: **PROGRESSIVE** is the safe option for sub-10-agent campaigns; **RATIO=1.5** with ADAPT off is the next step; **ADAPT_TAPERED** is the recommended production default for 10+ agent campaigns. Per DESIGN.md line 870: *"Predictive only behind a campaign-level toggle with mandatory drop% target ≤ 2%."*

### 2.4 PROGRESSIVE vs PROGRESSIVE-with-seizing (Genesys ASM, cite [37])

Genesys ASM (Active Seizing Mode) is a variant of PROGRESSIVE where the agent is "seized" (their headset rings) at the moment of dial, not the moment of answer. This eliminates the customer-greeting → agent-acceptance gap. We **do not** ship ASM in Phase 2 — it requires browser-side audio mute-during-ringback, which is a UX hazard with SIP.js. Track as Phase 3 nice-to-have; not in scope for E02 spec.

### 2.5 Preview mode (not in E02 scope)

Per T04 RESEARCH §2.4, PREVIEW is a UI flow that ends in a MANUAL-shaped originate. E02 does not drive PREVIEW; A04 + M02 do.

---

## 3. The decision formula (full derivation)

### 3.1 Base formula

```
desired_new_originates = round(agents × dial_level) - active_calls
```

This is the canonical Vicidial formula (DESIGN.md §6.2 line 629; AST_VDauto_dial.pl line approximate-1500 per cite [14]). Three subtleties:

- `round()` uses banker's rounding (Go: `math.Round`, which rounds half-away-from-zero) — for `agents=3, level=1.5` we get `round(4.5) = 5`. Vicidial uses Perl `int()` which truncates → 4. We pick `Round` because the abandonment-rate exposure of one extra dial-when-tied is statistically dominated by the next adaptive tick's correction; the wait-time gain of the extra dial is +~1 % occupancy. Document as a deliberate departure from Vicidial in HANDOFF.md.
- `agents` is **active not logged-in** — i.e., not on PAUSE. PAUSED agents are explicitly excluded; logged-out agents (gone from `t:{tid}:agents:by_campaign:{cid}:by_status:READY/INCALL/WRAPUP`) are excluded by Valkey ZRANGE.
- `active_calls` includes both **answered** (state=BRIDGED or RINGING) and **not-yet-answered** (state=ORIGINATED) calls; the formula must not re-dial during the 4-second ring window.

### 3.2 Clamp 1 — `min_call_buffer_clamp` (look-ahead pessimism)

If E03 publishes `avg_wait_to_answer_ms` for the campaign (Phase 2: stub to 4000 ms — the FCC ring-time minimum; Phase 3: actual EWMA from `call_log`), then:

```
if avg_wait_to_answer_ms × desired_new_originates > min_call_buffer_seconds × 1000 × agents:
    # We'd originate so many lines the average wait would exceed buffer
    desired_new_originates = floor(min_call_buffer_seconds × 1000 × agents / avg_wait_to_answer_ms)
```

`min_call_buffer_seconds` defaults to 2.0 (matches FCC safe-harbor TSR 16 CFR § 310.4(b)(4)(i); cite [4]). Effectively: "don't fill the queue deeper than agents-can-handle within safe-harbor".

This clamp rarely fires in practice — adaptive `dial_level` should already converge to satisfy it — but is a **belt-and-suspenders** guard against an E03 bug shipping `level = 5.0` to a 2-agent campaign.

### 3.3 Clamp 2 — `carrier_headroom_clamp`

Per T02 RESEARCH §9.2, each gateway has a `gateways.max_concurrent` (e.g., Twilio Elastic SIP default 200; Telnyx 100). The campaign's active-gateway active-call count is in `t:{tid}:gw:{gateway_id}:active` (T02 Valkey counter).

```
gw_headroom = sum over (gw in c.carriers) of max(0, gw.max_concurrent - gw_active[gw.id])
desired_new_originates = min(desired_new_originates, gw_headroom)
```

If `gw_headroom = 0`, the formula returns 0 — pacing intentionally idles until a carrier slot opens. **Operator alert:** if `gw_headroom = 0` for ≥ 30 s, fire `vici2_dialer_carrier_saturated_total` (Prometheus alert handed to O01).

**Note:** T04 also enforces the per-gateway cap (T04 RESEARCH §3.1) as the **authoritative** final check — pre-pacing-clamp is just an optimization to avoid the wasteful T04 round-trip.

### 3.4 Clamp 3 — `drop_gate_clamp`

E05 publishes a Valkey gauge `t:{tid}:campaign:{cid}:drop_gated` (`"1"` when 30-day rolling drop% ≥ campaign `drop_target_max`). Per E05.md and DESIGN.md §6.4 — when set, force `desired_new_originates = min(desired_new_originates, 1)`. Effectively this collapses the campaign to PROGRESSIVE-1.0 until E05 clears the gate (drop% drops below target).

Why `min(., 1)` and not `0`? Because we still want **some** dialing — call centers under safe-harbor still need to dial new leads; the gate just stops the **overdial**. Zero would idle the agents.

### 3.5 Clamp 4 — `ramp_up_rate_clamp`

When the campaign just went from `agents=0` to `agents=N` (e.g., shift start, or coffee-break-end "ready-storm"), naively dialing `round(N × 1.5)` simultaneously trips three failure modes:

1. Carrier rate-limit (Twilio CPS = 1 by default, raisable to 100 with approval; Telnyx CPS = 25 default; cite [38])
2. FreeSWITCH originate queue saturation (cite [4]; T01 PLAN §13 already enforces an internal CPS limiter)
3. Synchronized ringback storm — if all N customers answer at the same 4-second mark, the answered-but-no-agent abandon rate temporarily spikes to ~50 %

Solution: `ramp_up_rate_clamp` limits new originates per tick to:

```
max_per_tick = max(1, ceil(level)) × campaigns.ramp_up_factor
```

`ramp_up_factor` defaults to 2 (so for `level=1.5` we allow 4 new originates per tick = 4 CPS), tunable per campaign. After 3 ticks the count typically catches up to steady-state.

### 3.6 Composite formula

```
def compute_desired_new_originates(c, snapshot):
    # snapshot is a frozen view of agent count + active + dial_level + drop_gate + gw_headroom
    if c.dial_method == MANUAL:
        return 0

    level = (
        1.0 if c.dial_method == PROGRESSIVE
        else c.auto_dial_level if c.dial_method == RATIO
        else snapshot.dial_level   # ADAPT_*
    )

    base = max(0, round(snapshot.agents * level) - snapshot.active_calls)

    # Apply clamps (min-of)
    desired = base
    desired = min(desired, snapshot.min_call_buffer_max)   # clamp 1
    desired = min(desired, snapshot.gw_headroom)            # clamp 2
    desired = min(desired, 1) if snapshot.drop_gated else desired  # clamp 3
    desired = min(desired, snapshot.ramp_up_max)            # clamp 4

    return desired
```

Per-clamp metric: `vici2_dialer_pacing_clamp_total{campaign, clamp}` so operators see which clamp is firing (a Phase 1 prod-debug must-have, learned from Vicidial forum threads where operators couldn't figure out why dialing stalled).

### 3.7 Hand-off to E01.Claim + T04.Originate

Once `desired` is computed:

```
for i in range(desired):
    claim, err := e01.Claim(ctx, cid)
    if err == ErrEmptyHopper:
        publish(pubsub, "refill_request", cid)
        break
    if err != nil:
        record(metric_claim_error)
        break

    # Hand off — claim is the lead + its lock value
    go func(claim *LeadClaim) {
        outcome := t04.Originate(ctx, OriginateRequest{
            AttemptUUID: uuid.New(),
            LeadID:      claim.LeadID,
            CampaignID:  cid,
            Mode:        modeFromCampaign(c),
            ...
        })
        e01.Release(ctx, claim, mapToOutcome(outcome))
        if outcome.Kind == BRIDGED:
            freq_cap_inc(c, claim.LeadID.Phone)  // E01 PLAN §3.3 — E02 owns this INCR
    }(claim)
```

Three observations:

1. **The `for` loop is fast** — Valkey Claim takes ~150 µs (E01 PLAN ack §15); we issue `desired ≤ ~10` claims per tick under steady-state; total claim-loop latency ≪ 5 ms.
2. **T04.Originate is asynchronous from pacing's perspective** — the goroutine starts, the tick returns; T04 will INSERT `originate_audit`, run gates, call T01.Originate (which is also async via BACKGROUND_JOB). E02 doesn't await the answer.
3. **Frequency-cap INCR is E02's responsibility** per E01 PLAN §8.2 boundary table — it must fire *after* a successful BRIDGED (not at claim time), because re-queues shouldn't double-count. Implementation: T04 emits a `BRIDGED` outcome event on the `pacing_decisions` stream (or via gRPC return value); E02's stream consumer INCRs.

---

## 4. Input signals (Valkey reads only)

E02 reads from F04-owned keys. No MySQL reads on the hot path. Every read is sub-millisecond.

### 4.1 Agent state counts

Per F04 PLAN §4.6 the canonical agent-state indexes are per-tenant ZSETs scored by `last_change_at`. We use:

| Need | Key | Op | p99 latency |
|---|---|---|---|
| Ready agents (longest-wait, primary) | `t:{tid}:agents:by_campaign:{{cid}}:by_status:READY` | `ZCARD` | < 100 µs |
| INCALL agents | `t:{tid}:agents:by_campaign:{{cid}}:by_status:INCALL` | `ZCARD` | < 100 µs |
| WRAPUP agents | `t:{tid}:agents:by_campaign:{{cid}}:by_status:WRAPUP` | `ZCARD` | < 100 µs |
| PAUSED (excluded from agent count) | `t:{tid}:agents:by_campaign:{{cid}}:by_status:PAUSED` | observability only | n/a |

**Pipelined single round-trip:** three `ZCARD` in one Valkey PIPELINE = ~200 µs total. Under load, the F04 helper-lib uses RESP3 client-side caching with `CLIENT TRACKING ON BCAST PREFIX t:1:agents:by_campaign:`, so steady-state reads are O(0) network. Cache invalidation on agent state-transition (F04 PLAN §6.5 `agent_state_transition.v1.lua` BCASTs).

### 4.2 Active calls

Per F04 PLAN §4.8: `t:{tid}:campaign:{{cid}}:active_calls` is a SET maintained by T01's `record_call_outcome.v1.lua`.

```
SCARD t:{tid}:campaign:{{cid}}:active_calls
```

Single read, ~50 µs. The SET is more authoritative than a counter because it survives T01 crashes (cold-start E06 sweep rebuilds it from `call_log WHERE call_ended IS NULL`).

**Critical:** this SET must include **originated-but-not-yet-answered** calls (state=ORIGINATED in F04 PLAN's `t:{tid}:call:{uuid}` HASH). Otherwise the pacing would re-dial during ring. T01 PLAN §11.2 confirms `record_call_outcome.v1.lua` SADDs on CHANNEL_CREATE (well before answer). Good.

### 4.3 `dial_level`

Per F04 PLAN §4.4: `t:{tid}:campaign:{{cid}}:dial_level` STRING. RESP3 client-side cached (~100 ms staleness OK since E03 only writes every 15 s).

```
GET t:{tid}:campaign:{{cid}}:dial_level  # returns "1.85"
```

If missing (campaign just started, E03 hasn't ticked): default to `campaigns.auto_dial_level` from process-cache. If that's 0: fall back to 1.0. Logged as `dial_level_missing_total{cid}`.

### 4.4 Drop gate

Per E05.md and §3.4: `t:{tid}:campaign:{{cid}}:drop_gated` STRING `"1"` or absent.

```
EXISTS t:{tid}:campaign:{{cid}}:drop_gated
```

Single 50 µs read. RESP3 cached.

### 4.5 Carrier headroom

Per T02 RESEARCH §9.2: each gateway has `t:{tid}:gw:{gateway_id}:active` STRING counter. The campaign's gateway pool comes from `campaigns.carriers JSON` (F02 PLAN — array of gateway_ids). Process-cached at 60 s. For each gateway in the pool, one `GET`.

For a 3-gateway campaign: 3 × ~50 µs in a pipelined batch = ~100 µs.

Computed locally (no Valkey round-trip beyond the GETs):
```
gw_headroom = sum_{gw in pool}(max(0, gw.max_concurrent - active_count))
```

### 4.6 Recent abandons (E05 owns the calc; E02 reads the verdict)

E02 does **not** compute drop%. E05 does (15-s tick reading the F04 PLAN §4.3 `drop_window` STREAM). E02 only reads E05's published verdict in §4.4. This keeps the math in one module.

### 4.7 Campaign config snapshot

`campaigns` row in MySQL is **process-cached** (60 s TTL, refreshed via pubsub `t:{tid}:broadcast:campaign:{cid}:config_changed` for instant invalidation). Hot reads:
- `dial_method`, `auto_dial_level`, `adaptive_max_level`, `available_only_tally_flag`, `calls_per_second`, `dial_timeout_sec`, `ramp_up_factor`, `min_call_buffer_seconds`, etc.

### 4.8 Total read budget per tick

Pipelined Valkey reads under steady-state (with client-cache hits):
- 3 × ZCARD (agent statuses)
- 1 × SCARD (active calls)
- 1 × GET (dial_level)
- 1 × EXISTS (drop_gate)
- 3 × GET (gw_active, for 3-gateway average campaign)

= **9 ops in one round-trip**. Network RTT to local Valkey ~150 µs; pipelined ops are batched. Total tick read budget: **< 300 µs**.

This leaves the 1-second tick interval almost entirely free for the goroutine fan-out (claim + T04 dispatch) — no risk of pacing math hogging CPU.

---

## 5. Output signals (publish, don't push)

### 5.1 Per-tick decision artifact

Every tick (success or no-op) E02 writes one entry to:

```
Stream:   t:{tid}:campaign:{cid}:pacing_decisions
MAXLEN:   ~86400 (24h at 1 Hz)
Fields:   ts, agents, level, active, base, gw_headroom, ramp_max, drop_gated,
          desired, claimed, originated_async, clamps_fired, tick_duration_us
```

Why a stream and not just a gauge: **debuggability**. When the support engineer asks "why did we only originate 3 lines at 14:32:07 yesterday", they need an entry per second showing the decision inputs. Storage cost: ~140 B/entry × 86400 × 50 campaigns = ~600 MB/day; XTRIM nightly. F04's existing stream-trim cron handles it.

### 5.2 Live gauge for E03 and S01

```
String:   t:{tid}:campaign:{cid}:pacing_desired_last_tick     # int (last tick's `desired` after clamps)
String:   t:{tid}:campaign:{cid}:pacing_agents_last_tick       # int (last tick's `agents` snapshot)
String:   t:{tid}:campaign:{cid}:pacing_active_last_tick       # int (last tick's `active`)
String:   t:{tid}:campaign:{cid}:pacing_clamp_fired            # comma-list ("gw,drop")
```

These STRINGs are overwritten every tick; no TTL (overwritten before expiry). E03 reads them to make its 15-s adaptive decision (e.g., "drop_gated has been on for the last 5 ticks → reset level to 1.0 immediately, not wait for the next E03 tick"). S01 wallboard reads for live display.

### 5.3 Prometheus metrics

| Metric | Type | Labels | Reset |
|---|---|---|---|
| `vici2_dialer_pacing_tick_total` | counter | `{tenant, campaign}` | n/a |
| `vici2_dialer_pacing_desired` | gauge | `{tenant, campaign}` | per-tick |
| `vici2_dialer_pacing_agents` | gauge | `{tenant, campaign, status}` | per-tick |
| `vici2_dialer_pacing_active_calls` | gauge | `{tenant, campaign}` | per-tick |
| `vici2_dialer_pacing_clamp_total` | counter | `{tenant, campaign, clamp}` | n/a — clamp = `buffer/gw/drop/ramp` |
| `vici2_dialer_pacing_tick_skipped_total` | counter | `{tenant, campaign, reason}` | n/a — reason = `lock_contention/manual_mode/valkey_down/campaign_inactive` |
| `vici2_dialer_pacing_tick_duration_seconds` | histogram | `{tenant, campaign}` | buckets 0.0001/0.001/0.01/0.1/1 |
| `vici2_dialer_pacing_originate_total` | counter | `{tenant, campaign, outcome}` | outcome = `claimed/empty_hopper/t04_error` |
| `vici2_dialer_pacing_carrier_saturated_seconds` | counter | `{tenant, campaign}` | seconds-with-gw_headroom=0 |
| `vici2_dialer_pacing_drop_gated_seconds` | counter | `{tenant, campaign}` | seconds-with-drop_gated=on |
| `vici2_dialer_pacing_originates_per_second` | gauge | `{tenant, campaign}` | 1-min EWMA of originates |

Alert recipes (handed to O01):

- `pacing_tick_skipped_total{reason=valkey_down}` rate > 0 / 30 s → page (Valkey unhealthy).
- `pacing_originates_per_second` > `campaigns.calls_per_second × 1.2` for 1 min → warn (ramp_up_clamp not enforcing).
- `pacing_carrier_saturated_seconds` rate > 30 / 5 min → warn (carrier needs more `max_concurrent` or campaign needs sibling carrier).
- `pacing_drop_gated_seconds` rate > 60 / 10 min → page (drop-rate persistently over threshold).
- `pacing_clamp_total{clamp=buffer}` rate > 0 ongoing → page (E03 mis-tuned, level too high for agent count).

### 5.4 What we don't publish

- **The list of leadIDs.** Audit data lives in `originate_audit` (T04's table); we don't need a parallel pacing audit. The `pacing_decisions` stream stores **counts**, not lead identifiers.
- **The FS host or carrier picked.** That's T04's call (T04 RESEARCH §10.1); pacing is FS-agnostic.

---

## 6. Tick cadence — 1 Hz with sub-tick burst-spread

### 6.1 Why 1 Hz outer cadence

The trade-off space is:

| Outer cadence | Pro | Con |
|---|---|---|
| 100 ms | Maximum responsiveness; <100 ms idle window | High Valkey op rate (~9 ops × 10 × N campaigns = 4500 ops/s at 50 campaigns); pacing CPU dominates dialer process |
| 1 s (recommended) | Sub-second idle window OK (matches FCC's 2-s rule); 450 ops/s for 50 campaigns; trivial CPU | Up to 1-s lag in reaction to abrupt state change (mitigated by sub-tick spread + Valkey pubsub) |
| 2.5 s (Vicidial default) | Cheap | 2.5-s starvation window observable at agent UI; outdated |
| 15 s (E03's cadence) | n/a | Way too slow for pacing — only suitable for adaptive level tuning |
| Event-driven only | Theoretical zero-idle | No backstop on missed events; complex; debug nightmare |

Recommendation: **1 Hz outer**, with **event-driven sub-tick** for fast paths (agent state transitions). Hybrid model matches DESIGN.md §6.2 line 617 ("every `1000ms / calls_per_second` per campaign") + modern best practice [29][32].

### 6.2 Sub-tick burst-spread (within the 1-second window)

When `desired = 12` at tick T, naively issuing 12 simultaneous `T04.Originate` calls within the first 5 ms of the second:

- **Wastes carrier CPS budget.** Twilio default CPS = 1; raising requires support ticket. Spread the 12 over the second → 12 CPS instead of "12 in one millisecond".
- **Triggers FS internal rate-limit.** T01 PLAN §13 has a per-FS bucket; bursting 12 saturates it.
- **Synchronizes ringback.** 12 customers all hearing first-ring at T+800 ms → if all answer at T+4 s, we have 12 simultaneous CHANNEL_ANSWER events fighting for agent-pick → drop% spike.

Solution: a **token bucket** sized at `campaigns.calls_per_second` (default = 5; matches DESIGN.md key knobs §1.2). Per tick, we compute `desired` and then issue claims/originates at the token-bucket rate. For `desired=12, cps=5`:

- T+0 ms: originate 1
- T+200 ms: originate 2
- T+400 ms: originate 3
- T+600 ms: originate 4
- T+800 ms: originate 5
- T+1000 ms: **next tick** runs, recomputes `desired`. If still 7 outstanding from previous tick, new `desired` = 12 - 5 - 7 = 0; bucket idles. Self-balancing.

This is a continuous-rate burst control, simpler and more predictable than the "10 × 100 ms sub-ticks" alternative. The token bucket lives in-process (no Valkey op per dispatch); reset by the outer 1 Hz tick.

### 6.3 Event-driven sub-tick triggers (fast-path "tick now")

For abrupt state changes, waiting up to 1 s is suboptimal. Three triggers wake an out-of-band sub-tick:

1. **Agent PAUSED→READY transition.** Vicidial's well-known "agent un-pause storm" needs a fast originate to keep them busy. Subscribe `t:{tid}:broadcast:campaign:{cid}` for `agent_state_changed` events; on `to=READY`, immediately run a tick (guarded by the same Valkey tick-lock so we don't double-fire).
2. **CHANNEL_HANGUP_COMPLETE** (agent went WRAPUP→READY). Same as above.
3. **`drop_gated` cleared by E05.** Resume normal pacing immediately rather than waiting up to 1 s.

These are **opportunistic** — they accelerate the next tick by up to 1 s; failure to fire is harmless (the steady 1 Hz tick catches up).

### 6.4 Why not pure event-driven

We considered "remove the outer ticker; only run pacing on agent-state-change events." Rejected because:

- No backstop on missed events (Valkey pubsub is fire-and-forget; F04 PLAN §4.9 acknowledges loss tolerance).
- Hard to reason about correctness during chaos tests (kill-and-restart Valkey, missed messages).
- Pacing math is sub-millisecond — running it once per second per campaign costs ~10 µs of CPU. Zero benefit to skipping it.

The cron-tick + event-driven-trigger hybrid mirrors E01's filler design (E01 PLAN §1; "cron + pub/sub HYBRID") for consistency.

### 6.5 Cadence parameters table

| Cadence | Default | Tunable | Notes |
|---|---|---|---|
| Outer tick | 1000 ms | Per-campaign `pacing_tick_ms` (range 200–5000) | Default per DESIGN.md |
| Token-bucket rate | `campaigns.calls_per_second` (default 5) | Per-campaign | Hard cap on CPS within a tick |
| Event-driven sub-tick debounce | 50 ms | No | Coalesce multiple events into one tick run |
| Tick deadline | 200 ms wall-clock | No | If math + claim-loop > 200 ms, log warn + abort |
| Tick-lock TTL | 1000 ms (= outer tick) | No | F04 PLAN §4.13 already specifies this |

---

## 7. The "desired" handoff to the claim path

E02 doesn't have an external "publish" output the way E03 does (writing dial_level for E02 to read). E02's `desired` count is **acted on synchronously** within the same goroutine: it claims that many leads from E01.Consumer.Claim and hands each to T04.Originate.

The output is therefore:

1. **The side-effect** — N goroutines spawned, each driving one originate.
2. **The audit record** — one entry in `pacing_decisions` stream + metrics in §5.3.
3. **The freq-cap INCR** — performed on the per-goroutine BRIDGED outcome (E01 PLAN §3.3 boundary).

For E03 and S01, the **read-only side of the contract** is the `pacing_desired_last_tick` STRING (§5.2). This is the closest thing to a "publish" — it lets external consumers see what E02 decided without re-running the math.

---

## 8. Concurrency model (multi-instance, multi-campaign, multi-pod)

### 8.1 Topology

```
┌─────────────────────────────────────────────────────────────┐
│ dialer pod (Go process)                                      │
│                                                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ E02 root supervisor (one goroutine)                  │   │
│   │   - subscribes to campaign config CRUD events        │   │
│   │   - spawns/kills per-campaign goroutines             │   │
│   └─────────────────────────────────────────────────────┘   │
│        │                                                     │
│        ├─ goroutine: Pacer for campaign 42                  │
│        ├─ goroutine: Pacer for campaign 43                  │
│        ├─ ...                                                │
│        └─ goroutine: Pacer for campaign 99                  │
│                                                              │
│   Per-campaign goroutine:                                    │
│   - time.NewTicker(1s)                                      │
│   - select on { tickerChan, eventChan, ctx.Done }            │
│   - in each tick: acquire Valkey lock, snapshot, decide,    │
│     claim, dispatch, release lock                           │
│   - token-bucket gate on dispatch                            │
└─────────────────────────────────────────────────────────────┘
```

Same shape in pod 2, pod 3, … all running concurrently. They coordinate via:

### 8.2 Per-campaign tick lock (multi-pod safety)

F04 PLAN §4.13 specifies the contract:

```
SET t:{tid}:dialer:tick:{cid} <pod_id> EX 1 NX
```

If `SET` returns OK → we are the leader for this campaign-second. If `SET` returns nil → some sibling pod already locked it; we no-op (metric `tick_skipped_total{reason=lock_contention}`).

Properties:

- **TTL = 1 s = tick interval.** Lock auto-expires before the next tick. No manual unlock needed (and explicit unlock is risky — if our tick runs > 1 s, we might unlock a sibling's lock).
- **Leader is per-campaign-second, not per-campaign.** Two pods can lead alternating ticks; no sticky leader; no Raft.
- **Pod death is harmless** — lock expires in ≤ 1 s; sibling takes the next tick.
- **Clock skew tolerance.** If pod A's clock is 500 ms ahead of pod B, A will tend to win locks. Not great but not broken — pod B's pacing is just slower, not corrupt. Mitigate via NTP, alert on `clock_skew > 100 ms`.

### 8.3 Per-campaign goroutine isolation

A slow tick in campaign 42 must not block campaign 43's tick. The supervisor spawns one goroutine per campaign, each with its own ticker. The Valkey pipeline is per-goroutine (no shared state).

The 200-ms per-tick deadline (§6.5) is a soft cap: if a tick exceeds 200 ms, we log + abort that tick run, but the goroutine continues. We never block the next tick.

### 8.4 Hot-reload campaign config

When admin changes `campaigns.dial_method` from MANUAL → ADAPT_TAPERED via M02:

1. M02 writes to `campaigns` table.
2. M02 publishes `t:{tid}:broadcast:campaign:{cid}:config_changed`.
3. E02 supervisor in every pod receives the pubsub; the corresponding per-campaign goroutine reloads its in-memory config snapshot before its next tick.
4. Worst-case staleness: 1 tick = 1 s.

If the new `dial_method = MANUAL`: the goroutine's `tick()` returns early; no originates. After `manual_idle_ticks > 60` (1 minute), supervisor kills the goroutine to free memory. Restart cost: ~5 ms.

If the new `dial_method = ADAPT_TAPERED` from a previously-stopped campaign: supervisor receives a `campaign_started` event from M02 and spawns the goroutine.

### 8.5 Why one process, not one container per campaign

Vicidial runs `AST_VDauto_dial.pl --campaign=A` and `AST_VDauto_dial.pl --campaign=B` as separate processes. We don't. Reasons:

1. Process startup is 100s of ms; goroutine startup is microseconds.
2. Shared Valkey connection pool (one pool per pod, not per process).
3. Single Prometheus `/metrics` endpoint with `{campaign}` label.
4. Easier ops: one container, one log stream, one PID to monitor.

Tradeoff: a Go panic in pacer goroutine for campaign 42 must not crash the whole pod. Mitigation: `recover()` in every goroutine + sentry hook + metric.

### 8.6 Scaling to 200 agents / 100 campaigns

At 100 campaigns × 9 Valkey ops/tick × 1 Hz = **900 ops/s** for E02 across all campaigns on one pod. Valkey easily sustains 100k+ ops/s. CPU: ~1 ms/tick × 100 = **100 ms/s = 10 % of one core** per pod. Pacing scales linearly with campaign count; agent count is irrelevant to pacing cost (only Valkey ZCARD scans the index, O(log N) at most).

---

## 9. Algorithms compared (industry baseline)

Five baseline algorithms inform our design. We pick the **Vicidial-with-mod-clamps** approach; the others are documented for context + fallback if Vicidial math turns out flawed.

### 9.1 Vicidial AST_VDauto_dial.pl + AST_VDadapt.pl (cite [14][15][16][17])

- Outer tick: 2.5 s; reads `goalcalls = adlevel × agents`, originates the delta.
- Adapt tick: 15 s; reads `drop_window`, applies `adapt_intensity` modifier + `adapt_dl_diff_target`.
- Three modes (`ADAPT_HARD_LIMIT`, `ADAPT_AVERAGE`, `ADAPT_TAPERED`) — we ship same three (per E03.md).
- Pros: battle-tested at 100s of contact centers; spec well-known; operators can re-use mental model.
- Cons: 2.5 s tick is too slow; Perl interpreter; per-campaign process; no clamps for carrier headroom or buffer pessimism; "wake-up storm" issue (cite [16]).

**Our delta:** 1 Hz tick (was 2.5 s), four clamps added, token-bucket burst-spread, Go process not Perl, Valkey not MySQL for live state. Math otherwise identical.

### 9.2 Erlang C (cite [22][23])

Models call-center as M/M/N queue: arrivals are Poisson(λ), service times are exponential(µ), N agents.

```
A = λ × T_service               # offered traffic in Erlangs
Pw = (A^N / N!) × (N / (N-A))  /  (sum_{i=0..N-1}(A^i / i!) + same numerator)
```

Pros: closed-form math; mature; well-understood; Wikipedia-grade.
Cons: assumes **inbound** queue dynamics (callers wait); outbound has **the dialer** wait. Predictive dialing is "Erlang B with seizure" — different model. Erlang C ignores abandonment (which is the only thing the FCC cares about).

**Our use:** as a sanity-check during design — we'll cross-validate E03's tapered formula against Erlang C predictions in unit tests. Not the primary algorithm.

### 9.3 Erlang A (cite [18][22])

Erlang A extends Erlang C with patience-distribution (callers hang up after time T_patience). For predictive dialer **outbound**:

- "Patience" = 2 s safe-harbor window
- "Service" = agent talk time
- "Arrivals" = customer answer events from the dialer

This is the math underlying ASM (Genesys), and is referenced in Lindén 2010 thesis [18] §3.2. Closed-form for abandon-rate prediction:

```
P_abandon ≈ P_wait × P(wait > T_patience | wait)
            ≈ P_wait × exp(-(N - A) × T_patience / T_service)
```

Where T_patience = 2 s and T_service = AHT.

**Our use:** Phase 3 candidate replacement for the ADAPT_AVERAGE Vicidial formula. For Phase 2, stay with Vicidial's simpler P-controller — adopting Erlang A requires solid AHT estimation (Phase 3 EWMA over `call_log`). Document as a research direction in HANDOFF.md.

### 9.4 PID feedback control (Lindén 2010 [18]; patent US8681955 [19])

Closed-loop control of dial-level using P, I, D coefficients on the drop-rate error signal:

```
error = drop_target - drop_current
dial_level(t) = dial_level(t-1) + Kp × error + Ki × ∫ error + Kd × d(error)/dt
```

Pros: classical control theory; provably stable when Kp, Ki, Kd tuned well.
Cons: tuning is hard; nobody publishes recommended coefficients; PID overshoot on bursty signals (and call-center traffic is bursty).

**Our use:** none in Phase 2 (Vicidial's threshold + intensity-modifier scheme is simpler and field-proven). Note the patent **US8681955** is explicitly a "feedback control of a predictive dialer using abandonment rates" patent — we should not implement classic PID, to avoid patent exposure. Vicidial's simpler rule-based feedback (cite [14]) is prior-art-safe.

### 9.5 Modern adaptive (Five9, Talkdesk, Sprinklr; cite [29][32][35])

Vendor docs are vague but converge on:

- "Predict next-15-second agent availability" (look-ahead window matches Vicidial's 15-s adaptive cadence).
- "Adjust dial pace to keep agents busy 90% of the time" (target occupancy).
- "Maintain abandon < 3%" (FCC hard floor, see §12.1).

No vendor publishes the equation. Talkdesk [32]: *"Our algorithm adapts in real-time based on agent availability, AHT, and answer rate."* — vague. Five9 [29]: *"advanced algorithms predict agent availability."* — vague.

**Our use:** Treat industry as a proof-point that "Vicidial-style with our clamps" is competitive. Specifically, the FCC 3 % cap + agent-occupancy-target is the universal contract; the specific math varies.

### 9.6 Recommendation: ship Vicidial-with-clamps

Phase 2 = Vicidial-derived RATIO + ADAPT_TAPERED math (E03 owns the level updates), plus our 4 clamps (§3). Erlang A as a Phase 3 candidate for ADAPT_AVERAGE. PID rejected on patent grounds.

---

## 10. Failure modes matrix

| # | Failure | Detection | E02 action | Metric | Severity |
|---|---|---|---|---|---|
| 1 | Tick-lock contention (sibling pod won) | `SET NX` returns nil | No-op; sleep until next tick | `tick_skipped_total{reason=lock_contention}` | Info — expected at multi-pod |
| 2 | Stale agent state (ZSET score > 15 s ago) | F04 helper detects last-change-at > now - 15s | Treat agent as PAUSED for this tick; log | `agent_state_stale_total{cid, user_id}` | Warn |
| 3 | Valkey down | F04 client error | Pause goroutine with exp-backoff; do not originate; alert | `valkey_unavailable_seconds_total` | Page |
| 4 | E01 hopper empty (Claim returns nil) | Lua script returns nil | Publish `refill_request` pubsub; continue with K-N originates | `pacing_originate_total{outcome=empty_hopper}` | Info — recoverable |
| 5 | T04 returns ErrGatewayLimit | gRPC error type | Release E01 claim with re-queue=immediate; decrement in-memory `gw_headroom`; metric | `pacing_originate_total{outcome=gw_limit}` | Warn — operator action: add gateway capacity |
| 6 | T04 returns ErrCircuitOpen | gRPC error type | Freeze campaign for 30 s; release claim re-queue=delayed | `pacing_circuit_open_total{cid}` | Page if persistent |
| 7 | T04 returns ErrTCPABlocked | gRPC error type | Release claim with re-queue=delayed (or TZ-delayed); no metric (T04 already counts) | n/a | Info |
| 8 | T04 returns ErrDNCBlocked | gRPC error type | Release claim terminal (lead marked DNC); no metric | n/a | Info |
| 9 | Sudden agent logout mid-tick | Agent count delta visible next tick | Already-issued originates may abandon; E05 records the abandon + plays safe-harbor; next tick reflects new count | `agent_logout_during_originate_total` | Info — expected |
| 10 | Drop% over target mid-tick | E05 sets `drop_gated=true` | Next tick reads gate; clamps `desired` to 1 | `drop_gated_seconds` increments | Warn |
| 11 | `dial_level` STRING missing (E03 not up) | GET returns nil | Fall back to `campaigns.auto_dial_level` from process cache; log | `dial_level_missing_total` | Warn if persistent |
| 12 | E03 publishes `dial_level = 99` (bug) | Process-side sanity-check | Clamp to `campaigns.adaptive_max_level`; log + metric | `dial_level_out_of_range_total` | Warn |
| 13 | Tick exceeds 200 ms deadline | Wall-clock timer | Abort tick; next tick continues; log+metric | `tick_overrun_total` | Warn if persistent |
| 14 | Process crash mid-claim (claim held but originate not issued) | E06 janitor finds orphaned in_flight | E06 releases the F04 lock; lead returns to hopper next sweep | F04 already metrics this | Info |
| 15 | Clock skew between pods > 100 ms | Heartbeat | Alert; pacing degrades but doesn't break | `clock_skew_seconds` | Warn |
| 16 | `campaigns.calls_per_second` = 0 (admin error) | Config-load validation | Default to 1 CPS; surface admin warning | `config_invalid_total` | Warn |

The matrix is **observable end-to-end**: every failure increments a metric and writes a log line with `cid, ts, reason`. The PLAN phase must enumerate this list in tests (one test per row).

---

## 11. Open questions for PLAN

1. **Tick rendezvous mechanism.** Race-style (`SET NX EX 1` per tick) vs leader-election (single E02 across all campaigns)? **Recommend race** — F04 PLAN §4.13 already commits to it; leader-election adds Sentinel split-brain risk for marginal gain. PLAN must pin this and document the contention metric.

2. **Clamp ordering and visibility.** When multiple clamps fire, do we report only the binding one or all of them? **Recommend report-all** in `pacing_clamp_total` (one increment per firing clamp) — operators want to see "drop+buffer fired together at 14:32" for forensics. The `desired` value is min-of, regardless.

3. **Burst-spread mechanism.** Token-bucket (continuous) vs sub-ticks (10 × 100 ms)? **Recommend token-bucket** — simpler, no extra timer goroutines per campaign, matches CPS contract directly. Sub-ticks are uneven (burst → idle → burst) and harder to reason about.

4. **ramp_up_factor default.** 1.5 vs 2.0 vs 3.0? **Recommend 2.0** as the Phase 2 default; tunable per-campaign. Validate against the "30 agents un-pausing simultaneously" test scenario.

5. **PROGRESSIVE + callback override.** When a high-priority callback is in the hopper (D06 ScheduleImmediate), should pacing originate >1 line per agent? **Recommend NO** — callback priority is enforced in hopper score (E01 PLAN §3.5/§8.3), pacing respects 1.0 level. Callbacks ride on top of the normal rate, not on top of the dial-level.

6. **Multi-FS dispatch (X03).** Does E02 pick which FS pod issues bgapi, or does T04? **Recommend T04** — keeps E02 stateless re: telephony topology (X03 affinity is T02/T04 concern). E02 just hands `(lead, campaign)` to T04 and T04 picks FS via `req.FSHost=""` round-robin (T04 RESEARCH §11.9).

7. **Hot-config reload cadence.** Every-tick MySQL read vs every-15s vs pubsub-only? **Recommend every-15s + pubsub** — campaign config rarely changes; 15-s staleness is fine for non-critical fields; pubsub for critical (dial_method, active/inactive). Cuts MySQL hot-path reads to zero. F04 helper-lib already provides this.

8. **dial_level stale handling.** If E03 hasn't ticked yet for a brand-new campaign, what `level` do we use? **Recommend** = `campaigns.auto_dial_level` (the starting level), falling back to 1.0 if 0. PLAN should commit + add a "dial_level missing for > 30 s" alert.

9. **min_call_buffer_seconds clamp pessimism.** Phase 2 stubs `avg_wait_to_answer_ms = 4000` (ring time). When should we replace with actual EWMA? **Recommend Phase 3** — needs `call_log` post-processing pipeline. Stub clamp rarely fires anyway in production.

10. **Freq-cap INCR timing.** E01 PLAN §3.3 says E02 INCRs the freq counter on **successful BRIDGED**. T04 returns BRIDGED via gRPC return value (sync) or via `pacing_decisions` stream consumer (async)? **Recommend sync return value** — T04 already blocks until BACKGROUND_JOB completes; pacing's INCR is part of the goroutine's terminal action. Avoids stream-replay complexity.

11. **Per-tick deadline.** 200 ms vs 500 ms vs 1000 ms (= entire tick budget)? **Recommend 200 ms** — anything slower likely indicates Valkey health issue; we want fast-fail.

12. **Tick lock TTL when tick takes > 1 s.** F04 PLAN §4.13 says TTL=1s; if our tick runs 1.5 s, the lock has already expired and a sibling has started the next tick. Is this a problem? **No — it's a feature.** We don't hold cross-tick state in the lock; each tick is atomic w.r.t. the rest. Document the 200-ms deadline (§6.5) to make the > 1 s case very rare.

13. **Goroutine panic recovery.** What happens if a per-campaign goroutine panics? **Recommend** `defer recover() + sentry capture + supervisor respawn after 5 s backoff`. The campaign loses 5 s of pacing — acceptable. Document as `pacing_goroutine_panic_total`.

14. **Phase 2 vs Phase 3 split.** What math ships in Phase 2 vs Phase 3+? **Recommend Phase 2 = RATIO + ADAPT_TAPERED only** (3 of 5 modes wired; PROGRESSIVE for sub-10 agents, RATIO for static overdial, ADAPT_TAPERED for production). ADAPT_HARD_LIMIT + ADAPT_AVERAGE are easy to add (E03's job) so include them — but DESIGN.md line 838 explicitly lists "ADAPT_TAPERED" as the Phase-2-demo mode. MANUAL is from Phase 1.

---

## 12. TCPA / FCC compliance hooks

E02 doesn't enforce TCPA directly (T04 + C01 + E05 do) but its decisions interact with three rules.

### 12.1 FCC 3 % abandonment ceiling (47 CFR § 64.1200(a)(7))

**The rule** (cite [3][4][9]): "no more than three percent of all calls answered live by a person, measured over a 30-day period for a single calling campaign … an outbound telephone call is deemed 'abandoned' if a person answers the telephone and the caller does not connect the call to a sales representative within two seconds of the called person's completed greeting."

**E02 interaction:**

- E02 receives a "drop_gated" signal from E05 when the 30-day rolling drop% reaches or exceeds the campaign's configured target (`campaigns.adaptive_drop_pct`, default 1.5%, well under the 3% legal ceiling for safety margin — DESIGN.md §1.2 key knobs).
- When gated, E02 clamps `desired = min(desired, 1)` (clamp #3, §3.4).
- E02 does not compute the drop% — E05 does (E05.md). E02 only respects the verdict.
- The 30-day window is rolling per FCC rule; E05 manages window math via F04's `drop_window` STREAM with `XTRIM MINID <30d-ago>` cron.

### 12.2 Safe-harbor recorded-message rule (47 CFR § 64.1200(a)(7)(ii))

If the dialer abandons (answered but no agent within 2 s), the safe-harbor rule permits the dialer to play a recorded message **within 2 s of the greeting**, naming the seller + callback + opt-out, to NOT count the call as abandoned. E05 owns this audio + dialplan integration (E05.md). E02 just doesn't dial unless E05 has the safe-harbor audio configured (`campaigns.safe_harbor_audio` non-null) — but this is actually a T04 gate at originate-time, not an E02 gate. Document for PLAN.

### 12.3 "Single calling campaign" definition

FCC applies FTC's definition: "the offer of the same good or service for the same seller" (cite [4]). One row in `campaigns` is one campaign for FCC purposes. The `cid` we use for `drop_gated` and rolling 30-day window aligns with the FCC definition. Document in HANDOFF.md.

### 12.4 4-ring minimum (47 CFR § 64.1200(a)(6))

The dialer must let the phone ring at least 15 s or 4 rings before disconnecting. **E02 does not control ring time** — `originate_timeout` is a T01 channel variable. T04 sets `originate_timeout = campaigns.dial_timeout_sec` (default 22 s; we recommend 18–22 per DESIGN.md §1.2 key knobs). Validator at campaign-save: `dial_timeout_sec >= 15`. F02 PLAN should enforce.

### 12.5 Caller-ID rules (47 CFR § 64.1601)

Outbound caller-ID must be valid + reachable + accurate. **E02 doesn't pick caller-ID** (T04 does, RESEARCH §5). Document boundary in HANDOFF.

---

## 13. Worked examples

### 13.1 Example A — RATIO=1.5, 6 ready agents, no active calls

```
agents = 6
level = 1.5
active = 0
gw_headroom = 50
drop_gated = false
ramp_up_max = 100 (steady-state)
buffer_max = 100 (avg_wait_to_answer × 6 / 2s = lots)

base = round(6 * 1.5) - 0 = 9 - 0 = 9
desired = min(9, 100, 50, 100) = 9   # no clamp fires
```

E02 issues 9 originates spread across the second at the CPS rate. Token-bucket at `cps=5` issues 5 in the first 200 ms × 5 = 1 s, then next tick computes again (active will now be ~5).

### 13.2 Example B — ADAPT_TAPERED, 10 ready, 6 active, dial_level=1.85

```
agents = 10
level = 1.85
active = 6
gw_headroom = 50
drop_gated = false

base = round(10 * 1.85) - 6 = 19 - 6 = 13
desired = 13
```

13 new originates over the second. If the carrier CPS = 5, only 5 issue this tick; 8 carry over to next tick — but next tick re-reads `active` (which will be ~11 by then if originates connect) so `base = round(10*1.85) - 11 = 8`, and the bucket issues 5 of those. Self-balancing in 2-3 ticks.

### 13.3 Example C — Drop-gated mid-campaign

```
agents = 8
level = 1.85 (E03 hasn't yet noticed)
active = 5
drop_gated = true   # E05 just flipped

base = round(8 * 1.85) - 5 = 15 - 5 = 10
desired_after_drop_clamp = min(10, 1) = 1   # clamp #3 fires
```

Despite level=1.85, only 1 new originate issues this tick. E03 will read the gated signal on its next 15-s tick and aggressively drop `dial_level` to ~1.0.

### 13.4 Example D — Carrier saturated

```
agents = 12
level = 1.5
active = 8
gw_headroom = 2 (Twilio at 198/200 cap)
drop_gated = false

base = round(12 * 1.5) - 8 = 18 - 8 = 10
desired_after_gw_clamp = min(10, 2) = 2   # clamp #2 fires
```

Only 2 issue this tick; operator gets `carrier_saturated_seconds` alert.

### 13.5 Example E — Wake-up storm

```
agents jumps 0 → 30 in 1 second (shift start)
level = 1.5
active = 0
ramp_up_max = ceil(1.5) * 2.0 = 4   # clamp #4 fires hard

base = round(30 * 1.5) - 0 = 45
desired_after_ramp = min(45, 4) = 4   # clamp #4 fires
```

Only 4 issue tick 1. Tick 2: `active = 4`, ramp_max grows (per-second resets); 4 more issue. By tick ~10 the campaign reaches steady-state without overwhelming the carrier or causing simultaneous-ringback abandons.

---

## 14. Concurrency primitives and Lua scripts

### 14.1 Existing F04 Lua reused

- `claim_lead_from_hopper.v1.lua` (F04 PLAN §6.1) — wrapped via E01's `Consumer.Claim` Go API.
- `release_hopper_lock.v1.lua` (F04 PLAN §6.2) — via E01's `Consumer.Release`.

E02 makes **no direct Lua calls** in steady-state. All Valkey ops are: SET NX EX (tick lock), pipelined GETs/ZCARDs/SCARDs (snapshot read), one XADD (decision audit), one INCR (freq-cap on BRIDGED).

### 14.2 One new Lua: `pacing_snapshot.v1.lua` (optional, deferred)

To consolidate the per-tick snapshot read into a single round-trip with atomicity guarantees, a script could batch:

```lua
-- KEYS = [ready_zset, incall_zset, wrapup_zset, active_set, dial_level_key, drop_gated_key, gw_keys...]
-- ARGV = [N=number of agent ZSETs, M=number of gw keys]
-- Returns: {ready, incall, wrapup, active, dial_level_string, drop_gated_bool, [gw_actives...]}
```

PLAN should evaluate: is pipelined GETs/ZCARDs sufficient (yes, per F04 PLAN's RESP3 client-cache), or do we want one-script atomicity? **Recommend pipelined ops** for Phase 2 — simpler; if cache-coherence ever bites us, file an RFC to add the script.

---

## 15. File layout (proposal, PLAN to confirm)

```
dialer/cmd/dialer/
  main.go                          -- already exists (T01); E02 hooks supervisor on startup

dialer/internal/pacing/
  supervisor.go                    -- starts/stops per-campaign goroutines based on config events
  pacer.go                         -- per-campaign Pacer struct + tick loop
  decision.go                      -- pure-function decide(snapshot) -> desired (clamps applied)
  snapshot.go                      -- atomic-as-possible Valkey snapshot reader
  bucket.go                        -- token-bucket for burst-spread CPS
  freqcap.go                       -- post-BRIDGED INCR helper
  config.go                        -- per-campaign config struct (snapshotted from MySQL + hot-reload)
  metrics.go                       -- Prom counters/histograms (§5.3)
  modes.go                         -- mode→(level, agent_count_source) dispatch
  decision_test.go                 -- pure-math unit tests, table-driven
  pacer_test.go                    -- per-tick integration with mocked Valkey
  supervisor_test.go               -- start/stop lifecycle
  bucket_test.go                   -- token-bucket math
  integration_test.go              -- testcontainers Valkey + mock T04 + mock E01
```

Total estimated LOC: ~1000 production + ~800 test.

---

## 16. Hand-off to other modules

| Module | Hand-off content |
|---|---|
| **E01** | E02 calls `Consumer.Claim(cid)` / `Consumer.Release(claim, outcome)`. E02 publishes `t:{tid}:hopper:refill_request:{cid}` pubsub on empty-hopper or 5-consecutive-nil-claims (per E01 PLAN §1.3). E02 INCRs `t:{tid}:freq:{phone}:{cid}` STRING on BRIDGED. |
| **E03** | E02 reads `t:{tid}:campaign:{cid}:dial_level` STRING. E03 reads E02's `pacing_desired_last_tick` STRING and `pacing_decisions` stream as advisory inputs (it primarily reads `drop_window` directly). Soft contract: E03 writes dial_level ≤ once per 15 s. |
| **E04** | E04 is event-driven on FS CHANNEL_ANSWER; E02 has no direct interaction. |
| **E05** | E02 reads `t:{tid}:campaign:{cid}:drop_gated` STRING. E05 maintains it. |
| **T04** | E02 calls `T04.Originate(req)` (gRPC). E02 sets `req.Mode` from campaign + `req.AttemptUUID` per-originate. T04 returns sync result (BRIDGED/blocked/error). |
| **T01** | No direct interaction. |
| **F04** | Uses `t:{tid}:dialer:tick:{cid}` SET NX EX 1 (F04 PLAN §4.13). Uses agent ZSETs (§4.6) + active_calls SET (§4.8) read-only. |
| **F02** | Reads `campaigns` row: `dial_method, auto_dial_level, adaptive_max_level, calls_per_second, dial_timeout_sec, ramp_up_factor, min_call_buffer_seconds, available_only_tally_flag, pacing_tick_ms (new), drop_target_max`. PLAN may file F02 amendment for `ramp_up_factor` + `min_call_buffer_seconds` + `pacing_tick_ms` if missing. |
| **M02** | Admin UI for campaign config; on save, publishes `campaign_config_changed` pubsub so E02 reloads. |
| **O01** | All metrics in §5.3; alerts ditto. |
| **S01** | Reads `pacing_desired_last_tick` + `pacing_agents_last_tick` for wallboard. |

---

## 17. Citations

1. **47 CFR § 64.1200 — Delivery restrictions** — https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200 — authoritative source for 3 % abandonment ceiling, 30-day rolling window, safe-harbor recorded-message rule, 4-ring minimum.
2. **Cornell LII — 47 CFR § 64.1200** — https://www.law.cornell.edu/cfr/text/47/64.1200 — mirror for FCC rule.
3. **FCC — Telephone Consumer Protection Act of 1991** — https://www.federalregister.gov/documents/2012/06/11/2012-13862/telephone-consumer-protection-act-of-1991 — origin of TCPA + safe-harbor evolution.
4. **DNC.com — Understanding Abandoned Call Rules Under the TCPA** — https://www.dnc.com/blog/tcpa-tools-necessary-for-compliance-0-0 — modern annotated walkthrough of the 3 % calculation, "campaign" definition, recorded-message rule.
5. **DNC.com FAQ — Call Abandonment Safe Harbor** — https://www.dnc.com/faq/there-call-abandonment-safe-harbor — additional safe-harbor edge cases.
6. **SIPNEX — Abandoned Call Rate: FCC 3% Rule Explained** — https://www.sipnex.ca/blog/abandoned-call-rate-fcc-rules — call-center-ops-oriented 3 % rule explainer.
7. **FTC Telemarketing Sales Rule — 16 CFR Part 310** — https://www.ftc.gov/sites/default/files/documents/federal_register_notices/telemarketing-sales-rule-16-cfr-part-310/061004telemarketingsalesrule.pdf — FTC counterpart rule + 2-second connect-to-agent definition.
8. **Federal Register — Telemarketing Sales Rule (2004)** — https://www.federalregister.gov/documents/2004/11/17/04-25470/telemarketing-sales-rule — 2-second abandon definition; 3 % ceiling.
9. **CompliancePoint — Beginner's Guide to the TCPA** — https://www.compliancepoint.com/articles/beginners-guide-to-the-tcpa/ — compliance practitioner's intro to TCPA enforcement landscape.
10. **Davis Wright Tremaine — Effective Dates of New Federal Telemarketing Rules** — https://www.dwt.com/insights/2003/07/effective-dates-of-new-federal-telemarketing-rules — counterpart FCC/FTC dates + abandoned-call definitions.
11. **TCPAWorld — FCC ADOPTS ADDITIONAL RULES REGARDING CARRIER CALL BLOCKING, SAFE HARBOR (2021)** — https://tcpaworld.com/2021/01/03/fcc-adopts-additional-rules-regarding-carrier-call-blocking-safe-harbor-and-redress-for-callers/ — recent safe-harbor evolution.
12. **Call Center Advisor — Telemarketing Sales Rule Safe Harbor** — https://callcenteradvisor.com/telemarketing-sales-rule-safe-harbor/ — practitioner safe-harbor walkthrough.
13. **Vicidial — `inktel/Vicidial/bin/AST_VDauto_dial.pl`** — https://github.com/inktel/Vicidial/blob/master/bin/AST_VDauto_dial.pl — the canonical predictive-dialer loop in Perl: `goalcalls = adlevel × agents`, 2.5 s tick, available_only_ratio_tally semantics.
14. **Vicidial — `inktel/Vicidial/bin/AST_VDauto_dial_FILL.pl`** — https://github.com/inktel/Vicidial/blob/master/bin/AST_VDauto_dial_FILL.pl — the FILL variant used during oversubscribed campaigns.
15. **Vicidial Forum — Dial Level (Matt Florell post)** — http://www.vicidial.org/VICIDIALforum/viewtopic.php?p=25030 — Vicidial author Matt Florell on `auto_dial_level` semantics, `available_only_tally`, `adapt_intensity`, `dl_diff_target`.
16. **Vicidial Forum — Adapt Intensity Modifier** — https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=4&t=36910 — example showing +10 = "10% more aggressive", -10 = "10% less aggressive".
17. **prinasen/vicidial PREDICTIVE.txt** — https://github.com/prinasen/vicidial/blob/master/docs/PREDICTIVE.txt — Vicidial's own predictive-dialer documentation; per-second + every-15s cadence; ADAPT_HARD_LIMIT/TAPERED/AVERAGE definitions.
18. **Jonatan Lindén — "Predictive Dialing" (Uppsala University, 2010, IT-10047)** — http://www.diva-portal.org/smash/get/diva2:357150/FULLTEXT01.pdf — 30-credit master's thesis on predictive-dial algorithms; cites Korolev et al.; PID + Erlang A.
19. **Google Patents US8681955B1 — Feedback control of a predictive dialer using telemarketing call abandonment rates** — https://patents.google.com/patent/US8681955 — patent on threshold-based feedback control (we don't implement; documented as IP risk).
20. **Google Patents US8411844B1 — Method for controlling abandonment rate in outbound campaigns** — https://patents.google.com/patent/US8411844 — additional patent reference; confirms threshold-based dialer-rate control is the field's standard form.
21. **TechTarget — What is Erlang C and how is it used for call centers?** — https://www.techtarget.com/searchunifiedcommunications/definition/Erlang-C — Erlang C primer.
22. **Call Centre Helper — Erlang C Formula** — https://www.callcentrehelper.com/erlang-c-formula-example-121281.htm — exact formula `Pw = (A^N/N!)*(N/(N-A)) / (sum + same)`; service level extension; required-staff iterative method.
23. **Content Guru — The Formula at the Heart of CX: Calculating Erlang C** — https://www.contentguru.com/en-us/resources/blogs/calculating-erlang-c/ — modern annotated Erlang C.
24. **Wikipedia — Erlang (unit)** — https://en.wikipedia.org/wiki/Erlang_(unit) — units + traffic-intensity formula.
25. **Lokad — Calculate Call Center Staffing with Excel (Erlang formula)** — https://www.lokad.com/calculate-call-center-staffing-with-excel/ — Excel implementation reference.
26. **ResearchGate — Erlang C Formula and its Use in the Call Centers** — https://www.researchgate.net/publication/50905669_Erlang_C_Formula_and_its_Use_in_the_Call_Centers — academic survey.
27. **NICE — Erlang C Formula glossary** — https://www.nice.com/glossary/erlang-c-formula — vendor explainer.
28. **Genesys — Outbound Contact Dialing Modes (8.1.5)** — https://docs.genesys.com/Documentation/OU/8.1.5/Dep/DialingModes — predictive, predictive-with-seizing (ASM), progressive, preview definitions; ASM = "agent seized at dial time".
29. **Five9 — Predictive Dialing Mode docs** — https://documentation.five9.com/bundle/campaign-admin/page/campaign-admin/configuring-campaigns/configuring-dialing-modes/predicitive-dialing-mode.htm — Five9's mode definitions; recommendation thresholds (predictive ≥ 10 agents, progressive < 10).
30. **Five9 — Auto Dialer Software: Predictive, Progressive & Power Dialer** — https://www.five9.com/products/capabilities/dialer-system — vendor product page; mode comparison.
31. **Genesys Cloud — Dialing modes** — https://help.genesys.cloud/articles/dialing-modes/ — modern Genesys Cloud mode definitions.
32. **Talkdesk — How Predictive Dialers Work** — https://www.talkdesk.com/blog/how-predictive-dialers-work/ — abandonment-risk profile, overdial ratio math.
33. **Sprinklr Help — Predictive Dialers** — https://www.sprinklr.com/help/articles/dialers/predictive-dialers/641180977517d84a3ab00839 — vendor mode comparison.
34. **MightyCall — Predictive Dialer Software** — https://www.mightycall.com/features/predictive-dialer/ — modern predictive-dialer architecture; AHT-driven prediction.
35. **VanillaSoft — How to Choose the Right Dialer for Call Centers** — http://vanillasoft.com/blog/choosing-the-right-call-center-dialer — abandonment-risk profile by mode; parallel-dial caveats.
36. **ActiveCalls — Predictive vs Progressive vs Power Dialers (2025-2026)** — https://activecalls.com/blog/predictive-dialers-vs-progressive-dialers-vs-power-dialers-2025-2026-comparison/ — modern compliance posture per mode.
37. **Genesys — Predictive with Seizing (ASM) mode** — https://docs.genesys.com/Documentation/OU/latest/Dep/DialingModes — pre-answer seizing variant; not in our Phase 2.
38. **Twilio — Outbound Calls Per Second (CPS)** — https://help.twilio.com/articles/223180788 — Twilio default CPS limits; raisable on request; informs ramp_up_factor.
39. **DESIGN.md §1.2, §5.2, §6.2, §6.4** — local — modes, Redis live state, dialTick pseudocode, adaptive engine formulas.
40. **SPEC.md §4.1, §4.2, §4.3** — local — compliance hard floor; live state in Redis; dialer engine is the only originator.
41. **SPEC.md §10** — local — Phase 2 demo definition: ADAPT_TAPERED, 1.5×, drop < 2 %.
42. **DESIGN.md §1.2 (Risk register: E02 Pacing — Mirror Vicidial's algorithm; do not invent.)** — explicit guidance to follow Vicidial.
43. **viciwiki — Vicidial RatioManager** — https://viciwiki.com/index.php/Vicidial_RatioManager — admin UI conventions for ratio campaigns.
44. **CyburDial — ViciDial's Predictive Settings Revealed** — https://cyburdial.net/vicidials-predictive-settings-revealed/?amp — modern operator's guide to Vicidial pacing knobs.
45. **OwnPages — Kick butt on your predictive campaigns** — http://blog.ownpages.com/2012/02/kick-butt-on-your-predictive-campaigns.html — operator-blog explainer of Vicidial settings.
46. **Vicidial Forum — Vicidial Predictive Dialing Algorithm?** — http://eflo.net/VICIDIALforum/viewtopic.php?f=4&t=41174 — operator Q&A on the algorithm internals.
47. **Vicidial Forum — Dial ratio based on average wait time** — http://www.vicidial.org/VICIDIALforum/viewtopic.php?t=21857 — operator discussion of `adapt_dl_diff_target`.
48. **Vicidial Forum — VICIDial - Adapt calling mode** — http://www.eflo.net/VICIDIALforum/viewtopic.php?f=4&t=37108 — operator Q&A on ADAPT_TAPERED behavior.
49. **prospeo.io — Predictive Dialer Guide (2026)** — https://prospeo.io/s/predictive-dialer — modern compliance guide.
50. **callin.io — Predictive Dialer Algorithm in 2025** — https://callin.io/predictive-dialer-algorithm/ — ML-augmented modern predictive overview.

(Citation count: 50, ≥ 12 required.)

---

## STOP — Do not proceed to PLAN. Awaiting orchestrator review.

When unblocked the PLAN must:

1. Pin the **outer tick cadence** to 1 Hz (§6.1) and the **token-bucket burst-spread** (§6.2). Confirm `campaigns.calls_per_second` default = 5.
2. Lock the **decision formula** with all 4 clamps (§3.6). Commit to the per-clamp `pacing_clamp_total{clamp}` reporting (Q2).
3. Pin the **mode dispatch table** (§2.1) and the `available_only_tally_flag` per-campaign override (Q7).
4. Pin the **Valkey snapshot read path** (§4.8) at 9 pipelined ops ≤ 300 µs.
5. Pin the **output schema** (§7): stream `pacing_decisions` + STRINGs `pacing_*_last_tick` + Prom metrics §5.3.
6. Resolve the **14 open questions** in §11 — at minimum #1 (tick rendezvous), #3 (burst-spread mechanism), #4 (ramp_up_factor default), #6 (multi-FS dispatch), #10 (freq-cap INCR timing), #14 (Phase 2 mode subset).
7. Define **test fixtures**: 5 worked-example scenarios from §13 + the 16-row failure-mode matrix from §10 + 4 burst-spread token-bucket tests + 3 multi-pod tick-lock contention scenarios.
8. Define the **gRPC contract** to T04: pacing calls `dialer.OriginateService/Originate` with `req.Mode` mapped per §2.1. Reuse T04 PLAN's proto.
9. File **F02 amendment** if `campaigns.ramp_up_factor`, `min_call_buffer_seconds`, `pacing_tick_ms`, `drop_target_max` are missing. Additive — no RFC per SPEC §12.
10. Specify the **goroutine supervisor** lifecycle: spawn on campaign-start event, kill on campaign-stop or > 60 idle MANUAL ticks, respawn on panic with 5-s backoff.

Blocking dependencies BEFORE PLAN can proceed:
- **E01 PLAN landed** — `Consumer.Claim` / `Release` Go API frozen.
- **T04 RESEARCH landed** — `T04.Originate` gRPC contract drafted; PLAN may proceed in parallel with T04 PLAN as long as the gRPC schema is stable.
- **F04 PLAN landed** — Valkey key schema + Lua scripts frozen.
- **E03 RESEARCH** does NOT block — E02 only needs to read the `dial_level` STRING; the math on the E03 side can evolve independently.
- **E05 RESEARCH** does NOT block — E02 only needs to read `drop_gated`.
