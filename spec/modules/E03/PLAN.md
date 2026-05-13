# E03 — Adaptive Dial-Level Controller — PLAN

| Field | Value |
|---|---|
| **Module** | E03 — clamped PI adaptive dial-level controller |
| **Author** | E03-PLAN sub-agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator review |
| **Companion** | [RESEARCH.md](./RESEARCH.md) — 50 citations |
| **Module spec** | `spec/modules/E03.md` (superseded where this PLAN conflicts) |
| **Depends on (FROZEN upstream)** | E02 PLAN §1 (`dial_level` consumer contract — E02 reads the STRING E03 writes); F04 PLAN §4.4 (`dial_level` STRING; RESP3 client-side cached), §4.13 (`adapt:lock` key anticipated by F04); F04 HANDOFF §2 (Lua scripts — E03 does not call any directly; consumes client library); E05 RESEARCH §1 (`drop_pct_30d` gauge + `drop_gated` flag contract — E03 reads both); F02 PLAN §4 (existing `campaigns` columns: `auto_dial_level`, `adaptive_max_level`, `adaptive_drop_pct`, `dial_method`) |
| **Blocks** | E05 PLAN (must commit to publishing `drop_pct_30d` continuously, not just on `drop_gated` change); O01 (metrics wiring); M02 (admin UI exposes new columns + live dial_level readout); Implementation phase (cannot start without PLAN frozen) |

Once approved, the following are FROZEN: the `Decide()` pure function signature and module path (`dialer/internal/adapt/`), the `pace_state` HASH field names, the nine F02 amendment column names and types, all Prometheus metric names in §13, the `ResolveTarget()` tapered formula (with the corrected sign vs DESIGN.md §6.4), and the 15-s outer tick + 30-s fast-cut debounce cadence defaults. Test scenario names (S1–S8), go file names, and log sampling rates can change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **E03 is the thermostat, not the pacer.** E02 consumes `dial_level`; E03 is the only writer. E03 publishes one Valkey STRING per campaign every 15 seconds. ~400 LOC production + ~600 LOC tests + ~400 LOC simulator.

2. **Algorithm: clamped PI with deadband + asymmetric step sizes + back-calculation anti-windup.** ADAPT_HARD = pure-P (no integral). ADAPT_AVG + ADAPT_TAPERED = clamped PI, `Ki=0.005`, `Kp=0.05 pp⁻¹`, deadband ±0.3 pp, `I_MAX=0.5`, `K_back=0.01`. All modes quantize output to the nearest 0.05.

3. **Three modes share one code path.** `ResolveTarget()` returns the effective setpoint for the current mode and time; `HardLimit()` handles ADAPT_HARD; `AverageWithDeadband()` handles ADAPT_AVG and ADAPT_TAPERED. The mode switch is 5 lines.

4. **Tick cadence: 15-s outer loop + event-driven fast-cut (≤50 ms).** Fast-cut is decrease-only. 30-s debounce prevents `drop_gated` flapping from thrashing the controller. Outer tick is coordinated multi-pod via `SET NX EX 15` (F04 PLAN §4.13).

5. **Cold-start warm-up gate: 50 answered calls OR 5 minutes.** During warm-up, `dial_level` stays at `campaigns.auto_dial_level`; only the hard-cap fast-cut is live. After warm-up, full controller engages.

6. **Controller state persists in Valkey HASH `pace_state`.** Nine fields including `integral_term`, `warm_up_calls_remaining`, `last_action`. No new MySQL table. On full Valkey loss, cold-starts within 5 minutes.

7. **F02 amendment: 9 new columns on `campaigns`.** `adaptive_intensity`, `adaptive_dl_diff_target` (Phase 3 reserve), `adapt_tick_seconds`, `hold_band_pp`, `warmup_min_answered`, `warmup_min_seconds`, `drop_gated_debounce_sec`, `shift_start_local`, `shift_end_local`. Additive; single migration.

8. **E05 contract amendment (required).** E05 MUST publish `drop_pct_30d` STRING continuously every 15 s. E03 reads it regardless of `drop_gated` state. This is a blocking dependency for E05 PLAN.

9. **Patent defense is Vicidial prior-art lineage.** Code comments cite AST_VDadapt.pl explicitly. No speech analytics. No dynamic setpoint adjustment (we adjust the actuator, not the target). Legal review checkpoint required before Implementation phase ships.

10. **14 open questions from RESEARCH §12 are all resolved in this PLAN.** See §17 resolution table.

---

## 1. Goals + Non-Goals

### 1.1 Goals

- **Level computation**: every 15-s tick per active adaptive-mode campaign, compute `dial_level` using the pinned PI algorithm (§2).
- **Level publish**: write `t:{tid}:campaign:{cid}:dial_level` STRING (no TTL; persistent; RESP3 client-side cached by consumers).
- **Fast-cut**: on `drop_gated_changed` pubsub with `gated=true`, set `dial_level=1.0` within ~50 ms.
- **Warm-up gate**: inhibit controller on campaign cold-start; only engage after 50 answered calls OR 5 minutes (whichever comes first).
- **Controller state persistence**: read/write `pace_state` HASH in Valkey so crash + restart preserves integral term.
- **Multi-pod tick deduplication**: acquire `t:{tid}:adapt:lock:{cid}` via `SET NX EX 15` before each tick.
- **Observability**: write `t:{tid}:campaign:{cid}:adapt_decisions` STREAM (MAXLEN 5760); emit Prometheus metrics per §13.
- **Hot-config reload**: respond to `campaign_config_changed` pubsub within 1 tick; finish the in-flight tick with old config.
- **Supervisor lifecycle**: spawn per-campaign goroutines; reap on campaign-stop or `dial_method` change out of ADAPT_*; respawn on panic with 5-s backoff.

### 1.2 Non-Goals (explicit hand-offs)

| Concern | Owner |
|---|---|
| Per-tick pacing decision (`desired_new_originates`) | **E02** — reads `dial_level`; E03 never sees the per-second tick |
| 30-day rolling drop% computation | **E05** — E03 reads the published gauge |
| `drop_gated` boolean verdict | **E05** — E03 reads the flag, does not compute it |
| Lead claiming, originate dispatch | **E04** |
| Agent-state maintenance | **F04 Lua + A01** |
| `active_calls` SET maintenance | **T01 via record_call_outcome.v1.lua** |
| Safe-harbor audio playback | **E05** |
| `drop_window` STREAM writes | **T01 via F04 Lua** |
| Admin UI for new columns | **M02** |
| `adaptive_dl_diff_target` differential signal | **Phase 3** (column reserved; E03 ignores it in Phase 2) |
| ML / RL dial-level optimization | **Phase 4** (explicitly deferred; patent-risk note in §7) |
| Erlang-A patience-distribution modeling | **Phase 3** |

### 1.3 Module boundary diagram

```
E05 ──── writes ──── drop_pct_30d STRING ──────────┐
E05 ──── writes ──── drop_gated STRING ─────────────┤ E03 reads
E05 ──── publishes ─ drop_gated_changed pubsub ──── ┤ (fast-cut trigger)
                                                      │
E03 ──────────── writes ──── dial_level STRING ──── E02 reads (hot path)
                         └── dial_level STRING ──── E01 reads (hopper formula)
                         └── pace_state HASH ──────── internal only
                         └── adapt_decisions STREAM ── O01 / S01 reads
```

E03 is a pure consumer of E05's output and a pure producer of `dial_level`. No E03→E04 wire; no E03→E02 wire; no E03→T01 wire.

---

## 2. Algorithm Pinned: Clamped PI + Deadband + Asymmetric Step + Back-Calculation Anti-Windup

### 2.1 Plant model

| Symbol | Meaning |
|---|---|
| `u(t)` | `dial_level` — the actuator (continuous decimal, quantized to 0.05 grid) |
| `y(t)` | 30-day rolling abandonment % — the controlled variable (published by E05) |
| `r(t)` | `adaptive_drop_pct` — the setpoint (constant per campaign in HARD/AVG; time-varying in TAPERED) |
| `e(t)` | `r(t) − y(t)` — signed error (positive = under-dialing; negative = over-dialing) |

