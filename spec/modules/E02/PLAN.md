# E02 — Dialer Pacing Engine — PLAN

| Field | Value |
|---|---|
| **Module** | E02 — headroom publisher; per-tick decision function; dispatch_tokens writer |
| **Author** | E02-PLAN sub-agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator review |
| **Companion** | [RESEARCH.md](./RESEARCH.md) — 50 citations |
| **Module spec** | `spec/modules/E02.md` (superseded where this PLAN conflicts) |
| **Depends on (FROZEN upstream)** | E01 PLAN §6/§7/§8 (`Consumer.Claim`, `Consumer.Release`, `refill_request` pubsub, freq-cap boundary — E04 now owns freq-cap INCR; see §2.3); F04 HANDOFF §2 (`ScriptPickAgentForCall`, `ScriptRecordCallOutcome`, F04 key schema); F04 PLAN §4.4 (`dial_level` STRING), §4.6 (agent ZSETs), §4.8 (`active_calls` SET), §4.13 (tick lock `SET NX EX 1`); E04 PLAN §3 (`dispatch_tokens` STRING DECR contract — FROZEN); E03 RESEARCH §1 (`dial_level` write cadence 15 s; E03 owns E02 reads); E05 RESEARCH §1/§8 (`drop_gated` STRING; two-tier gate; dwell hysteresis); T04 PLAN §0 (gRPC service `T04OriginateService.Originate`; `OriginateRequest` shape); F02 PLAN §4 (campaign schema columns) |
| **Blocks** | E04 IMPLEMENT (dispatch_tokens contract must be frozen — **it is, see §4**); E03 PLAN (reads E02's `pacing_*_last_tick` advisory gauges); E05 PLAN (ratifies `drop_gated` signal contract); O01 (metrics wiring); S01 wallboard (`pacing_*_last_tick` reads) |

This PLAN turns the E02 RESEARCH into the exact Go package layout, public API
surface, Valkey key contract, decision formula, tick model, and test plan the
IMPLEMENT phase will deliver. Once approved the following are FROZEN: the
`dispatch_tokens` STRING write form (`SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2`),
the four-clamp composite formula, the Prometheus metric names (§14), the
`dialer/internal/pacing/` package boundary, and the 1 Hz + token-bucket tick
model. Gate internals, log sampling, and sub-tick event debounce timings can
change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **E02 is the headroom publisher, not the dispatcher.** E02 wakes every
   second per campaign, reads a snapshot of Valkey state, computes
   `desired_new_originates`, and writes that count as
   `dispatch_tokens:t{tid}:c{cid}` for E04 to consume via atomic DECR.
   E02 never touches the hopper, never calls T04, and never picks an agent.
   This is the boundary rewrite agreed with E04 PLAN §2 — superseding the
   inline claim+dispatch loop in E02 RESEARCH §3.7.

2. **Decision formula: Vicidial-derived base + four modern clamps.**
   `base = max(0, round(agents × dial_level) - active_calls)`.
   Clamps applied in order: (1) `min_call_buffer_clamp`, (2) `carrier_headroom_clamp`,
   (3) `drop_gate_clamp` (from E05), (4) `ramp_up_rate_clamp`. The minimum of
   all firing clamps is the `desired` value written to `dispatch_tokens`.

3. **Tick model: 1 Hz outer ticker + token-bucket burst spread inside E04.**
   E02's job ends at writing `dispatch_tokens`; the token-bucket rate limit
   (`campaigns.calls_per_second`, default 5) is enforced by E04's dispatch loop
   (E04 PLAN §3). E02 publishes the budget; E04 spends it.

4. **`dispatch_tokens` is a STRING SET EX 2, DECRed by E04.** This is the sole
   wire contract between E02 and E04. Key form:
   `t:{tid}:campaign:{cid}:dispatch_tokens`. TTL = 2 s ensures E04 sees nil
   (no dispatches) when E02 is down — correct safety posture.

5. **Multi-pod safety via per-campaign tick lock.** `SET t:{tid}:dialer:tick:{cid} <pod_id> EX 1 NX` (F04 PLAN §4.13). Exactly one pod writes `dispatch_tokens` per campaign-second. Lock contention is a metric, not an error.

6. **Mode dispatch is 5 lines.** MANUAL → return 0. PROGRESSIVE → `level = 1.0`.
   RATIO → `level = campaigns.auto_dial_level`. ADAPT_* → `level = Valkey.GET(dial_level)`.
   The three ADAPT subtypes are indistinguishable to E02; E03 owns the math
   that produces the `dial_level` value.

7. **Valkey snapshot is 9 pipelined ops, ≤ 300 µs, zero MySQL on hot path.**
   3 × ZCARD (agent status), 1 × SCARD (active_calls), 1 × GET (dial_level),
   1 × EXISTS (drop_gated), up to 3 × GET (gw_active per carrier in pool).
   RESP3 client-side caching (F04 PLAN §4 contract) delivers most reads in O(0) network.

8. **Output: two Valkey artifacts + Prometheus.**
   (a) STRING `dispatch_tokens` (E04 consumes).
   (b) Stream `t:{tid}:campaign:{cid}:pacing_decisions` MAXLEN 86400 (audit).
   (c) Four live-gauge STRINGs `pacing_*_last_tick` for E03 and S01.
   (d) Prometheus metrics per §14.

9. **Failure modes are 16, all observable.** Every failure increments one metric
   and writes one structured log line. No silent degradation.

10. **Schema amendments required.** Four columns missing from `campaigns`:
    `calls_per_second`, `ramp_up_factor`, `min_call_buffer_seconds`, `pacing_tick_ms`.
    Filed as F02 Amendment A2/E02 (additive, no RFC per SPEC §12). See §11.

---

## 1. Goals + non-goals

### 1.1 Goals

- **Pacing math**: every 1 Hz tick per campaign, compute `desired_new_originates`
  from a frozen Valkey snapshot using the Vicidial-derived formula with 4 clamps.
- **Headroom publish**: write `dispatch_tokens` STRING (SET EX 2) for E04 to DECR.
- **Observability**: write one `pacing_decisions` Stream entry per tick;
  overwrite four live-gauge STRINGs; emit Prometheus metrics per §14.
- **Multi-pod deduplication**: acquire the per-campaign tick lock via `SET NX EX 1`
  before any computation; release implicitly (TTL expiry).
- **Hot-config reload**: respond to `campaign_config_changed` pubsub within 1 tick.
- **Supervisor lifecycle**: spawn per-campaign goroutines on campaign-start; reap on
  campaign-stop or MANUAL-idle timeout; respawn on panic.
- **Event-driven sub-tick acceleration**: on `agent_state_changed{to=READY}` pubsub
  or `drop_gated` cleared pubsub, immediately fire a debounced tick (50 ms coalesce).

### 1.2 Non-goals (explicit hand-offs)

| Concern | Owner |
|---|---|
| Lead claiming from hopper ZSET | **E04** — DECR dispatch_tokens then Lua ZPOPMIN |
| Calling `T04.Originate` | **E04** |
| Agent-pick (pre-pair or dial-then-pair) | **E04** |
| Freq-cap INCR on BRIDGED | **E04** (E04 PLAN §2.2) |
| Adjusting `dial_level` | **E03** — E02 only reads it |
| Computing 30-day drop% | **E05** — E02 only reads `drop_gated` verdict |
| Safe-harbor audio playback | **E05** |
| `bgapi originate` ESL call | **T01** via T04 |
| 5-gate compliance pipeline | **T04** |
| Hopper fill from MySQL | **E01** |
| `originate_audit` row lifecycle | **T04** |
| `active_calls` SET maintenance | **T01** via `record_call_outcome.v1.lua` |
| Agent ZSET maintenance | **A01** via `agent_state_transition.v1.lua` |
| Multi-FS host affinity | **X03** (Phase 3.5); T04 handles FS routing |
| Per-campaign list-mix weighting | **E01** |

### 1.3 Module boundary summary

```
E03 ──── writes ──── dial_level STRING ──── E02 reads (hot path)
E05 ──── writes ──── drop_gated STRING ──── E02 reads (hot path)
E02 ──── writes ──── dispatch_tokens STRING ──── E04 reads (DECRs)
E02 ──── writes ──── pacing_decisions Stream ──── E03/S01/O01 read
F04 ──── maintains ── agent ZSETs, active_calls SET ──── E02 reads
```

E02 is a **pure decision function with side-effect-free reads** plus one write
(dispatch_tokens) and one audit append (pacing_decisions stream).

---

## 2. Algorithm pinned: Vicidial-derived + 4 clamps

### 2.1 Base formula

```
desired_new_originates = max(0, round(agents × dial_level) - active_calls)
```

This is the canonical Vicidial formula (DESIGN.md §6.2 line 629; AST_VDauto_dial.pl
`goalcalls = adlevel × agents`). Three committed subtleties:

- `round()` = `math.Round` (half-away-from-zero). Vicidial uses Perl `int()`
  (truncation). Our choice is documented as a deliberate departure — the extra
  dial on half-integer ties is corrected within the next adaptive tick.
- `agents` excludes PAUSED agents. Only READY (and optionally INCALL+WRAPUP per
  `available_only_tally`) count. PAUSED agents excluded unconditionally.
- `active_calls` includes originated-but-not-yet-answered calls (state=ORIGINATED
  in F04). SCARD of the SET maintained by `record_call_outcome.v1.lua` which SADDs
  on CHANNEL_CREATE and removes on CHANNEL_HANGUP_COMPLETE (T01 hook).

### 2.2 `agents` count by mode

| Mode | `available_only_tally = false` (default) | `available_only_tally = true` |
|---|---|---|
| PROGRESSIVE | READY only (hardcoded regardless of tally flag) | READY only |
| RATIO | READY + INCALL + WRAPUP | READY only |
| ADAPT_* | READY only (recommended; matches modern pacing literature) | READY only |

`campaigns.available_only_tally` (F02 PLAN §4) boolean toggles the INCALL+WRAPUP
inclusion for RATIO mode only. PROGRESSIVE always uses READY-only (1:1 hard limit).

### 2.3 Clamp 1 — `min_call_buffer_clamp`

Guard against E03 bugs shipping an extreme `dial_level` to a small campaign.
Uses E03's published `avg_wait_to_answer_ms` (Phase 2: stubbed to 4000 ms,
the FCC 4-ring minimum; Phase 3: EWMA from `call_log`).

