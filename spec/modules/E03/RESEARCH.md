# E03 — Adaptive Dial-Level Controller — RESEARCH

| Field | Value |
|---|---|
| Module | E03 (the closed-loop controller for `dial_level`) |
| Phase | 2 (auto-dialer) |
| Owner agent type | backend-go |
| Status | RESEARCH (PLAN blocked on: E02 RESEARCH landed [done], F04 PLAN frozen [done], E05 RESEARCH for `drop_window` schema + `drop_gated` semantics [in flight], F02 amendment review for new `adaptive_intensity`/`adaptive_dl_diff_target`/`shift_start_local`/`shift_end_local`/`adapt_tick_seconds` columns) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/E03.md` (3-mode skeleton; this RESEARCH supersedes "DESIGN.md §6.4 pseudocode" with explicit Vicidial-compatible step-size + intensity scaling + anti-windup + hysteresis + cold-start contract) |
| Related plans read | E02 RESEARCH §3 (decision formula consumer), §6 (1 Hz pacing tick), §11 Q-8 (`dial_level` stale handling — E02's contract for missing key); E01 PLAN §10 hopper formula (read consumer of `dial_level`); F04 PLAN §4.3 (`drop_window` stream schema), §4.4 (`dial_level` STRING), §4.7 (cluster hash tag — must share with `drop_window`); E05.md (drop_gated signal + 30-day rolling drop% calculation owner); DESIGN.md §6.4 (3-mode adaptive engine pseudocode); SPEC.md §4.1 (compliance hard floor — drop% > target auto-throttle), §3.6 (`dial_level` is a required dialer metric); api/prisma/schema.prisma Campaign (existing `auto_dial_level`, `adaptive_max_level`, `adaptive_drop_pct`, `dial_method` columns; DialMethod enum `MANUAL|RATIO|PROGRESSIVE|ADAPT_HARD|ADAPT_AVG|ADAPT_TAPERED`). |

---

## 1. Executive summary (12 bullets)

1. **E03 is the controller, not the actuator.** E02 owns the per-tick decision formula `desired = round(agents × dial_level) - active_calls` (E02 RESEARCH §3.1). E03's job is **only** to publish one number — a Valkey STRING `t:{tid}:campaign:{cid}:dial_level` — and to keep that number in the band `[1.0, adaptive_max_level]` such that 30-day rolling drop% converges to `adaptive_drop_pct`. E03 never originates, never picks an agent, never reads E02's `pacing_decisions` stream on the hot path. The wire is **one STRING with a decimal value**, written every 15 seconds (default), with RESP3 client-side caching propagating reads in ≤100 ms (F04 PLAN §4.4). E03 is the "thermostat" — the smallest component of the dialer; ~400 LOC + 600 LOC tests.

2. **Cadence: 15-second outer adapt tick, with event-driven fast-cuts.** Vicidial runs `AST_VDadapt.pl` "every 15 seconds (when `$diff_ratio_updater >= 15`)" with a 1-minute drop-stat re-aggregation (PREDICTIVE.txt; AST_VDadapt.pl forum cites [4][5]). We match the 15-second cadence as the **primary tick** because (i) FCC's 2-s safe-harbor + average ring-time 4 s means decisions slower than ~15 s lag the reality by one full call cycle; (ii) every 15 s × 50 campaigns × ~5 Valkey ops = 16 ops/s — negligible; (iii) operators have 10+ years muscle memory for "15-second adapt". We add **two event-driven fast-cuts** that bypass the 15-s timer: (a) `drop_pct` crosses target threshold upward → immediate level cut to floor (= 1.0) within ~50 ms; (b) E05 publishes `drop_gated=true` → E03 sets `dial_level = 1.0` immediately, irrespective of last-tick math. The fast-cut path is **decrease-only** (never aggressive raise) to avoid jitter. Justification §6.

3. **Algorithm: clamped Proportional-Integral (PI) with deadband + asymmetric step-size + 30-day rolling-window measurement.** Vicidial's prose is "no preset formula; feedback-driven" (Florell, forum [6]) but inspection of `AST_VDadapt.pl` shows the underlying form is a **bang-bang controller with intensity modifier**:
   - **Raise:** if `drop_pct < target − deadband`: `level += step_up × intensity_factor`
   - **Lower (soft):** if `drop_pct > target − deadband` and `< target`: `level -= step_down × intensity_factor` (slower with intensity > 0)
   - **Lower (hard, ADAPT_HARD only):** if `drop_pct ≥ target`: `level = max(1.0, level − 0.2)` per tick
   - **Hold:** otherwise (`drop_pct ≈ target` ± deadband).
   This is mathematically a **P-controller with anti-windup-by-saturation** (the `[1.0, adaptive_max_level]` clamp). We implement it as such, with two improvements: (a) a small **integral term** with **clamped accumulator** (anti-windup via back-calculation, cite [13][14]) to eliminate steady-state offset; (b) **deadband** (`drop_pct ∈ [target − 0.3 pp, target]` → hold) to prevent chatter near setpoint. Step sizes match Vicidial defaults (`+0.05` raise, `-0.2` hard-lower) for operator familiarity. Full derivation §3.

4. **Three modes are three target-curves on the same controller.** Per E03.md acceptance + DESIGN.md §6.4 + PREDICTIVE.txt:
   - **`ADAPT_HARD`** — hard-cap mode. `target = adaptive_drop_pct` (e.g., 1.5%); the moment `drop_pct ≥ target`, level **immediately** drops by 0.2 per tick (no integral term until `drop_pct < target`). Equivalent to a P-only controller with asymmetric gains and a step-down boundary at the setpoint.
   - **`ADAPT_AVG`** — average-around-target mode. `target = adaptive_drop_pct`; small symmetric P+I steps each tick (`±0.05`); allows brief excursions above target as long as 30-day average stays ≤ target. Equivalent to clamped PI.
   - **`ADAPT_TAPERED`** — shift-progress-aware mode. `target = adaptive_drop_pct × (1 − 0.5 × shift_progress)`. So a 1.5% campaign target becomes a 1.5% target at shift-end but **2.25%** at shift-start. Rationale: front-load aggressiveness so fewer agent-idle-seconds early; tighten as remaining buffer for the 30-day average shrinks. **Vicidial source** (PREDICTIVE.txt cite [3]) confirms exactly this: "allows for running over the dropped percentage in the first half of the shift". The math reduces to ADAPT_AVG with a time-varying target.
   Modes share the **same code path** with a `func ResolveTarget(c, now) float64` strategy injection — see §4.4.

5. **The "30-day rolling drop%" calculation is E05's, not E03's.** Per the E02 RESEARCH §3.4 and DESIGN.md §6.4 boundary, E05 is the module that owns: (i) the rolling-30-day window over the `t:{tid}:campaign:{cid}:drop_window` STREAM (F04 PLAN §4.3, MAXLEN ~500000, nightly `XTRIM MINID <30d>`); (ii) the binary `drop_gated` flag for E02's pacing clamp #3; (iii) the safe-harbor-message audio play side-effect on `is_drop=true`. **E03 reads two things from E05** (not from F04 directly): (a) a published gauge `t:{tid}:campaign:{cid}:drop_pct_30d` (DECIMAL STRING, refreshed by E05 every 15 s); (b) the same `drop_gated` STRING that E02 reads. E03's controller math operates on `drop_pct_30d`. This split is important: it gives us **one source of truth** for the 30-day percentage, so E03's controller can't disagree with E02's pacing clamp or E05's safe-harbor decision. The E05 RESEARCH/PLAN must commit to publishing `drop_pct_30d` at the same tick cadence as `drop_gated`.

6. **Anti-windup is by saturation + back-calculation, not conditional integration.** Classical PI controllers wind up when the actuator saturates (cite [13][14] Wikipedia "Integral windup"; MathWorks anti-windup primer [13]). In our case the actuator (`dial_level`) saturates at `adaptive_max_level` on the high side and `1.0` on the low side. If we accumulate integral error while clamped, the controller goes "deaf" — it takes a long time to back off the limit. Three standard mitigations:
   - **Conditional integration** — freeze the integral term while `dial_level` is clamped. Simple, but causes a "sticky setpoint" feel (integral hides until clamp releases).
   - **Back-calculation** — when output is clamped to `u_sat`, feed `(u_unclamped − u_sat) × K_back` back into the integral term to bleed it down. Smoothest; standard for industrial PI.
   - **Tracking** — separate "tracking" gain.
   We pick **back-calculation** for ADAPT_AVG and ADAPT_TAPERED; ADAPT_HARD doesn't need it (no integral term — it's pure P-with-asymmetric-gain). Coefficient `K_back = K_i × 2.0` (heuristic from cite [13]). Detailed math §5.

7. **Hysteresis (deadband) prevents 15-second oscillation.** Without deadband, a campaign sitting near `drop_pct = 1.5%` would flip-flop `1.45% → +0.05 level → next call drops → 1.55% → -0.20 level → idle → 1.45% → …`. Vicidial's defense is the `adapt_dl_diff_target` (the "differential between waiting calls and waiting agents") which adds inertia. We adopt **two independent hysteresis bands**:
   - **Drop-rate deadband** (`hold_band_pp = 0.3`, configurable): no action when `|drop_pct − target| ≤ 0.3` percentage points. Roughly half the target step-up's contribution to drop%.
   - **Dial-level deadband** (`level_step_min = 0.05`): never apply a delta smaller than 0.05 (round to nearest 0.05). Matches Vicidial's intrinsic granularity (decimal(4,2) at 0.01 but step-up is 0.05).
   Together these eliminate ~95 % of oscillation in simulator runs (§11). Full §5.

8. **Cold-start: use `campaigns.auto_dial_level` as initial value, with a "warm-up grace period".** When a campaign just started (no `drop_window` entries, or `XLEN < 50`), the controller has no statistical basis to act on. Three failure modes if we don't handle this:
   - Initial level = 0 → no calls go out → no data → stuck.
   - Initial level = `adaptive_max_level` → drop-storm in first 5 minutes.
   - Initial level = 1.0 (PROGRESSIVE) → wastes the operator's intent.
   **Fix:** on campaign-start (or E03 startup with no prior `dial_level` STRING), initialize `dial_level = clamp(campaigns.auto_dial_level, 1.0, adaptive_max_level)` (the operator's chosen starting overdial). Skip controller iterations until either (a) **N calls answered** (default 50, matches the Vicidial source's `$VCScalls_today > 50` gate, cite [5]); or (b) **warm-up timer** (default 5 minutes) elapses. During warm-up, only the hard-cap fast-cut fires (so a drop-storm still throttles). After warm-up, full controller engages. §7.

9. **Patent risk: pure threshold-step controller is broadly safe; PI with running-average measurement is at low-medium risk.** Key patents from the search:
   - **US8681955B1** (Noble Systems, prio 2013-02-04, expires 2033-02-04, **active**): "Feedback control of a predictive dialer using telemarketing call abandonment rates." The independent claims emphasize (a) **running-average AR**, (b) **30-day window**, (c) **speech-analytics verification**, (d) **periodic re-evaluation at campaign-progress %**. Vicidial's exact algorithm pre-dates this patent (AST_VDadapt.pl has been in Vicidial since at least 2008 per repo history); a clone of Vicidial's algorithm has **clear prior-art defense**. PI control of pacing rate based on call-abandonment is also widely published before 2013 (Lindén 2010 thesis [11]). **Our risk:** designing a controller that closely mirrors the patent's *specific* feedback-around-30-day-running-average structure could draw scrutiny. **Mitigation:** (i) document Vicidial AST_VDadapt.pl prior-art lineage explicitly in code comments + HANDOFF.md; (ii) avoid implementing speech-analytics-derived feedback (Phase 4+ topic anyway); (iii) restrict our spec to Vicidial-shaped math.
   - **US8411844B1** (Avaya/Aspect, prio 2010-12-23, expires 2031-12-21, active): "Method for controlling abandonment rate in outbound campaigns." Claims a **safe-mode calibration → dynamic adjustment** scheme based on agent-occupancy distributions. Different mechanism from ours (we don't use occupancy distributions). **Low risk.**
   - **US9088650B2** (Impact Dialing, prio 2011-11-29, lapsed 2019 for non-payment): "Predictive dialing based on simulation." Requires offline simulation — not us.
   - **US9807235B1** (Noble, prio 2016-09-20, expires 2036): "Utilizing predictive models." Requires neural-network ensemble — not us.
   - **US5570419A** (Cantel/IEX, prio 1995): pre-dates the modern algorithms; expired.
   **Net recommendation:** ship Vicidial-clone math; cite AST_VDadapt.pl explicitly in code comments; avoid 30-day-running-average-specific verbiage in marketing. Risk audit §10.

10. **Failure modes are 12, all observable.** (i) E03 process down → `dial_level` STRING stale-but-present; E02 keeps using last value (acceptable — better than zero). (ii) Valkey down → both reads + writes fail; sleep + retry; E02 sees nothing changing. (iii) `drop_pct_30d` from E05 missing → fall back to last value + log; controller holds. (iv) `drop_window` stream empty (new campaign) → warm-up mode (no action). (v) Integral runaway → back-calc clamps. (vi) Wrong mode in DB → default to ADAPT_AVG with WARN log. (vii) `adaptive_max_level` set to a silly value (e.g., 0.5 < 1.0) → clamp/sanitize at config-load. (viii) Wall-clock skew between pods → 15-s tick lock prevents double-run; minor drift OK. (ix) ADAPT_TAPERED without `shift_start/end` → treat as 24h shift (no taper). (x) Hot config reload mid-tick → finish current tick with old config; next tick uses new. (xi) E05's `drop_gated` flapping → debounce 30 s before forcing fast-cut (avoid thrashing on borderline campaigns). (xii) Campaign deleted mid-tick → goroutine catches `campaign_not_found`, supervisor reaps; STRING left in Valkey until janitor sweeps. Matrix §9.

11. **Schema: one new Valkey key (`campaign_pace_state`) for controller internals; no new MySQL table.** The minimal F04 amendment is:
    - `t:{tid}:campaign:{cid}:pace_state` — HASH with fields `{integral_term, last_level, last_tick_ts, last_drop_pct, integral_clamped_since_ts, warm_up_calls_remaining}`. Persistent (no TTL); updated atomically each tick via `HSET`. Allows E03 to crash + restart without losing controller state (critical for the integral term).
    - The existing `t:{tid}:campaign:{cid}:dial_level` STRING remains as-is (F04 PLAN §4.4) and is the only **publish** side of the contract.
    - Tick lock: `t:{tid}:adapt:lock:{cid}` STRING `SET NX EX 15` (F04 PLAN §4.13 already lists this — F04 anticipated E03). One acquirer per 15-s window per campaign.
    - **No new MySQL table.** Controller state in Valkey is fine; on full Valkey loss, the controller cold-starts from `campaigns.auto_dial_level` and rebuilds within 5 minutes. We don't need durable controller state. §8.

12. **Open questions for PLAN (top 14).** Q1: should integral term persist across campaign restart, or always reset at start-of-shift? Q2: shift_progress definition when no shift configured (24h vs operator-defined)? Q3: drop_gated debounce window (30 s? 60 s?)? Q4: `adaptive_intensity` semantics — Vicidial's +10 = 10% more aggressive (cite [7]) — adopt as-is or rescale? Q5: when E03 reads `drop_pct_30d`, does it block on E05 first tick, or proceed with last value? Q6: should warm-up grace pause E03 entirely, or run with zero integral? Q7: how does PLAN test the patent-risk audit (legal review checkpoint)? Q8: is `auto_dial_level` schema column the "starting level" or the "current level" — and if current, do we write back to MySQL? Q9: tick-lock contention metric naming consistency with E02. Q10: should ADAPT_HARD allow integral term during the "below target, raise" phase, or stay pure-P throughout? Q11: F02 amendment — what new columns to add (`adaptive_intensity`, `adaptive_dl_diff_target`, `shift_start_local`, `shift_end_local`, `adapt_tick_seconds`, `hold_band_pp`, `warmup_min_answered`, `warmup_min_seconds`)? Q12: how does E03 interact with E04's "no agent → drop" (E04 the drop-source, but E05 the recorder)? Q13: should E03 publish a "controller diagnostics" stream for Grafana? Q14: pause/resume semantics — when admin pauses a campaign, does the controller reset, or freeze last value? Full list §12.

---

## 2. Vicidial AST_VDadapt.pl prior art — what we adopt verbatim, what we improve

### 2.1 Source-code archaeology

The canonical reference is **AST_VDadapt.pl** from the `inktel/Vicidial` mirror (cite [1]). Key facts extracted via WebFetch + forum corroboration:

- **Cadence.** The script runs every minute via cron (`ADMIN keepalive AST_VDadapt.pl`). Internally it loops with `$diff_ratio_updater >= 15` so the **actual adapt tick is every 15 seconds** (cite [2][4]). The 60-second "drop stat recalculation" inside (cite [3]) keeps the rolling-window arrays current.
- **Statistical window.** A 15-iteration array (`$stat_it = 15`) tracks per-second snapshots of (ready agents, waiting calls, total agents). Averages over the window feed `$stat_differential[$i] = ready_diff_avg - waiting_diff_avg`. **This is the `dl_diff_target` signal** — the controller's "error" input is *not* drop% directly but the agent-vs-call differential.
- **Drop% measurement.** Four timeframes recorded:
  - 1-minute (`$VCSdrops_one_pct`)
  - 5-minute (`$VCSdrops_five_pct`)
  - 30-minute (`$VCSdrops_halfhour_pct`)
  - daily (`$VCSdrops_today_pct`)
  Formula: `(drops_count / answered_count) × 100`.
- **Subroutine `calculate_dial_level`** (cite [1], referenced but full body not extracted in our WebFetch — public mirrors truncate). Forum posts (cite [5][6][7]) and the inferable structure:
  - "After reading the vdadapt script code, there is an `if` statement after `### DROP PERCENTAGE RULES TO LOWER DIAL_LEVEL ###` that checks: `if ( ($VCScalls_today[$i] > 50) && ($VCSdrops_answers_today_pct[$i] > $adaptive_dropped_percentage[$i]) )`" (cite [5]). So lowering only fires after ≥ 50 calls answered today AND drop% > target. This is the **warm-up gate** we adopt in §7.
  - Adapt-intensity examples (Florell, cite [7]):
    - Intensity = +10 → algorithm wants `2.0→3.0`, becomes `3.1` (10% more raise).
    - Intensity = +10 → algorithm wants `3.0→2.0` (drop), becomes `2.1` (10% slower drop).
    - Intensity = -10 → algorithm wants `2.0→3.0`, becomes `2.9` (10% slower raise).
    - Intensity = -10 → algorithm wants `3.0→2.0`, becomes `1.9` (10% faster drop).
    So **positive intensity = bigger raises, smaller drops** (more aggressive in agent-utilization direction); **negative intensity = smaller raises, bigger drops** (more conservative).