The plant is nonlinear, stochastic, time-varying, and has a ~30-day effective time constant (one dial-level step changes the 30-day average by `1/2880` per tick). Classic industrial PI controller is appropriate; D-term is rejected (cite RESEARCH §3.2 — D-term amplifies Poisson noise in drop-counting).

### 2.2 Gains and constants (FROZEN)

| Parameter | Value | Rationale |
|---|---|---|
| `step_up_base` | `0.05` | Vicidial parity (RESEARCH §2.2); minimum effective raise |
| `step_down_hard_base` | `0.20` | Vicidial parity (RESEARCH §2.2) |
| `step_down_soft_base` | `0.05` | symmetric soft lower; same resolution as raise |
| `Kp` | `0.05 / 1.0` (= `step_up_base` per 1 pp error) | 1 step-up for every 1 pp of under-dialing |
| `Ki` | `0.005` | ~66 ticks (16.5 min) of 1-pp error to saturate `I_MAX` |
| `I_MAX` | `0.5` | integral clamp; back-calculation keeps it honest |
| `K_back` | `0.01` (= `2 × Ki`) | MathWorks anti-windup heuristic (RESEARCH §5.3) |
| `hold_band_pp` | `0.30` pp (default; per-campaign via `campaigns.hold_band_pp`) | half the typical step contribution to drop%; eliminates quantization limit cycles |
| `integral_bleed_hold` | `0.95` per tick while in deadband | half-life ~22 ticks (5.5 min); prevents stale integral memory |
| `quantize_step` | `0.05` | snap output to nearest 0.05; applied before every write |
| `floor` | `1.0` (absolute; any `adaptive_max_level < 1.0` is clamped to 1.0 at config load) | |
| `ceil` | `campaigns.adaptive_max_level` (validated ≥ 1.0) | |

### 2.3 Intensity modifier (Vicidial-parity)

`campaigns.adaptive_intensity` ∈ `[−20, +20]` (TINYINT; default 0).

```
intensity_factor_raise  = 1.0 + intensity / 100.0   # > 1 when intensity > 0
intensity_factor_lower  = 1.0 - intensity / 100.0   # < 1 when intensity > 0 (slower drop)
```

Semantics (RESEARCH §2.1 cite [7]):
- `+10` → raises are 10% larger; soft drops are 10% smaller.
- `−10` → raises are 10% smaller; soft drops are 10% larger.
- ADAPT_HARD's hard-lower step uses `step_down_hard × intensity_factor_lower`.

| Action | Default step | Intensity = +10 | Intensity = -10 |
|---|---|---|---|
| raise | +0.05 | +0.055 | +0.045 |
| lower_soft | −0.05 | −0.045 | −0.055 |
| lower_hard | −0.20 | −0.18 | −0.22 |

### 2.4 Complete tick math (ADAPT_AVG / ADAPT_TAPERED)

```
target := ResolveTarget(mode, adaptiveDropPct, shiftStart, shiftEnd, now)
err    := target - dropPct30d

// 1. Deadband
if abs(err) <= hold_band_pp:
    newLevel    = currentLevel
    newIntegral = lastIntegral * 0.95   // bleed while holding
    action      = "hold"
    return

// 2. P + I terms
pTerm := Kp * err
if err > 0: pTerm *= intensity_factor_raise
else:       pTerm *= intensity_factor_lower

iTerm := lastIntegral + Ki * err * tickSeconds

// 3. Unclamped output
unclamped := currentLevel + pTerm + iTerm

// 4. Clamp + back-calculate anti-windup
newLevel      := clamp(unclamped, floor, ceil)
clampedDelta  := newLevel - unclamped          // 0 when not clamped
newIntegral   := iTerm + K_back * clampedDelta // bleeds integral

// 5. Quantize to 0.05 grid
newLevel = quantize(newLevel)
```

### 2.5 ADAPT_HARD tick math (pure-P; no integral)

```
target := adaptiveDropPct    // ResolveTarget returns it unchanged for HARD

if dropPct30d >= target:
    newLevel = max(floor, currentLevel - step_down_hard * intensity_factor_lower)
    newIntegral = 0
    action = "lower_hard"
else:
    newLevel = min(ceil, currentLevel + step_up * intensity_factor_raise)
    newIntegral = 0
    action = "raise"

newLevel = quantize(newLevel)
```

No deadband in HARD — operators chose HARD because they want zero tolerance above the setpoint.

### 2.6 Worked examples (FROZEN; used verbatim in unit tests)

**A — ADAPT_AVG, well below target, no integral buildup.**
```
target=1.5, drop=0.5, currentLevel=1.85, integral=0, intensity=0, max=3.0
err=1.0 → pTerm=0.05; iTerm=0+0.005×1.0×15=0.075
unclamped=1.975 → quantize → 2.00
Output: NewLevel=2.00, NewIntegral=0.075, Action=raise
```

**B — ADAPT_AVG, slightly above target — falls in deadband.**
```
target=1.5, drop=1.7, currentLevel=2.20, integral=0.05, intensity=0, max=3.0
err=-0.2 → abs(err)=0.2 ≤ 0.3 → HOLD
Output: NewLevel=2.20, NewIntegral=0.0475, Action=hold
```

**C — ADAPT_AVG, well above target, soft lower.**
```
target=1.5, drop=2.5, currentLevel=2.20, integral=0.05, intensity=0, max=3.0
err=-1.0 → abs(err)=1.0 > 0.3 → ACT
pTerm=0.05×-1.0=-0.05; iTerm=0.05+0.005×-1.0×15=-0.025
unclamped=2.125 → quantize → 2.15
Output: NewLevel=2.15, NewIntegral=-0.025, Action=lower_soft
```

**D — ADAPT_HARD, drop > target, intensity=+5.**
```
step_down_hard=0.20×(1-0.05)=0.19
Output: NewLevel=max(1.0,2.20-0.19)=2.01→2.00, NewIntegral=0, Action=lower_hard
```

**E — Anti-windup clamp at ceiling.**
```
target=1.5, drop=0.1, currentLevel=2.95, integral=0.4, max=3.0
err=1.4 → pTerm=0.07; iTerm=0.505
unclamped=3.525 → clamped to 3.0; clampedDelta=-0.525
newIntegral=0.505+0.01×-0.525=0.4995→0.50
Output: NewLevel=3.00, NewIntegral=0.50, Action=raise
```

**F — ADAPT_TAPERED, mid-shift (progress=0.25), target=1.5.**
```
shiftStart=08:00, shiftEnd=17:00, now=10:15
progress=2.25h/9h=0.25 → effective_target=1.5×(1.5-0.5×0.25)=2.0625
drop=2.0 → err=0.0625 → falls in deadband → HOLD
```

---

## 3. Mode Dispatch via `ResolveTarget()` Strategy

### 3.1 `AdaptInput` and `AdaptOutput` (FROZEN signatures)

```go
// package dialer/internal/adapt

type AdaptInput struct {
    Mode              DialMethod  // ADAPT_HARD | ADAPT_AVG | ADAPT_TAPERED
    DropPct30d        float64     // from E05 published gauge; 0..100
    AdaptiveDropPct   float64     // campaigns.adaptive_drop_pct
    CurrentLevel      float64     // last published dial_level (from pace_state.last_level)
    AdaptiveMaxLevel  float64     // campaigns.adaptive_max_level; validated ≥ 1.0
    Intensity         int         // campaigns.adaptive_intensity; -20..+20
    HoldBandPP        float64     // campaigns.hold_band_pp; default 0.30
    LastIntegral      float64     // from pace_state HASH
    LastTickTs        time.Time
    Now               time.Time
    TickSeconds       float64     // campaigns.adapt_tick_seconds; default 15
    WarmUp            bool        // true if warm-up not yet exited; controller inhibited
    ShiftStart        time.Time   // campaigns.shift_start_local resolved to today UTC; zero = unset
    ShiftEnd          time.Time   // campaigns.shift_end_local resolved to today UTC; zero = unset
}

type AdaptOutput struct {
    NewLevel       float64   // clamped [1.0, AdaptiveMaxLevel]; quantized to 0.05
    NewIntegral    float64   // back-calculated and clamped to [-I_MAX, +I_MAX]
    ActionTaken    string    // "raise"|"lower_soft"|"lower_hard"|"hold"|"warm_up"|"fast_cut"
    Reason         string    // human-readable for audit stream
    NeedsWrite     bool      // false when NewLevel == CurrentLevel (skip Valkey write)
}

// Decide is a pure function — no I/O, no clock reads. All inputs are passed in.
// This is the only entry point for the controller math.
func Decide(in AdaptInput) AdaptOutput
```