```
if avg_wait_to_answer_ms × desired > min_call_buffer_seconds × 1000 × agents:
    desired = floor(min_call_buffer_seconds × 1000 × agents / avg_wait_to_answer_ms)
```

`min_call_buffer_seconds` (F02 amendment A2/E02.2, default 2.0) matches FCC
TSR 16 CFR § 310.4(b)(4)(i) safe-harbor window. In Phase 2, with the 4000 ms
stub, this clamp fires only at extreme `dial_level` (≥ 2.5 × agents); it is a
belt-and-suspenders guard, rarely active in practice.

### 2.4 Clamp 2 — `carrier_headroom_clamp`

Per-gateway headroom aggregated from `t:{tid}:gw:{gateway_id}:active` counters
(T02 Valkey contract):

```
gw_headroom = sum_{gw in campaign.carriers}(max(0, gw.max_concurrent - gw_active[gw.id]))
desired = min(desired, gw_headroom)
```

When `gw_headroom = 0`, the formula returns 0 — pacing idles until a carrier
slot opens. If `gw_headroom = 0` for ≥ 30 consecutive seconds, fire
`vici2_dialer_carrier_saturated_seconds` alert (O01). Note: T04 also enforces
the per-gateway cap as the **authoritative** final gate; this clamp is an
optimization that avoids a wasted T04 round-trip.

### 2.5 Clamp 3 — `drop_gate_clamp` (from E05)

E05 publishes `t:{tid}:campaign:{cid}:drop_gated` STRING `"1"` when 30-day
rolling drop% reaches the hard cap (default 3.0%; per-campaign override
`campaigns.drop_target_max_override` — F02 amendment from E05 RESEARCH §16).
When set:

```
desired = min(desired, 1)
```

Effectively collapses the campaign to PROGRESSIVE-1.0, allowing minimal dialing
while E05's dwell + hysteresis recovery timer counts down (E05 RESEARCH §8:
gate releases only when `drop_pct ≤ 2.0%` AND `recover_seconds` elapses).
`min(., 1)` not `0` because zero would idle all agents.

E02 reads `drop_gated` via single `EXISTS` command (~50 µs, RESP3 cached).
E02 does NOT compute drop% — it only respects E05's verdict.

### 2.6 Clamp 4 — `ramp_up_rate_clamp`

Prevents the "wake-up storm" (E02 RESEARCH §3.5; Vicidial forum cite [16]):
agents returning from break simultaneously causing a burst of simultaneous
INVITEs that trips carrier CPS limits.

```
max_per_tick = max(1, ceil(dial_level)) × campaigns.ramp_up_factor
desired = min(desired, max_per_tick)
```

`ramp_up_factor` (F02 amendment A2/E02.3, default 2.0) is per-campaign and
tunable. For `dial_level=1.5`, `ramp_up_max = ceil(1.5) × 2 = 4`. After 3
ticks at steady state, `active_calls` rises to match the base formula and the
clamp no longer binds. Validated against "30 agents un-pausing simultaneously"
test scenario in §16.

### 2.7 Composite formula (reference implementation)

```go
func (d *Decider) Decide(snap Snapshot) int {
    if snap.DialMethod == MANUAL {
        return 0
    }

    level := resolveLevel(snap)   // §7 mode dispatch
    agentCount := resolveAgents(snap) // §2.2

    base := max(0, round(float64(agentCount)*level)-snap.ActiveCalls)

    desired := base

    // Clamp 1 — min_call_buffer
    if snap.AvgWaitToAnswerMs > 0 {
        bufferMax := int(math.Floor(snap.MinCallBufferSeconds*1000*float64(agentCount) /
            float64(snap.AvgWaitToAnswerMs)))
        if desired > bufferMax {
            desired = bufferMax
            d.metrics.clampTotal.With("clamp", "buffer").Inc()
        }
    }

    // Clamp 2 — carrier headroom
    if desired > snap.GWHeadroom {
        desired = snap.GWHeadroom
        d.metrics.clampTotal.With("clamp", "gw").Inc()
    }

    // Clamp 3 — drop gate
    if snap.DropGated && desired > 1 {
        desired = 1
        d.metrics.clampTotal.With("clamp", "drop").Inc()
    }

    // Clamp 4 — ramp up rate
    rampMax := max(1, int(math.Ceil(level))) * snap.RampUpFactor
    if desired > rampMax {
        desired = rampMax
        d.metrics.clampTotal.With("clamp", "ramp").Inc()
    }

    return max(0, desired)
}
```

Per-clamp metric `vici2_dialer_pacing_clamp_total{tenant,campaign,clamp}` (§14).
All firing clamps are counted (not just the binding one) for forensic visibility.
The `desired` value is `min-of-all-clamped` regardless.

---

## 3. Tick model: 1 Hz outer + token-bucket burst spread in E04

### 3.1 Why 1 Hz outer cadence

| Cadence | Valkey ops/s (50 campaigns) | Starvation window | Decision |
|---|---|---|---|
| 100 ms | 4500 | < 100 ms | Rejected — CPU/ops overhead; marginal gain |
| **1 s (chosen)** | **450** | **≤ 1 s** | Matches FCC 2-s rule; trivial cost |
| 2.5 s (Vicidial) | 180 | 2.5 s | Too slow — 16% idle at 15-s AHT |
| 15 s (E03 cadence) | 30 | 15 s | Unsuitable for pacing (adequate for level tuning) |

1 Hz matches DESIGN.md §6.2 "every 1000ms/calls_per_second" and modern best
practice (Talkdesk, Five9, Genesys — E02 RESEARCH §9.5). Configurable per
campaign via `campaigns.pacing_tick_ms` (F02 amendment A2/E02.4; range 200–5000 ms;
default 1000).

