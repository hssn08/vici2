# E05 — Drop-Rate Enforcement + Safe-Harbor (FCC 3% Gate) — PLAN

| Field | Value |
|---|---|
| **Module** | E05 — per-campaign 30-day rolling abandonment-rate tracker + FCC safe-harbor enforcer + drop-gate publisher |
| **Author** | E05-PLAN sub-agent (Claude Sonnet 4.6) |
| **Date** | 2026-05-13 |
| **Status** | PROPOSED — awaiting orchestrator review |
| **Companion** | [RESEARCH.md](./RESEARCH.md) — 30 citations; 19 sections |
| **Module spec** | `/root/vici2/spec/modules/E05.md` (superseded where this PLAN conflicts) |
| **Depends on (FROZEN upstream)** | F02 schema (`drop_log`, `call_log.is_drop`, `campaigns.adaptive_drop_pct`, `campaigns.safe_harbor_audio`); F04 HANDOFF §2 (`ScriptRecordCallOutcome`, `drop_window` STREAM key contract, Valkey helper lib); D04 PLAN §9 (`humanAnswered` flag = FCC denominator); T04 PLAN §2 (originate_audit = source of truth for attempt evidence; `gateDropCap` Phase-1 stub ALLOW wired here); E02 PLAN §2/§10 (`drop_gate_clamp` = clamp #3; reads `drop_gated` STRING; contract FROZEN) |
| **Blocks** | E02 IMPLEMENT (must receive ratified `drop_gated` STRING contract — ratified here §6); E03 PLAN (reads `drop_pct_30d` gauge from this module); T04 IMPLEMENT (`gateDropCap` reads `drop_pct` published by this module); O01 (Prometheus metric names frozen by §14); S01 wallboard (`drop_pct` STRING key, Valkey pubsub event names); M08 reporting queries (TCPA evidence trail) |

Once approved the following are **FROZEN**: the `drop_gated` Valkey STRING contract (key form, set/absent semantics, TTL=none), the `drop_pct_30d` STRING key name, the `drop_gate_transitions` STREAM entry shape, the Prometheus metric names (§14), the `dialer/internal/drop_gate/` package boundary, the denominator query form (must JOIN `statuses.human_answered=TRUE`), the state machine transitions (§7), and the F02 amendment column list (§9). Gate internals, dwell precision, alert deduplication policy, and log sampling may change without RFC.

---

## 0. TL;DR — 10-bullet decision summary

1. **E05 owns three distinct loci.** (a) The **answer-side terminator** — a FreeSWITCH dialplan `sched_transfer` that fires at `CHANNEL_ANSWER + 2 s` and routes to the `safe_harbor` extension to play the FCC-required recorded message, then hangs up; (b) the **rolling-window calculator** — a 15-s Go ticker that reads MySQL `drop_log` + `call_log`, computes the 30-day drop rate, and publishes Valkey gauges; (c) the **gate publisher** — writes the Boolean `drop_gated` Valkey STRING that E02's clamp #3 reads on every 1-Hz tick. E05 does not originate calls, pick agents, manage leads, or publish `dial_level`.

2. **Default thresholds: soft 1.0% / hard 1.5% / FCC ceiling 3.0%.** Per DESIGN.md §1.2 and RESEARCH §7.5: new campaigns ship with `drop_target_soft=1.00` and `drop_target_max=1.50`. Both are per-campaign overridable up to 2.5%/3.0% respectively. A F02 CHECK constraint enforces `drop_target_max <= 3.00` and `drop_target_soft <= drop_target_max`. NEVER allow `drop_target_max > 3.00` — the FCC ceiling is absolute.

3. **Drop definition is frozen: live human + `CHANNEL_ANSWER + 2 s` + no agent bridge.** Phase 1 uses `CHANNEL_ANSWER + 2 s` as the 2-second deadline (conservative; FCC says "after completed greeting" which is always ≥ answer time). A successful agent bridge cancels the schedule; if no bridge, `sched_transfer` fires and the call becomes `DROP` (safe_harbor audio played) or `PDROP` (audio missing/race — per-call legal exposure).

4. **Numerator = `drop_log` rows; denominator = `call_log JOIN statuses WHERE human_answered=TRUE`.** Both are strict 30-day rolling windows (`WHERE dropped_at >= NOW() - INTERVAL 30 DAY`). The denominator NEVER uses a `status IN (...)` list — only the `human_answered` boolean column on D04's `statuses` table. This is a CI-enforced invariant (grep in M08 forbids alternative denominator expressions). Valkey STREAM `drop_window` is the fast-path advisory; MySQL is always authoritative (TCPA evidence).

5. **Hysteresis 1.0 pp + dwell 300 s prevent gate flapping.** Gate engages at `drop_pct >= drop_target_max`; releases only when `drop_pct < release_threshold = max(drop_target_max - 1.0, 0.1%)` AND 300 s have elapsed since engagement. At the default `drop_target_max=1.50`, `release_threshold=0.50`. Per-campaign `recover_seconds` (default 300, minimum 60) configures the dwell.

6. **Soft cap action: operator page only.** At `soft_cap <= drop_pct < hard_cap`, E05 sends a WARN-severity page and transitions the state machine to `SOFT_BREACH`. E05 does NOT set `drop_gated`. E03 reads `drop_pct_30d` independently and stops raising dial-level (E03's own logic — no API call from E05 to E03). The `drop_gated` STRING is set only at `HARD_BREACH`.

7. **PDROP is a per-call legal violation — PAGE on every occurrence.** `PDROP` means a live human answered but safe-harbor audio did not play (pre-route race, missing file, software error). Each PDROP is a § 64.1200(a)(7) violation with no exemption. E05 alerts immediately with deduplication: one page per campaign per 10-minute window (suppresses spam from a config bug); the underlying `vici2_e05_safe_harbor_audio_play_failed_total` counter is always incremented.

8. **Small-denominator warmup floor: denominator < 100 → assume 0%.** New campaigns skip all gate logic until 100 live-answered calls are accumulated. Before that threshold, E05 logs + emits `vici2_e05_warmup_campaigns` but does not compute `drop_pct` or transition states. This prevents the "1 drop on first 10 calls = 10% rate" false-gate that would immediately lock a new campaign.

9. **Dual-write: Valkey fast path + MySQL durable evidence.** T01's `record_call_outcome.v1.lua` (F04 HANDOFF §2) is the sole writer of the `drop_window` STREAM. E05's Node ESL handler is the sole writer of `drop_log` (MySQL INSERT) and `call_log.is_drop` (MySQL UPDATE). A 60-s reconciler checks STREAM count vs `drop_log` count; drift > 0.05% → WARN + use MySQL; drift > 1% → PAGE + set `drop_gated=1` defensively (fail-closed).

10. **7-year TCPA evidence retention via `drop_log` + `call_log` + `originate_audit`.** Every drop event produces: one `drop_log` row, one `call_log.is_drop=true` update, one `originate_audit` row (T04 owns), and optionally one `recording_log` row (R01 owns). All keyed on the same `attempt_uuid` / `call_uuid` (T04 one-UUID rule). C04 owns partition retention; E05 ensures atomic MySQL writes per event.

---

## 1. Goals + non-goals

### 1.1 Goals

- **FCC § 64.1200(a)(7) compliance**: enforce the 3% abandonment ceiling per campaign per 30-day rolling window; play the required recorded message on every abandoned call; maintain the TCPA evidence trail.
- **Answer-side terminator**: install a FreeSWITCH `sched_transfer` at originate time so that exactly 2 s after `CHANNEL_ANSWER`, any un-bridged customer hears the safe-harbor audio and is cleanly disconnected.
- **Rolling-window calculation**: every 15 s, recompute per-campaign `drop_pct` from MySQL (authoritative) and publish the gauge to Valkey for E02, E03, T04, and S01.
- **Gate publish**: write/delete `drop_gated` STRING in Valkey on hard-cap transitions; E02's clamp #3 reads this key on every 1-Hz tick.
- **Hysteresis + dwell state machine**: prevent gate flapping with a 1.0 pp hysteresis band and a 300 s minimum dwell before release.
- **Operator override**: expose `POST /api/admin/campaigns/:cid/drop-gate/release` for audited force-release, protected by F05 RBAC `campaigns:override_drop_gate`.
- **TCPA evidence writes**: INSERT `drop_log` and UPDATE `call_log` atomically in a single MySQL transaction per drop event.
- **Reconciler**: validate STREAM vs MySQL counts every 60 s; alert on drift; fail-closed on severe drift.
- **Prometheus metrics**: emit all metrics enumerated in §14 with correct label cardinality.
- **Multi-tenant isolation**: all Valkey keys namespaced `t:{tid}:campaign:{cid}:*`; MySQL queries `WHERE tenant_id=?`; no cross-campaign or cross-tenant state.

### 1.2 Non-goals (explicit hand-offs)

| Concern | Owner |
|---|---|
| Publishing `dial_level` (raise/lower pacing rate) | E03 |
| Pacing tick decision formula, `dispatch_tokens` | E02 |
| Agent pick for incoming answer | E04 |
| ESL transport (`bgapi originate`, reconnect, circuit breaker) | T01 |
| Writing `drop_window` STREAM entries | T01 (`record_call_outcome.v1.lua`) |
| TCPA time-of-day window checks | C01 |
| DNC suppression | D05 |
| Consent verification | C02 |
| Safe-harbor audio upload + format validation | M02 |
| Admin UI campaign config | M03 |
| TCPA report queries | M08 |
| Recording file lifecycle | R01 / C04 |
| Retention partition drops (7-year) | C04 |
| Audit log immutability | C03 |
| Valkey cluster layout + Lua script registry | F04 |

---

## 2. FCC § 64.1200(a)(7) — exact text + safe harbor conditions

### 2.1 Verbatim text (annotated)

> § 64.1200(a)(7): "No person or entity shall initiate any telephone call to any residential line using an artificial or prerecorded voice to deliver a message without the prior express written consent of the called party … However, the prohibitions of § 64.1200(a)(7) do not apply to … a call by a telemarketer using a predictive dialer that abandons such a call only if:
>
> **(i)** the telemarketer employs technology that ensures abandonment of no more than three percent **[F: the HARD CEILING]** of all telemarketing calls answered by a live person **[denominator: human_answered=TRUE]**, measured over a 30-day period **[rolling window, not calendar month]** for a single calling campaign **[per campaigns row; never tenant-wide]**;
>
> **(ii)** the seller or telemarketer, for each telemarketing call placed, allows the telephone to ring for at least 15 seconds or four (4) rings before disconnecting an unanswered call **[originate_timeout ≥ 15 s; T04 cross-check]**;
>
> **(iii)** whenever a sales representative is not available to speak with the person answering the call within two (2) seconds after the called person's completed greeting **[2-second clock; E05's terminator]**, the seller or telemarketer must promptly play a recorded message that states the name and telephone number of the seller on whose behalf the call was placed **[safe-harbor audio; campaigns.safe_harbor_audio]**;
>
> **(iv)** the seller or telemarketer must maintain records establishing compliance with paragraph (a)(7) of this section **[drop_log + call_log + originate_audit; 7-year retention]**."

### 2.2 Engineering hooks

| Hook | FCC language | E05 enforcement |
|---|---|---|
| **Predictive dialer only** | "using a predictive dialer" | E05 gate only for `dial_method != 'MANUAL'`; MANUAL campaigns skip all drop-rate logic |
| **3% hard ceiling** | "no more than three percent" | `drop_target_max <= 3.00` (CHECK constraint, CI test); E05 engages hard gate at `drop_pct >= drop_target_max` |
| **Denominator = live persons** | "answered by a live person" | `JOIN statuses s WHERE s.human_answered = TRUE`; D04 owns the flag; never a `status IN (...)` list |
| **30-day rolling window** | "measured over a 30-day period" | `WHERE dropped_at >= NOW() - INTERVAL 30 DAY`; Valkey STREAM trimmed nightly to 30d (F04 cron) |
| **Per campaign** | "for a single calling campaign" | All state keyed by `(tenant_id, campaign_id)`; no rollup |
| **15-second ring** | "at least 15 seconds or four rings" | E05 startup cross-checks `campaigns.dial_timeout_sec >= 15`; refuses to start pacer otherwise |
| **2-second window** | "within two seconds after … completed greeting" | `sched_transfer +2 safe_harbor XML default` installed at originate; Phase 1 uses `CHANNEL_ANSWER + 2 s` (conservative) |
| **Recorded message plays** | "must promptly play a recorded message" | FS `playback ${safe_harbor_audio_path}` inside `45_safe_harbor.xml` extension |
| **Message content** | "name and telephone number of the seller" | M02 admin validates upload contains required content; E05 reads path only |
| **Record-keeping** | "maintain records establishing compliance" | `drop_log` INSERT + `call_log` UPDATE per event; 7-year retention via C04 |

### 2.3 The "safe harbor" name is not an exemption from counting

The 3% ceiling IS the safe harbor. The recorded message is an ADDITIONAL requirement that must be satisfied when abandoning. Playing the audio does not remove the call from the numerator — it merely satisfies condition (iii). A call is still counted as `DROP` in both numerator and denominator regardless of whether audio plays. Only if the audio does NOT play (`PDROP`, `safe_harbor_played=false`) does the call become a per-call § 64.1200(a)(7) violation with no exemption.

### 2.4 Parallel FTC TSR jurisdiction

16 CFR § 310.4(b)(4)(i) imposes identical rules (3%/30-day/2-second/recorded-message). E05 satisfies both by complying with the FCC rule; no separate implementation is needed.

---

## 3. Drop definition — frozen

A call is an **abandonment** (counts in numerator AND denominator) when ALL of the following are true:

1. `CHANNEL_ANSWER` fired (carrier signaled live pickup — `human_answered=TRUE`).
2. No `CHANNEL_BRIDGE` occurred within 2 000 ms of `CHANNEL_ANSWER`.
3. The channel is hung up (either by the `sched_transfer` timer or by the customer).

**Status assignments:**

| Scenario | Status | `safe_harbor_played` | Numerator | Denominator | Severity |
|---|---|---|---|---|---|
| No agent in 2 s, audio played | `DROP` | `true` | YES | YES | Normal (within rate) |
| No agent in 2 s, audio missing/failed | `PDROP` | `false` | YES | YES | PAGE — per-call violation |
| Customer hangup < 2 s (early) | `PDROP` | `false` | YES (default) | YES | WARN |
| AMD-classified (not human) | system-amd status | — | NO | NO | Not a drop |
| Agent bridged within 2 s, then hangs up | call disposition | — | NO | YES | Normal |

**Conservative default for customer-early-hangup**: counted as abandon (`PDROP`, `drop_reason='customer_hangup_early'`). Per-campaign override `campaigns.count_early_customer_hangup_as_drop` (default `true`) allows the lenient interpretation but M03 shows a warning when flipped.

**Phase 1 clock approximation**: the 2-second deadline starts at `CHANNEL_ANSWER`. The FCC says "after completed greeting" which is always later than answer, so this is strictly conservative — we will never abandon after the legal limit. Phase 2.5 candidate: hook `mod_avmd` speech-detect event for accurate greeting timestamp.

---

## 4. Threshold pair — soft 1.0% / hard 1.5% / FCC ceiling 3.0%

### 4.1 Default values (new campaigns)

| Parameter | Default | FCC absolute cap | Direction |
|---|---|---|---|
| `drop_target_soft` | 1.00% | — (operator-advisory only) | Overridable up to 2.50% |
| `drop_target_max` | 1.50% | 3.00% (CHECK constraint) | Overridable up to 3.00% |
| `drop_target_max_override` | NULL | must be ≤ `drop_target_max` | Downward only (regulated industries) |
| `hysteresis_pp` | 1.00 pp | — | Hard-coded; not configurable |
| `release_threshold` | `max(drop_target_max - 1.00, 0.10)` | — | Derived; e.g., 0.50% at default |
| `recover_seconds` | 300 s | minimum 60 s | Per-campaign |

### 4.2 Rationale for 1.0/1.5 defaults

DESIGN.md §1.2 recommends 1.5% operational hard cap (1.5 pp margin below the FCC 3% ceiling). We set soft=1.0% to give operators 0.5 pp early warning before the hard gate. The 1.0 pp hysteresis band prevents flapping: at default `drop_target_max=1.50`, the gate does not release until `drop_pct < 0.50%`.

### 4.3 Per-campaign override

Operators may raise `drop_target_max` up to 3.00% and `drop_target_soft` up to 2.50% via M03 admin UI. The F02 CHECK constraint is the hard floor; E05 startup validation is the defense-in-depth. A downward override (`drop_target_max_override`) for regulated industries (healthcare, finance) can be set ≤ `drop_target_max`.

### 4.4 CONFIG CHECK constraint (F02 amendment §9)

```sql
CONSTRAINT chk_drop_targets
  CHECK (
    drop_target_max     <= 3.00
    AND drop_target_soft <= drop_target_max
    AND drop_target_max  > 0
    AND (drop_target_max_override IS NULL
         OR drop_target_max_override <= drop_target_max)
    AND recover_seconds >= 60
  )
```

---

## 5. Rolling 30-day window math

### 5.1 Authoritative queries (MySQL, 15-s ticker)

**Numerator** (drops in last 30 days):

```sql
SELECT COUNT(*) AS drops_30d
FROM drop_log
WHERE tenant_id   = ?
  AND campaign_id = ?
  AND dropped_at  >= NOW() - INTERVAL 30 DAY;
```

**Denominator** (live-answered calls in last 30 days):

```sql
SELECT COUNT(*) AS answers_30d
FROM call_log c
JOIN statuses s
  ON c.tenant_id = s.tenant_id
 AND c.status    = s.status
WHERE c.tenant_id    = ?
  AND c.campaign_id  = ?
  AND c.call_started >= NOW() - INTERVAL 30 DAY
  AND s.human_answered = TRUE;
```

**Rate computation:**

```go
// warmup floor: skip if denominator < 100
if denominator < 100 {
    dropPct = 0.0   // assume safe during warmup
    publishWarmup()
    return
}
dropPct = 100.0 * float64(numerator) / float64(denominator)
```

### 5.2 Valkey gauges written by the 15-s ticker

| Key | Value | Purpose |
|---|---|---|
| `t:{tid}:campaign:{cid}:drop_pct_30d` | `"1.23"` (decimal text) | E02 / E03 / T04 / S01 read |
| `t:{tid}:campaign:{cid}:drop_count_30d` | `"127"` | Cached numerator |
| `t:{tid}:campaign:{cid}:drop_denominator_30d` | `"10317"` | Cached denominator |

Note: `drop_pct_30d` is the canonical key name (RESEARCH §5.6 uses `drop_pct`; this PLAN standardizes the `_30d` suffix to match E03 RESEARCH §1 bullet 5 contract). The key `t:{tid}:campaign:{cid}:drop_pct_30d` is **FROZEN** — all downstream readers (E02, E03, T04, S01) must use this exact key.

### 5.3 Fast-path consistency (STREAM advisory)

T01's `record_call_outcome.v1.lua` writes `answered=1, dropped=0|1` to the `drop_window` STREAM (F04 HANDOFF §2). This stream drives the 1-Hz advisory reads by E03 and S01 (via the cached STRING above). The 60-s reconciler (§10) validates STREAM counts vs MySQL counts.

### 5.4 Denominator invariants (CI-enforced)

1. The denominator query MUST use `JOIN statuses WHERE human_answered=TRUE`. CI grep in M08 forbids any `status IN (...)` denominator expression.
2. AMD-classified statuses (`A`, `AA`, `AVMA`, `AFAX`) have `human_answered=FALSE` — excluded from denominator automatically.
3. `DROP` and `PDROP` have `human_answered=TRUE` — always in denominator (dropping a live human is still an answered call).
4. `LM` (left voicemail) has `human_answered=FALSE` — excluded (FTC TSR convention).

---

## 6. Action mapping

### 6.1 Soft cap breach (`drop_target_soft <= drop_pct < drop_target_max`)

| Action | Who |
|---|---|
| Transition state machine → `SOFT_BREACH` | E05 |
| Page operator at WARN severity | E05 (alert deduplication: 1 page per campaign per 60 min) |
| Turn M03 campaign row yellow | E05 publishes `vici2_e05_drop_soft_cap_breached_seconds` gauge |
| Broadcast `{event: soft_breach, drop_pct}` on `t:{tid}:broadcast:campaign:{cid}` | E05 |
| Stop raising dial-level | E03 reads `drop_pct_30d` independently — no E05 call |
| Set `drop_gated` | **NO** — E02 paces normally |

### 6.2 Hard cap breach (`drop_pct >= drop_target_max`)

| Action | Who |
|---|---|
| Transition state machine → `HARD_BREACH` | E05 |
| Page operator at PAGE severity | E05 (deduplication: 1 page per campaign per 10 min) |
| `SET t:{tid}:campaign:{cid}:drop_gated 1` (no TTL — sticky until DEL) | E05 |
| `SET t:{tid}:campaign:{cid}:drop_gate_engaged_at <RFC3339>` | E05 |
| `XADD t:{tid}:campaign:{cid}:drop_gate_transitions {action: engage, drop_pct, source: auto, ts}` | E05 |
| `PUBLISH t:{tid}:broadcast:campaign:{cid} {event: drop_gate_engaged, drop_pct, ts}` | E05 |
| Clamp `desired=1` (PROGRESSIVE-1.0) | E02 reads `drop_gated` on next tick (≤ 1 s) |
| Reset `dial_level = 1.0` | E03 reads `drop_pct_30d >= drop_target_max`; E03's own fast-cut |
| Increment `vici2_e05_drop_gate_engagements_total{source=auto}` | E05 |

### 6.3 `drop_gated` Valkey STRING contract (FROZEN)

```
Key:    t:{tid}:campaign:{cid}:drop_gated
Type:   STRING
Set:    SET t:{tid}:campaign:{cid}:drop_gated "1"    (no TTL; persistent until DEL)
Read:   EXISTS t:{tid}:campaign:{cid}:drop_gated     (E02 uses EXISTS, not GET)
Clear:  DEL t:{tid}:campaign:{cid}:drop_gated
Absent: gate is NOT engaged (E02 allows normal pacing)
```

E02 uses `EXISTS` (not `GET`) per E02 PLAN §2/§10 clamp #3. The value `"1"` is semantic convention only; E02 treats any present value as engaged.

---

## 7. Hysteresis + dwell — state machine

### 7.1 States

```
NORMAL        — drop_pct < drop_target_soft; no alert; E02 pacing unrestricted
SOFT_BREACH   — drop_target_soft <= drop_pct < drop_target_max; WARN alert; no gate
HARD_BREACH   — drop_pct >= drop_target_max; PAGE alert; drop_gated=1; E02 clamped
```

### 7.2 Transitions

```
NORMAL       --(drop_pct >= drop_target_soft)-------------> SOFT_BREACH  [WARN page]
NORMAL       --(drop_pct >= drop_target_max)-------------> HARD_BREACH   [PAGE; gate on]
SOFT_BREACH  --(drop_pct >= drop_target_max)-------------> HARD_BREACH   [PAGE; gate on]
SOFT_BREACH  --(drop_pct < drop_target_soft - 0.50 pp)---> NORMAL        [clear warning]
HARD_BREACH  --(drop_pct < release_threshold            --> dwell check:
                AND elapsed >= recover_seconds)              if drop_pct < drop_target_soft-0.50:
                                                               -> NORMAL   [gate off; clear all]
                                                             else:
                                                               -> SOFT_BREACH [gate off; keep WARN]
HARD_BREACH  --(operator force-release via API)-----------> NORMAL        [gate off; audit-logged]
```

**Release threshold**: `release_threshold = max(drop_target_max - 1.00, 0.10)`.

At default `drop_target_max=1.50`: `release_threshold = 0.50%`.
At `drop_target_max=3.00`: `release_threshold = 2.00%`.

### 7.3 Dwell enforcement

The dwell timer starts at the moment `HARD_BREACH` is entered (recorded in `t:{tid}:campaign:{cid}:drop_gate_engaged_at`). At every 15-s ticker tick, if the gate is engaged:

```go
elapsed := time.Since(engagedAt)
if dropPct < releaseThreshold && elapsed >= time.Duration(recoverSeconds)*time.Second {
    releaseGate(source="auto")
}
```

### 7.4 State machine implementation

In-process Go FSM (not Valkey-Lua) because:
- The FSM needs access to the dwell timer, which is process-local time.
- State is simple (3 states; rarely transitions).
- On crash-restart, state is recovered from Valkey at startup (see §10.4).

Concurrency: one goroutine per active campaign; no shared mutable state across campaigns.

### 7.5 Soft-cap hysteresis band (return to NORMAL)

`SOFT_BREACH → NORMAL` requires `drop_pct < drop_target_soft - 0.50 pp` (prevents flip-flop at the soft boundary). At default `drop_target_soft=1.00%`, return requires `drop_pct < 0.50%`.

---

## 8. PDROP path — dialplan safe-harbor

### 8.1 Dialplan extension `45_safe_harbor.xml`

```xml
<extension name="safe_harbor">
  <condition field="destination_number" expression="^safe_harbor$">
    <action application="set"      data="hangup_after_bridge=true"/>
    <action application="set"      data="vici2_safe_harbor_played=true"/>
    <action application="playback" data="${safe_harbor_audio_path}"/>
    <action application="set"      data="hangup_cause=NORMAL_CLEARING"/>
    <action application="hangup"/>
  </condition>
</extension>
```

File path: `freeswitch/conf/dialplan/default/45_safe_harbor.xml`.

### 8.2 Originate-time channel-var injection (T04 responsibility)

T04 injects at originate time:

```
execute_on_answer=sched_transfer:+2 safe_harbor XML default
safe_harbor_audio_path=/var/lib/freeswitch/sounds/custom/safe_harbor/<campaign_id>.wav
```

The `sched_transfer +2` schedules the transfer for 2 000 ms after `CHANNEL_ANSWER`. If E04 bridges the customer before T+2 s, the schedule fires but `mod_dptools` suppresses the transfer on a bridged channel. E04 additionally sets `uuid_setvar <call_uuid> vici2_safe_harbor_cancelled true` as belt-and-suspenders.

### 8.3 Audio preconditions (campaign cannot start without this)

Enforcement layers (defense-in-depth):

1. **F02 schema**: nullable `campaigns.safe_harbor_audio`; auto-dial campaigns validated at API save.
2. **M03 admin UI**: refuses to activate campaign with `dial_method != MANUAL` and `safe_harbor_audio IS NULL`.
3. **E02 startup**: file-stat check at pacer spawn time; refuses to spawn if file missing.
4. **T04 originate-time gate**: `gateDropCap` (Phase 1 stub → wired by E05 IMPLEMENT) also checks config validity.

If audio is missing at dial time despite all preconditions: FreeSWITCH `playback` errors, `vici2_safe_harbor_played` is NOT set, E05 ESL handler sees `CHANNEL_HANGUP_COMPLETE` without the flag, writes `PDROP` with `drop_reason='audio_missing'`, and pages operator. A hardcoded fallback audio (`fallback_safe_harbor.wav` baked into the FS install) plays as defense-in-depth.

### 8.4 ESL event handling (Node handler)

File: `api/src/esl/handlers/safe-harbor-played.ts` (~80 LOC).

| Event | Condition | Action |
|---|---|---|
| `CHANNEL_HANGUP_COMPLETE` | `vici2_safe_harbor_played=true` AND `answered=true` AND `NOT bridged` | MySQL TX: INSERT `drop_log` (`safe_harbor_played=true`, `drop_reason='no_agent'`) + UPDATE `call_log SET is_drop=true, status='DROP'`. T01 writes STREAM separately. |
| `CHANNEL_HANGUP_COMPLETE` | `answered=true` AND NOT `bridged` AND NOT `vici2_safe_harbor_played` | MySQL TX: INSERT `drop_log` (`safe_harbor_played=false`, `drop_reason` per §8.5) + UPDATE `call_log SET is_drop=true, status='PDROP'`. PAGE operator. |
| `CHANNEL_HANGUP_COMPLETE` | `CHANNEL_BRIDGE` was observed for this UUID | No drop_log insert. T01 normal CDR finalization. |

### 8.5 `DropReason` enum (extended via F02 amendment)

```
no_agent              — E04 picker returned nil; sched_transfer fired; audio played OK
timeout               — sched_transfer fired; no picker response at all
queue_full            — E04 returned "all agents at capacity"
customer_hangup_early — customer BYE before T+2 s; no audio opportunity
audio_missing         — safe_harbor_audio file not found at playback
software_error        — catch-all; SEV1 always
```

---

## 9. Schema additions (F02 amendment)

All additions land in a single migration file: `api/prisma/migrations/YYYYMMDDHHMMSS_e05_drop_gate/migration.sql`.

### 9.1 New columns on `campaigns`

| Column | Type | Default | Constraint | Purpose |
|---|---|---|---|---|
| `drop_target_soft` | `DECIMAL(4,2)` | `1.00` | `> 0`, `<= drop_target_max` | Soft-cap alert threshold |
| `drop_target_max_override` | `DECIMAL(4,2) NULL` | `NULL` | `<= drop_target_max` when set | Downward-only regulated-industry cap |
| `recover_seconds` | `INT` | `300` | `>= 60` | Dwell time before gate auto-release |
| `count_early_customer_hangup_as_drop` | `BOOLEAN` | `TRUE` | — | Conservative counting policy |

**Rename**: `campaigns.adaptive_drop_pct` → `campaigns.drop_target_max` (alias retained for one minor version; CI migration test validates both names work during transition).

### 9.2 New column on `drop_log`

| Column | Type | Purpose |
|---|---|---|
| `originator_attempt_uuid` | `VARCHAR(40) NULL` | Forward-link to `originate_audit.attempt_uuid` (discovery-friendly FK) |

### 9.3 Extended `DropReason` enum

Add `customer_hangup_early`, `audio_missing`, `software_error` to the existing `DropReason` enum (extending, not replacing, `no_agent`, `timeout`, `queue_full`).

### 9.4 New table: `drop_gate_transition_log`

```prisma
model DropGateTransitionLog {
  id          BigInt   @default(autoincrement())
  tenantId    BigInt   @map("tenant_id")
  campaignId  String   @map("campaign_id") @db.VarChar(32)
  action      String   @map("action") @db.VarChar(16)   -- "engage" | "release"
  dropPct     Decimal  @map("drop_pct") @db.Decimal(5,2)
  source      String   @map("source") @db.VarChar(16)   -- "auto" | "operator"
  operatorId  BigInt?  @map("operator_id")
  reason      String?  @db.VarChar(255)
  occurredAt  DateTime @map("occurred_at") @db.DateTime(6)
  createdAt   DateTime @default(now()) @map("created_at") @db.DateTime(6)

  @@id([id, occurredAt])
  @@index([tenantId, campaignId, occurredAt], map: "idx_dgtl_t_camp_ts")
  @@map("drop_gate_transition_log")
}
```

Partitioned `RANGE COLUMNS(occurred_at)` monthly (same pattern as `originate_audit`). This table mirrors the `drop_gate_transitions` Valkey STREAM for 7-year durable retention. The STREAM is written first (low-latency); the MySQL insert follows in the same background goroutine.

### 9.5 CHECK constraint addition (F02 amendment)

```sql
ALTER TABLE campaigns ADD CONSTRAINT chk_drop_targets CHECK (
  drop_target_max <= 3.00
  AND drop_target_soft <= drop_target_max
  AND drop_target_max > 0
  AND (drop_target_max_override IS NULL OR drop_target_max_override <= drop_target_max)
  AND recover_seconds >= 60
);
```

---

## 10. Valkey–MySQL dual-write + 60-s reconciler

### 10.1 Write ownership

| Data | Writer | Mechanism |
|---|---|---|
| `drop_window` STREAM | T01 `record_call_outcome.v1.lua` | XADD per call outcome; `answered=1, dropped=0|1` |
| `drop_log` INSERT | E05 ESL handler (Node) | MySQL TX per drop event |
| `call_log.is_drop` UPDATE | E05 ESL handler (Node) | Same MySQL TX |
| `drop_pct_30d` STRING | E05 15-s ticker (Go) | SET every 15 s |
| `drop_gated` STRING | E05 gate publisher (Go) | SET on engage; DEL on release |
| `drop_gate_transition_log` INSERT | E05 gate publisher (Go) | On each transition |

### 10.2 Reconciler algorithm (60-s cadence)

```go
// For each active campaign:
streamDropped := XRANGE drop_window ... | filter(dropped=1) | count
dbDropped     := SELECT COUNT(*) FROM drop_log WHERE ... AND dropped_at >= NOW() - INTERVAL 30 DAY

if dbDropped == 0 {
    drift = 0.0
} else {
    drift = abs(streamDropped - dbDropped) / float64(dbDropped)
}

switch {
case drift <= 0.0005:   // <= 0.05% — OK
    // no action
case drift <= 0.010:    // 0.05% < drift <= 1% — warn; MySQL wins
    log.Warn("stream drift", "drift_pct", drift*100)
    alert(WARN, "drop_window stream drift for campaign", cid)
    useDBAsAuthoritative()
default:                // > 1% — severe; fail-closed
    log.Error("SEVERE stream drift", "drift_pct", drift*100)
    alert(PAGE, "drop_window severe stream drift; campaign drop-gated defensively", cid)
    setDropGated(cid, "severe_drift")
}
```

**Fail-closed policy**: any Valkey unavailability > 30 s → mark all active campaigns as `drop_gated=1` in memory (cannot write to Valkey); resume once Valkey reconnects. MySQL is the authoritative rate; the in-memory gate is the safety posture.

### 10.3 Drift tolerance rationale

At 50 CPS × 1% drop rate: ~1 300 drops/month = denominator ~130 000. 0.05% drift = 65 calls disagreement. This covers cold-start races (T01 and E05 ESL handlers fire concurrently on `CHANNEL_HANGUP_COMPLETE`; one may arrive 100–500 ms before the other). Tighter than 0.05% generates false alerts; looser than 0.05% hides genuine bugs.

### 10.4 Cold-start state recovery

On E05 process startup (pod crash, redeploy):

```go
for each active campaign:
    thresholds = SELECT drop_target_soft, drop_target_max, recover_seconds FROM campaigns WHERE id=?
    numerator, denominator = freshMySQLQuery(campaignID)   // never trust Valkey on startup
    dropPct = compute(numerator, denominator)
    SET drop_pct_30d, drop_count_30d, drop_denominator_30d
    if dropPct >= thresholds.drop_target_max:
        SET drop_gated
        engagedAt = XREVRANGE drop_gate_transitions LIMIT 1 | filter(action=engage) | ts
        // gate stays engaged; dwell tracking continues from engagedAt
    else if DROP_GATED key exists but dropPct < releaseThreshold:
        // previous dwell may or may not have elapsed
        engagedAt = readFromTransitionsStream()
        // apply dwell check normally; may release on first tick
```

Recovery time: ~3 ms per campaign; 50 campaigns = ~150 ms. Negligible startup delay.

---

## 11. Small-denominator warmup floor

- **Threshold**: denominator < 100 live-answered calls → warmup mode.
- **Warmup behavior**: `drop_pct_30d` published as `"0.00"`; no state-machine transitions; `vici2_e05_warmup_campaigns` gauge incremented.
- **Rationale**: at 1% drop rate, 10 answered calls = 1 expected drop; the rate could be 0% or 10% depending on random timing. 100 answered calls = ~1 expected drop with stable measurement.
- **Exit**: once denominator reaches 100, warmup exits automatically on next ticker tick; normal state machine engages.
- **No manual warmup bypass**: operators who want to skip warmup must wait for 100 calls. There is no API to override the floor (prevents gaming the startup window).

---

## 12. Go package layout

```
dialer/
└── internal/
    └── drop_gate/
        ├── doc.go               — package-level godoc; FCC citation
        ├── gate.go              — DropGate struct; Tick(), RecordDrop(), Release()
        ├── gate_test.go         — unit tests for state machine + threshold math
        ├── ticker.go            — 15-s MySQL recompute + Valkey publish goroutine
        ├── ticker_test.go       — integration tests with test-MySQL + test-Valkey
        ├── reconciler.go        — 60-s STREAM-vs-MySQL reconciler
        ├── reconciler_test.go
        ├── recovery.go          — cold-start state reconstruction
        ├── recovery_test.go
        ├── metrics.go           — Prometheus registration (§14 names)
        └── config.go            — CampaignConfig struct (thresholds, audio path)
```

FreeSWITCH dialplan:
```
freeswitch/conf/dialplan/default/45_safe_harbor.xml
```

Node ESL handler:
```
api/src/esl/handlers/safe-harbor-played.ts   — CHANNEL_HANGUP_COMPLETE handler
api/src/esl/handlers/safe-harbor-played.test.ts
```

Prisma migration:
```
api/prisma/migrations/YYYYMMDDHHMMSS_e05_drop_gate/migration.sql
```

---

## 13. Public API

### 13.1 Go interface (`dialer/internal/drop_gate`)

```go
package drop_gate

// DropGate manages the per-campaign FCC 3% drop-rate gate.
// One DropGate instance per active campaign; goroutine-safe.
type DropGate interface {
    // Tick is called by the 15-s ticker goroutine. Reads MySQL, updates Valkey,
    // transitions state machine, fires alerts. Returns current drop_pct.
    Tick(ctx context.Context) (dropPct float64, err error)

    // RecordDrop is called by E04's agent-picker goroutine on no-agent events,
    // and by the ESL handler on CHANNEL_HANGUP_COMPLETE (as notification only;
    // MySQL writes happen in the ESL handler, not here).
    RecordDrop(ctx context.Context, req DropEvent) error

    // ForceRelease releases the drop gate immediately regardless of dwell.
    // Requires operatorID for audit log. Called by the admin API handler.
    ForceRelease(ctx context.Context, operatorID int64, reason string) error

    // State returns the current FSM state.
    State() GateState // NORMAL | SOFT_BREACH | HARD_BREACH

    // Close shuts down background goroutines.
    Close() error
}

type DropEvent struct {
    CallUUID     string
    CampaignID   string
    TenantID     int64
    DropReason   DropReason
    SafeHarborOK bool
    OccurredAt   time.Time
}

type GateState string

const (
    StateNormal      GateState = "NORMAL"
    StateSoftBreach  GateState = "SOFT_BREACH"
    StateHardBreach  GateState = "HARD_BREACH"
)
```

### 13.2 REST admin endpoint

```
POST /api/admin/campaigns/:campaignId/drop-gate/release
Authorization: Bearer <token>  (F05: campaigns:override_drop_gate permission)
Body: { "reason": "string (required)" }

Response 200: { "released": true, "drop_pct": 1.38, "engaged_for_seconds": 847 }
Response 403: { "error": "insufficient_permissions" }
Response 404: { "error": "campaign_not_found" }
Response 409: { "error": "gate_not_engaged" }
```

Audit: every force-release is written to C03 `audit_log` with `actor_id`, `campaign_id`, `reason`, `drop_pct_at_release`, `engaged_duration_seconds`.

### 13.3 T04 `gateDropCap` wiring (Phase 1 stub → Phase 2 wired)

T04 PLAN §2 bullet 2 states: "Phase 1 stubs ALLOW". E05 IMPLEMENT wires the gate:

```go
// dialer/internal/originate/gates.go (T04 package)
func gateDropCap(ctx context.Context, cid string, tid int64, vk ValkeyCli) error {
    // Phase 1: return nil (ALLOW)
    // Phase 2 (wired by E05 IMPLEMENT):
    dropPct, err := vk.Get(ctx, keys.DropPct30d(tid, cid))
    if err != nil { return nil } // fail-open on Valkey error (E02 is the fail-closed path)
    if dropPct >= campaign.DropTargetMax {
        return ErrRateLimited{SubReason: "drop_cap", DropPct: dropPct}
    }
    return nil
}
```

The gate reads `drop_pct_30d` (published by E05's ticker). The T04 gate is fail-open on Valkey error because E02's `drop_gated` EXISTS check is the primary fail-closed mechanism; T04's gate is defense-in-depth at originate time.

---

## 14. Prometheus metrics (FROZEN names)

| Metric | Type | Labels | Purpose |
|---|---|---|---|
| `vici2_e05_drop_rate_pct` | gauge | `{tenant, campaign}` | Live 30-day drop % (the regulated number) |
| `vici2_e05_drop_count_30d` | gauge | `{tenant, campaign}` | Numerator |
| `vici2_e05_drop_denominator_30d` | gauge | `{tenant, campaign}` | Denominator |
| `vici2_e05_drop_gate_engaged` | gauge (0/1) | `{tenant, campaign}` | Current hard-cap gate state |
| `vici2_e05_drop_gate_engagements_total` | counter | `{tenant, campaign, source}` | `source=auto\|operator_force` |
| `vici2_e05_drop_gate_releases_total` | counter | `{tenant, campaign, source}` | same |
| `vici2_e05_drop_gate_seconds_engaged_total` | counter | `{tenant, campaign}` | Cumulative gated seconds |
| `vici2_e05_drop_soft_cap_breached_seconds` | counter | `{tenant, campaign}` | Soft-cap exposure |
| `vici2_e05_drop_hard_cap_breached_seconds` | counter | `{tenant, campaign}` | Hard-cap exposure |
| `vici2_e05_drops_total` | counter | `{tenant, campaign, drop_reason, safe_harbor_played}` | Per-drop classification |
| `vici2_e05_pdrop_total` | counter | `{tenant, campaign, reason}` | PDROPs (no audio; near-zero target) |
| `vici2_e05_safe_harbor_audio_play_failed_total` | counter | `{tenant, campaign}` | Per-call violation signal; PAGE on rate > 0 |
| `vici2_e05_stream_drift_pct` | gauge | `{tenant, campaign}` | Reconciler: STREAM vs MySQL drift |
| `vici2_e05_stream_severe_drift_total` | counter | `{tenant, campaign}` | Drift > 1% events |
| `vici2_e05_ticker_duration_seconds` | histogram | `{tenant}` | 15-s ticker latency |
| `vici2_e05_reconciler_duration_seconds` | histogram | `{tenant}` | 60-s reconciler latency |
| `vici2_e05_drop_log_write_latency_seconds` | histogram | `{tenant}` | Per-drop MySQL write |
| `vici2_e05_invalid_config_total` | counter | `{tenant, campaign, reason}` | Threshold misconfig |
| `vici2_e05_warmup_campaigns` | gauge | `{tenant}` | Campaigns still in denominator warmup |

**Alert rules:**

| Alert | Condition | Severity |
|---|---|---|
| DropGateEngaged | `drop_gate_engaged{} == 1` for any campaign | PAGE |
| PDROPRate | `rate(pdrop_total[5m]) > 1/60` (>1/min) | PAGE |
| SafeHarborPlayFailed | `rate(safe_harbor_audio_play_failed_total[5m]) > 0` | PAGE |
| StreamSevereDrift | `rate(stream_severe_drift_total[5m]) > 0` | PAGE |
| SoftCapSustained | `drop_soft_cap_breached_seconds` rate > 60/min | WARN |
| ValkeyUnavailable | `valkey_unavailable_seconds` rate > 5/min | WARN |

**No PII in labels**: `phone_e164` is never a metric label. CI test asserts this.

---

## 15. Files to create

| File | Lines (est.) | Purpose |
|---|---|---|
| `dialer/internal/drop_gate/doc.go` | 20 | Package godoc + FCC citation |
| `dialer/internal/drop_gate/config.go` | 60 | `CampaignConfig` struct; threshold validation |
| `dialer/internal/drop_gate/gate.go` | 180 | `DropGate` implementation; state machine |
| `dialer/internal/drop_gate/gate_test.go` | 300 | Unit tests; state transitions; hysteresis math |
| `dialer/internal/drop_gate/ticker.go` | 120 | 15-s MySQL recompute goroutine + Valkey publish |
| `dialer/internal/drop_gate/ticker_test.go` | 150 | Integration tests (test-MySQL + test-Valkey) |
| `dialer/internal/drop_gate/reconciler.go` | 90 | 60-s STREAM-vs-MySQL drift reconciler |
| `dialer/internal/drop_gate/reconciler_test.go` | 100 | Reconciler unit + integration tests |
| `dialer/internal/drop_gate/recovery.go` | 80 | Cold-start state reconstruction |
| `dialer/internal/drop_gate/recovery_test.go` | 80 | Recovery scenarios |
| `dialer/internal/drop_gate/metrics.go` | 80 | Prometheus registration (frozen names) |
| `freeswitch/conf/dialplan/default/45_safe_harbor.xml` | 15 | FS dialplan extension |
| `api/src/esl/handlers/safe-harbor-played.ts` | 90 | Node ESL CHANNEL_HANGUP_COMPLETE handler |
| `api/src/esl/handlers/safe-harbor-played.test.ts` | 120 | Handler unit tests |
| `api/prisma/migrations/YYYYMMDDHHMMSS_e05_drop_gate/migration.sql` | 60 | F02 amendment: 8 new columns + enum ext + new table + CHECK |
| `api/src/routes/admin/campaigns/drop-gate.ts` | 60 | REST `POST .../drop-gate/release` handler |
| `api/src/routes/admin/campaigns/drop-gate.test.ts` | 80 | Route tests (RBAC, 409 state checks) |

---

## 16. Test plan

### 16.1 Unit tests (no external dependencies)

| Test | Validates |
|---|---|
| State machine transitions: all 6 arrows in §7.2 | Correct state after each transition condition |
| Threshold math: soft/hard/release at default and overridden values | `release_threshold = max(drop_target_max - 1.0, 0.10)` |
| Warmup floor: denominator < 100 → `drop_pct = 0, state = NORMAL` | No gate during warmup |
| Hysteresis band: `drop_pct` oscillating around soft cap does not page repeatedly | Alert deduplication logic |
| `drop_gated` key form matches E02 PLAN §10 contract verbatim | String comparison |
| `drop_pct_30d` key name matches frozen contract | String comparison |
| DropReason enum covers all 6 cases | Exhaustive switch |
| Config validation: `drop_target_max > 3.0` → error | Reject invalid config |
| Config validation: `drop_target_soft > drop_target_max` → error | Reject invalid config |
| No PII labels in Prometheus metrics | Reflect over metric descriptors |

### 16.2 Integration tests (test-MySQL + test-Valkey)

| Test | Validates |
|---|---|
| Ticker: MySQL query → Valkey SET round-trip at correct keys | End-to-end gauge publish |
| Gate engage: `drop_pct >= drop_target_max` → `drop_gated` key exists in Valkey | Full engage path |
| Gate release: dwell elapsed + `drop_pct < release_threshold` → `drop_gated` DEL | Full release path |
| Force-release: POST API → `drop_gated` DEL + audit log row + transition log row | Admin API path |
| Reconciler: inject 5 MySQL rows, 5 STREAM entries → drift = 0 | Healthy path |
| Reconciler: inject 5 MySQL rows, 4 STREAM entries → drift = 20% → PAGE + gate engaged | Severe-drift path |
| Cold-start recovery: pre-set `drop_gated` + `drop_gate_transitions` STREAM → state reconstructed correctly | Recovery path |
| Warmup exit: insert 100 `call_log` rows with `human_answered=TRUE` → warmup exits on next tick | Warmup floor |
| PDROP handling: ESL event with no `vici2_safe_harbor_played` → `PDROP` status + `safe_harbor_played=false` in `drop_log` | PDROP path |
| DROP handling: ESL event with `vici2_safe_harbor_played=true` → `DROP` status + `safe_harbor_played=true` | Normal drop path |

### 16.3 FreeSWITCH dialplan test

| Test | Validates |
|---|---|
| `sched_transfer +2` fires at T+2 000 ms on unanswered channel | Timer accuracy ± 50 ms |
| `sched_transfer` does NOT fire on bridged channel | Race safety |
| Dialplan `playback` sets `vici2_safe_harbor_played=true` channel-var | Channel-var propagation |
| Missing audio file: `playback` errors; `vici2_safe_harbor_played` absent on hangup | PDROP trigger |

### 16.4 End-to-end acceptance test (staging)

```
1. Create campaign with drop_target_max=1.50, drop_target_soft=1.00.
2. Simulate 200 live-answered calls with 0 drops → confirm NORMAL state, drop_pct=0.00.
3. Inject 3 drop events → drop_pct = 1.5% → confirm HARD_BREACH, drop_gated=1 in Valkey.
4. Confirm E02 pacing clamp fires within 1 s (observed via vici2_dialer_pacing_clamp_total{clamp=drop}).
5. Wait 300 s (dwell) + inject 200 more answered calls (0 drops) → drop_pct drops to ~0.93%.
   → still above release_threshold=0.50% → gate stays.
6. Inject 500 more answered calls (0 drops) → drop_pct drops to ~0.33% < 0.50% → gate releases.
7. Confirm drop_gate_transition_log has engage + release rows.
8. Verify M08 TCPA report shows: human_answered_total=900, drops_total=3, drop_rate_pct=0.33%, fcc_hard_cap_pct=3.00.
```

---

## 17. Acceptance criteria

| # | Criterion | Test |
|---|---|---|
| AC-01 | `drop_gated=1` is set in Valkey within 1 tick (≤ 1 s) after `drop_pct >= drop_target_max` | E2E §16.4 step 4 |
| AC-02 | Gate does not release until BOTH `drop_pct < release_threshold` AND `recover_seconds` elapsed | Integration test §16.2 |
| AC-03 | Every `DROP` event produces a `drop_log` row + `call_log.is_drop=true` in the same MySQL TX | Integration test §16.2 |
| AC-04 | Every `PDROP` event (`safe_harbor_played=false`) pages the operator | Unit test §16.1 (alert logic) |
| AC-05 | PDROP alert deduplication: at most 1 page per campaign per 10-minute window | Unit test §16.1 |
| AC-06 | `drop_target_max > 3.00` is rejected at startup with clear error; campaign refuses to start | Unit + config validation test |
| AC-07 | Denominator query uses `JOIN statuses WHERE human_answered=TRUE` (no `status IN (...)`) | CI grep in migration + M08 |
| AC-08 | Denominator < 100 → `drop_pct_30d` = `"0.00"` in Valkey; no state transitions | Integration test |
| AC-09 | Stream drift > 1% → campaign drop-gated defensively + PAGE within 60 s | Integration test §16.2 |
| AC-10 | Force-release via API is C03-audit-logged with `actor_id`, `reason`, `drop_pct_at_release` | Route test §16.2 |
| AC-11 | Safe-harbor audio plays before hangup on every non-bridged answered call | FS dialplan test §16.3 |
| AC-12 | No PII (`phone_e164`) appears in any Prometheus metric label | CI label audit |
| AC-13 | Cold-start: if `drop_gated` was present before crash, gate is re-engaged within first ticker tick | Recovery test §16.2 |
| AC-14 | T04 `gateDropCap` returns `ErrRateLimited{SubReason:"drop_cap"}` when `drop_pct >= drop_target_max` | T04 unit test (wired by E05 IMPLEMENT) |
| AC-15 | `drop_gate_transition_log` row written for every engage + release | Integration test |

---

## 18. Dependencies + risks

### 18.1 Dependencies (blocking)

| Dependency | Status | Risk if delayed |
|---|---|---|
| F02 amendment merged (§9 columns + table + enum) | PROPOSED | E05 cannot write `drop_log` with new columns; IMPLEMENT blocked |
| D04 PLAN approved + `statuses.human_answered` seeded | PROPOSED | Denominator query returns wrong results |
| F04 HANDOFF `ScriptRecordCallOutcome` frozen | DONE (F04 HANDOFF.md) | STREAM write contract is stable |
| E02 PLAN `drop_gated` contract ratified | Ratified here §6 | E02 IMPLEMENT can proceed |
| T04 PLAN `gateDropCap` wiring path defined | T04 PLAN §2 stub; wired by E05 IMPLEMENT | T04 IMPLEMENT needs the `drop_pct_30d` key name (frozen here §5.2) |

### 18.2 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| FS `sched_transfer` race: stray transfer fires after bridge on older FS versions | Low | Customer hears brief audio artifact | `vici2_safe_harbor_cancelled` channel-var guard; E05 `late_audio_skipped_total` metric |
| MySQL replication lag causes ticker to read stale drop count | Medium | Brief undercount → gate may not engage on first tick | Gate engages on next tick (15 s lag); tolerable; reconciler catches sustained lag |
| Valkey cluster shard rebalance during gate write | Low | Temporary `drop_gated` SET fails | Retry with backoff (3 × 100 ms); fail-closed: set in-memory if Valkey down |
| Operator force-releases gate repeatedly (evasion) | Low | Campaign exceeds 3% while operator suppresses gate | C03 audit log + M08 report flags repeated force-releases; no API rate limit (operator trust level) |
| `drop_target_max` column rename breaks existing E03/E02 code reading `adaptive_drop_pct` | Medium | Runtime error if code not updated atomically | Alias column retained for one minor version; CI grep for old column name in application code |
| Per-campaign denominators grow large (Phase 4, 500+ campaigns) | Medium | M08 report queries slow | Partition pruning on `call_log(call_started)` keeps 30-day scans bounded; existing F02 index `(tenant_id, campaign_id, call_started)` covers the query |
| PDROP alert spam from misconfigured audio path | Medium | On-call fatigue | 10-minute deduplication window per campaign; underlying counter always increments for audit |
| FCC rule change (3% ceiling altered) | Very Low | Hard-coded 3% ceiling needs update | `drop_target_max <= 3.00` CHECK constraint is the only hard-coded value; update one migration + one constant |

### 18.3 Open questions (resolved)

| Question (RESEARCH §16) | Resolution |
|---|---|
| Where does the 2-s timer live? | Dialplan `sched_transfer` (RESEARCH §4.1 ratified) |
| Soft-cap action — page only or also slow E03? | Page only; E03 reads `drop_pct_30d` independently |
| Count customer-early-hangup? | YES by default (`count_early_customer_hangup_as_drop=TRUE`); per-campaign override |
| Safe-harbor audio precondition | Required; multi-layer enforcement (§8.3) |
| PDROP alert deduplication policy | 1 page per campaign per 10-minute window |
| Reconciler drift tolerance | 0.05% / 1.0% (WARN / PAGE thresholds) |
| Operator override RBAC | `campaigns:override_drop_gate`; admin role default |
| Warmup denominator floor | 100 calls; not configurable |
| State machine implementation | In-process Go FSM with cold-start Valkey recovery |
| Gate transitions stream persistence | Mirrored to `drop_gate_transition_log` MySQL table (§9.4) |
| T04 `gateDropCap` wiring | E05 IMPLEMENT wires it; key is `drop_pct_30d` (§13.3) |
| Multi-pod ticker ownership | Per-campaign tick lock `SET NX EX 1` (same pattern as E02 PLAN §5) |