`Decide()` is side-effect-free. Every 15-s tick calls `Decide()` and the caller writes the result to Valkey. Fast-cut path bypasses `Decide()` and writes `dial_level=1.0` directly (see §4.3).

### 3.2 `ResolveTarget()` (FROZEN formula — corrects DESIGN.md §6.4 typo)

```go
func ResolveTarget(mode DialMethod, dropPct float64, shiftStart, shiftEnd, now time.Time) float64 {
    if mode != ADAPT_TAPERED {
        return dropPct  // HARD + AVG use configured % as-is
    }
    if shiftStart.IsZero() || shiftEnd.IsZero() {
        return dropPct  // no shift configured → no taper → behaves like AVG
    }
    if now.Before(shiftStart) {
        return dropPct * 1.5  // before shift: maximally lenient
    }
    if now.After(shiftEnd) {
        return dropPct  // after shift: strict (campaign should be paused anyway)
    }
    progress := float64(now.Sub(shiftStart)) / float64(shiftEnd.Sub(shiftStart))
    // progress=0 → target=1.5×dropPct (lenient early, allows running over)
    // progress=1 → target=1.0×dropPct (strict at end)
    // Matches PREDICTIVE.txt: "allows for running OVER the dropped % in the first half"
    // DESIGN.md §6.4 has the opposite sign — this formula is the correction.
    return dropPct * (1.5 - 0.5*progress)
}
```

**DESIGN.md correction note:** DESIGN.md §6.4 line 684 reads `effective_target = drop_target * (1 - 0.5*shift_progress)`, which gives STRICTER target early. Vicidial's PREDICTIVE.txt explicitly states the first half of the shift allows running OVER the target. The correct formula is `drop_target * (1.5 - 0.5*shift_progress)`. This PLAN's formula takes precedence; DESIGN.md correction will be filed in HANDOFF.

### 3.3 Mode dispatch (5 lines)

```go
func Decide(in AdaptInput) AdaptOutput {
    if in.WarmUp {
        return AdaptOutput{NewLevel: in.CurrentLevel, NewIntegral: in.LastIntegral,
            ActionTaken: "warm_up", Reason: "warm-up gate active", NeedsWrite: false}
    }
    target := ResolveTarget(in.Mode, in.AdaptiveDropPct, in.ShiftStart, in.ShiftEnd, in.Now)
    switch in.Mode {
    case ADAPT_HARD:
        return HardLimit(in, target)
    case ADAPT_AVG, ADAPT_TAPERED:
        return AverageWithDeadband(in, target)
    default:
        // Wrong mode in DB → default to ADAPT_AVG with WARN (failure mode #6)
        return AverageWithDeadband(in, target)
    }
}
```

---

## 4. Tick Cadence: 15-s Outer + Event-Driven Fast-Cut (≤50 ms) with 30-s Debounce

### 4.1 The two timescales

| Path | Trigger | Latency | Direction |
|---|---|---|---|
| **Outer adapt tick** | Go ticker, per `adapt_tick_seconds` (default 15) | 0–15 s | raise OR lower |
| **Fast-cut** | `drop_gated_changed` pubsub payload `gated=true` | ~50 ms | decrease-only |

### 4.2 Outer 15-s tick

```
each tick:
  1. SET t:{tid}:adapt:lock:{cid} <pod_id> EX {adapt_tick_seconds} NX
     → nil: sibling won, skip, metric vici2_adapt_tick_skipped_total{reason=lock_contention}
     → OK:  proceed
  2. Pipeline GET: dial_level, drop_pct_30d, drop_gated; HGETALL: pace_state
  3. Reload campaign config if campaign_config_changed pubsub was received
  4. Validate config (adaptive_max_level ≥ 1.0, etc.)
  5. Decide(input) → output
  6. If output.NeedsWrite: SET t:{tid}:campaign:{cid}:dial_level {output.NewLevel}
  7. HSET pace_state {all fields atomically}
  8. XADD adapt_decisions stream (MAXLEN 5760)
  9. Prometheus metrics update
```

Multi-pod: exactly one pod writes per 15-s window per campaign. Lock TTL = `adapt_tick_seconds`. If E03 crashes mid-tick, lock expires automatically and the next pod or restarted pod resumes.

### 4.3 Event-driven fast-cut (E05 → E03)

Subscribe to `t:{tid}:broadcast:campaign:{cid}` (F04 pubsub channel).

On message `{event: "drop_gated_changed", gated: true}`:

1. Check debounce: if last fast-cut was < `drop_gated_debounce_sec` (default 30) seconds ago → skip (metric `vici2_adapt_drop_gated_debounce_total`).
2. Acquire `SET t:{tid}:adapt:fastcut:{cid} <pod> EX 5 NX` → nil: sibling is already cutting; skip.
3. GET `dial_level`. If already `1.0` → no-op.
4. SET `dial_level = 1.0`.
5. HSET `pace_state.integral_term = 0`, `pace_state.last_action = fast_cut`, `pace_state.last_tick_ts = now`.
6. XADD `adapt_decisions` with `action=fast_cut`.
7. Update `vici2_adapt_fast_cut_total`.
8. Record debounce timestamp.

Fast-cut is **decrease-only**: we never raise `dial_level` on a pubsub event; raises stay on the 15-s rhythm.

### 4.4 `drop_gated` flapping defense

If E05's `drop_gated` flips more than 3 times per minute (detected in the fast-cut handler via a sliding counter), escalate:
- Engage debounce for 5 minutes (not just 30 s).
- Log `WARN` with campaign_id.
- Metric `vici2_adapt_drop_gated_flap_total`.

### 4.5 Tick tuning parameters (per-campaign)

| Parameter | Column | Default | Range | Notes |
|---|---|---|---|---|
| `adapt_tick_seconds` | `campaigns.adapt_tick_seconds` | 15 | 5–60 | Vicidial parity at 15 |
| `drop_gated_debounce_sec` | `campaigns.drop_gated_debounce_sec` | 30 | 0–300 | 0 = react every flip |
| `warmup_min_answered` | `campaigns.warmup_min_answered` | 50 | 0–500 | Vicidial's `$VCScalls_today > 50` |
| `warmup_min_seconds` | `campaigns.warmup_min_seconds` | 300 | 0–1800 | 5 min is enough to gather drop signal |

---

## 5. Cold-Start Warm-Up Gate (50 answered calls OR 5 min)

### 5.1 When warm-up activates

Warm-up activates when:
- Campaign first transitions to ADAPT_* mode (new campaign, or mode switch).
- E03 finds no `pace_state` HASH in Valkey (cold-start or Valkey wipe).
- `pace_state.warm_up_calls_remaining > 0` on restart (warm-up was in progress).

### 5.2 Warm-up initialization

```
dial_level   = clamp(campaigns.auto_dial_level, 1.0, adaptive_max_level)
pace_state   = {
    integral_term           : "0"
    last_level              : dial_level
    last_tick_ts            : ""
    last_drop_pct           : "0"
    last_action             : "warm_up"
    warm_up_calls_remaining : warmup_min_answered (default 50)
    warm_up_started_at      : now_unix_ms
    clamp_active_since_ts   : ""
    tick_count              : "0"
}
```

### 5.3 Warm-up exit gates (first satisfied wins)

| Gate | Condition | Notes |
|---|---|---|
| **Calls gate** | `warm_up_calls_remaining ≤ 0` | Decremented on `call_completed` events; E03 subscribes to the F04 event stream |
| **Time gate** | `now - warm_up_started_at ≥ warmup_min_seconds` | Checked on every tick |
| **Compliance override** | `drop_pct_30d > adaptive_drop_pct` | Hard-cap path fires immediately regardless of warm-up; then warm-up continues for raises |

### 5.4 Behavior during warm-up

- Controller main path inhibited: `Decide()` returns `ActionTaken="warm_up"`, `NeedsWrite=false`.
- Hard-cap fast-cut path remains live: if `drop_gated=true` fires, `dial_level` cuts to 1.0 immediately (compliance floor; not inhibited by warm-up).
- `dial_level` STRING is not written on each tick (unnecessary churn; RESP3 cache is stable).
- Metric `vici2_adapt_warmup_active{tenant, campaign}` = 1 during warm-up, 0 after.
- Metric `vici2_adapt_warmup_calls_remaining{tenant, campaign}` = gauge of remaining call count.