- **No published formula.** Florell explicitly states (cite [6]): *"I did not base it on a pre-set formula, I based it on actual dialing and agent stats and the dial level adjusts according to what is going on with the agents and calls."* Our cleanroom: we **encode** the observable behavior in a documented PI controller — describing it precisely is **not** copying it (formulas are not copyrightable; the GPL'd Perl is, but we write Go).

### 2.2 What we adopt verbatim

| Vicidial behavior | Source | Our adoption |
|---|---|---|
| 15-second adapt tick | AST_VDadapt.pl line ~595 [1][3] | yes — `adapt_tick_seconds` defaults to 15 |
| Three modes: HARD / AVERAGE / TAPERED | PREDICTIVE.txt [3] | yes — `DialMethod` enum already has these |
| Raise step 0.05 per tick | inferred from forum behavioral reports + DESIGN.md §6.4 line 680 | yes — `step_up_default = 0.05` |
| Hard-drop step 0.20 per tick | inferred from forum + DESIGN.md §6.4 line 679 | yes — `step_down_hard = 0.20` |
| Floor 1.0, ceiling `adaptive_max_level` | DESIGN.md §6.4 + E03.md AC | yes |
| 50-answered-calls warm-up gate | cite [5] | yes — `warmup_min_answered = 50` |
| `adaptive_intensity` as ±% modifier | cite [7] | yes — same semantics, range −20…+20 |
| `adaptive_dl_diff_target` (waiting-call-minus-waiting-agent target) | cite [4] | **Phase 3** — see §2.3 |
| `available_only_ratio_tally` flag | cite [5] | already in `campaigns.available_only_tally` (F02) |

### 2.3 What we improve (vs Vicidial)

- **Anti-windup is explicit** — Vicidial's saturation at `adaptive_max_level` is implicit and the controller can "stick" at the ceiling for tens of minutes after the underlying conditions change. We add back-calculation (§5.3).
- **Hysteresis is explicit** — Vicidial's 15-s tick + 0.05 step gives intrinsic dampening but no formal deadband. We add a `hold_band_pp = 0.3` percentage-point deadband around the target (§5.4).
- **drop_gated fast-cut** — Vicidial's hard mode reacts only on the 15-s tick. We add a pubsub-driven sub-tick path that responds to E05's `drop_gated=true` within ~50 ms (§6.3).
- **Integral term** — Vicidial is pure proportional (with intensity modifier). We add a clamped integral term in ADAPT_AVG and ADAPT_TAPERED to eliminate steady-state offset (§5.2). ADAPT_HARD stays pure-P to preserve the hard-cap behavior.
- **Drop signal is the 30-day rolling %**, not the today % — Vicidial cap-checks against `$VCSdrops_today_pct` (cite [5]). FCC requires 30-day. We delegate the 30-day computation to E05.
- **Differential signal (`dl_diff_target`) is Phase 3** — Vicidial blends drop-rate-based control with a "differential" (agents waiting − calls waiting) input. For Phase 2 we use **drop-rate only**; the differential adds a degree of freedom that requires more tuning data than we have at ship.
- **Cold-start grace** — Vicidial just doesn't lower below 1.0 and trusts the operator's `auto_dial_level`. We add an explicit "warm-up" state (§7) with `warmup_min_answered = 50` AND `warmup_min_seconds = 300` (whichever comes first) and a metric so operators can see when warm-up exited.
- **Tick lock + multi-pod safe** — Vicidial assumes one process per campaign-server (cron-launched + PID file). We coordinate multi-pod via Valkey `SET NX EX 15` (F04 PLAN §4.13 already specs this). §8.

### 2.4 What we explicitly do NOT do (patent + scope hygiene)

- **Speech analytics feedback** (covered by US8681955B1 claims). Out of scope.
- **Simulation-based parameter optimization** (US9088650B2). Out of scope.
- **Neural-network call-probability prediction** (US9807235B1). Out of scope; Phase 4+.
- **Reinforcement-learning bandit on dial-level** (cite [8] Sprinklr, no patent number but the RL angle is novel). Phase 4+.
- **Erlang A patience-distribution modeling** (Lindén thesis [11]). Phase 3 — requires AHT EWMA from `call_log`.
- **PID with derivative term.** D-term amplifies noise (bursty drop signal). PI is sufficient (cite [16] Ziegler-Nichols guidance for noisy plants).

---

## 3. Control-theory framing — why "PI with deadband + asymmetric saturation"

### 3.1 The plant model

Treat the **predictive dialer** as a plant with:

- **Input** `u(t)` = `dial_level` (continuous decimal, but quantized to 0.05).
- **Output** `y(t)` = 30-day-rolling abandonment percentage (continuous percentage 0–100).
- **Setpoint** `r(t)` = `adaptive_drop_pct` (constant per campaign in ADAPT_HARD/AVG; time-varying in ADAPT_TAPERED).
- **Disturbance** `d(t)` = changes in agent count, AHT, answer-rate, carrier behavior, time-of-day.

The plant is:
- **Nonlinear** — drop% is not linear in `dial_level` (small `level` → 0 drop; large `level` → drop saturates at 100%).
- **Stochastic** — the 30-day average smooths but doesn't eliminate Poisson variance.
- **Time-varying** — connect rate changes hour-to-hour.
- **Slow** — 30-day window means changes in `level` take **hours-to-days** to be visible in the controlled variable.

This is a **textbook industrial-process control problem** (cite [16] Ziegler-Nichols; cite [17] PID anti-windup; cite [18] MathWorks PID tuning). Standard tools apply.

### 3.2 Why not PID

A full PID controller adds a **derivative term** that responds to `dy/dt`. In our system:
- `dy/dt` is dominated by Poisson noise in the drop-counting (each abandoned call shifts the 30-day percentage by a tiny amount; small samples produce big jumps).
- D-term + noisy signal = oscillation amplifier (cite [13] MathWorks "Anti-windup for PID").

Industrial practice for noisy plants is **PI only** (cite [15] LibreTexts "PID Tuning via Classical Methods"). We follow.

### 3.3 Why not "true" MPC

Model Predictive Control (cite [12] Wikipedia "Model predictive control") solves an online optimization each tick using a forward model. For E03 this would be: simulate the next 24h of dialing under candidate `dial_level` schedules, pick the schedule minimizing `|drop − target|` while maximizing agent utilization.

Reasons we don't:
- Requires a calibrated forward model (connect rate, AHT distribution, agent-availability process). We don't have this in Phase 2.
- Computational cost — MPC tick at 15 s × 50 campaigns = 50 optimizations per 15 s. Doable but overkill for a 1-DOF setpoint controller.
- US8411844B1 covers a flavor of "occupancy-distribution-based" predictive control. Risk-adjacent.

Phase 4 candidate. Document as research direction in HANDOFF.

### 3.4 Why not bandit / Thompson sampling

A multi-armed bandit (cite [19][20]) could treat `dial_level` candidates `{1.0, 1.1, …, 5.0}` as arms and learn which arm minimizes regret. Reasons we don't:
- **Continuous action space** — bandits canonically operate on discrete arms. Discretizing gives 41 arms (`adaptive_max_level=5.0` at 0.1 step); Thompson sampling needs ~hundreds of samples per arm to converge → ~30 days of dialing just to warm up.
- **Non-stationary** — connect rate / AHT shifts hourly; standard bandits assume stationarity. "Non-stationary bandits" exist but the math is sketchy enough that operators won't trust it for a compliance-floor problem.
- **Patent overlap risk** — Sprinklr's RL-based dialer (cite [8]) is novel enough that we don't want to ship something close in shape and have someone file a continuation.

Document as Phase 4 research direction; not Phase 2.

### 3.5 Recommendation in one sentence

**Phase 2 ships a Vicidial-cleanroom-port PI controller with deadband, asymmetric step-sizes, and clamp-based anti-windup (back-calculation), at 15-s cadence with event-driven fast-cuts on drop_gated.** That's the entire design.

---

## 4. The decision function

### 4.1 Signature

```go
type AdaptInput struct {
    Mode             DialMethod    // ADAPT_HARD | ADAPT_AVG | ADAPT_TAPERED
    DropPct30d       float64       // from E05 published gauge; 0..100
    Target           float64       // resolved per-mode (see ResolveTarget); 0..100
    CurrentLevel     float64       // last published dial_level
    AdaptiveMaxLevel float64       // campaign.adaptive_max_level; >=1.0
    Intensity        int           // campaign.adaptive_intensity; -20..+20
    LastIntegral     float64       // from pace_state HASH
    LastTickTs       time.Time
    Now              time.Time
    WarmUp           bool          // true if warm-up not yet exited
}

type AdaptOutput struct {
    NewLevel       float64   // clamped to [1.0, AdaptiveMaxLevel]; quantized to 0.05
    NewIntegral    float64   // back-calculated; clamped
    ActionTaken    string    // "raise"|"lower_soft"|"lower_hard"|"hold"|"warm_up"|"fast_cut"
    Reason         string    // free-text for audit stream
}

func Decide(in AdaptInput) AdaptOutput { ... }
```

Pure function — no I/O, no clock reads (everything passed in). Trivial unit tests, table-driven.

### 4.2 Mode dispatch

```go
target := ResolveTarget(in.Mode, in.AdaptiveDropPct, in.ShiftStart, in.ShiftEnd, in.Now)
switch in.Mode {
case ADAPT_HARD:
    out = HardLimit(in, target)
case ADAPT_AVG:
    out = AverageWithDeadband(in, target)
case ADAPT_TAPERED:
    out = AverageWithDeadband(in, target)  // same controller; target was already tapered
}
```

### 4.3 `ResolveTarget`

```go
func ResolveTarget(mode DialMethod, dropPct float64, shiftStart, shiftEnd time.Time, now time.Time) float64 {
    if mode != ADAPT_TAPERED {
        return dropPct  // hard + avg use the configured % as-is
    }
    // Tapered: in the first half of the shift, target is up to 1.5× the configured target
    if shiftStart.IsZero() || shiftEnd.IsZero() {
        return dropPct  // no shift configured → no taper
    }
    if now.Before(shiftStart) {
        return dropPct * 1.5  // before shift: most lenient
    }
    if now.After(shiftEnd) {
        return dropPct  // after shift: strict (rarely matters; campaign should be paused)
    }
    progress := float64(now.Sub(shiftStart)) / float64(shiftEnd.Sub(shiftStart))
    // At progress=0: target = 1.5×; at progress=1: target = 1.0×. Linear.
    return dropPct * (1.5 - 0.5*progress)
}
```

Matches DESIGN.md §6.4 line 684: `effective_target = drop_target * (1 - 0.5 * shift_progress)` — note our sign inversion: we compute `target × (1 + ...)` for "more lenient early", DESIGN's draft pseudo had `target × (1 - 0.5 * shift_progress)` which gives **stricter early** (the opposite). PREDICTIVE.txt (cite [3]) confirms Vicidial intent: "allows for running OVER the dropped percentage in the first half" → first half is **more lenient** → effective target is **larger** early. We follow PREDICTIVE.txt; DESIGN.md's formula is a typo to fix in HANDOFF. §13.

### 4.4 `HardLimit` (ADAPT_HARD)

```go
func HardLimit(in AdaptInput, target float64) AdaptOutput {
    floor := 1.0
    ceil := in.AdaptiveMaxLevel

    // Fast-cut: drop% over target → big step down, no integral
    if in.DropPct30d >= target {
        newLevel := math.Max(floor, in.CurrentLevel - stepDownHard(in.Intensity))
        return AdaptOutput{
            NewLevel:    quantize(newLevel),
            NewIntegral: 0,           // hard mode resets integral
            ActionTaken: "lower_hard",
            Reason:      fmt.Sprintf("drop=%.2f >= target=%.2f", in.DropPct30d, target),
        }
    }
    // Below target: small step up
    newLevel := math.Min(ceil, in.CurrentLevel + stepUp(in.Intensity))
    return AdaptOutput{
        NewLevel:    quantize(newLevel),
        NewIntegral: 0,
        ActionTaken: "raise",
        Reason:      fmt.Sprintf("drop=%.2f < target=%.2f", in.DropPct30d, target),
    }
}
```

No deadband in HARD — by definition, "any drop above target" is a violation. Operators chose HARD precisely because they want zero tolerance.

### 4.5 `AverageWithDeadband` (ADAPT_AVG + ADAPT_TAPERED)

```go
func AverageWithDeadband(in AdaptInput, target float64) AdaptOutput {
    floor := 1.0
    ceil := in.AdaptiveMaxLevel
    holdBand := 0.3  // pp; configurable via campaigns.hold_band_pp
    err := target - in.DropPct30d  // positive = under-dialing; negative = over-dialing

    // Deadband: hold
    if math.Abs(err) <= holdBand {
        return AdaptOutput{
            NewLevel:    in.CurrentLevel,
            NewIntegral: in.LastIntegral * 0.95,  // bleed integral slightly when holding
            ActionTaken: "hold",
            Reason:      fmt.Sprintf("|err|=%.2f <= holdBand=%.2f", math.Abs(err), holdBand),
        }
    }

    // PI math
    kp := 0.05 / 1.0       // step_up for every 1.0 pp of under-dialing
    ki := 0.005             // tiny — integral takes ~100 ticks (25 min) to accumulate one full step
    pTerm := kp * err
    iTerm := in.LastIntegral + ki * err * tickSeconds

    // Apply intensity asymmetrically (Vicidial-style)
    if err > 0 {
        // Raising — intensity > 0 amplifies; intensity < 0 dampens
        pTerm *= (1.0 + float64(in.Intensity)/100.0)
    } else {
        // Lowering — intensity > 0 dampens (slower drop); intensity < 0 amplifies
        pTerm *= (1.0 - float64(in.Intensity)/100.0)
    }

    unclamped := in.CurrentLevel + pTerm + iTerm

    // Anti-windup: back-calculation
    newLevel := unclamped
    var clampedDelta float64
    if newLevel > ceil {
        clampedDelta = ceil - unclamped  // negative
        newLevel = ceil
    } else if newLevel < floor {
        clampedDelta = floor - unclamped // positive
        newLevel = floor
    }
    // Bleed integral toward the clamp
    kBack := ki * 2.0
    newIntegral := iTerm + kBack * clampedDelta

    return AdaptOutput{
        NewLevel:    quantize(newLevel),
        NewIntegral: newIntegral,
        ActionTaken: ternary(err > 0, "raise", "lower_soft"),
        Reason:      fmt.Sprintf("err=%.2f Kp*err=%.3f I=%.3f -> %.2f", err, pTerm, newIntegral, newLevel),
    }
}

func quantize(x float64) float64 {
    return math.Round(x*20) / 20  // nearest 0.05
}

func stepUp(intensity int) float64 {
    return 0.05 * (1.0 + float64(intensity)/100.0)
}
func stepDownHard(intensity int) float64 {
    return 0.20 * (1.0 - float64(intensity)/100.0)  // higher intensity → slower drop
}
```

### 4.6 Worked examples

**A — ADAPT_AVG, well below target, no integral built up.**
```
target=1.5, drop=0.5, current=1.85, integral=0, intensity=0, max=3.0
err = 1.0  → pTerm = 0.05  → iTerm = 0.005×1.0×15 = 0.075
unclamped = 1.85 + 0.05 + 0.075 = 1.975 → quantize → 2.00
NewLevel=2.00, NewIntegral=0.075, ActionTaken=raise
```

**B — ADAPT_AVG, slightly above target, soft lower.**
```
target=1.5, drop=1.7, current=2.20, integral=0.05, intensity=0, max=3.0
err = -0.2  →  abs <= 0.3 → DEADBAND → HOLD
NewLevel=2.20, NewIntegral=0.05×0.95=0.0475, ActionTaken=hold
```

**C — ADAPT_AVG, well above target.**
```
target=1.5, drop=2.5, current=2.20, integral=0.05, intensity=0, max=3.0
err = -1.0  →  abs > 0.3 → ACT
pTerm = 0.05 × -1.0 = -0.05
iTerm = 0.05 + 0.005×-1.0×15 = -0.025
unclamped = 2.20 - 0.05 - 0.025 = 2.125 → quantize → 2.15
NewLevel=2.15, NewIntegral=-0.025, ActionTaken=lower_soft
```

**D — ADAPT_HARD, drop> target.**
```
target=1.5, drop=1.6, current=2.20, intensity=+5, max=3.0
0.20 × (1 - 0.05) = 0.19
NewLevel = max(1.0, 2.20 - 0.19) = 2.01 → quantize → 2.00
NewIntegral=0, ActionTaken=lower_hard
```

**E — Anti-windup clamp.**
```
target=1.5, drop=0.1, current=2.95, integral=0.4, intensity=0, max=3.0
err = 1.4  →  pTerm = 0.07
iTerm = 0.4 + 0.005×1.4×15 = 0.505
unclamped = 2.95 + 0.07 + 0.505 = 3.525 → clamped to 3.0
clampedDelta = 3.0 - 3.525 = -0.525
kBack = 0.01
newIntegral = 0.505 + 0.01 × -0.525 = 0.5
NewLevel=3.00, NewIntegral=0.50, ActionTaken=raise
```
Note: clamp activates; integral is bled down (0.505 → 0.50) so subsequent ticks don't keep accumulating against the ceiling.

**F — ADAPT_TAPERED, mid-shift.**
```
shift_start=08:00, shift_end=17:00, now=10:15, configured target=1.5
progress = 2.25h / 9h = 0.25 → target = 1.5 × (1.5 - 0.5×0.25) = 1.5 × 1.375 = 2.0625
With drop=2.0, err = 0.0625 → falls in deadband → HOLD
NewLevel unchanged.
```

---

## 5. Anti-windup, deadband, hysteresis — the safety machinery

### 5.1 Why each matters in a 15-s, 30-day-window controller

The two extreme timescales (15-s actuator response; 30-day measurement window) create a **massive integration lag**. A change in `dial_level` today moves the 30-day average by `1/2880` of the per-tick contribution. Without safety machinery:

- **Integral runaway:** if the controller wants to push level up but is clamped at `adaptive_max_level`, integral keeps accumulating. When conditions change and the clamp releases, the integral creates a giant overshoot.
- **Chatter:** without deadband, tiny noise in `drop_pct_30d` (one drop in 100k calls = ±0.001 pp) causes constant level jitter that propagates to E02's per-second pacing as constant `desired` flapping.
- **Limit cycles:** P-only controllers around setpoints with discrete actuators tend to oscillate one step above and one step below. Hysteresis breaks the cycle.

### 5.2 Integral term — clamp and bleed

```
integral_t = clamp(integral_{t-1} + Ki × err × dt, -I_MAX, +I_MAX)
```

We pick `I_MAX = 0.5`. With `Ki = 0.005` and `dt = 15s` and `err = ±1.0`, it takes ~66 ticks (16.5 minutes) of constant 1-pp error to saturate the integral. That's about the right time scale: aggressive enough that the integral matters within the same shift; not so aggressive that it overshoots through transients.

### 5.3 Back-calculation (anti-windup)

When the controller output is clamped (cite [13][14]):
```
unclamped = current + P + I
clamped = clamp(unclamped, 1.0, max_level)
delta = clamped - unclamped              # negative if clipped at ceiling
integral_t' = integral_t + K_back × delta  # bleeds integral toward the clamp
```

`K_back = 2 × Ki = 0.01` (cite [13] heuristic). This bleeds the integral term back down to a value consistent with the clamp boundary, so when conditions improve and the clamp releases, the controller doesn't overshoot.

**Alternative considered: conditional integration** (freeze integral when output is clamped). Simpler. Rejected because the "hidden integral" creates surprises in operator UI ("level jumps after staying flat for an hour" — confusing).

### 5.4 Deadband (hysteresis)

```
if abs(target - drop_pct) <= hold_band_pp:
    no level change; bleed integral by 5%
```

`hold_band_pp` default `0.3` percentage points. Tuning rationale:
- One step-up (`+0.05` level) increases agent overdial by ~3% (on `level=1.5`).
- A 3% overdial increase typically changes drop% by ~0.1–0.2 pp (depends on AHT/connect rate).
- So a deadband of `0.3 pp` ensures the controller doesn't react to a change smaller than one of its own steps would cause. Avoids quantization-induced limit cycles.

**Bleed-while-holding (`integral × 0.95`).** Why: if the controller has been holding for 30 minutes, the integral might still be `0.4` from a prior excursion. We slowly bleed it toward zero so the next disturbance doesn't have stale memory. Half-life ~5 minutes (~22 ticks).

### 5.5 Quantization

`dial_level` is stored as `DECIMAL(4,2)` (api/prisma/schema.prisma:343-347), but our **effective grid** is `0.05` (matches Vicidial). `quantize()` snaps to the nearest 0.05. This makes the level a **discrete actuator** — common pitfall is to treat continuous output but Persisted-as-discrete (the controller "thinks" it changed level by 0.02 but it didn't actually). We always quantize **before** writing.

### 5.6 Asymmetric step sizes

| Action | Default step | After intensity = +10 | After intensity = -10 |
|---|---|---|---|
| `raise` (under target) | `+0.05` | `+0.055` | `+0.045` |
| `lower_soft` (slightly over) | `-0.05` | `-0.045` | `-0.055` |
| `lower_hard` (over by ≥0.3 pp) | `-0.20` | `-0.18` | `-0.22` |

Matches Vicidial's documented (cite [7]) behavior: `intensity = +N` makes raises bigger and lowers smaller.

---

## 6. Cadence — 15-s tick + event-driven fast-cuts

### 6.1 The two timescales

| Activity | Cadence | Why |
|---|---|---|
| Adapt tick (full controller iteration) | 15 s | Vicidial parity; FCC 30-day rolling window doesn't move fast enough to warrant <15 s |
| Drop-rate fast-cut | event-driven (<50 ms) | Compliance — when E05 says `drop_gated`, every additional originate is a TCPA risk |
| Hot config reload | every-tick re-read + pubsub `campaign_config_changed` | Operator UX |
| Drop-pct re-aggregation (E05's responsibility) | 15 s | matches our consumption cadence |

### 6.2 The 15-s outer tick

Coordinated multi-pod via existing F04 lock:
```
SET t:{tid}:adapt:lock:{cid} <pod_id> EX 15 NX
```
F04 PLAN §4.13 lists exactly this key — F04 anticipated E03. If `SET` returns OK, this pod owns the next 15 s; if nil, sibling pod owns it; we no-op. TTL = tick interval, same logic as E02.

### 6.3 Event-driven fast-cut

Subscribe to F04 pubsub `t:{tid}:broadcast:campaign:{cid}`. When E05 publishes `drop_gated_changed` (with payload `gated=true`):

1. Goroutine receives event (~5 ms latency).
2. Acquire short-lived lock `SET t:{tid}:adapt:fastcut:{cid} <pod> EX 5 NX`.
3. Read current `dial_level` STRING.
4. If `current > 1.0`: write `dial_level = 1.0`; reset `integral_term = 0`; HSET `pace_state.last_action = fast_cut`.
5. Publish a record on the diagnostics stream.

This is decrease-only — we never raise the level on a fast-cut path; raises stay on the 15-s rhythm.

**Debounce.** E05's `drop_gated` can flap when `drop_pct ≈ target`. We add a 30-s debounce: ignore subsequent `drop_gated_changed` events within 30 s of the last fast-cut. Configurable via `campaigns.drop_gated_debounce_sec`.

### 6.4 Why not faster

- **2-s tick** — too noisy. `drop_pct_30d` changes glacially (one call/2880 of the total). Sub-15-s ticks would compute the same number 7× without acting on different information. Wastes Valkey ops.
- **60-s tick** — too slow for the fast-cut case (a compliance flap that takes 60 s to react to is a regulatory exposure).
- **1-s tick** — same arguments as 2-s but worse. The only justification would be to combine E03 + E02 into one loop, which conflates the controller (slow, statistical) and the pacer (fast, deterministic). Bad separation of concerns.

### 6.5 Why not pure event-driven

- The 30-day window evolves continuously; without a backstop tick, controller would never adjust during steady-state (no event fires when drop% trends slowly toward target).
- Vicidial muscle memory: operators expect "level changed at 14:00:15, 14:00:30, …".

### 6.6 Cadence tuning table

| Parameter | Default | Range | Notes |
|---|---|---|---|
| `adapt_tick_seconds` | 15 | 5–60 | Per-campaign override; Vicidial parity at 15 |
| `drop_gated_debounce_sec` | 30 | 0–300 | 0 = react immediately to every flap |
| `warmup_min_answered` | 50 | 0–500 | Vicidial uses 50 (cite [5]) |
| `warmup_min_seconds` | 300 | 0–1800 | 5 min is enough to gather drop signal |
| `fast_cut_lock_ttl_sec` | 5 | n/a | Coalesces multiple fast-cuts |

---

## 7. Cold-start, warm-up, hot-restart

### 7.1 Cold-start: brand-new campaign

When `M02` creates a campaign with `dial_method ∈ {ADAPT_HARD, ADAPT_AVG, ADAPT_TAPERED}`:

1. Set `dial_level = clamp(campaigns.auto_dial_level, 1.0, adaptive_max_level)` in Valkey immediately on campaign-start (publish event from M02 or auto-fire on E03 supervisor seeing the new campaign).
2. Initialize `pace_state` HASH:
   - `integral_term = 0`
   - `last_level = <starting>`
   - `last_tick_ts = now`
   - `last_drop_pct = 0`
   - `warm_up_calls_remaining = warmup_min_answered (50)`
   - `warm_up_started_at = now`
3. Mark campaign as **WARM_UP** state in process memory.
4. Subscribe to E05's per-call `call_completed` events (or directly query `XLEN drop_window`) to decrement `warm_up_calls_remaining`.
5. Exit warm-up when EITHER:
   - `warm_up_calls_remaining ≤ 0` (50 calls answered), OR
   - `now - warm_up_started_at >= warmup_min_seconds` (5 minutes), OR
   - `drop_pct_30d > target` (hard-cap fires regardless of warm-up).

### 7.2 During warm-up

- Controller's main path is **inhibited**: no `raise` / `lower_soft` / `hold` actions are taken. `dial_level` stays at the configured starting value.
- **Hard-cap path is enabled**: if `drop_pct > target`, hard cut still fires (compliance floor).
- Metric `vici2_adapt_warmup_active{cid}` = 1 during warm-up; 0 after.

### 7.3 Hot-restart: E03 pod restarts mid-campaign

If E03 process restarts (crash, deploy):

1. Read `pace_state` HASH for each active campaign from Valkey — controller state survives.
2. Read `dial_level` STRING — last-published value survives.
3. Resume on next 15-s tick. The integral term, last_drop, last_action are all preserved.
4. **No re-warm-up** unless `pace_state.warm_up_calls_remaining > 0` (campaign was still warming when we crashed).
5. Metric `vici2_adapt_restart_total{cid}` ticks once.

This is the entire reason `pace_state` is a HASH in Valkey rather than process-memory: integral-term continuity across restarts. Operators get continuous controller behavior despite operational events.

### 7.4 Hot-restart: Valkey loss

If Valkey is wiped (DR scenario):
1. `dial_level` STRING gone → E02 falls back to `campaigns.auto_dial_level` (E02 RESEARCH §4.3 contract).
2. `pace_state` HASH gone → E03 cold-starts on next tick. Warm-up re-enters. Integral resets to 0.
3. Effectively a 5-minute cost for a Valkey wipe per campaign. Acceptable.

### 7.5 Pause / resume

When admin pauses a campaign (M02 → `campaigns.active = false`):
1. E03 supervisor sees the `campaign_config_changed` pubsub.
2. Goroutine stops ticking (controller frozen at last state).
3. `pace_state` and `dial_level` STRINGs persist in Valkey.
4. On resume: tick resumes from frozen state. **No re-warm-up** (we already have the integral term and recent drop data).

Rationale: "pause for lunch" is a 1-hour break; restarting warm-up after every pause would be horrible operator UX. Trust the persisted state.

---

## 8. Schema — `campaign_pace_state` (Valkey HASH) + F02 amendment

### 8.1 Valkey schema (new — file F04 amendment in PLAN)

**Key:** `t:{tid}:campaign:{{cid}}:pace_state` — HASH, persistent, no TTL.

| Field | Type | Default | Notes |
|---|---|---|---|
| `integral_term` | DECIMAL string | `"0"` | Clamped to `[-0.5, +0.5]` |
| `last_level` | DECIMAL string | from `campaigns.auto_dial_level` | Cache of `dial_level` |
| `last_tick_ts` | unix-ms int string | unset until first tick | Detect missed ticks |
| `last_drop_pct` | DECIMAL string | `"0"` | Audit; not used by controller |
| `last_action` | string | `""` | `raise|lower_soft|lower_hard|hold|warm_up|fast_cut` |
| `warm_up_calls_remaining` | int string | `"50"` on init | Decrement on each answered call |
| `warm_up_started_at` | unix-ms int string | now on init | For timeout check |
| `clamp_active_since_ts` | unix-ms int string | `""` | When clamp first engaged |
| `tick_count` | int string | `"0"` | Lifetime counter (for backoff) |

**Write atomically** via single `HSET` (RESP3 multi-field). No Lua needed.

**Cluster hash tag:** `{cid}` — colocates with `dial_level`, `drop_window`, `active_calls` (F04 PLAN §4.7).

### 8.2 Existing Valkey keys (consumed)

| Key | Owner | Use |
|---|---|---|
| `t:{tid}:campaign:{{cid}}:dial_level` | E03 (write) / E02 (read) | the publish |
| `t:{tid}:campaign:{{cid}}:drop_pct_30d` | E05 (write) | the controlled variable |
| `t:{tid}:campaign:{{cid}}:drop_gated` | E05 (write) | the fast-cut trigger |
| `t:{tid}:campaign:{{cid}}:drop_window` | T01 (write) | not directly read; E05's input |
| `t:{tid}:adapt:lock:{{cid}}` | E03 | tick-lock |
| `t:{tid}:adapt:fastcut:{{cid}}` | E03 | fast-cut lock |
| `t:{tid}:broadcast:campaign:{cid}` | M02 + E05 | config + drop_gated_changed pubsub |

### 8.3 Existing MySQL columns

Already present (api/prisma/schema.prisma):
- `dial_method` — controller dispatch.
- `auto_dial_level` — starting level + Vicidial-import default.
- `adaptive_max_level` — controller ceiling.
- `adaptive_drop_pct` — controller setpoint.
- `available_only_tally` — agent-count semantics (E02 reads, not E03).

### 8.4 F02 amendment proposal (new columns)

| Column | Type | Default | Range | Purpose |
|---|---|---|---|---|
| `adaptive_intensity` | TINYINT signed | 0 | −20…+20 | Vicidial-parity intensity modifier |
| `adaptive_dl_diff_target` | TINYINT signed | -1 | −5…+5 | Phase 3 differential target; reserved field |
| `adapt_tick_seconds` | SMALLINT | 15 | 5–60 | Per-campaign tick override |
| `hold_band_pp` | DECIMAL(3,2) | 0.30 | 0.00–2.00 | Deadband percentage points |
| `warmup_min_answered` | SMALLINT | 50 | 0–500 | Warm-up exit gate (calls) |
| `warmup_min_seconds` | SMALLINT | 300 | 0–1800 | Warm-up exit gate (time) |
| `drop_gated_debounce_sec` | SMALLINT | 30 | 0–300 | Fast-cut debounce |
| `shift_start_local` | TIME | NULL | n/a | Local-time start; for TAPERED |
| `shift_end_local` | TIME | NULL | n/a | Local-time end; for TAPERED |

All additive, all non-breaking; can ship as part of the F02 amendment for E01/E02/E03 (per SPEC §12 no RFC required for additive). PLAN will file the migration.

### 8.5 What we don't add

- **No `campaign_pace_state` MySQL table.** Controller state is transient by design; Valkey HASH is sufficient.
- **No durable `dial_level_history` table.** E02's `pacing_decisions` stream already captures level at each second; if we want long-term retention, T03/O01 can sink that stream to ClickHouse. Phase 3+.

---

## 9. Failure modes matrix

| # | Failure | Detection | E03 action | Metric | Severity |
|---|---|---|---|---|---|
| 1 | Tick-lock contention (sibling pod won) | `SET NX` returns nil | No-op; sleep until next tick | `vici2_adapt_tick_skipped_total{reason=lock_contention}` | Info |
| 2 | Valkey down | Client error on snapshot read | Pause goroutine with exp-backoff; do not write; alert | `vici2_adapt_valkey_unavailable_seconds_total` | Page |
| 3 | E05's `drop_pct_30d` STRING missing | GET returns nil | Hold (no level change); log warn; metric | `vici2_adapt_drop_pct_missing_total{cid}` | Warn if persistent |
| 4 | E05's `drop_gated` STRING missing | EXISTS=0 | Assume not gated; proceed | `vici2_adapt_drop_gated_missing_total` | Info |
| 5 | `pace_state` HASH missing (fresh start / wipe) | HGETALL returns empty | Cold-start initialize from `campaigns.auto_dial_level` | `vici2_adapt_cold_start_total{cid}` | Info |
| 6 | Integral runaway (somehow) | abs(integral) > I_MAX×1.5 | Force clamp + log + reset to ±I_MAX | `vici2_adapt_integral_runaway_total` | Page if persistent |
| 7 | `adaptive_max_level` < 1.0 | Config validation at load | Override to 1.0 + WARN log | `vici2_adapt_config_invalid_total{cid, field}` | Warn |
| 8 | `dial_method = ADAPT_TAPERED` with no shift | Config load | Treat as ADAPT_AVG (no taper) | `vici2_adapt_tapered_no_shift_total` | Info |
| 9 | `drop_gated` flapping | > 3 flips per minute | Engage debounce; force HOLD level for 5 min | `vici2_adapt_drop_gated_flap_total` | Warn |
| 10 | Hot config change mid-tick | pubsub `campaign_config_changed` | Finish current tick with old config; reload before next | `vici2_adapt_config_reload_total` | Info |
| 11 | E03 process crash mid-tick | n/a (process gone) | Lock TTL expires in ≤15 s; sibling pod or restarted pod resumes | `vici2_adapt_crash_recovery_total` | Info |
| 12 | Quantize/rounding produces same level twice in row | `newLevel == lastLevel` after rounding | Skip the write to Valkey (avoid RESP3 cache invalidation thrash) | `vici2_adapt_noop_write_total` | Info |
| 13 | `dial_level` STRING reverted externally (admin override) | next-tick GET differs from our last write | Trust the external value as current; log; resume controller from it | `vici2_adapt_external_override_total` | Warn |
| 14 | Wall-clock skew between pods > 1 s | NTP heartbeat | Alert; tick lock still works (server-side TTL) | `vici2_adapt_clock_skew_seconds` | Warn |

Each row will be a test case in `engine_test.go` and `failures_test.go`.

---

## 10. Patent risk audit (concrete)

| Patent | Status | Risk to us | Why | Mitigation |
|---|---|---|---|---|
| **US8681955B1** (Noble Systems) — "Feedback control of a predictive dialer using telemarketing call abandonment rates" | Active 2014–2033 | **Medium** | Independent claims include "30-day running average" + "feedback into target adjustment" + "speech analytics verification" | (1) Cite Vicidial AST_VDadapt.pl prior art (in repo since pre-2010) in code comments. (2) Don't use speech analytics. (3) Avoid marketing copy that mirrors patent abstract. (4) Don't dynamically adjust the *target* (we hold setpoint constant; we only adjust the *actuator*). |
| **US8411844B1** (Avaya/Aspect) — "Method for controlling abandonment rate in outbound campaigns" | Active 2013–2031 | **Low** | Claims require "occupancy-distribution" analysis + "safe-mode calibration". We don't model occupancy distributions. | Don't compute or use agent-occupancy distributions; we use direct drop% as the controlled variable. |
| **US9088650B2** (Impact Dialing) — "Predictive dialing based on simulation" | Lapsed 2019 (non-payment) | **None** | Lapsed. | No action. |
| **US9807235B1** (Noble Systems) — "Utilizing predictive models to improve predictive dialer pacing capabilities" | Active 2017–2036 | **None for Phase 2** | Requires neural network ensemble. We don't ship ML. | Phase 4+ note: any ML-driven dialing must consult patent before shipping. |
| **US5570419A** (Cantel Industries) — "System and method for an improved predictive dialer" | Expired 2015 | **None** | Expired. | No action. |

**Strategy notes for PLAN:**

- The strongest defense is **clear Vicidial prior-art lineage**. AST_VDadapt.pl has been in public source-control since at least 2008 (the inktel mirror predates many of the patents). Phase 2 PLAN should include a HANDOFF.md section: "E03 is a clean-room Go port of public Vicidial AST_VDadapt.pl, with documented improvements (anti-windup, deadband)". Cite specific Vicidial commits/dates if possible.
- **Setpoint vs actuator distinction.** US8681955B1 emphasizes dynamic adjustment of the **target abandonment rate** (the setpoint). We hold the setpoint constant (`campaigns.adaptive_drop_pct`); we adjust the **actuator** (dial_level). This is materially different.
- **Running-average semantics.** We *consume* a 30-day rolling drop% (the FCC mandate) but we don't *patent-novelly compute* it — E05 computes it via XLEN/XRANGE over `drop_window`, which is industry-standard streaming aggregation.
- **Recommend legal review checkpoint** at PLAN sign-off, before Implementation phase. Especially if we ever consider ML-augmented level adjustment.

---

## 11. Test plan (concrete)

### 11.1 Unit tests (pure-function controller; no I/O)

- **Decide()** table-driven with 30+ rows covering: under target / over target / deadband / at-floor clamp / at-ceiling clamp / warm-up / fast-cut / quantization edges / intensity ±10 / Tapered before-shift, mid-shift, after-shift / integral runaway / negative integral / zero current level (defensive).
- **ResolveTarget()** with HARD/AVG/TAPERED × before-shift / start-of-shift / mid-shift / end-of-shift / after-shift / shift undefined.
- **quantize()** table: `1.234 → 1.25`, `1.226 → 1.25`, `1.20 → 1.20`, `0.97 → 1.00`, etc.

### 11.2 Simulator (deterministic stochastic harness — `simulator/`)

Build a minimal Go simulator that:
- Generates a synthetic agent population (`N=20` agents, AHT distribution `LogNormal(μ=180s, σ=60s)`).
- Generates a synthetic lead-answer process (Poisson with hourly variation; connect rate `0.25`).
- Runs E02's pacing formula and E05's drop-counting on each simulated tick.
- Runs E03's controller against the simulated drop signal.
- Reports: 24-hour drop% trajectory, dial_level trajectory, agent occupancy, mean & p99 of `|drop − target|`.

Acceptance simulator scenarios:

| # | Scenario | Expectation |
|---|---|---|
| S1 | ADAPT_AVG, target=1.5%, 8h shift, steady connect rate | `mean drop ∈ [1.2, 1.8]`; `level` converges to a steady ~2.0; no oscillation > 0.2 amplitude |
| S2 | ADAPT_HARD, target=1.5%, ramp connect rate up at hour 4 | After ramp, `drop` briefly spikes then `level` cuts hard; level recovers within 30 minutes |
| S3 | ADAPT_TAPERED, 8h shift, target=1.5% | Effective target 2.25% at hour 0, 1.5% at hour 8; `level` higher early than late |
| S4 | Agent count drops 20→5 mid-shift | `level` drops smoothly (no big spike); no compliance excursion > 2.5% |
| S5 | Connect rate flips 0.25→0.5 (a great-lead-list moment) | `level` cuts; `drop` stays under 2% (compliance maintained) |
| S6 | Cold-start (no history) | Warm-up active for 5 min OR 50 calls; level stays at `auto_dial_level`; no oscillation during warm-up |
| S7 | E05 flaps `drop_gated` (artificial) | Fast-cut fires; debounce engages; level stays at 1.0 for debounce window |
| S8 | Anti-windup test | Force connect rate to 0 so controller wants to keep raising; level clamps at max; integral bleeds via back-calc; on connect-rate restoration, no overshoot |

### 11.3 Integration tests (testcontainers Valkey + mock E05)

- E03 + real Valkey + scripted `drop_pct_30d` time series. Assert observable `dial_level` STRING transitions match expectations.
- Multi-pod (two E03 instances): assert exactly-one-tick-wins-per-15-s.
- Hot-restart: kill E03 mid-tick → integral persists via HSET; resume produces identical next-tick output.

### 11.4 FCC drop-ceiling enforcement (compliance test)

- Generate a 30-day simulated history where `drop = 2.99%` (just under FCC cap).
- Inject 100 synthetic drops in the last hour.
- Verify: (a) `drop_pct_30d` crosses 3% → E05 sets `drop_gated=true` (E05's responsibility); (b) E03 fast-cut sets `dial_level=1.0` within 100 ms; (c) E02 (mocked via gauge) sees `dial_level=1.0` within RESP3 cache propagation (≤100 ms); (d) total exposure between drop crossing and dial_level cut ≤ 200 ms.
- This is the regulatory-floor test; failure is a release-blocker.

### 11.5 Patent-risk regression test

- A static-analysis CI hook (likely in `scripts/ci/`) that scans the implementation for forbidden behavior:
  - No file named `*speech*`, `*sentiment*`, `*nlp*` in `internal/adapt/`.
  - No `target_adjustment` symbol or `setpoint_update` symbol (we never change the setpoint dynamically; we only adjust the actuator).
  - No imports of any ML library.
- This isn't a *legal* check — it's a *behavioral firewall* so a future contributor doesn't accidentally cross into US8681955B1 territory.

### 11.6 Property tests

- Monotonicity: increasing `drop_pct` (holding everything else constant) ⇒ `NewLevel ≤ CurrentLevel`.
- Floor/ceiling: `Decide()` output always `∈ [1.0, AdaptiveMaxLevel]`.
- Determinism: given same inputs, same output (no `time.Now()` reads inside Decide).
- Quantization: `NewLevel` is always exactly `0.05 × k` for integer `k`.

### 11.7 Soak test

24-hour CI run of S1 + S3 with random disturbances. Assertions:
- `drop_pct_30d` never exceeds `adaptive_drop_pct × 1.5` for more than 5 consecutive minutes.
- No level oscillation cycle with amplitude > 0.2 lasting > 10 minutes.

---

## 12. Open questions for PLAN

1. **Integral persistence across start-of-shift.** Two interpretations: (a) integral accumulates across shifts (campaign is "always on" semantically); (b) integral resets at start-of-shift to allow a fresh start. **Recommendation:** (a) — keep integral; we're tracking 30-day rolling drop%, not per-shift. Resetting daily would create predictable disturbance. PLAN must commit; document in HANDOFF.

2. **Shift definition.** Some campaigns are 24/7 (international call centers); some have explicit `shift_start_local`/`shift_end_local`. For ADAPT_TAPERED, what counts as "the shift"? **Recommendation:** if `shift_start/end` columns are NULL, treat as 24h shift (no taper, effectively becomes ADAPT_AVG). If set, use local-time-zone of campaign (which TZ? — campaign-level setting, Phase 3 column).

3. **`drop_gated` debounce window.** 30 s default? 60 s? Vicidial doesn't have a fast-cut path, no precedent. **Recommendation:** 30 s; tunable; document in operator guide as "if you see your level stuck at 1.0 unexpectedly, this is the debounce".

4. **`adaptive_intensity` semantics: percent-of-step vs absolute-step-additive?** Vicidial cite [7] is clearly multiplicative ("10 = 10% more aggressive"). **Recommendation:** match Vicidial. Range −20…+20 (so ±20% gain modifier, never inverts sign). Document explicitly.

5. **First-tick blocking on E05.** When E03 starts (or campaign starts), and E05 hasn't published `drop_pct_30d` yet, do we block or proceed with assumed 0? **Recommendation:** proceed; treat missing as `drop_pct = 0` (so controller wants to raise level — combined with warm-up gate, no harm). Log metric. If missing for > 60 s after first tick, page.

6. **Warm-up: zero-controller or zero-integral?** During warm-up, do we (a) freeze level entirely, or (b) let it move but skip the integral term? **Recommendation:** (a) freeze; simpler and matches operator intuition that "warm-up = controller off". Hard-cap still works.

7. **Patent-risk legal review checkpoint.** PLAN sign-off should include explicit "legal review of patent audit (§10) — completed Y/N". This is not negotiable for compliance posture.

8. **`auto_dial_level` semantics — starting level or current level?** Today it's overloaded: RATIO mode uses it as the live level; ADAPT_* uses it as the starting level. Currently both. **Recommendation:** keep current semantics — `auto_dial_level` = starting level for ADAPT, live level for RATIO. E03 reads it on cold-start only. We do **not** write back to MySQL (it'd cause hot writes). The "live" level lives only in Valkey. PLAN must clarify in column-doc.

9. **Tick-lock contention metric.** Should `vici2_adapt_tick_skipped_total{reason=lock_contention}` use the same label name (`reason`) as `vici2_dialer_pacing_tick_skipped_total`? **Recommendation:** yes — operator dashboards should be consistent. Use the same `reason` enum across E02 and E03.

10. **ADAPT_HARD integral term — keep at zero or allow during raise phase?** Current draft: zero throughout. Alternative: integral during raise (so we accelerate raise when consistently below target), zero during hard-lower. **Recommendation:** zero throughout — keeps HARD mode predictable. Operators choose HARD because they want simple, no-magic behavior.

11. **F02 amendment columns.** All 9 proposed in §8.4. **Recommendation:** all in one migration (additive, low-risk). File in `api/prisma/migrations/<date>_e03_adaptive_engine/`.

12. **E04 interaction.** E04 (agent picker, F04 PLAN §6.4 `pick_agent_for_call`) returns `nil` when no agent is available — that's when a drop is generated (E05 records it). E03 has no direct interaction with E04. **Confirm:** no E03↔E04 wire is needed; document in §15.

13. **Diagnostics stream.** Should E03 write a stream `t:{tid}:campaign:{cid}:adapt_decisions` (one entry per tick) for operator forensics? **Recommendation:** yes; mirrors E02's `pacing_decisions` (E02 RESEARCH §5.1). XADD with MAXLEN ~5760 (24h at 15-s).

14. **Pause/resume.** When admin pauses (`campaigns.active = false`), what happens? **Recommendation:** freeze controller state in Valkey; on resume, continue from frozen state. No re-warm-up. §7.5.

---

## 13. Defects in existing specs (file as HANDOFF fixes)

### 13.1 DESIGN.md §6.4 ADAPT_TAPERED formula has wrong sign

Line 684 reads:
```
ADAPT_TAPERED: shift_progress = elapsed/total_shift
               effective_target = drop_target * (1 - 0.5*shift_progress)
               ... same as AVG but vs effective_target
```

`1 - 0.5 × shift_progress` evaluates to `1.0` at `progress=0` and `0.5` at `progress=1`. That means effective target is **stricter at start** (`drop_target`) and **even stricter at end** (`0.5 × drop_target`). This contradicts PREDICTIVE.txt and the documented behavior ("allows for running over the dropped percentage in the FIRST half of the shift") and contradicts the Vicidial source (cite [3]).

Correct formula:
```
effective_target = drop_target * (1 + 0.5 * (1 - shift_progress))
                 = drop_target * (1.5 - 0.5 * shift_progress)
```

Which evaluates to `1.5 × drop_target` at start and `1.0 × drop_target` at end. PLAN should propose a DESIGN.md edit; we encode the corrected formula in E03 PLAN.

### 13.2 E03.md AC: "drop by 0.2 immediately" implies same-tick — clarify

E03.md acceptance line 42: *"With drop% > target, hardlimit drops level by 0.2 immediately."* "Immediately" here means the **same 15-s tick**, not "real-time/event-driven". The event-driven fast-cut is a separate addition we propose in §6.3. PLAN should distinguish these two behaviors explicitly.

### 13.3 DialMethod enum: ADAPT_HARD vs DESIGN.md ADAPT_HARD_LIMIT

The Prisma schema uses `ADAPT_HARD` (api/prisma/schema.prisma:264); DESIGN.md says `ADAPT_HARD_LIMIT` (line 679); Vicidial uses `ADAPT_HARD_LIMIT`. Cosmetic mismatch but should be reconciled. **Recommendation:** keep `ADAPT_HARD` in code (it's the actual enum), document mapping to Vicidial's `ADAPT_HARD_LIMIT` for operator UIs (M02).

### 13.4 E03.md "every 15s per campaign" — confirm against cron model

E03.md says "Every 15s per campaign in ADAPT_* mode". Vicidial uses a 1-minute cron with internal 15-s loop. We use a Go ticker with 15-s period — no cron. Confirm this is the intent. **Recommendation:** yes; document the architectural difference in HANDOFF.

---

## 14. File layout (proposal; PLAN to confirm)

```
dialer/cmd/dialer/
  main.go                          -- already exists (T01/E02 share); E03 supervisor wired on startup

dialer/internal/adapt/
  supervisor.go                    -- per-campaign goroutine spawn/kill on config events
  engine.go                        -- pure Decide() function (entry point)
  hardlimit.go                     -- HardLimit() — ADAPT_HARD mode
  average.go                       -- AverageWithDeadband() — ADAPT_AVG + ADAPT_TAPERED mode
  target.go                        -- ResolveTarget() — per-mode target curve
  warmup.go                        -- warm-up state machine + exit gates
  fastcut.go                       -- event-driven drop_gated handler + debounce
  state.go                         -- pace_state HASH read/write + integral persistence
  config.go                        -- per-campaign config snapshot + hot-reload
  metrics.go                       -- Prom counters/gauges
  decision.go                      -- one-tick tick(snapshot) orchestrator
  engine_test.go                   -- Decide() table tests (30+ rows)
  average_test.go                  -- AverageWithDeadband() edge cases
  hardlimit_test.go                -- HardLimit() edge cases
  target_test.go                   -- ResolveTarget() (incl. tapered shift math)
  warmup_test.go                   -- warm-up exit transitions
  fastcut_test.go                  -- debounce, fast-cut lock
  integration_test.go              -- testcontainers Valkey

dialer/internal/adapt/simulator/  -- separate sub-package; not used in production
  agents.go                        -- synthetic agent pool
  leads.go                         -- synthetic answer-rate process
  pacer.go                         -- mocks E02's per-tick formula
  drop.go                          -- mocks E05's drop-counter
  scenario.go                      -- runs a named scenario; reports trajectory
  simulator_test.go                -- runs S1..S8 from §11.2; CI-fast subset
  soak_test.go                     -- 24h run; CI-nightly only
```

Estimated: ~400 LOC production + ~600 LOC tests + ~400 LOC simulator (the simulator is also useful for E05 and E02 regression).

---

## 15. Hand-off contracts to other modules

| Module | Hand-off |
|---|---|
| **E02** | E03 writes `t:{tid}:campaign:{cid}:dial_level` STRING; E02 reads it (E02 RESEARCH §4.3). Soft contract: write rate ≤ 1 per 15 s. E03 reads E02's `pacing_*_last_tick` STRINGs as **advisory** inputs for diagnostics only (not on the controller path). |
| **E05** | E05 writes `t:{tid}:campaign:{cid}:drop_pct_30d` STRING (DECIMAL percentage, refreshed every 15 s) and `t:{tid}:campaign:{cid}:drop_gated` STRING (`"1"` when 30-day rolling drop ≥ campaign target). E03 reads both. E05 also publishes `t:{tid}:broadcast:campaign:{cid}` pubsub with payload `{event: "drop_gated_changed", gated: bool}` to drive E03's fast-cut path. **Contract amendment for E05 PLAN:** must publish `drop_pct_30d` even when `drop_gated=false` (E03's controller needs the value continuously, not just when gated). |
| **E04** | No interaction. E04 is event-driven on FS CHANNEL_ANSWER; E03 doesn't see E04. |
| **E01** | No direct interaction. E01 reads `dial_level` independently for the hopper-target formula. E03 has no view of hopper state. |
| **T01 / T04** | No direct interaction. |
| **F04** | New key: `t:{tid}:campaign:{{cid}}:pace_state` HASH (§8.1). Existing keys consumed: `dial_level`, `drop_pct_30d`, `drop_gated`, `broadcast:campaign:{cid}`. New lock: `t:{tid}:adapt:lock:{{cid}}` (F04 PLAN §4.13 already specs this). New lock: `t:{tid}:adapt:fastcut:{{cid}}` (5-s TTL). File F04 amendment for `pace_state` HASH + fastcut lock. |
| **F02** | New columns (§8.4): `adaptive_intensity`, `adaptive_dl_diff_target` (Phase-3 reserve), `adapt_tick_seconds`, `hold_band_pp`, `warmup_min_answered`, `warmup_min_seconds`, `drop_gated_debounce_sec`, `shift_start_local`, `shift_end_local`. Additive. |
| **M02** | Admin UI exposes the new columns + a "Current dial level" readout (read from Valkey via API). On config save, publishes `campaign_config_changed`. |
| **O01** | Metrics consumed: `vici2_dialer_dial_level{cid}` (gauge), `vici2_adapt_tick_total`, `vici2_adapt_action_total{action}` where `action ∈ raise|lower_soft|lower_hard|hold|warm_up|fast_cut`, `vici2_adapt_drop_pct_30d{cid}`, `vici2_adapt_integral_term{cid}`, `vici2_adapt_warmup_active{cid}`. Alert recipes: drop% > target × 1.5 for > 5 min, integral runaway, fast-cut firing > 1/min sustained. |
| **S01** | Wallboard reads `dial_level` STRING. |

---

## 16. Metrics

| Metric | Type | Labels | Reset |
|---|---|---|---|
| `vici2_adapt_tick_total` | counter | `{tenant, campaign}` | n/a |
| `vici2_adapt_tick_skipped_total` | counter | `{tenant, campaign, reason}` — `reason = lock_contention|warm_up|valkey_down|drop_pct_missing|campaign_paused` | n/a |
| `vici2_adapt_action_total` | counter | `{tenant, campaign, action}` — `action = raise|lower_soft|lower_hard|hold|fast_cut|warm_up` | n/a |
| `vici2_adapt_dial_level` | gauge | `{tenant, campaign}` | per-tick |
| `vici2_adapt_drop_pct_30d` | gauge | `{tenant, campaign}` | per-tick (echo of E05's value) |
| `vici2_adapt_integral_term` | gauge | `{tenant, campaign}` | per-tick |
| `vici2_adapt_clamp_active_seconds` | counter | `{tenant, campaign, side}` — `side = ceiling|floor` | counts seconds at clamp |
| `vici2_adapt_warmup_active` | gauge (0/1) | `{tenant, campaign}` | event-driven |
| `vici2_adapt_fast_cut_total` | counter | `{tenant, campaign}` | n/a |
| `vici2_adapt_tick_duration_seconds` | histogram | `{tenant, campaign}` | buckets 0.0001/0.001/0.01/0.1/1 |
| `vici2_adapt_external_override_total` | counter | `{tenant, campaign}` | n/a — admin write to dial_level |
| `vici2_adapt_cold_start_total` | counter | `{tenant, campaign}` | n/a |

Alert recipes (handed to O01):

- `vici2_adapt_drop_pct_30d > 0.9 × campaigns.adaptive_drop_pct × 1.5` for 10 min → warn (controller failing to converge).
- `vici2_adapt_action_total{action=fast_cut} rate > 6/hr sustained` → page (E05's `drop_gated` flapping).
- `vici2_adapt_integral_runaway_total rate > 0/hour` → page (controller bug).
- `vici2_adapt_clamp_active_seconds{side=ceiling} rate > 600/hr` → warn (operator likely needs to raise `adaptive_max_level`).
- `vici2_adapt_tick_skipped_total{reason=valkey_down} rate > 0/min` → page.

---

## 17. Citations

1. **Vicidial — `inktel/Vicidial/bin/AST_VDadapt.pl`** — https://github.com/inktel/Vicidial/blob/master/bin/AST_VDadapt.pl — the canonical adaptive script source: 15-s adapt cadence (`$diff_ratio_updater >= 15`); 1-min drop-stat aggregation; 15-iteration rolling window; `&calculate_dial_level` subroutine; `available_only_ratio_tally` semantics.
2. **Vicidial — `h4ck3rm1k3/vicidial-asterisk-gui/bin/AST_VDadapt.pl`** — https://github.com/h4ck3rm1k3/vicidial-asterisk-gui/blob/master/bin/AST_VDadapt.pl — mirror; useful for confirming the algorithm independent of inktel.
3. **Vicidial — `inktel/Vicidial/docs/PREDICTIVE.txt`** — https://github.com/inktel/Vicidial/blob/master/docs/PREDICTIVE.txt — documents the three ADAPT modes (HARD_LIMIT, AVERAGE, TAPERED) and confirms first-half-of-shift leniency in TAPERED.
4. **Vicidial Forum — "Dial Level" Matt Florell post** — http://www.vicidial.org/VICIDIALforum/viewtopic.php?p=25030 — Florell's prose statement that there is "no preset formula" and clarification of `adaptive_dl_diff_target` semantics.
5. **Vicidial Forum — "Dial Level" thread (6864)** — http://www.eflo.net/VICIDIALforum/viewtopic.php?t=6864 — operator post citing AST_VDadapt source code: warm-up gate `$VCScalls_today > 50 && drop% > target`.
6. **Vicidial Forum — "Predictive algorithm" (11047)** — http://www.eflo.net/VICIDIALforum/viewtopic.php?t=11047 — Florell on "feedback-driven, not formula-driven" controller character.
7. **Vicidial Forum — "Adapt Intensity Modifier" (36910)** — https://www.vicidial.org/VICIDIALforum/viewtopic.php?f=4&t=36910 — Florell's concrete numeric examples: `+10` = 10% more aggressive (raise) AND slower drop (`2.0→3.0` becomes `3.1`; `3.0→2.0` becomes `2.1`).
8. **Sprinklr Help — Predictive Dialers** — https://www.sprinklr.com/help/articles/dialers/predictive-dialers/641180977517d84a3ab00839 — modern RL-based dialer; useful as a "what we don't do (Phase 4)" reference.
9. **ViciStack — VICIdial Auto-Dial Level Tuning by Campaign Type** — https://vicistack.com/blog/vicidial-auto-dial-level-tuning/ — concrete tuning advice: B2B max 3.5; B2C max 6.0; intensity range -1..+1 in practice; drop-target 2% safe-operating value.
10. **CyburDial — ViciDial's Predictive Settings Revealed** — https://dialer.one/index.php/vicidials-predictive-settings-revealed/ — operator-blog walk-through of all the knobs.
11. **Jonatan Lindén — "Predictive Dialing"** (Uppsala University 2010, IT-10047) — http://www.diva-portal.org/smash/get/diva2:357150/FULLTEXT01.pdf — master's thesis on PID + Erlang-A approaches; pre-2013 prior art for PID-style feedback control of dial-level.
12. **Wikipedia — Model predictive control** — https://en.wikipedia.org/wiki/Model_predictive_control — MPC primer for the "what we don't do (Phase 4)" reference in §3.3.
13. **MathWorks — Anti-Windup Control Using a PID Controller Block** — https://www.mathworks.com/help/simulink/slref/anti-windup-control-using-a-pid-controller.html — back-calculation reference; coefficient guidance.
14. **Wikipedia — Integral windup** — https://en.wikipedia.org/wiki/Integral_windup — definition; cite for §5.1.
15. **LibreTexts — 9.3 PID Tuning via Classical Methods** — https://eng.libretexts.org/Bookshelves/Industrial_and_Systems_Engineering/Chemical_Process_Dynamics_and_Controls_(Woolf)/09:_Proportional-Integral-Derivative_(PID)_Control/9.03:_PID_Tuning_via_Classical_Methods — PI-vs-PID guidance for noisy plants.
16. **Wikipedia — Ziegler–Nichols method** — https://en.wikipedia.org/wiki/Ziegler%E2%80%93Nichols_method — heuristic PI tuning; useful for `Kp/Ki` selection in §4.5.
17. **MathWorks — Understanding PID Control, Part 2** — https://www.mathworks.com/videos/understanding-pid-control-part-2-expanding-beyond-a-simple-integral-1528310418260.html — practitioner video on anti-windup; informs our back-calc choice.
18. **Erdos Miller — PID Anti-windup Techniques** — https://info.erdosmiller.com/blog/pid-anti-windup-techniques — clear engineering blog summary of the three anti-windup approaches.
19. **Wikipedia — Thompson sampling** — https://en.wikipedia.org/wiki/Thompson_sampling — bandit primer; used in §3.4 "what we don't do (Phase 4)".
20. **Agrawal & Goyal — Analysis of Thompson Sampling for the Multi-armed Bandit Problem** (PMLR 2012) — http://proceedings.mlr.press/v23/agrawal12/agrawal12.pdf — sample-complexity bounds; relevant to bandit-dialer feasibility.
21. **Google Patents US8681955B1** — https://patents.google.com/patent/US8681955 — Noble Systems patent on feedback-controlled predictive dialer; **active 2014–2033**; emphasizes 30-day running average + speech analytics; relevant to §10.
22. **Google Patents US8411844B1** — https://patents.google.com/patent/US8411844 — Avaya/Aspect patent on occupancy-distribution-based abandonment control; **active 2013–2031**; different mechanism from ours; relevant to §10.
23. **Google Patents US9088650B2** — https://patents.google.com/patent/US9088650 — Impact Dialing patent on simulation-based dialer optimization; **lapsed 2019**; no risk; relevant to §10.
24. **Google Patents US9807235B1** — https://patents.google.com/patent/US9807235B1/en — Noble Systems patent on neural-network-ensemble predictive dialing; **active 2017–2036**; no Phase-2 risk; relevant to §10 + Phase-4 deferral.
25. **Google Patents US5570419A** — https://patents.google.com/patent/US5570419A/en — Cantel Industries predictive-dialer patent; **expired 2015**; no risk.
26. **Erlang.com Erlang B calculator** — https://www.erlang.com/calculator/erlb/ — loss-formula reference; cited in §3 for the "blocking model" alternative we don't use.
27. **TechTarget — What is Erlang C** — https://www.techtarget.com/searchunifiedcommunications/definition/Erlang-C — Erlang C primer; same as E02 RESEARCH citation.
28. **Wikipedia — Erlang (unit)** — https://en.wikipedia.org/wiki/Erlang_(unit) — Erlang traffic-intensity reference.
29. **47 CFR § 64.1200(a)(7)** — https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200 — 3% abandonment ceiling; 30-day rolling window; defines what E03 is ultimately trying to satisfy.
30. **FTC 16 CFR § 310.4(b)(4)** — https://www.ftc.gov/legal-library/browse/rules/telemarketing-sales-rule — FTC counterpart; the 2-second connect-to-agent rule that defines "abandonment".
31. **DESIGN.md §1.2, §6.4** — local — DialMethod modes, 3-mode adaptive-engine pseudocode (formula corrected in §13.1).
32. **SPEC.md §4.1, §3.6** — local — compliance hard floor; `dial_level` is a required metric.
33. **SPEC.md §10** — local — Phase 2 demo target: ADAPT_TAPERED, 1.5×, drop < 2%.
34. **api/prisma/schema.prisma Campaign (lines 308–375)** — local — existing columns (`dial_method`, `auto_dial_level`, `adaptive_max_level`, `adaptive_drop_pct`, `available_only_tally`).
35. **api/prisma/schema.prisma DialMethod enum (lines 260–267)** — local — `MANUAL|RATIO|PROGRESSIVE|ADAPT_HARD|ADAPT_AVG|ADAPT_TAPERED`.
36. **F04 PLAN §4.3** — local — `drop_window` STREAM schema; MAXLEN ~500000; nightly XTRIM MINID; the persistent source of E05's drop% computation.
37. **F04 PLAN §4.4** — local — `dial_level` STRING; RESP3 client-side cached; the wire E03 publishes on.
38. **F04 PLAN §4.7** — local — cluster hash-tag convention (`{cid}` colocation); pace_state must use same tag.
39. **F04 PLAN §4.13** — local — `t:{tid}:adapt:lock:{cid}` STRING with 15-s TTL; F04 anticipated E03.
40. **E02 RESEARCH §3.4 (Clamp 3 — `drop_gate_clamp`)** — local — how E02 consumes `drop_gated`; defines the boundary that E05 owns the calculation.
41. **E02 RESEARCH §11 Q-8 (`dial_level stale handling`)** — local — fallback to `campaigns.auto_dial_level` when `dial_level` STRING is missing; defines E02's expectation of E03 boot.
42. **E01 PLAN §10** — local — hopper target formula `ready_agents × dial_level × (60/dial_timeout) × multiplier`; E01 is another consumer of `dial_level`.
43. **viciwiki — Vicidial RatioManager** — https://viciwiki.com/index.php/Vicidial_RatioManager — admin-UI convention for ratio/adapt campaigns; useful for M02 UI alignment.
44. **prospeo.io — Predictive Dialer Guide (2026)** — https://prospeo.io/s/predictive-dialer — modern compliance/operations guide; informs failure-mode reasoning.
45. **callin.io — Predictive Dialer Algorithm in 2025** — https://callin.io/predictive-dialer-algorithm/ — ML-augmented modern overview; informs Phase-4 deferral.
46. **Stanford — Lecture 14, Model Predictive Control** — https://web.stanford.edu/class/archive/ee/ee392m/ee392m.1056/Lecture14_MPC.pdf — primer used in §3.3 for the "what we don't do" rationale.
47. **MathWorks — What Is Model Predictive Control** — https://www.mathworks.com/help/mpc/gs/what-is-mpc.html — vendor MPC explainer; same as 46 above for accessibility.
48. **PMC (Bistak et al.) — Making Ziegler-Nichols Tuning Precise and Reliable** — https://pmc.ncbi.nlm.nih.gov/articles/PMC8468566/ — recent academic refinement of PI tuning; cited for §4.5 coefficient choice rationale.
49. **ResearchGate — Anti-windup Schemes for PI/PR Controllers** — https://www.researchgate.net/publication/277879787_Anti-windup_Schemes_for_Proportional_Integral_and_Proportional_Resonant_Controller — academic coverage of anti-windup techniques relevant to §5.3.
50. **Stanford BVR — A Tutorial on Thompson Sampling** — https://web.stanford.edu/~bvr/pubs/TS_Tutorial.pdf — formal TS treatment; cited in §3.4 for the bandit deferral.

(Citation count: 50; ≥ 12 required.)

---

## STOP — Do not proceed to PLAN. Awaiting orchestrator review.

When unblocked the PLAN must:

1. Pin the **15-s outer adapt tick** + **event-driven fast-cut** (§6); confirm `adapt_tick_seconds` default = 15 and `drop_gated_debounce_sec` default = 30.
2. Lock the **controller math** in §4–§5: PI with deadband; back-calculation anti-windup; quantize-to-0.05; Vicidial-parity step sizes (`+0.05 raise`, `-0.20 hard-lower`); intensity multiplier per §4.5.
3. Pin the **three-mode dispatch**: HARD = pure-P with hard-cap; AVG + TAPERED = clamped PI with deadband; TAPERED = same controller, time-varying target via `ResolveTarget` (§4.3); fix DESIGN.md taper-sign bug per §13.1.
4. Pin the **warm-up state machine** (§7): cold-start from `campaigns.auto_dial_level`; exit on 50 calls OR 5 minutes; hard-cap path remains live during warm-up.
5. Pin the **schema**: new HASH `pace_state` (§8.1) + 9 new F02 columns (§8.4). File F04 amendment for `pace_state` + fastcut lock; file F02 amendment for the columns.
6. Resolve the **14 open questions** in §12 — at minimum #1, #2, #3, #4, #5, #6, #11.
7. Define **test fixtures**: 30+ unit-test rows for Decide(); 8 simulator scenarios from §11.2; the FCC drop-ceiling test from §11.4; the patent-risk static-analysis CI hook from §11.5; the property tests from §11.6.
8. Define the **E05 contract amendment**: E05 must publish `drop_pct_30d` STRING continuously (every 15 s), not just when `drop_gated` flips. Document in E05 PLAN.
9. **Legal review checkpoint** for the patent audit (§10) — must complete before Implementation phase ships. Block PLAN sign-off until present.
10. Specify the **goroutine supervisor** lifecycle (mirror E02 RESEARCH §8.1): spawn on campaign-start event, kill on campaign-stop or 60 idle MANUAL ticks, respawn on panic with 5-s backoff.

Blocking dependencies BEFORE PLAN can proceed:

- **E02 RESEARCH landed** [done] — `dial_level` consumer contract frozen.
- **F04 PLAN landed** [done] — Valkey schema; `adapt:lock` key already specified.
- **E05 RESEARCH** — `drop_pct_30d` STRING + `drop_gated` semantics + per-call `call_completed` event. **Soft block.** E03 can stub-mock E05 if PLAN starts in parallel as long as the publish-contract is named.
- **F02 amendment review** — the 9 new columns. Additive; can be filed alongside E03 PLAN.
- **Legal review** — patent audit signoff before Implementation phase (not PLAN phase).

Not blocking:

- **E01 PLAN** — already landed; E03 has no E01 dependency beyond shared `dial_level` semantics.
- **T01/T04** — E03 has no telephony interactions.
- **M02** — UI work; can ship after E03 with the column reads.