### 3.2 Token-bucket burst spread (lives in E04, not E02)

The original E02 RESEARCH §6.2 described a token-bucket inside E02. After the
E02↔E04 boundary rewrite (E04 PLAN §2), the token-bucket is **E04's responsibility**:

- E02 writes `dispatch_tokens = N` (the per-second budget).
- E04 DECRs at up to `campaigns.calls_per_second` per second (default 5 CPS).
- Multi-pod DECRs aggregate naturally via Valkey atomicity — no in-process
  coordination required.

E02 is unaware of the token-bucket implementation. E02's only output is the
`dispatch_tokens` value.

### 3.3 Event-driven sub-tick acceleration

Three events wake an out-of-band tick ahead of the 1-second timer:

| Event | Valkey signal | Debounce |
|---|---|---|
| Agent PAUSED→READY | `t:{tid}:broadcast:campaign:{cid}` pubsub `agent_state_changed{to=READY}` | 50 ms coalesce |
| CHANNEL_HANGUP → agent WRAPUP→READY | Same pubsub | 50 ms coalesce |
| `drop_gated` cleared by E05 | `t:{tid}:broadcast:campaign:{cid}` pubsub `drop_gate_cleared` | 50 ms coalesce |

The sub-tick is guarded by the same `SET NX EX 1` tick lock. If the lock is
already held (normal 1 Hz tick running), the sub-tick is a no-op. Failure to
fire is harmless — the next 1-Hz tick catches up within 1 s.

### 3.4 Tick deadline

Soft deadline: 200 ms wall-clock. If snapshot reads + computation + Valkey
writes exceed 200 ms, abort the tick (log + `vici2_dialer_pacing_tick_overrun_total`),
continue normal 1 Hz schedule. This protects against Valkey latency spikes
cascading into tick-skips.

### 3.5 Cadence parameters table

| Parameter | Default | Source | Range |
|---|---|---|---|
| Outer tick interval | 1000 ms | `campaigns.pacing_tick_ms` (F02 A2/E02.4) | 200–5000 |
| Tick lock TTL | 1000 ms | F04 PLAN §4.13 | Fixed = tick interval |
| Sub-tick debounce | 50 ms | Hardcoded | No |
| Tick deadline (soft) | 200 ms | Hardcoded | No |
| Snapshot cache staleness | 100 ms | RESP3 client-side cache (F04 §4) | No |

---

## 4. `dispatch_tokens` contract (FROZEN — synced with E04 PLAN §3)

### 4.1 Wire form

E02 writes once per tick per campaign:

```
SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2
```

- `<n>` = `desired_new_originates` after all 4 clamps (minimum 0).
- `EX 2` = 2-second TTL. If E02 is down or its tick takes > 2 s, the key
  expires and E04 sees nil → zero dispatches. This is the correct safety posture.
- The key is **overwritten** each tick (not accumulated). E04's DECR burns the
  budget; leftover tokens from a prior tick are superseded by the new `SET`.

### 4.2 E04 consumption (read-only from E02's perspective)

E04 consumes the token per dispatch:

```
// E04 dispatch loop (E04 PLAN §3.2)
n, err = DECR t:{tid}:campaign:{cid}:dispatch_tokens
if n < 0 {
    INCR t:{tid}:campaign:{cid}:dispatch_tokens   // over-decrement recovery
    return ErrNoTokens
}
// proceed with claim + T04.Originate
```

E02 never reads `dispatch_tokens` back. The value is owned by E02 on write and
owned by E04 on read/DECR. No other module may write to this key.

### 4.3 Clock-skew consideration

If E02's tick fires at T=0 (writes `n=5 EX 2`) and E04's process clock is 1 s
behind, E04's DECR at T=1.5 (wall) sees the key still present (TTL not yet
expired from E04's perspective). This is acceptable — the 2-s TTL was chosen to
outlast clock skew of < 1 s (NTP-synced pods ≤ 100 ms skew; E02 RESEARCH §8.2).

### 4.4 When E02 computes `desired = 0`

E02 still writes `SET ... 0 EX 2`. This is intentional — E04 sees 0 (not nil)
and DECRs to -1 on any dispatch attempt, correctly rejecting all dispatches.
Writing 0 (rather than deleting the key) preserves E04's ability to distinguish
"E02 is healthy but says no dispatches" from "E02 is dead". E04 handles both
the nil case (key expired) and the 0 case identically (no dispatch), but
`vici2_picker_no_tokens_total{reason}` metric labels them differently.

---

## 5. Input signals + sources (Valkey reads only)

All reads are from F04-owned keys. Zero MySQL reads on the hot path. Reads are
pipelined in a single Valkey round-trip per tick.

### 5.1 Agent state counts

| Signal | Key | Op | Staleness |
|---|---|---|---|
| READY agents (primary) | `t:{tid}:agents:by_campaign:{cid}:by_status:READY` | `ZCARD` | RESP3 client-cache, ≤ 100 ms |
| INCALL agents (RATIO mode only) | `t:{tid}:agents:by_campaign:{cid}:by_status:INCALL` | `ZCARD` | same |
| WRAPUP agents (RATIO mode only) | `t:{tid}:agents:by_campaign:{cid}:by_status:WRAPUP` | `ZCARD` | same |

Stale agent detection: F04 helper-lib compares last-change-at timestamp in
the ZSET score. If `now - score > 15 s`, the agent is treated as PAUSED for
this tick; `vici2_dialer_agent_state_stale_total{cid}` increments.

### 5.2 Active calls

```
SCARD t:{tid}:campaign:{cid}:active_calls
```

F04 PLAN §4.8. SET maintained by `record_call_outcome.v1.lua` — SADD on
CHANNEL_CREATE, SREM on CHANNEL_HANGUP_COMPLETE. Includes originated-but-
not-yet-answered calls so pacing doesn't re-dial during the 4-second ring window.

### 5.3 `dial_level`

```
GET t:{tid}:campaign:{cid}:dial_level  → "1.85"
```

Written by E03 every 15 s (E03 RESEARCH §1). RESP3 client-side cached (~100 ms
staleness). If missing (new campaign; E03 not yet started):

1. Fall back to `campaigns.auto_dial_level` from process-cache.
2. If that is 0.00: fall back to 1.0.
3. Log `vici2_dialer_dial_level_missing_total{cid}`.
4. If missing > 30 s: alert (O01 — E03 may be down).

Sanity check: if `GET` returns a value > `campaigns.adaptive_max_level`, clamp
to `adaptive_max_level` and increment `vici2_dialer_dial_level_out_of_range_total`.

### 5.4 Drop gate

```
EXISTS t:{tid}:campaign:{cid}:drop_gated  → 0 or 1
```

Written by E05 when 30-day rolling drop% ≥ hard cap. E02 reads once per tick.
RESP3 cached. The key's value (when present) is `"1"` but E02 only needs
existence (Boolean).

### 5.5 Carrier headroom

Per gateway in `campaigns.carriers` JSON (process-cached 60 s):

```
GET t:{tid}:gw:{gateway_id}:active  → "42"   (T02 Valkey counter)
```

Pipelined; 3-gateway campaign = 3 GETs in one round-trip. Headroom computed
in-process:

```go
gw_headroom = sum over pool of max(0, gw.MaxConcurrent - activeCount)
```

If a gateway GET returns nil (T02 not yet populated): assume 0 active (full
headroom for that gateway). Log `vici2_dialer_gw_active_missing_total{gwid}`.

### 5.6 Campaign config snapshot

Process-cached (60 s TTL) from MySQL `campaigns` row, refreshed immediately
on `t:{tid}:broadcast:campaign:{cid}:config_changed` pubsub. Hot-path reads:

```
dial_method, auto_dial_level, adaptive_max_level, available_only_tally,
calls_per_second, dial_timeout_sec, ramp_up_factor, min_call_buffer_seconds,
pacing_tick_ms, carriers (JSON array of gateway_ids)
```

### 5.7 Total read budget per tick

Nine pipelined Valkey ops in one round-trip (RESP3 PIPELINE):