### 5.5 Hot-restart: E03 pod crash mid-campaign

1. `pace_state` HASH survives in Valkey.
2. On restart: `HGETALL pace_state` — all fields present → resume from persisted state.
3. If `warm_up_calls_remaining > 0` → re-enter warm-up.
4. If warm-up already exited (calls=0 and time elapsed) → full controller engages on next tick.
5. Metric `vici2_adapt_cold_start_total` does NOT tick on hot-restart (only ticks when HGETALL returns empty).

### 5.6 Pause / resume

When `campaigns.active = false` (admin pause):
1. E03 supervisor stops ticking (controller frozen at last state).
2. `pace_state` and `dial_level` STRINGs persist in Valkey.
3. On resume: tick resumes from frozen state. **No re-warm-up** (operator UX: "pause for lunch" = 1 h gap; restarting warm-up would be disruptive).

**Resolved Q14:** freeze-on-pause, resume from frozen state.

### 5.7 Integral persistence across start-of-shift

**Resolved Q1:** integral accumulates across shifts (do not reset daily). We track 30-day rolling drop%, not per-shift. Resetting daily would create predictable disturbance at shift-start.

---

## 6. Quantization (0.05 Grid)

`dial_level` is stored as `DECIMAL(4,2)` in MySQL (`campaigns.auto_dial_level`) and as a STRING in Valkey. The **effective grid** is 0.05 — matching Vicidial's intrinsic step size.

```go
func quantize(x float64) float64 {
    return math.Round(x*20) / 20  // rounds to nearest 0.05
}
```

Quantization is applied **before** every write — the controller always works on the quantized value, not the continuous output. This prevents a "drift" artifact where the controller believes it changed the level but the Valkey string is unchanged.

**No-op write suppression:** if `quantize(newLevel) == pace_state.last_level`, set `NeedsWrite=false` and skip the Valkey SET (avoids RESP3 cache invalidation churn). Metric `vici2_adapt_noop_write_total`.

**Validation test for quantize():**
`1.234→1.25`, `1.226→1.25`, `1.20→1.20`, `0.97→1.00`, `5.001→5.00`, `0.974→0.95`

---

## 7. Patent-Defense Audit (US8681955B1 Mitigations FROZEN)

### 7.1 Patent risk table

| Patent | Status | Risk | Mitigation |
|---|---|---|---|
| **US8681955B1** (Noble Systems) — "Feedback control of a predictive dialer using telemarketing call abandonment rates" | Active 2014–2033 | **Medium** | See §7.2 |
| **US8411844B1** (Avaya/Aspect) — occupancy-distribution-based control | Active 2013–2031 | **Low** | We use direct drop% not occupancy distributions |
| **US9088650B2** (Impact Dialing) — simulation-based | Lapsed 2019 | **None** | No action |
| **US9807235B1** (Noble Systems) — neural-network ensemble | Active 2017–2036 | **None (Phase 2)** | No ML in Phase 2; Phase 4 must re-audit |
| **US5570419A** (Cantel) — old predictive dialer | Expired 2015 | **None** | No action |

### 7.2 US8681955B1 mitigations (FROZEN)

These behaviors are **permanently prohibited** in `dialer/internal/adapt/` and enforced by a CI static-analysis hook (§15.5):

1. **No speech analytics feedback.** E03 never reads speech-content signals. All inputs are `dial_level`, `drop_pct_30d`, `drop_gated`, and campaign config scalars.
2. **No dynamic setpoint adjustment.** E03 adjusts the **actuator** (`dial_level`), never the **setpoint** (`adaptive_drop_pct`). `ResolveTarget()` reads the configured target; it does not modify it.
3. **Prior-art citation in all source files.** Every file in `dialer/internal/adapt/` includes the header comment:
   ```
   // E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
   // in source control since at least 2008 per inktel/Vicidial git history).
   // Improvements: explicit anti-windup (back-calculation), deadband, drop_gated fast-cut.
   // Prior art documented per SPEC patent-defense protocol.
   ```
4. **No ML library imports.** The CI hook (`scripts/ci/check-adapt-patent-boundaries.sh`) asserts: no `*speech*` / `*sentiment*` / `*nlp*` files under `internal/adapt/`; no `target_adjustment` or `setpoint_update` symbols; no ML library imports.

### 7.3 Legal review checkpoint

**Legal review of the patent audit (§7.1) MUST be completed and signed off before the Implementation phase ships to production.** The PLAN sign-off page includes a field:

```
Legal review of E03 patent audit: [ ] Completed  [ ] Deferred  Reviewer: ___  Date: ___
```

This is not negotiable for compliance posture. The implementation may proceed; legal review must complete before go-live.

### 7.4 Phase 4 deferral notes

These are documented as future research to prevent accidental reimplementation:
- **RL / Thompson sampling dial-level bandit** — requires continuous action space + stationary assumption + Sprinklr prior-art risk. Phase 4.
- **MPC (Model Predictive Control)** — requires calibrated forward model (connect rate, AHT). Phase 4.
- **Erlang-A patience-distribution modeling** — requires AHT EWMA from `call_log`. Phase 3.
- **`adaptive_dl_diff_target` differential signal** — column reserved in F02; E03 logs a WARN if non-default but ignores it. Phase 3.

---

## 8. E05 Contract: `drop_pct_30d` Continuous + `drop_gated` Flag

### 8.1 What E03 requires from E05 (BLOCKING for E05 PLAN)

E05 MUST publish two Valkey STRINGs, continuously, every ~15 seconds regardless of `drop_gated` state:

| Key | Type | Format | Publisher cadence | Meaning |
|---|---|---|---|---|
| `t:{tid}:campaign:{cid}:drop_pct_30d` | STRING | DECIMAL percentage, e.g. `"1.42"` | Every 15 s | 30-day rolling abandonment %, computed by E05 |
| `t:{tid}:campaign:{cid}:drop_gated` | STRING | `"1"` or `"0"` | Event-driven on change | Whether E02 and E03 should clamp to `dial_level=1.0` |

**Critical amendment:** the original E05 design only publishes `drop_gated` on state changes. E03's controller math requires `drop_pct_30d` on EVERY 15-s tick (the controlled variable). E05 PLAN must commit to continuous publication.

### 8.2 E03 behavior when E05 keys are absent

| Missing key | E03 behavior |
|---|---|
| `drop_pct_30d` absent | Use `last_drop_pct` from `pace_state` (cached value); log WARN; metric `vici2_adapt_drop_pct_missing_total`. If absent for > 60 s: page |
| `drop_pct_30d` absent AND no cached value | Assume `0.0` (controller wants to raise level; combined with warm-up gate → no harm). Log ERROR |
| `drop_gated` absent | Assume not gated (`"0"`); proceed normally; metric `vici2_adapt_drop_gated_missing_total` |

### 8.3 `drop_gated_changed` pubsub contract

E05 publishes on channel `t:{tid}:broadcast:campaign:{cid}` with payload:
```json
{"event": "drop_gated_changed", "gated": true}
{"event": "drop_gated_changed", "gated": false}
```

E03 subscribes and acts within ~50 ms on `gated=true`. `gated=false` is advisory (E03 will resume raising on the next regular tick; no special action needed on release).

### 8.4 Resolved Q5 (first-tick blocking)

When E03 starts and E05 hasn't published `drop_pct_30d` yet: proceed with `0.0` (controller wants to raise, which is inhibited by warm-up). Do not block. Log INFO. If missing > 60 s after first tick: page.

---

## 9. F02 Amendment Scope (9 New Columns)

### 9.1 New columns on `campaigns`

All additive, non-breaking, no RFC required per SPEC §12.

| Column | MySQL type | Prisma | Default | Range | Purpose |
|---|---|---|---|---|---|
| `adaptive_intensity` | `TINYINT` | `Int @default(0)` | 0 | −20…+20 | Vicidial-parity intensity modifier (§2.3) |
| `adaptive_dl_diff_target` | `TINYINT` | `Int @default(-1)` | −1 | −5…+5 | Phase 3 differential target; E03 ignores in Phase 2; reserved |
| `adapt_tick_seconds` | `SMALLINT UNSIGNED` | `Int @default(15)` | 15 | 5–60 | Per-campaign outer tick interval |
| `hold_band_pp` | `DECIMAL(3,2)` | `Decimal @default(0.30)` | 0.30 | 0.00–2.00 | Drop-rate deadband in percentage points |
| `warmup_min_answered` | `SMALLINT UNSIGNED` | `Int @default(50)` | 50 | 0–500 | Warm-up exit gate: min answered calls |
| `warmup_min_seconds` | `SMALLINT UNSIGNED` | `Int @default(300)` | 300 | 0–1800 | Warm-up exit gate: min elapsed seconds |
| `drop_gated_debounce_sec` | `SMALLINT UNSIGNED` | `Int @default(30)` | 30 | 0–300 | Fast-cut debounce window |
| `shift_start_local` | `TIME` | `DateTime? @db.Time` | NULL | n/a | Local-time shift start; for ADAPT_TAPERED |
| `shift_end_local` | `TIME` | `DateTime? @db.Time` | NULL | n/a | Local-time shift end; for ADAPT_TAPERED |

### 9.2 Resolved open questions about these columns

**Resolved Q4 (intensity semantics):** multiplicative, Vicidial-parity, range −20…+20 (so ±20% gain modifier; never inverts sign). Documented in M02 UI tooltip.

**Resolved Q2 (shift definition):** if `shift_start_local` or `shift_end_local` is NULL, `ResolveTarget` returns `adaptive_drop_pct` unchanged (ADAPT_TAPERED behaves like ADAPT_AVG). No taper without an explicit shift. Timezone: Phase 2 uses UTC. Phase 3 adds `campaigns.timezone` column; document in HANDOFF.

**Resolved Q11 (all 9 columns):** file all 9 in one migration: `api/prisma/migrations/<date>_e03_adaptive_engine/`.

### 9.3 Resolved Q8 (`auto_dial_level` semantics)

`campaigns.auto_dial_level` = starting level for ADAPT_* modes (read once on cold-start). E03 reads it at initialization only. E03 does **not** write back to MySQL (avoiding hot writes on every controller tick). The live `dial_level` lives only in Valkey. Column doc: "Initial dial level for adaptive modes; also used as live level for RATIO mode (E02 reads it)."

### 9.4 Migration file

`api/prisma/migrations/YYYYMMDD_e03_adaptive_engine/migration.sql`

All nine columns in one `ALTER TABLE campaigns ADD COLUMN ...` statement. Additive, no data migration needed, no downtime (MySQL online DDL with `ALGORITHM=INSTANT` where available; otherwise `INPLACE`).

---

## 10. Schema Additions: `campaign_pace_state` Valkey HASH

### 10.1 New key (F04 amendment required)

**Key:** `t:{tid}:campaign:{cid}:pace_state`  
**Type:** HASH  
**TTL:** None (persistent)  
**Cluster hash tag:** `{cid}` — colocates with `dial_level`, `drop_window`, `active_calls` (F04 §4.7)

| Field | Type (string representation) | Default on init | Notes |
|---|---|---|---|
| `integral_term` | DECIMAL string | `"0"` | Clamped to `[-0.5, +0.5]`; back-calculation anti-windup |
| `last_level` | DECIMAL string | from `campaigns.auto_dial_level` | Cache of last written `dial_level` |
| `last_tick_ts` | unix-ms int string | `""` | Set on first tick; used to detect missed ticks |
| `last_drop_pct` | DECIMAL string | `"0"` | Audit field; last seen `drop_pct_30d` |
| `last_action` | string | `""` | `raise\|lower_soft\|lower_hard\|hold\|warm_up\|fast_cut` |
| `warm_up_calls_remaining` | int string | `"50"` | Decremented on call_completed events |
| `warm_up_started_at` | unix-ms int string | now on init | For timeout check |
| `clamp_active_since_ts` | unix-ms int string | `""` | When output clamp first engaged |
| `tick_count` | int string | `"0"` | Lifetime tick counter |

Written atomically via single `HSET` (multi-field, RESP3 native). No Lua script needed.

### 10.2 New lock keys (F04 amendment required)

| Key | Type | TTL | Notes |
|---|---|---|---|
| `t:{tid}:adapt:lock:{cid}` | STRING | `adapt_tick_seconds` (15 s) | Already listed in F04 PLAN §4.13 |
| `t:{tid}:adapt:fastcut:{cid}` | STRING | 5 s | Coalesces multiple fast-cut events; NEW — file F04 amendment |

### 10.3 Existing keys consumed (not modified)

| Key | Owner | E03 operation |
|---|---|---|
| `t:{tid}:campaign:{cid}:dial_level` | E03 (write) / E02, E01 (read) | SET (no TTL) |
| `t:{tid}:campaign:{cid}:drop_pct_30d` | E05 (write) | GET |
| `t:{tid}:campaign:{cid}:drop_gated` | E05 (write) | EXISTS / GET |
| `t:{tid}:broadcast:campaign:{cid}` | M02 + E05 (publish) | SUBSCRIBE |

### 10.4 No new MySQL table

Controller state is transient by design. On full Valkey loss, E03 cold-starts from `campaigns.auto_dial_level` and rebuilds within 5 minutes (warm-up gate). `dial_level_history` is deferred — E02's `pacing_decisions` stream already captures level at each second; T03/O01 can sink it to ClickHouse in Phase 3+.

---

## 11. Go Package Layout (`dialer/internal/adapt/`)

### 11.1 Production files

```
dialer/internal/adapt/
  engine.go          // Decide() entry point; mode dispatch; warm-up inhibit
  hardlimit.go       // HardLimit() — ADAPT_HARD pure-P controller
  average.go         // AverageWithDeadband() — ADAPT_AVG + ADAPT_TAPERED PI
  target.go          // ResolveTarget() — per-mode effective setpoint
  warmup.go          // warm-up state machine: init, exit-gate check, calls-remaining decrement
  fastcut.go         // event-driven drop_gated_changed handler + debounce + flap detection
  state.go           // pace_state HASH read/write; cold-start init; Valkey key constants
  config.go          // per-campaign config snapshot struct; validation (max_level ≥ 1.0); hot-reload
  supervisor.go      // goroutine spawn/kill/respawn; per-campaign lifecycle; tick orchestrator
  decision.go        // one-tick orchestrator: acquire lock → snapshot → Decide → write → XADD
  metrics.go         // Prometheus counter/gauge registration; label constants
```

### 11.2 Test files

```
dialer/internal/adapt/
  engine_test.go         // Decide() table tests (≥30 rows); all worked examples A–F
  hardlimit_test.go      // HardLimit() edge cases + failure modes
  average_test.go        // AverageWithDeadband() edge cases + anti-windup tests
  target_test.go         // ResolveTarget() × {HARD,AVG,TAPERED} × time phases
  warmup_test.go         // warm-up entry/exit transitions; all three exit gates
  fastcut_test.go        // debounce; fast-cut lock; flap detection; drop_gated=false no-op
  state_test.go          // pace_state HSET/HGETALL round-trip; cold-start init; hot-restart
  config_test.go         // validation: max_level < 1.0 clamped; wrong mode defaults to AVG
  integration_test.go    // testcontainers Valkey; multi-pod tick-lock; hot-restart integral persistence
  failures_test.go       // all 14 failure modes from §12 (one test case each)
```

### 11.3 Simulator sub-package

```
dialer/internal/adapt/simulator/
  agents.go        // synthetic agent pool (N=20; LogNormal AHT μ=180s σ=60s)
  leads.go         // synthetic lead-answer process (Poisson; hourly variation; connect rate 0.25)
  pacer.go         // mock E02 formula: desired = max(0, round(agents × dial_level) - active_calls)
  drop.go          // mock E05: counts answers + drops; computes rolling drop%
  scenario.go      // named scenario runner; outputs trajectory + stats report
  simulator_test.go  // S1–S8 in ≤30 s CI-fast subset (sub-second simulated time)
  soak_test.go       // 24h simulated run of S1+S3 with random disturbances; nightly CI only
```

Simulator is a separate sub-package; never imported by production code. Useful for E02 and E05 regression testing as well.