| # | Op | p99 (network RTT 150 µs) |
|---|---|---|
| 1–3 | ZCARD ×3 (READY, INCALL, WRAPUP) | < 50 µs each |
| 4 | SCARD (active_calls) | < 50 µs |
| 5 | GET (dial_level) | < 50 µs |
| 6 | EXISTS (drop_gated) | < 50 µs |
| 7–9 | GET ×3 (gw_active per carrier) | < 50 µs each |

**Total round-trip: ≤ 300 µs.** The 1000 ms tick budget is spent ≤ 0.03% on
reads. The remaining budget accommodates the sub-tick event handler, the XADD
(audit stream), the SET (dispatch_tokens), and four SETEX (live gauges).

---

## 6. Output: Valkey keys + Stream events

### 6.1 `dispatch_tokens` STRING (primary output)

```
t:{tid}:campaign:{cid}:dispatch_tokens
```

STRING. Written `SET <n> EX 2` once per successful tick. Value is a non-negative
integer. E04 DECRs. See §4 for full contract.

### 6.2 `pacing_decisions` Stream (audit)

```
XADD t:{tid}:campaign:{cid}:pacing_decisions * \
    ts <unix_ms> \
    agents <int> \
    level <decimal> \
    active <int> \
    base <int> \
    gw_headroom <int> \
    ramp_max <int> \
    drop_gated <0|1> \
    desired <int> \
    clamps_fired <comma-list> \
    tick_duration_us <int> \
    lock_acquired <0|1>

MAXLEN ~ 86400 (24 h at 1 Hz; XTRIM nightly by F04 trim cron)
```

Storage: ~140 B/entry × 86400 × 50 campaigns ≈ 600 MB/day. Trimmed nightly
by the F04 existing `XTRIM MINID` cron job. This is the primary forensic source
for "why did we only originate 3 calls at 14:32:07?".

Note: stream entry is written even on lock-miss ticks (`lock_acquired=0`) to
show the pod saw the tick but deferred to the winner. Helps debug skewed
distributions.

### 6.3 Live-gauge STRINGs (overwritten each tick, no TTL)

```
t:{tid}:campaign:{cid}:pacing_desired_last_tick     # int
t:{tid}:campaign:{cid}:pacing_agents_last_tick      # int
t:{tid}:campaign:{cid}:pacing_active_last_tick      # int
t:{tid}:campaign:{cid}:pacing_clamp_fired           # comma-list, e.g. "gw,drop"
```

E03 reads `pacing_desired_last_tick` and `pacing_clamp_fired` as advisory inputs
to its 15-s adaptive tick (e.g., persistent `gw` clamp signals carrier saturation,
which is independent of drop% — E03 should not chase `dial_level` up if the true
bottleneck is the carrier, not drop rate). S01 wallboard reads all four for the
live campaign display. Written via PIPELINE along with `dispatch_tokens`.

### 6.4 What E02 does NOT publish

- **List of leadIDs dispatched.** Those are in `originate_audit` (T04 owns).
- **FS host or carrier selected.** T04 decides (T04 PLAN §6); E02 is FS-agnostic.
- **Claim outcome details.** E04 owns those (E04 PLAN §7).

---

## 7. Mode dispatch (5-line switch)

```go
func resolveLevel(snap Snapshot) float64 {
    switch snap.DialMethod {
    case MANUAL:
        return 0   // tick returns 0 immediately; switch is never reached
    case PROGRESSIVE:
        return 1.0  // constant; agent count = READY-only regardless of tally flag
    case RATIO:
        return snap.Config.AutoDialLevel  // static operator-set value
    default:  // ADAPT_HARD, ADAPT_AVG, ADAPT_TAPERED
        return snap.DialLevel  // E03 writes this; E02 only reads
    }
}
```

The three ADAPT subtypes are **indistinguishable to E02**. E03 owns their
differentiated math; E02 honors whatever decimal E03 writes to `dial_level`.
This separation provides:

1. **Testability**: E02 unit tests stub `dial_level` to a fixed decimal; no E03 mock.
2. **A/B ability**: flipping `ADAPT_TAPERED` → `ADAPT_AVG` is a campaign-table
   row update with zero E02 code change.
3. **Extensibility**: a future ML dial-level writer (Phase 4) just writes the
   `dial_level` STRING; E02 honors it unchanged.

### 7.1 PROGRESSIVE vs RATIO=1.0 distinction

Both modes produce `level=1.0` but differ in `agents` count:

- **PROGRESSIVE**: `agents = ZCARD(READY)`. Hard 1:1. If 5 READY + 3 INCALL →
  `desired = 5 - active`. Never overdials.
- **RATIO=1.0**: `agents = ZCARD(READY) + ZCARD(INCALL) + ZCARD(WRAPUP)` (when
  `available_only_tally=false`). If 5 READY + 3 INCALL → `desired = 8 - active`.
  Overdials onto INCALL agents (who will be free by ring-time).

Phase 2 ship recommendation: PROGRESSIVE for < 10 agent campaigns; RATIO=1.5 as
next step; ADAPT_TAPERED as the production default for 10+ agents (DESIGN.md line
870: "predictive only behind campaign-level toggle with mandatory drop% target ≤ 2%").

---

## 8. Cold-start and warmup

### 8.1 Problem statement

When a campaign first starts (or E02 restarts after a crash), several inputs
are absent or unreliable:

- `dial_level` STRING: not yet written by E03.
- `active_calls` SET: may be stale if E06 janitor hasn't swept yet.
- `drop_gated`: absent (E05 hasn't processed any calls yet).

### 8.2 Cold-start resolution per input

| Input | Cold-start default | Staleness handling |
|---|---|---|
| `dial_level` | `campaigns.auto_dial_level`; if 0 → 1.0 | Alert if missing > 30 s (O01) |
| `active_calls` | 0 (no SET = no active calls) | Correct — E06 sweeps orphaned calls on startup |
| `drop_gated` | absent → false (not gated) | Correct — new campaign has no drop history |
| `gw_active` | nil → 0 (full headroom) | Logged; T04's gate is the authoritative final check |
| Agent ZSETs | empty → `agents=0` → `desired=0` | No originates until agents log in; correct |

### 8.3 E03 owns the level; E02 reads it

E02 does not initialize or write `dial_level`. E03 is responsible for publishing
the initial `dial_level = campaigns.auto_dial_level` (clamped to [1.0, max]) when
a campaign starts. E02 RESEARCH §11 Q8 resolution: if `dial_level` is absent,
E02 falls back to `campaigns.auto_dial_level` from process-cache (not from
Valkey), so E02 can start pacing immediately without waiting for E03's first
15-second tick.

### 8.4 Warmup-rate protection

The `ramp_up_rate_clamp` (§2.6) naturally handles cold-start ramp:
- Tick 1: `agents` jumps from 0 → N; `ramp_max = ceil(level) × ramp_up_factor`.
  At most 4 originates issue (for `level=1.5`, `factor=2`).
- Tick 2–4: `active_calls` catches up; ramp_max no longer binding.
- Tick 5+: steady state.

No separate "warmup mode" needed in E02 — the ramp_up_rate_clamp is the warmup.

---

## 9. Tick rendezvous mechanism

### 9.1 Per-campaign `SET NX EX 1` race (F04 confirmed pattern)

F04 PLAN §4.13 explicitly specifies this contract. E02 implements it unchanged:

```go
func (p *Pacer) acquireTick(ctx context.Context) (bool, error) {
    ok, err := p.valkey.SetNX(ctx,
        fmt.Sprintf("t:%d:dialer:tick:%d", p.tenantID, p.campaignID),
        p.podID,
        1*time.Second,
    )
    return ok, err
}
```

- `EX 1` = tick interval (1 s default). Auto-expires before the next tick.
- Returns `true` → this pod is the leader for this campaign-second.
- Returns `false` → another pod holds the lock; increment
  `vici2_dialer_pacing_tick_skipped_total{reason=lock_contention}` and return.

No manual unlock. Explicit unlock is risky: if our tick runs > 1 s (deadline
breach), we might unlock a sibling pod's lock. TTL expiry is the only release.

### 9.2 Properties

- **Leader is per-campaign-second, not per-campaign.** Two pods can lead
  alternating ticks; no sticky leader; no Raft required.
- **Pod death is harmless.** Lock expires in ≤ 1 s; sibling takes the next tick.
- **Two pods can write `dispatch_tokens` in the same second** only if one of them
  wins the lock after the other's TTL expires mid-second. Since TTL = tick
  interval, this race window is < 1 ms. E04's DECR is atomic regardless.
- **Clock skew tolerance.** Pod A's clock 500 ms ahead → A tends to win locks
  more often. Not a correctness problem — just a fairness skew. Alert on
  `clock_skew_seconds > 0.1` (NTP monitoring; O01).

### 9.3 Tick lock TTL when tick interval is per-campaign

`campaigns.pacing_tick_ms` is per-campaign. The lock TTL is set to the campaign's
configured interval, not a hardcoded 1 s:

```go
lockTTL := time.Duration(p.config.PacingTickMs) * time.Millisecond
p.valkey.SetNX(ctx, lockKey, p.podID, lockTTL)
```

The 200 ms tick deadline (§3.4) ensures the tick completes well before TTL expiry
at the default 1000 ms setting.

---

## 10. Failure modes

Complete 16-row matrix. Every failure increments one counter-metric and writes
one structured log line with `{tenant_id, campaign_id, reason, ts}`.

| # | Failure | Detection | E02 action | Metric | Sev |
|---|---|---|---|---|---|
| 1 | Tick-lock contention (sibling pod won) | `SetNX` returns false | No-op; return | `tick_skipped_total{reason=lock_contention}` | Info — expected |
| 2 | MANUAL mode campaign | `dial_method == MANUAL` | Return `desired=0`; skip write | `tick_skipped_total{reason=manual_mode}` | Info |
| 3 | Campaign inactive / deleted | Config load returns `nil` | Return; supervisor kills goroutine | `tick_skipped_total{reason=campaign_inactive}` | Info |
| 4 | Valkey down | F04 client error on any read | Sleep with exp-backoff (1 s → 30 s max); do not write `dispatch_tokens` | `valkey_unavailable_seconds_total` | Page if > 30 s |
| 5 | Stale agent state (ZSET score > 15 s old) | F04 helper `last_change_at` check | Treat agent as PAUSED for this tick; reduce `agents` count | `agent_state_stale_total{cid, user_id}` | Warn |
| 6 | `dial_level` STRING missing | GET returns nil | Fall back to `campaigns.auto_dial_level`; log | `dial_level_missing_total{cid}` | Warn |
| 7 | `dial_level` out of range (E03 bug) | Value > `adaptive_max_level` | Clamp to `adaptive_max_level`; log | `dial_level_out_of_range_total{cid}` | Warn |
| 8 | `gw_active` GET returns nil | T02 not yet populated | Assume 0 active (full headroom); log | `gw_active_missing_total{gw_id}` | Info |
| 9 | All clamps fire simultaneously | Min-of-clamps = 0 | Write `dispatch_tokens = 0 EX 2`; log clamps_fired | Normal metric path | Info |
| 10 | `drop_gated` turns on mid-tick | EXISTS returns 1 | Clamp #3 fires; `desired = min(desired, 1)` | `drop_gated_seconds_total` increments | Warn |
| 11 | Tick exceeds 200 ms deadline | Wall-clock timer | Abort tick; log warn; continue schedule | `tick_overrun_total{cid}` | Warn if persistent |
| 12 | Clock skew > 100 ms between pods | External NTP monitoring | Alert; pacing degrades (one pod wins all locks) but is not corrupted | `clock_skew_seconds` (O01) | Warn |
| 13 | `campaigns.calls_per_second = 0` (admin error) | Config-load validation | Default to 1 CPS; surface admin warning | `config_invalid_total{field=calls_per_second}` | Warn |
| 14 | Per-campaign goroutine panic | `defer recover()` | Sentry capture; supervisor respawns after 5 s backoff | `pacing_goroutine_panic_total{cid}` | Page if recurring |
| 15 | Campaign deleted mid-tick | Config load returns nil after lock acquired | Release lock; supervisor reaps goroutine | `tick_skipped_total{reason=campaign_deleted}` | Info |
| 16 | E02 process crash mid-tick (lock held, tokens not yet written) | Lock auto-expires in ≤ 1 s | Sibling pod acquires lock on next tick; `dispatch_tokens` TTL also expires → E04 sees nil → no dispatches | `valkey_unavailable_seconds_total` (if crash is Valkey-induced) | Info — self-healing |

---

## 11. Schema additions to `campaigns`

Four columns are missing from the current F02 schema (checked against `api/prisma/schema.prisma`
2026-05-13). Filed as **F02 Amendment A2/E02** (additive; no RFC per SPEC §12 — no existing
column removed or renamed).

### 11.1 Amendment A2/E02 — four new columns

| Column | Type | Default | Constraint | Purpose |
|---|---|---|---|---|
| `calls_per_second` | `SMALLINT UNSIGNED NOT NULL DEFAULT 5` | 5 | `>= 1` | Token-bucket CPS ceiling for E04 dispatch; informational for E02 (E02 passes this to E04 via `dispatch_tokens` budget sizing) |
| `ramp_up_factor` | `DECIMAL(4,2) NOT NULL DEFAULT 2.00` | 2.00 | `>= 1.00` | Multiplier for ramp_up_rate_clamp (§2.6) |
| `min_call_buffer_seconds` | `DECIMAL(4,2) NOT NULL DEFAULT 2.00` | 2.00 | `>= 0.50` | Clamp 1 buffer (§2.3); matches FCC 2-s safe-harbor |
| `pacing_tick_ms` | `SMALLINT UNSIGNED NOT NULL DEFAULT 1000` | 1000 | `>= 200 AND <= 5000` | Per-campaign tick interval |

Migration: one Prisma migration file `20260513_f02_a2_e02_pacing_columns.sql`.
Additive; safe for zero-downtime deploy on Phase 1 schema.

### 11.2 Columns already present (no amendment needed)

- `auto_dial_level DECIMAL(4,2)` — used as level for RATIO mode and as cold-start
  default for ADAPT_* when `dial_level` STRING is absent.
- `adaptive_max_level DECIMAL(4,2)` — sanity-clamp ceiling for `dial_level`.
- `adaptive_drop_pct DECIMAL(4,2)` — read by E05, not E02 directly.
- `available_only_tally BOOLEAN` — governs RATIO mode agent count (§2.2).
- `dial_method DialMethod` — 5-line mode dispatch (§7).
- `dial_timeout_sec SMALLINT` — passed to T04, not used by E02 pacing math.
- `safe_harbor_audio VARCHAR(255)` — T04 pre-check; not E02's concern.

---

## 12. Go package layout

All E02 code lives under `dialer/internal/pacing/`. The `dialer/cmd/dialer/main.go`
(already exists per SPEC.md §2) hooks the E02 supervisor on startup.

```
dialer/internal/pacing/
  supervisor.go         # PacingManager: starts/stops per-campaign goroutines
                        #   on campaign CRUD events (pubsub + startup scan)
                        #   respawns panicking goroutines (5 s backoff)
  pacer.go              # Pacer struct: per-campaign goroutine
                        #   time.NewTicker + select{tickerChan, eventChan, ctx.Done}
                        #   acquire tick lock → snapshot → decide → publish
  decision.go           # Decider.Decide(Snapshot) int — pure function, zero I/O
                        #   implements §2.7 composite formula
                        #   testable without Valkey
  snapshot.go           # SnapshotReader.Read(ctx, cid) Snapshot
                        #   builds the 9-op Valkey PIPELINE; assembles Snapshot struct
  config.go             # CampaignConfig struct (process-cached from MySQL + hot-reload)
                        #   Subscribe()  listens to campaign_config_changed pubsub
  publish.go            # Publisher.Publish(ctx, cid, desired, snap, meta)
                        #   SET dispatch_tokens EX 2
                        #   XADD pacing_decisions
                        #   SETEX ×4 live-gauge STRINGs
  metrics.go            # All Prometheus counters/gauges/histograms (§14)
  modes.go              # resolveLevel(Snapshot) float64
                        #   resolveAgents(Snapshot) int
  types.go              # Snapshot struct, CampaignConfig struct, DialMethod enum

  decision_test.go      # Table-driven unit tests for Decide(); no Valkey mock needed
                        #   5 worked-example scenarios (§13.1) + 4 boundary cases per clamp
  snapshot_test.go      # SnapshotReader with testcontainers Valkey; seeds fixture state
  pacer_test.go         # Per-tick integration: mock config, real Valkey (testcontainers)
  supervisor_test.go    # Start/stop lifecycle; panic-respawn; config hot-reload
  publish_test.go       # Publisher: asserts dispatch_tokens key value + TTL + stream entry
  modes_test.go         # resolveLevel + resolveAgents coverage across all 5 modes + tally
  integration_test.go   # End-to-end: 4 campaigns × 3 pods, tick-lock fairness, 16 failure modes
```

Estimated LOC: ~700 production + ~900 test. Total ~1600 LOC.

No gRPC service exposed by E02 — pacing is in-process within the dialer binary.
E04 (also in-process) reads `dispatch_tokens` via Valkey; no direct Go function
call between E02 and E04.

---

## 13. Public API (in-process; no gRPC for hot path)

E02 exposes a minimal Go API to `main.go` only:

```go
package pacing

// NewManager creates the PacingManager. Call Start() to begin ticking.
func NewManager(cfg ManagerConfig) *Manager

type ManagerConfig struct {
    Valkey      *valkey.Client        // F04 helper client
    DB          *sql.DB               // MySQL for campaign config (cached)
    Prometheus  *prometheus.Registry
    PodID       string                // unique per pod (e.g., hostname)
}

type Manager struct {
    // opaque
}

// Start subscribes to campaign events, runs a startup scan of active campaigns,
// and begins per-campaign tick goroutines. Blocks until ctx is cancelled.
func (m *Manager) Start(ctx context.Context) error

// Stop drains all per-campaign goroutines gracefully (max 5 s).
func (m *Manager) Stop(ctx context.Context) error

// ActiveCampaignCount returns the number of running Pacer goroutines.
// Used by health check and tests.
func (m *Manager) ActiveCampaignCount() int
```

No other exported types. `Decider`, `SnapshotReader`, and `Publisher` are
package-internal — called only by `Pacer.tick()`. This keeps the E02 surface
minimal and prevents E04 from accidentally calling into E02's internals.

---

## 14. Metrics

### 14.1 Prometheus metric registry

All metrics use the `vici2_dialer_pacing_` prefix and carry `{tenant, campaign}`
labels as the base label set. Additional labels per metric:

| Metric | Type | Additional labels | Purpose |
|---|---|---|---|
| `vici2_dialer_pacing_tick_total` | Counter | — | Total ticks attempted (all outcomes) |
| `vici2_dialer_pacing_tick_skipped_total` | Counter | `reason` = `lock_contention \| manual_mode \| campaign_inactive \| valkey_down \| campaign_deleted` | Understand why ticks are no-ops |
| `vici2_dialer_pacing_tick_duration_seconds` | Histogram | — | Buckets: 0.0001, 0.001, 0.01, 0.1, 0.2, 1.0. SLO: p99 < 200 ms |
| `vici2_dialer_pacing_tick_overrun_total` | Counter | — | Ticks that exceeded 200 ms deadline |
| `vici2_dialer_pacing_desired` | Gauge | — | Last tick's `desired` value (after all clamps) |
| `vici2_dialer_pacing_agents` | Gauge | `status` = `READY \| INCALL \| WRAPUP` | Last tick's agent count per status |
| `vici2_dialer_pacing_active_calls` | Gauge | — | Last tick's SCARD of active_calls |
| `vici2_dialer_pacing_dial_level` | Gauge | — | Last tick's resolved `dial_level` value |
| `vici2_dialer_pacing_clamp_total` | Counter | `clamp` = `buffer \| gw \| drop \| ramp` | Per-clamp fire count (all firing clamps counted, not just binding) |
| `vici2_dialer_pacing_drop_gated_seconds_total` | Counter | — | Cumulative seconds campaign was drop-gated |
| `vici2_dialer_pacing_carrier_saturated_seconds_total` | Counter | — | Cumulative seconds gw_headroom = 0 |
| `vici2_dialer_pacing_dispatch_tokens_written_total` | Counter | — | Successful `SET dispatch_tokens` writes |
| `vici2_dialer_pacing_dispatch_tokens_value` | Gauge | — | Last written `desired` value (same as `pacing_desired` for correlation) |
| `vici2_dialer_pacing_goroutine_panic_total` | Counter | — | Per-campaign goroutine panics |
| `vici2_dialer_agent_state_stale_total` | Counter | — | Agent state observations > 15 s old |
| `vici2_dialer_dial_level_missing_total` | Counter | — | Ticks where `dial_level` STRING absent |
| `vici2_dialer_dial_level_out_of_range_total` | Counter | — | Ticks where `dial_level` > `adaptive_max_level` |
| `vici2_dialer_gw_active_missing_total` | Counter | `gateway_id` | Ticks where gw_active GET returned nil |
| `vici2_dialer_config_invalid_total` | Counter | `field` | Config validation failures at process-cache refresh |
| `vici2_dialer_clock_skew_seconds` | Gauge | — | Clock skew estimate (via tick-lock winner pod distribution) |

### 14.2 Alert recipes for O01

| Alert | Condition | Severity |
|---|---|---|
| Valkey unhealthy | `tick_skipped_total{reason=valkey_down}` rate > 0 / 30 s | PAGE |
| CPS overrun | `dispatch_tokens_value` > `campaigns.calls_per_second × 1.2` for 1 min | WARN |
| Carrier saturated | `carrier_saturated_seconds_total` rate > 30 / 5 min | WARN → ops ticket |
| Drop gate persistent | `drop_gated_seconds_total` rate > 60 / 10 min | PAGE |
| Buffer clamp active | `clamp_total{clamp=buffer}` rate > 0 for > 5 min | PAGE (E03 mis-tuned) |
| Goroutine panic recur | `goroutine_panic_total` > 3 in 5 min for same `{campaign}` | PAGE |
| Tick p99 overrun | `tick_duration_seconds` p99 > 200 ms over 2 min | WARN |
| E03 missing | `dial_level_missing_total` rate > 0 for > 30 s | WARN |

---

## 15. Files to create

```
# New files (all in dialer/internal/pacing/)
dialer/internal/pacing/supervisor.go
dialer/internal/pacing/pacer.go
dialer/internal/pacing/decision.go
dialer/internal/pacing/snapshot.go
dialer/internal/pacing/config.go
dialer/internal/pacing/publish.go
dialer/internal/pacing/metrics.go
dialer/internal/pacing/modes.go
dialer/internal/pacing/types.go
dialer/internal/pacing/decision_test.go
dialer/internal/pacing/snapshot_test.go
dialer/internal/pacing/pacer_test.go
dialer/internal/pacing/supervisor_test.go
dialer/internal/pacing/publish_test.go
dialer/internal/pacing/modes_test.go
dialer/internal/pacing/integration_test.go

# Modified files
dialer/cmd/dialer/main.go          # Hook pacing.NewManager().Start(ctx)
api/prisma/schema.prisma           # F02 Amendment A2/E02: 4 new columns
api/prisma/migrations/
  20260513_f02_a2_e02_pacing_columns/
    migration.sql                  # ADD COLUMN ×4 on campaigns table
    down.sql                       # DROP COLUMN ×4 (dev/test rollback only)
```

No new Lua scripts. E02 makes no direct Lua calls — all Valkey ops are standard
commands (SET NX EX, pipelined GETs/ZCARDs/SCARD, XADD, SETEX). The existing
F04 Lua scripts are called only by E01 (claim/release) and T01 (record_call_outcome),
not by E02.

---

## 16. Test plan

### 16.1 Unit tests — `decision_test.go` + `modes_test.go`

Table-driven, zero I/O. Tests call `Decider.Decide(snap)` and assert `desired`.

**Worked-example scenarios (from E02 RESEARCH §13):**

| Test | Input | Expected `desired` | Clamp asserted |
|---|---|---|---|
| A — RATIO=1.5, 6 ready, 0 active | agents=6, level=1.5, active=0, gw=50, gated=false | 9 | none |
| B — ADAPT, 10 ready, 6 active, level=1.85 | agents=10, level=1.85, active=6, gw=50 | 13 | none |
| C — Drop-gated mid-campaign | agents=8, level=1.85, active=5, gated=true | 1 | drop |
| D — Carrier saturated | agents=12, level=1.5, active=8, gw=2 | 2 | gw |
| E — Wake-up storm | agents→30 (was 0), level=1.5, active=0, ramp_factor=2 | 4 | ramp |

**Boundary cases per clamp (4 × 3 = 12 tests):**

- Each clamp: just-below-threshold (no fire), exactly-at-threshold (fires), above-threshold (fires+clamp).

**Mode dispatch tests (5 modes × 2 tally values = 10 tests):**
- MANUAL → always 0.
- PROGRESSIVE → level=1.0, agents=READY only, regardless of tally flag.
- RATIO + tally=false → agents=READY+INCALL+WRAPUP.
- RATIO + tally=true → agents=READY only.
- ADAPT_HARD/AVG/TAPERED → reads `snap.DialLevel` regardless of tally.

**Formula edge cases (6 tests):**
- `round()` half-integer: `agents=3, level=1.5 → round(4.5) = 5` (not 4).
- `desired < 0` before `max(0, ...)`: negative base → 0 output.
- `dial_level = 0` cold-start → fallback to 1.0 → valid output.
- All clamps fire simultaneously → `desired = 0`.
- Multiple clamps fire: all are counted in `clamps_fired`, `desired = min-of-all`.
- `agents=0` → `desired=0` always (no divide-by-zero in buffer clamp).

### 16.2 Integration tests — `snapshot_test.go`, `publish_test.go`

Use `testcontainers-go` with a real Valkey 8 container.

**Snapshot tests (7 scenarios):**
- All keys populated → correct Snapshot struct fields.
- `dial_level` absent → falls back to `auto_dial_level`.
- `gw_active` absent → full headroom.
- `drop_gated` present → `DropGated=true`.
- Stale ZSET score → agent excluded from count.
- Partial pipeline failure (one GET timeout) → error surfaced, tick aborts.
- RESP3 client-cache invalidation → updated value visible within 100 ms.

**Publish tests (5 scenarios):**
- `desired > 0` → `dispatch_tokens` STRING exists with correct value + TTL ≈ 2 s.
- `desired = 0` → `dispatch_tokens` exists with value `"0"` (not deleted).
- Stream entry has all required fields.
- Live-gauge STRINGs overwritten on successive ticks.
- `lock_acquired=0` entry still written to stream (lock-miss tick).

### 16.3 Pacer + supervisor tests — `pacer_test.go`, `supervisor_test.go`

**Per-tick integration (6 scenarios):**
- Normal tick: lock acquired → snapshot → decide → publish → lock auto-expires.
- Lock miss: sibling holds lock → no-op → metric fired.
- Tick deadline exceeded: abort after 200 ms → `tick_overrun_total` fired.
- Campaign config hot-reload: pubsub triggers config refresh; next tick uses new value.
- Event-driven sub-tick: simulate `agent_state_changed{to=READY}` pubsub → debounced tick fires within 100 ms.
- Valkey down: pacer sleeps with backoff; resumes when Valkey recovers.

**Supervisor lifecycle (4 scenarios):**
- Campaign created event → goroutine spawned → tick begins.
- Campaign stopped event → goroutine drains → terminates.
- MANUAL campaign → goroutine spawned but ticks return 0 immediately.
- Goroutine panic → `recover()` fires → Sentry capture → supervisor respawns after 5 s.

### 16.4 Failure-mode matrix tests — `integration_test.go`

One test per row in the §10 failure-mode table (16 tests). Each test:
1. Seeds the failure condition in the testcontainers environment.
2. Runs E02 tick.
3. Asserts the correct metric incremented.
4. Asserts no panic and no `dispatch_tokens` written in failure cases 4–16.

### 16.5 Multi-pod tick-lock contention — `integration_test.go`

Three contention scenarios:

| Scenario | Setup | Assert |
|---|---|---|
| Two pods, same campaign | 2 Pacer goroutines share 1 Valkey | Each second, exactly one writes `dispatch_tokens`; `lock_contention` metric = 1 per second |
| Three pods, one campaign | 3 goroutines | At most 1 write per second; aggregate `lock_contention` = 2 per second |
| Leader pod dies mid-tick | Kill winning goroutine's context | Surviving pod acquires next-second lock; no gap > 2 ticks |

### 16.6 Simulation: 100 agents × 4 campaigns × 5 modes

A single integration test seeds:
- 4 campaigns: 1 PROGRESSIVE, 1 RATIO=1.5, 1 ADAPT_HARD, 1 ADAPT_TAPERED.
- 100 agents: 25 per campaign, cycling through PAUSED→READY→INCALL→WRAPUP.
- Simulated AHT: 15 s (mock T04 returns BRIDGED after 15-second delay in goroutine).
- E02 runs for 60 simulated seconds (time-accelerated with `clockwork` mock).

Assertions:
- PROGRESSIVE campaign: `desired` never exceeds READY agent count.
- RATIO=1.5 campaign: `desired = round(agents × 1.5) - active` at steady state.
- Drop-gate injection (E05 mock sets `drop_gated=1`): all ADAPT_* campaigns clamp to 1 within 1 tick.
- Ramp-up: 25 agents transition PAUSED→READY simultaneously; `desired` ≤ 4 for ticks 1–3.
- No `dispatch_tokens` written > `campaigns.calls_per_second`.

---

## 17. Acceptance criteria

All of the following must pass before E02 is marked DONE:

### 17.1 Functional

- [ ] `Decider.Decide()` produces correct `desired` for all 5 modes across the 5 worked examples (§16.1).
- [ ] All 4 clamps fire correctly at boundary conditions; per-clamp `clamp_total` metrics increment.
- [ ] `dispatch_tokens` is written with value `n` and TTL ≈ 2 s on every successful tick.
- [ ] `dispatch_tokens = 0` is written (not deleted) when `desired = 0`.
- [ ] `pacing_decisions` stream contains all required fields on every tick.
- [ ] Four live-gauge STRINGs are overwritten on every tick.
- [ ] MANUAL mode: `dispatch_tokens` is never written (or is written as 0); E04 issues no dispatches.

### 17.2 Multi-pod

- [ ] With 3 pods competing: exactly 1 `dispatch_tokens` write per campaign-second (within 5% tolerance over 60 s).
- [ ] Pod death: surviving pod resumes within 2 ticks (2 s); no tick gap > 2 s.
- [ ] Clock skew 100 ms: all pods still produce at most 1 write per campaign-second.

### 17.3 Failure modes

- [ ] Valkey down: no `dispatch_tokens` write; `valkey_unavailable_seconds_total` increments; pacer resumes on recovery.
- [ ] Goroutine panic: `recover()` fires; supervisor respawns within 5 s; `goroutine_panic_total` increments.
- [ ] `dial_level` absent: falls back to `auto_dial_level`; `dial_level_missing_total` increments.
- [ ] `dial_level` out of range: clamped; `dial_level_out_of_range_total` increments.

### 17.4 Performance

- [ ] Tick p99 duration < 50 ms on a localhost Valkey (testcontainers). Baseline budget: 300 µs reads + < 1 ms compute + < 1 ms Valkey write = < 10 ms realistic; 50 ms is the fail-safe.
- [ ] 100 campaigns × 1 Hz tick: total Valkey ops ≤ 950/s (100 × 9 read + 1 write = 1000, minus ~5% lock misses).
- [ ] CPU consumption for 100-campaign tick loop: < 10% of one core.

### 17.5 Schema

- [ ] F02 Amendment A2/E02 migration applies cleanly on the Phase-1 schema snapshot.
- [ ] `campaigns.calls_per_second >= 1` constraint enforced by MySQL (CHECK constraint in migration).
- [ ] `campaigns.pacing_tick_ms BETWEEN 200 AND 5000` constraint enforced.

### 17.6 Observability

- [ ] All 20 metrics in §14.1 are registered and visible at `:9090/metrics` after startup.
- [ ] All 8 alert recipes in §14.2 are wired in O01 (alert config PR, not E02's code, but must be referenced in HANDOFF).

---

## 18. Dependencies + risks

### 18.1 Hard dependencies (must land before E02 IMPLEMENT starts)

| Dep | Status | What E02 needs |
|---|---|---|
| E01 PLAN | Landed | `Consumer.Claim` / `Consumer.Release` Go API frozen — **but E02 no longer calls them** (E04 does). E02 only needs the `refill_request` pubsub key name from E01 PLAN §1.3. |
| F04 HANDOFF | Landed | Valkey key schema + Lua scripts frozen. All 9 snapshot read ops resolved. |
| E04 PLAN §3 | PROPOSED | `dispatch_tokens` STRING contract frozen — ratified in this PLAN §4. E04 IMPLEMENT can proceed in parallel once both PLANs are approved. |
| T04 PLAN | PROPOSED | `OriginateRequest` shape — not needed by E02 (E04 calls T04; E02 does not). E02 is unblocked. |
| F02 Amendment A2/E02 | This PLAN files it | 4 new columns needed before E02 IMPLEMENT uses them. |

### 18.2 Soft dependencies (can proceed in parallel)

| Dep | Risk if not landed | Mitigation |
|---|---|---|
| E03 PLAN | E02 reads `dial_level` STRING; safe fallback to `auto_dial_level` | Phase 2 can ship E02 with E03 stubbed at `dial_level = auto_dial_level` |
| E05 PLAN | E02 reads `drop_gated`; key absent → not gated | Phase 2 can ship with `drop_gated` absent (no gating); E05 wires it later |
| O01 metric wiring | Alert recipes in §14.2 not active | E02 emits metrics regardless; alerts can be wired post-E02-launch |

### 18.3 Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Vicidial formula `round()` vs `int()` divergence | Medium | Low — next adaptive tick corrects | Document as deliberate departure in HANDOFF; unit-test both behaviours |
| ramp_up_rate_clamp too conservative (idle agents at shift-start) | Medium | Medium — agent-occupancy metric shows idle | Tune `ramp_up_factor` per campaign; default 2.0 validated in §16.6 scenario |
| E04's DECR racing E02's SET (2-s TTL window) | Low | Low — `DECR` on expired key returns nil (E04 gets ErrNoTokens) | Tested in integration_test.go multi-pod scenarios |
| `pacing_decisions` stream growing unbounded if XTRIM cron fails | Low | Medium — Valkey memory growth | Alert on stream XLEN > 100000 per campaign (O01); F04 trim cron already exists |
| F02 Amendment A2/E02 merge conflict with other concurrent amendments | Low | Low — columns are additive | Coordinate with F02 IMPLEMENT agent; additive migrations are safe |
| Patent exposure (US8681955B1) | Low — prior art defense via Vicidial lineage | High — litigation | E02 RESEARCH §9.4 / E03 RESEARCH §9 analysis; code comments cite AST_VDauto_dial.pl explicitly; no derivative-term or speech-analytics feedback |
| Valkey client-side cache staleness > 100 ms during high-mutation periods | Low | Low — one extra stale tick | RESP3 BCAST invalidations fire on every agent ZSET mutation (F04 §4.6) |
| `ramp_up_factor` misconfigured to 0 by admin | Low | Low | Config-load validation clamps to 1; `config_invalid_total` alert |

### 18.4 Phase 3 upgrade path

The following are **not** in E02's Phase 2 scope but designed to be additive:

- **Erlang A pacing math** — replaces the Vicidial base formula in `decision.go`; pure function swap; no API change.
- **`adaptive_dl_diff_target` input** (Vicidial's waiting-call-minus-waiting-agent signal) — additional Valkey read in `snapshot.go`; zero API break.
- **ASM (Genesys-style pre-answer seizing)** — requires browser-side audio mute; Phase 3; E02 unaffected (mode dispatch change only).
- **Per-campaign `avg_wait_to_answer_ms` from EWMA** — replace Phase 2 stub (4000 ms) with a real read from E03's published `avg_wait_ms` STRING; one-line change in `snapshot.go`.
- **ML dial-level writer** — writes `dial_level` STRING; E02 consumes it unchanged.

---

## Appendix A: Open questions resolved from E02 RESEARCH §11

All 14 open questions from RESEARCH §11 are resolved by this PLAN:

| Q | Resolution | Where |
|---|---|---|
| Q1 — Tick rendezvous mechanism | Race-style `SET NX EX 1` per tick (F04 §4.13) | §9 |
| Q2 — Clamp ordering and all-clamp visibility | Report all firing clamps in metric; `desired` = min-of-all | §2.7, §14.1 |
| Q3 — Burst-spread mechanism | Token-bucket moved to E04; E02 only writes budget count | §3.2, §4 |
| Q4 — ramp_up_factor default | 2.0 (validated in §16.6 30-agent storm scenario) | §2.6 |
| Q5 — PROGRESSIVE + callback override | NO — callbacks ride on hopper score (E01); pacing respects 1.0 level | §2.1 |
| Q6 — Multi-FS dispatch | T04 picks FS host; E02 is FS-agnostic | §1.2, §12 |
| Q7 — Hot-config reload cadence | 15-s process-cache + pubsub for instant invalidation | §5.6, §8.3 of supervisor design |
| Q8 — `dial_level` stale handling | Fall back to `auto_dial_level`; if 0 → 1.0; alert if > 30 s absent | §5.3 |
| Q9 — min_call_buffer Phase 2 vs 3 | Phase 2: stub `avg_wait_to_answer_ms = 4000` ms | §2.3 |
| Q10 — Freq-cap INCR timing | Moved to E04 (on OutcomeBridged); not E02's responsibility | §1.2, E04 PLAN §2.2 |
| Q11 — Per-tick deadline | 200 ms soft cap; abort + log + metric on breach | §3.4 |
| Q12 — Tick lock TTL when tick > 1 s | No problem — lock auto-expires; next tick proceeds; deadline aborts long ticks | §9.2 |
| Q13 — Goroutine panic recovery | `defer recover()` + Sentry + supervisor respawn after 5 s | §10 row 14 |
| Q14 — Phase 2 mode subset | All 5 modes wired; ADAPT_* indistinguishable to E02; E03 owns their differentiation | §7 |

---

## Appendix B: Hand-off to downstream modules

| Module | What E02 hands off |
|---|---|
| **E04** | `dispatch_tokens` STRING (`SET t:{tid}:campaign:{cid}:dispatch_tokens <n> EX 2`) — FROZEN contract |
| **E03** | `pacing_desired_last_tick`, `pacing_agents_last_tick`, `pacing_active_last_tick`, `pacing_clamp_fired` STRINGs (advisory; E03 reads to inform dial-level decisions) |
| **E05** | Ratification of `drop_gated` contract: E02 reads `EXISTS t:{tid}:campaign:{cid}:drop_gated` each tick; clamps to `min(desired, 1)` when set; no other interaction with E05 |
| **S01** | `pacing_*_last_tick` STRINGs for wallboard live display |
| **O01** | All 20 metrics in §14.1; 8 alert recipes in §14.2 |
| **F02** | Amendment A2/E02: 4 new columns on `campaigns` table |
| **E01** | E02 publishes `t:{tid}:hopper:refill_request:{cid}` pubsub when E04 reports empty hopper — **but this publish is now in E04** (E04 owns the claim loop); E02 RESEARCH §3.7 publish is superseded by E04 PLAN §2 |