### 11.4 Wiring into existing `dialer/cmd/dialer/main.go`

E03 supervisor wires on startup alongside E01/E02. On each active ADAPT_* campaign in MySQL:

```go
adaptSupervisor := adapt.NewSupervisor(valkey, db, prom)
adaptSupervisor.Start(ctx)  // spawns per-campaign goroutines
```

Goroutine lifecycle (RESEARCH §12 Q10 resolution):
- Spawn on `campaign_config_changed` with `dial_method ∈ {ADAPT_HARD, ADAPT_AVG, ADAPT_TAPERED}`.
- Kill on `campaign_config_changed` with `dial_method ∉ ADAPT_*` or `campaigns.active = false`.
- Kill on campaign deletion (catches `ErrCampaignNotFound`, supervisor reaps; `dial_level` STRING left in Valkey until E06 janitor sweeps — TTL-less; janitor is Phase 3).
- Respawn on panic with 5-s backoff (same pattern as E02 supervisor per E02 PLAN §8.1).

---

## 12. Public API

### 12.1 `adapt.Decide()` — the only pure function callers need

```go
// Pure function. No I/O. Deterministic given same inputs.
// Callers: decision.go (tick path), fastcut.go (fast-cut path — bypasses this and writes directly).
func Decide(in AdaptInput) AdaptOutput
```

### 12.2 `adapt.Supervisor` — lifecycle management

```go
type Supervisor struct { /* unexported */ }

// NewSupervisor constructs the supervisor. Call once at process start.
func NewSupervisor(vc *valkey.Client, db *sql.DB, reg prometheus.Registerer) *Supervisor

// Start begins watching for campaigns and spawning/killing goroutines.
// Blocks until ctx is cancelled.
func (s *Supervisor) Start(ctx context.Context) error

// CampaignCount returns the number of active campaign goroutines (for health checks).
func (s *Supervisor) CampaignCount() int
```

### 12.3 `adapt.PaceState` — Valkey HASH codec

```go
type PaceState struct {
    IntegralTerm         float64
    LastLevel            float64
    LastTickTs           time.Time
    LastDropPct          float64
    LastAction           string
    WarmUpCallsRemaining int
    WarmUpStartedAt      time.Time
    ClampActiveSince     time.Time
    TickCount            int64
}

// Load reads pace_state from Valkey. Returns (zero-value, false, nil) if key absent (cold-start).
func LoadPaceState(ctx context.Context, vc *valkey.Client, tid int64, cid int64) (PaceState, bool, error)

// Save atomically writes all fields via HSET.
func SavePaceState(ctx context.Context, vc *valkey.Client, tid int64, cid int64, ps PaceState) error
```

### 12.4 `adapt.Config` — per-campaign config snapshot

```go
type Config struct {
    Mode               DialMethod
    AdaptiveDropPct    float64
    AdaptiveMaxLevel   float64  // validated ≥ 1.0 at construction
    AutoDialLevel      float64  // cold-start initial level
    Intensity          int      // -20..+20
    HoldBandPP         float64  // default 0.30
    AdaptTickSeconds   int      // default 15
    WarmupMinAnswered  int      // default 50
    WarmupMinSeconds   int      // default 300
    DropGatedDebounce  int      // default 30
    ShiftStartLocal    *time.Time  // nil when not set
    ShiftEndLocal      *time.Time  // nil when not set
}

// LoadConfig reads campaign config from DB. Validates and clamps.
func LoadConfig(ctx context.Context, db *sql.DB, tid int64, cid int64) (Config, error)
```

---

## 13. Metrics

All metrics follow E02's label scheme for operator dashboard consistency (Resolved Q9).

### 13.1 Metric table

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `vici2_adapt_tick_total` | Counter | `{tenant, campaign}` | Every completed outer tick |
| `vici2_adapt_tick_skipped_total` | Counter | `{tenant, campaign, reason}` | `reason ∈ lock_contention\|warm_up\|valkey_down\|drop_pct_missing\|campaign_paused` |
| `vici2_adapt_action_total` | Counter | `{tenant, campaign, action}` | `action ∈ raise\|lower_soft\|lower_hard\|hold\|fast_cut\|warm_up` |
| `vici2_adapt_dial_level` | Gauge | `{tenant, campaign}` | Current `dial_level` value |
| `vici2_adapt_drop_pct_30d` | Gauge | `{tenant, campaign}` | Echo of E05's `drop_pct_30d` (for co-location in dashboards) |
| `vici2_adapt_integral_term` | Gauge | `{tenant, campaign}` | For debugging controller state |
| `vici2_adapt_clamp_active_seconds` | Counter | `{tenant, campaign, side}` | `side ∈ ceiling\|floor`; counts seconds at clamp boundary |
| `vici2_adapt_warmup_active` | Gauge (0/1) | `{tenant, campaign}` | 1 during warm-up |
| `vici2_adapt_warmup_calls_remaining` | Gauge | `{tenant, campaign}` | Countdown to warm-up exit |
| `vici2_adapt_fast_cut_total` | Counter | `{tenant, campaign}` | Each fast-cut event acted on |
| `vici2_adapt_drop_gated_debounce_total` | Counter | `{tenant, campaign}` | Fast-cuts skipped by debounce |
| `vici2_adapt_drop_gated_flap_total` | Counter | `{tenant, campaign}` | Flap detection activations |
| `vici2_adapt_tick_duration_seconds` | Histogram | `{tenant, campaign}` | Buckets: 0.0001/0.001/0.01/0.1/1.0 |
| `vici2_adapt_noop_write_total` | Counter | `{tenant, campaign}` | Ticks where `NeedsWrite=false` |
| `vici2_adapt_external_override_total` | Counter | `{tenant, campaign}` | Admin wrote `dial_level` outside E03 |
| `vici2_adapt_cold_start_total` | Counter | `{tenant, campaign}` | `pace_state` HGETALL returned empty |
| `vici2_adapt_restart_total` | Counter | `{tenant, campaign}` | Hot-restart (pace_state present) |
| `vici2_adapt_drop_pct_missing_total` | Counter | `{tenant, campaign}` | Ticks where E05's gauge was absent |
| `vici2_adapt_integral_runaway_total` | Counter | `{tenant, campaign}` | `abs(integral) > I_MAX × 1.5` |
| `vici2_adapt_config_invalid_total` | Counter | `{tenant, campaign, field}` | Config validation failure per field |

### 13.2 Alert recipes for O01

| Alert | Condition | Severity |
|---|---|---|
| Controller not converging | `vici2_adapt_drop_pct_30d > adaptive_drop_pct * 1.5` sustained 10 min | Warn |
| Fast-cut storm | `rate(vici2_adapt_fast_cut_total[5m]) > 1/min` | Page |
| Integral runaway | `rate(vici2_adapt_integral_runaway_total[1h]) > 0` | Page |
| Ceiling clamp sustained | `rate(vici2_adapt_clamp_active_seconds{side=ceiling}[1h]) > 600` | Warn (operator needs to raise `adaptive_max_level`) |
| Valkey unavailable | `rate(vici2_adapt_tick_skipped_total{reason=valkey_down}[1m]) > 0` | Page |
| E05 drop_pct missing | `rate(vici2_adapt_drop_pct_missing_total[5m]) > 0` sustained 2 min | Page |

---

## 14. Files to Create

### 14.1 Production Go files

| File | LOC estimate | Key contents |
|---|---|---|
| `dialer/internal/adapt/engine.go` | ~80 | `Decide()`, mode dispatch, warm-up inhibit |
| `dialer/internal/adapt/hardlimit.go` | ~50 | `HardLimit()` |
| `dialer/internal/adapt/average.go` | ~90 | `AverageWithDeadband()`, integral term, back-calc |
| `dialer/internal/adapt/target.go` | ~40 | `ResolveTarget()`, tapered formula |
| `dialer/internal/adapt/warmup.go` | ~60 | Warm-up state machine, exit-gate logic |
| `dialer/internal/adapt/fastcut.go` | ~70 | Pubsub handler, debounce, flap detection |
| `dialer/internal/adapt/state.go` | ~60 | `PaceState` struct, HSET/HGETALL codec |
| `dialer/internal/adapt/config.go` | ~50 | `Config` struct, DB load, validation |
| `dialer/internal/adapt/supervisor.go` | ~100 | Goroutine lifecycle, campaign watching |
| `dialer/internal/adapt/decision.go` | ~80 | One-tick orchestrator (lock → snapshot → Decide → write → XADD) |
| `dialer/internal/adapt/metrics.go` | ~60 | Prometheus registration, label helpers |
| **Total production** | **~740 LOC** | |

### 14.2 Test files

| File | Test count | Notes |
|---|---|---|
| `engine_test.go` | ≥30 table rows | All worked examples A–F pinned; all 14 failure mode behaviors |
| `hardlimit_test.go` | ~15 | Edge cases + intensity combinations |
| `average_test.go` | ~20 | Anti-windup; integral bleed; deadband edges |
| `target_test.go` | ~12 | All mode/time combinations |
| `warmup_test.go` | ~10 | Three exit gates + compliance override |
| `fastcut_test.go` | ~12 | Debounce; flap; lock coalesce |
| `state_test.go` | ~10 | Round-trip codec; cold-start init |
| `config_test.go` | ~8 | Validation clamping |
| `integration_test.go` | ~6 | Testcontainers Valkey; multi-pod lock; hot-restart |
| `failures_test.go` | 14 | One per failure mode in §12 |

### 14.3 Simulator files

| File | Notes |
|---|---|
| `simulator/agents.go` | N=20; LogNormal(μ=180, σ=60) AHT |
| `simulator/leads.go` | Poisson; hourly variation; connect rate 0.25 |
| `simulator/pacer.go` | E02 mock formula |
| `simulator/drop.go` | E05 mock (rolling window) |
| `simulator/scenario.go` | Named scenario runner; trajectory report |
| `simulator/simulator_test.go` | S1–S8 CI-fast |
| `simulator/soak_test.go` | 24h; nightly CI only |

### 14.4 Migration

| File | Notes |
|---|---|
| `api/prisma/migrations/YYYYMMDD_e03_adaptive_engine/migration.sql` | 9 new `campaigns` columns (§9.1) |
| `api/prisma/migrations/YYYYMMDD_e03_adaptive_engine/down.sql` | Dev/test rollback only |

### 14.5 CI scripts

| File | Notes |
|---|---|
| `scripts/ci/check-adapt-patent-boundaries.sh` | Patent-defense static analysis (§7.2, §15.5) |

### 14.6 F04 amendment required

File amendment to F04 PLAN documenting two new Valkey keys:
- `t:{tid}:campaign:{cid}:pace_state` HASH (§10.1)
- `t:{tid}:adapt:fastcut:{cid}` STRING (§10.2)

---

## 15. Test Plan

### 15.1 Unit tests — `Decide()` table (≥30 rows, `engine_test.go`)

All worked examples from §2.6 are pinned as table rows. Additional rows cover:

| Test case | Input variant | Expected output |
|---|---|---|
| Under target, zero integral | `drop=0, target=1.5, level=1.0, integral=0` | raise |
| Under target, max integral built up | `integral=0.5` | raise clamped by back-calc |
| Over target, inside deadband | `\|err\|=0.2, holdBand=0.3` | hold + bleed |
| Over target, outside deadband | `\|err\|=0.5, holdBand=0.3` | lower_soft |
| At floor clamp | `level=1.0, drop=3.0, target=1.5` | hold at floor (HARD: 1.0; AVG: hold) |
| At ceiling clamp | `level=max, drop=0, integral=0.4` | back-calc bleeds integral |
| Warm-up active | `WarmUp=true` | warm_up, NeedsWrite=false |
| Fast-cut (tested in fastcut_test.go) | — | — |
| TAPERED before shift | `progress<0; target*1.5` | raises aggressively |
| TAPERED mid-shift | `progress=0.5; target*1.25` | converges to higher target |
| TAPERED after shift | `progress>1; target*1.0` | same as AVG |
| TAPERED with no shift | `shiftStart=zero` | behaves like AVG |
| Intensity +20 | all modes | step sizes scaled correctly |
| Intensity -20 | all modes | step sizes scaled correctly |
| Quantization edge | `1.226→1.25`, `1.224→1.20` | exact boundary |
| NeedsWrite=false | `quantize(new)==last` | skip write |
| HARD: drop exactly at target | `drop==target` | lower_hard (no deadband in HARD) |
| HARD: drop below target | `drop < target` | raise |
| Default mode (unknown) | `mode=RATIO` | defaults to AVG + WARN metric |
| External override detected | `current != last_level` | log + resume from current |

### 15.2 Property tests (`engine_test.go`)

Four properties verified via table enumeration (not random — deterministic for CI stability):

1. **Monotonicity:** increasing `DropPct30d` (all else fixed) → `NewLevel ≤ CurrentLevel`.
2. **Floor/ceiling:** `Decide()` output always `∈ [1.0, AdaptiveMaxLevel]`.
3. **Determinism:** same `AdaptInput` → same `AdaptOutput` (no `time.Now()` inside).
4. **Quantization:** `NewLevel` is always exactly `0.05 × k` for some integer `k`.

### 15.3 Simulator scenarios S1–S8 (`simulator_test.go`)

| # | Scenario | Pass criterion |
|---|---|---|
| S1 | ADAPT_AVG, target=1.5%, 8h shift, steady connect rate 0.25 | `mean(drop) ∈ [1.2, 1.8]`; level oscillation amplitude ≤ 0.20 |
| S2 | ADAPT_HARD, target=1.5%, connect rate ramps up at hour 4 | After ramp, drop spikes then level cuts hard; level recovers within 30 min |
| S3 | ADAPT_TAPERED, 8h shift, target=1.5% | Level higher in first half than second half; effective target follows formula |
| S4 | Agent count drops 20→5 mid-shift | Level drops smoothly; no compliance excursion > 2.5% |
| S5 | Connect rate flips 0.25→0.5 (great lead list) | Level cuts; drop stays under 2% |
| S6 | Cold-start (no history) | Warm-up active for 5 min OR 50 calls; level stays at `auto_dial_level`; no oscillation during warm-up |
| S7 | E05 flaps `drop_gated` artificially | Fast-cut fires; debounce engages; level stays at 1.0 for debounce window; no thrash |
| S8 | Anti-windup (connect rate = 0) | Level clamps at max; integral bleeds via back-calc; on connect-rate restore, no overshoot (level stays ≤ max) |

### 15.4 Integration tests (`integration_test.go`)

- E03 + real Valkey (testcontainers) + scripted `drop_pct_30d` time series. Assert `dial_level` STRING transitions match expectations.
- Multi-pod (two E03 goroutine supervisors with different pod IDs): assert exactly one tick wins per 15-s window per campaign.
- Hot-restart: goroutine killed mid-tick; `pace_state` HGETALL on restart yields same integral; next tick produces same output.
- Valkey loss recovery: client reports error; E03 backs off with exponential retry; no panic.

### 15.5 FCC drop-ceiling enforcement (compliance test, `failures_test.go`)

1. Simulate 30-day history with `drop = 2.99%`.
2. Inject 100 synthetic drops in the last hour.
3. Verify:
   a. `drop_pct_30d` crosses 3% → E05 sets `drop_gated=true` (E05's responsibility, mocked here).
   b. E03 fast-cut sets `dial_level=1.0` within 100 ms of pubsub receipt.
   c. Total exposure between drop crossing and level cut ≤ 200 ms.

This is the regulatory-floor test; failure is a **release-blocker**.

### 15.6 Patent-defense CI hook (`scripts/ci/check-adapt-patent-boundaries.sh`)

Static-analysis assertions on `dialer/internal/adapt/`:
- No files matching `*speech*`, `*sentiment*`, `*nlp*`.
- No exported symbol named `*TargetAdjust*`, `*SetpointUpdate*`, or `*UpdateTarget*`.
- No imports of ML libraries (blacklist: `tensorflow`, `onnx`, `gorgonia`, `golearn`).
- Every `.go` file under `dialer/internal/adapt/` contains the required prior-art comment header.

CI step name: `adapt-patent-check`. Runs in the same stage as `go vet`. Failure blocks merge.

### 15.7 Soak test (`simulator/soak_test.go`, nightly CI only)

24-hour simulated run of S1 + S3 with random disturbances (agent count variance, connect rate spikes). Assertions:
- `drop_pct_30d` never exceeds `adaptive_drop_pct × 1.5` for more than 5 consecutive simulated minutes.
- No level oscillation cycle with amplitude > 0.20 lasting > 10 simulated minutes.
- `integral_term` never exceeds `I_MAX × 1.1` (back-calc is working).

---

## 16. Acceptance Criteria

These are the release-blocking criteria. All must pass before E03 IMPLEMENT is marked DONE.

| # | Criterion | Test |
|---|---|---|
| AC1 | `Decide()` is a pure function: same inputs → same outputs, no I/O | `engine_test.go` determinism property |
| AC2 | `NewLevel` is always quantized to the 0.05 grid | `engine_test.go` quantization property |
| AC3 | `NewLevel` is always `∈ [1.0, AdaptiveMaxLevel]` | `engine_test.go` floor/ceiling property |
| AC4 | ADAPT_HARD: `drop ≥ target` → `lower_hard` fires (no deadband) | `hardlimit_test.go` |
| AC5 | ADAPT_AVG: `\|err\| ≤ hold_band_pp` → `hold` (no level change) | `average_test.go` |
| AC6 | Anti-windup: integral does not grow unboundedly at ceiling clamp | `average_test.go`, S8 |
| AC7 | ADAPT_TAPERED: `ResolveTarget` returns `dropPct × 1.5` at shift-start, `dropPct × 1.0` at shift-end | `target_test.go` |
| AC8 | Warm-up inhibits raises for 50 calls AND 5 minutes; hard-cap fires regardless | `warmup_test.go` + S6 |
| AC9 | Fast-cut sets `dial_level=1.0` within 100 ms of `drop_gated_changed` pubsub | `integration_test.go` + compliance test |
| AC10 | 30-s debounce prevents fast-cut thrash | `fastcut_test.go` + S7 |
| AC11 | Multi-pod: exactly one tick per 15 s per campaign (lock enforcement) | `integration_test.go` |
| AC12 | Hot-restart: `pace_state` HASH persists integral; next tick identical to if crash hadn't occurred | `integration_test.go` |
| AC13 | All 14 failure modes produce an observable metric increment (no silent degradation) | `failures_test.go` |
| AC14 | Patent-defense CI hook passes on E03 production code | CI `adapt-patent-check` |
| AC15 | Legal review of patent audit completed and signed off | Legal sign-off field in HANDOFF |
| AC16 | FCC drop-ceiling compliance test passes (≤200 ms exposure) | `failures_test.go` §15.5 |
| AC17 | All 9 F02 amendment columns present in schema.prisma and migration file | Schema review |
| AC18 | `pace_state` HASH and `fastcut` lock key documented in F04 amendment | F04 amendment file |
| AC19 | Simulator S1–S8 all pass | `simulator_test.go` |
| AC20 | Soak test passes for 24 simulated hours | Nightly CI |

---

## 17. Dependencies + Risks

### 17.1 Module dependencies

| Module | E03 dependency | Status |
|---|---|---|
| **E02 PLAN** | `dial_level` consumer contract frozen | DONE |
| **F04 PLAN + HANDOFF** | Valkey key schema; `adapt:lock` key pre-specified | DONE |
| **E05 RESEARCH** | `drop_pct_30d` + `drop_gated` STRING semantics named | DONE (soft) |
| **E05 PLAN** | Must commit to publishing `drop_pct_30d` continuously | BLOCKING — E05 PLAN must ratify |
| **F02 PLAN** | Existing `campaigns` columns consumed; 9 new columns to add | Amendment additive; non-blocking |
| **Legal review** | Patent audit sign-off | Blocking before go-live (not before IMPLEMENT start) |

### 17.2 Inter-module wire contracts (FROZEN by this PLAN)

| Contract | Published by | Consumed by | Key |
|---|---|---|---|
| `dial_level` STRING | **E03** | E02, E01 | `t:{tid}:campaign:{cid}:dial_level` |
| `drop_pct_30d` STRING | **E05** | E03 | `t:{tid}:campaign:{cid}:drop_pct_30d` |
| `drop_gated` STRING | **E05** | E03, E02 | `t:{tid}:campaign:{cid}:drop_gated` |
| `drop_gated_changed` pubsub | **E05** | E03 (fast-cut) | `t:{tid}:broadcast:campaign:{cid}` |
| `pace_state` HASH | **E03** | E03 only | `t:{tid}:campaign:{cid}:pace_state` |

### 17.3 Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| E05 PLAN delays `drop_pct_30d` contract | Medium | High (E03 can't tick correctly) | E03 stubs E05 with a mock gauge during IMPLEMENT; wire up when E05 PLAN freezes |
| Integral accumulates error during Valkey-flap periods | Low | Medium | `K_back` back-calculation + `I_MAX` clamp prevent runaway; test in `failures_test.go` |
| US8681955B1 patent claim | Low | High (litigation) | Prior-art citation in every file; no speech analytics; no setpoint adjustment; CI hook; legal review before go-live |
| DESIGN.md ADAPT_TAPERED formula typo propagates to other modules | Medium | Medium | This PLAN's formula is the authoritative version; DESIGN.md correction in HANDOFF |
| Operator confusion about `hold_band_pp` tuning | Low | Low | M02 UI tooltip + operator guide entry |
| Multi-pod Valkey client contention on `pace_state` HSET | Very low | Low | `SET NX EX 15` tick lock prevents concurrent writes; fast-cut uses separate lock |

### 17.4 Resolved open questions (all 14 from RESEARCH §12)

| # | Question | Resolution |
|---|---|---|
| Q1 | Integral persistence across shift restart? | Keep integral (30-day rolling; reset daily would cause disturbance) |
| Q2 | Shift definition when no shift configured? | Treat as 24h shift (no taper); `ResolveTarget` returns `dropPct` unchanged |
| Q3 | `drop_gated` debounce window? | 30 s default; per-campaign via `drop_gated_debounce_sec` column |
| Q4 | `adaptive_intensity` semantics? | Multiplicative, Vicidial-parity, ±20% range |
| Q5 | First-tick blocking on E05? | Proceed with 0.0; log; page if missing >60 s |
| Q6 | Warm-up: zero-controller or zero-integral? | Freeze controller entirely; hard-cap remains live |
| Q7 | Patent-risk legal review checkpoint? | Required before go-live; block field in HANDOFF |
| Q8 | `auto_dial_level` semantics? | Starting level for ADAPT_*; E03 reads once on cold-start; does not write back to MySQL |
| Q9 | Tick-lock metric label consistency? | Use `reason` label name, same as E02 |
| Q10 | ADAPT_HARD integral during raise phase? | Zero throughout; keeps HARD predictable |
| Q11 | F02 amendment columns? | All 9 in one migration |
| Q12 | E04 interaction? | No direct wire needed; E04→E05 (drop recording); E03 has no E04 dependency |
| Q13 | Diagnostics stream? | Yes: `adapt_decisions` STREAM, MAXLEN 5760 (24h at 15s) |
| Q14 | Pause/resume semantics? | Freeze controller state; resume from frozen; no re-warm-up |

---

## 18. HANDOFF Requirements

The E03 IMPLEMENT agent must produce a `HANDOFF.md` covering:

1. All AC items (§16) with test result summary.
2. DESIGN.md §6.4 ADAPT_TAPERED formula correction — note the typo and the corrected formula.
3. `DialMethod` enum: `ADAPT_HARD` (our code) maps to Vicidial's `ADAPT_HARD_LIMIT` (operator UI label only; M02 can display the Vicidial name while the DB stores `ADAPT_HARD`).
4. Architectural note: E03 uses a Go ticker (not a cron job) for the 15-s loop — different from Vicidial's cron + internal loop but functionally equivalent.
5. Legal review sign-off field.
6. Phase 3 roadmap: `adaptive_dl_diff_target` differential signal; Erlang-A patience-distribution modeling; shift timezone column.
7. Phase 4 roadmap: RL/bandit dial-level optimization (patent re-audit required); MPC.
8. Vicidial prior-art lineage statement for the record.
9. F04 amendment confirmation: `pace_state` HASH and `adapt:fastcut` lock key documented.
10. Open question for E05 team: confirm `drop_pct_30d` publish cadence (must be ≤ `adapt_tick_seconds`).

---

*End of E03 PLAN*
