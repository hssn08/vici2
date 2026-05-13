# E01 — Hopper Engine — PLAN

**Module:** E01 (Hopper engine: SQL→Valkey filler + Valkey→Originate consumer)
**Author:** E01 PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 40 citations behind every choice below.

This plan turns the E01 spec + RESEARCH findings into the exact filler
trigger strategy, gate ordering, claim/release contracts, outcome
mapping, file layout, configuration knobs, and metrics taxonomy the
IMPLEMENT phase will deliver. Once approved, the public Go interface
(`Filler`, `Consumer`) is FROZEN (changes require RFC).

E01 is the **single point** where compliance gates (TCPA window,
DNC, frequency caps) are enforced before a number reaches the originate
path (SPEC.md §4.1). The filler is also the throughput regulator: too
empty → idle agents; too full → stale leads. Boundaries with E02/E03/E04
and T04 are sharp (see §10).

---

## 0. TL;DR (10 bullets)

1. **Filler trigger = cron + depth-driven hybrid.** A 30-second in-process
   ticker covers steady-state; Valkey pub/sub channel
   `t:{tid}:hopper:refill_request:{cid}` from E02 pacing fires when
   `ZCARD < 25%` of target. A per-campaign Valkey advisory lock
   `t:{tid}:hopper:filler_lock:{cid}` (`SET NX EX 60`) makes multi-pod
   safe; a 10-slot global semaphore caps concurrent fillers. Goroutine-
   per-campaign keeps slow campaigns from blocking fast ones.
2. **Hopper sizing formula** is Vicidial-compatible:
   `target = ceil(active_agents × dial_level × (60 / dial_timeout) × multiplier)`
   floored to `min_hopper_level=50` and capped at `max_hopper_level=5000`.
   `dial_level` is read from Valkey
   `t:{tid}:campaign:{cid}:dial_level` every tick (E03 writes it).
3. **Per-lead gate order is cheap → legal**, fail-fast: SQL WHERE (status,
   `called_count`, recycle delay) → freq-cap → DNC (Bloom + MySQL fallback)
   → TZ resolve (D03) → TCPA (C01) → optional `lead_filter` DSL (Phase 2
   = SQL-only; cel-go in Phase 3+).
4. **Skip metrics** use a **controlled vocabulary** to keep cardinality
   bounded: `vici2_dialer_filler_skipped_total{reason}` with
   12 enum values (§4.4 — `tcpa_window`, `tcpa_blocked`, `dnc_federal`, …).
5. **`SKIP_UNTIL` from C01** pushes the lead to a delayed-set ZSET
   `t:{tid}:campaign:{cid}:delayed` with score = `nextOpenAt_unix`. The
   filler re-evaluates at each tick via `ZRANGEBYSCORE 0 NOW LIMIT 0 100`.
6. **`BLOCK_INVALID` from C01** writes
   `UPDATE leads SET status='INVALID', invalid_reason=?` and the lead is
   permanently excluded from future fillers (status not in `dial_statuses`).
7. **Atomic claim** wraps F04 PLAN's `claim_lead_from_hopper.v1.lua`
   in a typed Go API (`Claim`/`Release` with a fence token). Lock TTL
   = `max(dial_timeout + 5s, 30s)`; campaign-save validator rejects
   `lock_ttl ≤ dial_timeout + 5`.
8. **`hopper_mirror` writes async-batched** (100 rows / 100ms) by a
   TS worker `workers/src/hopper-mirror-writer.ts`; cold-start sweep
   `workers/src/hopper-recovery.ts` ZADDs back leads whose
   `claimed_until < NOW()`.
9. **Outcome handling** maps 8 dial outcomes to `Release` actions
   (BRIDGED → terminal; NO_ANSWER → re-queue with status-specific
   `recycle_delay`; CARRIER_FAIL → re-queue immediately without
   penalty; TZ_BLOCKED_AT_ORIGINATE → push to delayed-set; etc.).
10. **15 RESEARCH open questions resolved** (see §16): freq-cap inline,
    Redis counter + nightly MySQL reconciliation, cel-go DSL deferred
    to Phase 3, in-process ticker, soft auto-trim (no active prune),
    EVEN multi-list mix Phase 2, `VICI2_HOPPER_DRY_RUN` env flag for
    dev/test.

---

## 1. Filler trigger strategy — cron + depth-driven hybrid

### 1.1 Architecture (recap from RESEARCH §3)

```
┌──────────────────────────────────────────────────────────────┐
│ E01 Filler service (long-running goroutine in dialer process) │
│                                                                 │
│  ┌─────────────────────┐    ┌──────────────────────────────┐  │
│  │ Cron tick (30s)     │    │ Pub/sub listener             │  │
│  │ time.NewTicker      │    │ Channel:                     │  │
│  │ For each active cid:│    │   t:{tid}:hopper:            │  │
│  │   maybeFill(cid)    │    │   refill_request:{cid}       │  │
│  └─────────┬───────────┘    └──────────────┬───────────────┘  │
│            │                                │                  │
│            ▼                                ▼                  │
│         maybeFill(cid):                                        │
│           lock = SET filler_lock:{cid} NX EX 60                │
│           if !lock: return (someone else's running, skip)      │
│           target = computeTarget(cid)                          │
│           have   = ZCARD(hopper:{cid})                         │
│           if have >= target * 0.9: release lock; return        │
│           drainDelayedSet(cid)  -- ZRANGEBYSCORE 0 now         │
│           need = target - have                                 │
│           rows = db.QueryLeadsForHopper(cid, ceil(need * 1.5)) │
│           inserted, skipped = 0, map[reason]int                │
│           pipe = valkey.Pipeline()                             │
│           for r in rows:                                        │
│             reason := checkAllGates(r)                         │
│             if reason != "": skipped[reason]++; continue        │
│             pipe.ZADD(hopper:{cid}, score, r.lead_id)          │
│             enqueueMirrorInsert(r)                             │
│             inserted++                                         │
│             if inserted >= need: break                         │
│           pipe.Exec()                                          │
│           emitMetrics(filler_duration, inserted, skipped)      │
│           release lock                                         │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 Cron driver — in-process ticker

- One `time.NewTicker(30 * time.Second)` per dialer pod.
- On tick, fan out: for each active campaign, push `maybeFill(cid)` job
  onto a buffered channel; a pool of 10 worker goroutines drains it.
- Per-campaign lock arbitrates between pods; missing a tick is harmless
  (pub/sub or next 30s tick covers it).

### 1.3 Pub/sub depth trigger

E02 (pacing) publishes when claim returns nil ≥ 5 consecutive times,
**or** when a successful claim leaves `ZCARD < target × 0.25` (low-water).
Channel format:

| Channel | Payload |
|---|---|
| `t:{tid}:hopper:refill_request:{cid}` | empty body (cid in channel name); listener triggers `maybeFill(cid)` |

Pub/sub is fire-and-forget. The 30s cron is the backstop.

### 1.4 Per-campaign concurrency control

- Per-campaign lock: `SET t:{tid}:hopper:filler_lock:{cid} <instance_id> EX 60 NX`
- Global semaphore: `chan struct{}` size 10 in the filler service —
  prevents 100 campaigns starting fillers simultaneously and exhausting
  DB connections.
- Lock TTL 60s is generous (filler should complete in <5s p95). If a
  filler genuinely takes longer, the next tick's `SET NX` fails — fine.
- On clean shutdown, `DEL filler_lock:{cid}` to let the next pod take
  it without waiting for TTL.

### 1.5 Knobs

| Setting | Default | Tunable | Notes |
|---|---|---|---|
| Cron interval | 30s | No (system-wide) | Halves Vicidial's 60s starvation window |
| `low_water_pct` | 25% of target | Per-campaign | Drives pub/sub trigger |
| `high_water_pct` | 90% of target | Per-campaign | Fill stops when reached |
| Filler lock TTL | 60s | No | Generous safety net |
| Per-campaign filler concurrency | 1 (lock) | No | Prevents double-fill |
| Global filler concurrency | 10 (semaphore) | No | Caps DB load |
| Over-fetch ratio | 1.5× | Per-campaign | Compensates for skip-rate |
| `dry_run` env flag | `VICI2_HOPPER_DRY_RUN=false` | env only | Logs ZADDs, doesn't write |

### 1.6 Cold-start

On dialer pod boot, before starting the cron:
1. Recovery sweep (delegated to `workers/src/hopper-recovery.ts`):
   `SELECT * FROM hopper_mirror WHERE tenant_id=? AND (claimed_until IS NULL OR claimed_until < NOW())`
2. Group by campaign; for each, `ZADD t:{tid}:campaign:{cid}:hopper score lead_id` (idempotent).
3. Emit `vici2_dialer_recovered_total` counter (per SPEC §4.7).
4. Then the cron and pub/sub listener start.

---

## 2. Hopper sizing formula

### 2.1 Auto formula (when `campaigns.hopper_size_target = 0`)

```
target = ceil(active_agents × dial_level × (60 / dial_timeout_sec) × hopper_multiplier)
target = max(target, min_hopper_level)        // default 50
target = min(target, max_hopper_level)        // default 5000
```

Inputs:

| Input | Source | Refresh |
|---|---|---|
| `active_agents` | `ZCARD t:{tid}:agents:by_campaign:{cid}:by_status:READY` + `:INCALL` + `:WRAPUP` | per-tick |
| `dial_level` | Valkey STRING `t:{tid}:campaign:{cid}:dial_level` (E03 writes) | per-tick (RESP3 client-side cached) |
| `dial_timeout_sec` | Postgres `campaigns.dial_timeout_sec` (default 22) | per-tick (cached 60s) |
| `hopper_multiplier` | `campaigns.hopper_multiplier` (default 1.5; raise to 2.0 for 25+ agents) | per-tick (cached 60s) |
| `min_hopper_level` | `campaigns.min_hopper_level` (default 50) | per-tick (cached 60s) |
| `max_hopper_level` | `campaigns.max_hopper_level` (default 5000) | per-tick (cached 60s) |

If target hits the cap (5000), emit
`vici2_dialer_hopper_target_capped_total{cid}` so operator knows to split
the campaign or raise `max_hopper_level`.

### 2.2 Manual override

If `campaigns.hopper_size_target > 0`, use it verbatim (Vicidial's static
hopper_level behavior). Useful for spike-testing and DR.

### 2.3 ADAPT-aware reads

`dial_level` is a Valkey STRING that E03 (adaptive engine) writes every
~15s. RESP3 + `CLIENT TRACKING ON BCAST PREFIX t:1:campaign:` (per F04 PLAN
§7.2) keeps the client cache fresh; expect ≤ 100ms staleness.

---

## 3. Per-lead gate execution (cheap → legal)

### 3.1 Pipeline (fail-fast)

```
Stage 0: SQL WHERE (status, list active, called_count, recycle delay, modify_at, deleted_at)
Stage 1: Frequency cap (per-state: FL/OK/MD/ME)         → reason: freq_cap_state
Stage 2: DNC scrub (D05.Check: federal Bloom + state + internal)  → reason: dnc_federal | dnc_state | dnc_internal | dnc_litigator
Stage 3: TZ resolve (D03.Resolve)                       → reason: no_tz
Stage 4: TCPA window (C01.Check)                         → reason: tcpa_window | tcpa_blocked
Stage 5: lead_filter DSL (Phase 2: SQL-only; Phase 3+: cel-go) → reason: lead_filter_excluded
```

Each stage that fails returns a `skipReason` string from the controlled
vocabulary (§4); the loop emits the metric and continues to the next
lead.

### 3.2 Stage 0 — SQL WHERE

The base query for every campaign:

```sql
SELECT l.id, l.phone_e164, l.state, l.postal_code, l.known_timezone,
       l.tz_offset_min, l.rank, l.called_count, l.last_local_call_time,
       l.list_id
FROM   leads l
JOIN   campaign_lists cl ON cl.list_id = l.list_id AND cl.campaign_id = ?
LEFT JOIN statuses s ON s.tenant_id = l.tenant_id AND s.code = l.status
WHERE  l.tenant_id = ?
  AND  l.list_id IN (?, ?, ...)               -- active campaign lists
  AND  l.status  IN (?, ?, ...)                -- campaign.dial_statuses
  AND  l.called_count < ?                       -- campaign.max_calls_per_lead
  AND  (l.last_local_call_time IS NULL
        OR l.last_local_call_time < NOW() - INTERVAL ? SECOND)  -- COALESCE(s.recycle_delay_seconds, campaign.default_recycle_delay)
  AND  l.deleted_at IS NULL
  AND  l.modify_at <= NOW()
  AND  cl.active = 1
ORDER BY l.rank DESC, l.modify_at ASC
LIMIT ?;
```

**Index used:** `idx_t_list_status_modify (tenant_id, list_id, status, modify_at)`
(F02 PLAN §4.13). EXPLAIN expected: `range` on the composite. Add
`SELECT ... /*+ MAX_EXECUTION_TIME(2000) */` query hint to fail fast on a
runaway query (MySQL 8 `MAX_EXECUTION_TIME` hint).

**Recycle delay** is per-status by default (D04 owns `statuses` table:
NA=300s, B=120s, AVMA=600s, etc.) with per-campaign override via
`campaign_status_overrides` (D04 + E01 coordination).

**Phase 2 multi-list mix:** EVEN — divide LIMIT by N lists, run N small
queries with `list_id = ?`, interleave results. Phase 3+: weighted MULTI.

### 3.3 Stage 1 — Frequency cap (per-state)

Decision (RESEARCH Q1+Q2): **inline in E01** with **Redis counter + nightly
MySQL reconciliation**.

| State | Cap | Window | Cite |
|---|---|---|---|
| FL | 3 calls | 24h | Fla. Stat. § 501.616 |
| OK | 3 calls | 24h | 15 OK Stat. § 775C.4 |
| MD | 3 calls | 24h | Md. Com. Law 14-3201 |
| ME | 1 call (autodialer) | 8h | 10 M.R.S. § 1498 |

Counter key: `t:{tid}:freq:{phone_e164}:{cid}` STRING with `INCR` +
`EXPIRE 86400` (or 28800 for ME). Read at gate-time:
`GET t:{tid}:freq:{phone}:{cid}`; if `>= cap`, skip.

Counters are incremented by E02 (after a successful originate, not at
claim time) so over-counting on re-queue is impossible. Nightly cron
(D04 worker) reconciles against `call_log` and corrects drift.

Fallback (Bloom unavailable): treat as "frequency unknown" → BLOCK
fail-closed for compliance; emit `vici2_dialer_filler_freq_degraded_total`.

### 3.4 Stage 2 — DNC scrub (D05 contract)

Direct Valkey reads (per RESEARCH §4.2 recommendation b). Order:
`federal Bloom → state SET → internal SET → litigator SET`.

```
hit_federal  := BF.EXISTS dnc:federal:bloom <phone>           # O(1), 0.1% FPR
if hit_federal: SELECT 1 FROM dnc WHERE phone=? AND source='federal'  # confirm
hit_state    := SISMEMBER dnc:state:{state} <phone>
hit_internal := SISMEMBER t:{tid}:dnc:internal <phone>
hit_litigator:= SISMEMBER dnc:litigator <phone>
```

Skip reasons map 1-to-1 to source: `dnc_federal`, `dnc_state`,
`dnc_internal`, `dnc_litigator`.

If `BF.EXISTS` errors (module not loaded, Bloom unavailable):
fail-closed → BLOCK and emit `vici2_dialer_filler_dnc_degraded_total`.

### 3.5 Stage 3 — TZ resolve (D03 contract)

```go
tz, err := d03.Resolve(ctx, lead)  // 4-tier: known_timezone → zip → state → NPA-NXX
if err != nil || !tz.Valid {
    skip("no_tz")
    continue
}
```

D03 is in-memory (NPA-NXX table loaded at boot, refreshed every 24h);
expected latency < 50µs.

### 3.6 Stage 4 — TCPA window (C01 contract)

```go
verdict := c01.Check(ctx, lead, tz, time.Now(), c01.EnforcementHopper)
switch verdict.Kind {
case c01.ALLOW:
    // continue
case c01.SKIP_UNTIL:
    enqueueDelayed(cid, lead.ID, verdict.NextOpenAt)
    skip("tcpa_window")
    continue
case c01.BLOCK_INVALID:
    markLeadInvalid(lead.ID, verdict.Reason)
    skip("tcpa_blocked")
    continue
}
```

`tcpa_window` indicates a temporary skip (lead returns later via
delayed-set). `tcpa_blocked` indicates a permanent block (lead becomes
status `INVALID`; M03 admin UI surfaces it for review).

### 3.7 Stage 5 — `lead_filter` DSL (Phase 2 = SQL-only)

**Phase 2 ships SQL-only.** Admin defines a parameterized SQL fragment in
`campaigns.lead_filter_sql` (whitelisted columns: `state`, `postal_code`,
`vendor_lead_code`, `rank`, `called_count`, `custom_data` JSON paths).
Validator at campaign save rejects DDL keywords, `;`, `--`, `/*`,
function calls.

**Phase 3+:** cel-go expression evaluator (Google Common Expression
Language) compiled to AST; generates parameterized SQL fragments. AST
also evaluable in Go for post-SQL re-checks. Spec deferred to a future
RFC.

### 3.8 SKIP_UNTIL handling — delayed-set ZSET

Key: `t:{tid}:campaign:{cid}:delayed`
Type: ZSET; score = `nextOpenAt_unix`; member = `lead_id`.

At each `maybeFill(cid)`:

```
delayed := ZRANGEBYSCORE t:{tid}:campaign:{cid}:delayed 0 NOW LIMIT 0 100
for each lead_id in delayed:
    ZREM ... lead_id
    re-load lead from MySQL (one query, batched up to 100)
    re-run gates (TCPA + DNC fresh)
    if pass: enqueue ZADD into hopper this tick
    if SKIP_UNTIL again: ZADD back into delayed with new score
```

Piggyback on filler tick (RESEARCH Q7); no separate worker.

### 3.9 BLOCK_INVALID handling

```sql
UPDATE leads
SET status='INVALID', invalid_reason=?, modify_at=NOW()
WHERE id=? AND tenant_id=?;
```

Write to `audit_log` for compliance trail. Lead's status no longer
matches `dial_statuses` so future SQL filler queries won't return it.

---

## 4. Skip-reason metric — controlled vocabulary

Single counter: `vici2_dialer_filler_skipped_total{reason}`.

Allowed reason values (closed enum — any other value is a bug):

| Reason | When |
|---|---|
| `tcpa_window` | C01 returned SKIP_UNTIL |
| `tcpa_blocked` | C01 returned BLOCK_INVALID (one-shot — lead becomes INVALID) |
| `dnc_federal` | DNC hit federal source |
| `dnc_internal` | DNC hit tenant-internal source |
| `dnc_state` | DNC hit a state list |
| `dnc_litigator` | DNC hit known-litigator list |
| `freq_cap_state` | Per-state cap exceeded (FL/OK/MD/ME) |
| `freq_cap_campaign` | Per-campaign cap exceeded (Phase 3+) |
| `no_tz` | D03 couldn't resolve a timezone |
| `recycle_delay` | last_local_call_time too recent (only emitted when SQL didn't filter; e.g., race with E02 increment) |
| `max_calls_reached` | called_count ≥ max_calls_per_lead (race-safety; SQL also filters) |
| `lead_filter_excluded` | `lead_filter_sql` (or future cel-go) excluded |
| `status_excluded` | Lead status not in `dial_statuses` (race-safety) |

Cardinality cap: 13 values × ~50 campaigns × 1 tenant = 650 series.
Acceptable. Per-state-DNC and per-state-freq are NOT broken out by
state in the label (would explode cardinality); state is in the log line
for forensics only.

---

## 5. Atomic claim contract (consumer side)

### 5.1 Public Go API

```go
// Filler — long-running goroutine inside the dialer process
type Filler interface {
    Start(ctx context.Context) error
    Stop(ctx context.Context) error
    FillNow(ctx context.Context, campaignID int64) (insertedCount int, err error)
}

// Consumer — called from E02 (pacing)
type Consumer interface {
    Claim(ctx context.Context, campaignID int64) (*LeadClaim, error)
    Release(ctx context.Context, claim *LeadClaim, outcome ReleaseOutcome) error
    ScheduleImmediate(ctx context.Context, cid, leadID int64, priority int) error  // for D06
}

type LeadClaim struct {
    LeadID    int64
    Campaign  int64
    LockValue string    // "{instance_id}:{claim_ts_ms}" — fence token for Release
    ClaimedAt time.Time
    ExpiresAt time.Time // ClaimedAt + lockTTL
}

type ReleaseOutcome struct {
    Kind   OutcomeKind
    Reason string                  // free-form for logs (not a metric label)
    Score  *float64                // optional — for re-queue with custom score
    NextOpenAt *time.Time          // for TZ_BLOCKED → enqueue to delayed-set
}

type OutcomeKind int
const (
    OutcomeBridged OutcomeKind = iota   // success — terminal
    OutcomeNoAnswer                      // re-queue with status recycle delay
    OutcomeBusy                          // re-queue with shorter recycle delay
    OutcomeMachine                       // terminal OR re-queue (per campaign config)
    OutcomeDropped                       // terminal (call_log + drop_log written)
    OutcomeCarrierFail                   // re-queue immediately, no penalty
    OutcomeTZBlockedAtOriginate          // push to delayed-set
    OutcomeLeadDeleted                   // terminal
)
```

### 5.2 Wraps F04 PLAN's Lua scripts

- `Claim` → `EVALSHA claim_lead_from_hopper.v1.lua` (F04 PLAN §6.1)
  with `KEYS=[hopper, lead_lock_prefix, in_flight]`,
  `ARGV=[lockTTLseconds, instanceID, nowMs]`. Returns `lead_id` or nil.
- `Release` → `EVALSHA release_hopper_lock.v1.lua` (F04 PLAN §6.2)
  with `KEYS=[lead_lock, in_flight, hopper]`,
  `ARGV=[leadID, reinsertFlag, reinsertScore, expectedLockValue]`.
  Idempotent on stale-lock (returns 0 if fence mismatch).

### 5.3 Lock TTL = max(dial_timeout + 5s, 30s)

| Setting | Default | Source |
|---|---|---|
| `dial_timeout_sec` | 22s | `campaigns.dial_timeout_sec` |
| `slack_sec` | 5s | constant |
| `min_lock_ttl` | 30s | constant |
| `lock_ttl_sec` | `max(dial_timeout_sec + slack_sec, min_lock_ttl)` | derived |

**Validator at campaign save (M02):**
```go
if c.LockTTLSec <= c.DialTimeoutSec + 5 {
    return errors.New("lock_ttl_sec must be > dial_timeout_sec + 5")
}
if c.LockTTLSec > 120 {
    return errors.New("lock_ttl_sec capped at 120s (avoid stuck-lead pile-ups)")
}
```

Validator runs at API write-time; runtime asserts the same on Filler.Start.

### 5.4 Crash recovery chain

```
Filler ZADD lead 12345 + hopper_mirror INSERT (async, 100ms-batched)
   ↓
E02 Claim: Lua script ZPOPMIN + SET lock NX EX 30 + HSET in_flight
   ↓
T04 originates → bgapi originate → carrier rings phone
   ↓
DIALER POD CRASHES (kill -9)
   ↓
30s passes → lead_lock auto-expires
   ↓
At T+60s: E06 janitor sweep clears in_flight HASH entries with no matching lock
   ↓
Cold-start sweep (next dialer boot OR next janitor tick) reads
hopper_mirror WHERE claimed_until < NOW() and ZADDs back
   ↓
Next filler tick: lead is back in hopper, eligible for re-claim
```

**Worst case:** lead waits 60–90s before re-attempt. Acceptable.

---

## 6. `hopper_mirror` async-batched writes

### 6.1 Why async

Filler is hot-path (target p95 < 5s for 1M leads, 100 campaigns). Each
ZADD is sub-ms; an INSERT into `hopper_mirror` with the same payload
adds ~1ms × 1000 leads = 1s/cycle. Async-batched writes amortize that
cost to ~10ms total (one INSERT batch).

### 6.2 Strategy

- Filler enqueues `MirrorEvent{tenant_id, campaign_id, lead_id, score, claimed_until=NULL}`
  to a Valkey Stream `t:{tid}:hopper_mirror_writes` (XADD with `MAXLEN ~ 100000`).
- TS worker `workers/src/hopper-mirror-writer.ts` consumes the stream
  via `XREADGROUP` (group=`hopper-mirror-writer`), buffers up to 100
  rows or 100ms whichever first, then issues a single INSERT batch.
- On `hopper_mirror` write success, XACK.
- On Claim, the same worker consumes a "claimed" event and UPDATES
  `claimed_by, claimed_until` (separate stream
  `t:{tid}:hopper_mirror_claims` to keep concerns split).
- On Release, an "unclaimed" event clears or DELETEs the row.

Stream-based decoupling means: filler/claim/release are unaffected if
MySQL is briefly slow; backpressure surfaces as growing `XLEN`.

### 6.3 Crash-recovery semantics

If Valkey crashes between filler ZADD success and stream XADD success:
hopper_mirror is missing a row but Valkey has the lead. Acceptable —
the lead is dialable. On restart, the cold-start sweep finds nothing
new to ZADD (lead already there).

If MySQL crashes after stream XADD: events accumulate in stream until
MySQL recovers; worker drains. Stream `MAXLEN ~ 100000` caps memory.

If both crash simultaneously: the lead might be lost. Worst-case lead
will be picked up by the next filler tick (same SQL query). Document
in HANDOFF.

### 6.4 Cold-start sweep

`workers/src/hopper-recovery.ts`:
1. Run on dialer boot (not on TS worker boot — coordinate via signal).
2. Per active tenant: `SELECT campaign_id, lead_id, score FROM hopper_mirror WHERE tenant_id=? AND (claimed_until IS NULL OR claimed_until < NOW())`
3. Group by campaign_id; per campaign, batch ZADD (idempotent — no-op
   if already there).
4. Emit `vici2_dialer_recovered_total{campaign}` per SPEC §4.7.

---

## 7. Outcome handling (8 dial outcomes)

E02 calls `Release(ctx, claim, outcome)` after every dial attempt.
The mapping table:

| Outcome | `Release` action | Lead state side-effect |
|---|---|---|
| **BRIDGED** (success) | TERMINAL: `DEL lock`, `HDEL in_flight`, no re-queue | D04 sets disposition; `called_count++` (E02) |
| **NO_ANSWER** | RETRY: re-queue with score = `now + status.recycle_delay_seconds` (e.g., 300s for NA) | D04 sets `NA`; `called_count++` |
| **BUSY** | RETRY: re-queue with shorter delay (e.g., 120s) | D04 sets `B`; `called_count++` |
| **MACHINE** (AMD) | Per campaign `machine_terminal=true` → TERMINAL; else RETRY | D04 sets `AVMA`; `called_count++` |
| **DROPPED** (answered, no agent in 2s) | TERMINAL (counts toward 30-day drop_window already written by T01) | D04 sets `ADC`; E05 emits safe-harbor metric |
| **CARRIER_FAIL** (503, congestion) | RETRY immediately, score = `now` (no penalty) | No lead state change; lead competes for next claim |
| **TZ_BLOCKED_AT_ORIGINATE** (T04 last-chance gate) | TERMINAL + push to delayed-set with `nextOpenAt` | No state change; lead returns when window opens |
| **LEAD_DELETED** (race with admin delete) | TERMINAL | (lead is gone) |

Per-outcome metric: `vici2_dialer_hopper_claims_total{outcome}`.

`called_count++` and `last_local_call_time = NOW()` are written by E02
in the same UPDATE that sets the disposition (D04). E01 doesn't touch
the lead row directly during release.

---

## 8. E01 ↔ E02 ↔ E03 ↔ E04 ↔ T04 boundary (sharp)

### 8.1 Producer/consumer split

```
   ┌──────────────────────────────────────────────────────────┐
   │  MySQL: leads, dnc, callbacks, hopper_mirror, call_log   │
   └────────────────────────┬─────────────────────────────────┘
                            │ SELECT
                            ▼
   ┌────────────────────────────────────────┐
   │  E01 Filler (this module)              │
   │   - cron 30s + pubsub trigger          │
   │   - SQL → gates → ZADD                 │
   │   - delayed-set drain                   │
   │   - hopper_mirror stream writer         │
   └────────────────────────┬───────────────┘
                            │ ZADD
                            ▼
   ┌────────────────────────────────────────┐
   │  Valkey ZSET t:{tid}:campaign:{cid}:hopper │
   └────────────────────────┬───────────────┘
                            │ Lua claim
                            ▼
   ┌────────────────────────────────────────┐
   │  E01 Consumer (this module)            │
   │   - Claim → LeadClaim (fence token)    │
   │   - Release → outcome → state          │
   │   - ScheduleImmediate (D06 callbacks)  │
   └────────────────────────┬───────────────┘
                            │ LeadClaim
                            ▼
   ┌────────────────────────────────────────┐
   │  E02 Pacing (rate limiter)             │
   │   - per-campaign tick                  │
   │   - reads dial_level                   │
   │   - decides "claim K leads now"        │
   │   - writes freq counter on success     │
   └────────┬─────────────────┬────────────┘
            │                  │
            │                  ▼
            │   ┌──────────────────────────────┐
            │   │  E03 Adaptive engine         │
            │   │   - reads drop_window stream │
            │   │   - writes dial_level        │
            │   └──────────────────────────────┘
            │
            ▼
   ┌────────────────────────────────────────┐
   │  E04 Picker (when call answers)        │
   │   - pick_agent_for_call.v1.lua          │
   │   - bridges into conference_${agent}   │
   └────────────────────────────────────────┘
```

### 8.2 What E01 owns vs delegates

| Responsibility | Owner |
|---|---|
| SQL filler query | **E01** |
| TCPA gate at filler-time | **E01** (via C01) |
| TCPA gate at originate-time (last-chance) | T04 (via C01) |
| DNC scrub at filler-time | **E01** (via D05) |
| TZ resolve | **E01** (via D03) |
| Frequency cap counter increment | E02 (after originate) |
| Frequency cap counter read | **E01** (at filler-time) |
| Atomic claim from Valkey | **E01** (Lua wrapped) |
| Pacing (claims/sec rate) | E02 |
| Dial level adjustment (drop% feedback) | E03 |
| Agent picking on answer | E04 |
| `bgapi originate` | T04 |
| Disposition write to `leads` row | D04 (via API) |
| Callback scheduling | D06 |
| Janitor sweep of stale `in_flight` | E06 |

### 8.3 D06 callback integration

D06 worker, when a callback fires, calls:

```go
err := consumer.ScheduleImmediate(ctx, campaignID, leadID, priority)
```

Inside `ScheduleImmediate`:
1. Run all gates (TCPA window, DNC, freq cap, TZ) — callbacks STILL run
   gates; legal-floor compliance is non-negotiable.
2. If pass: ZADD into hopper with high-priority score
   (`(MAX_PRIO - priority) * 1e10 + nowNs`).
3. If TCPA SKIP_UNTIL: push into delayed-set; return error so D06 can
   reschedule the callback.
4. If TCPA BLOCK or DNC: return error; D06 logs and abandons callback.

ScheduleImmediate **bypasses** the `low_water_pct` check (callbacks are
time-sensitive; insert immediately even if hopper is full).

### 8.4 Public interface freeze

The `Filler` and `Consumer` Go interfaces (§5.1) are FROZEN once PLAN
is approved. Adding methods is OK; renaming/removing requires RFC.

---

## 9. File layout

### 9.1 Go (in `dialer/`)

```
dialer/cmd/hopper/
  main.go                      -- entrypoint for hopper filler service (long-running)

dialer/internal/hopper/
  filler.go                    -- main loop, cron+pubsub, per-campaign goroutine pool
  claim.go                     -- Claim/Release Go API; wraps Lua via F04 helper
  release.go                   -- outcome → state transition mapping (§7 table)
  size.go                      -- target formula, dial_level read, multiplier logic
  query.go                     -- per-campaign SQL builder, multi-list EVEN mix
  gates.go                     -- pipeline: gates 1-5 in order, returns skipReason
  freqcap.go                   -- per-state cap check (Redis counter)
  delayed.go                   -- SKIP_UNTIL → delayed-set push + drain
  invalid.go                   -- BLOCK → markLeadInvalid()
  schedule.go                  -- ScheduleImmediate (D06 callback path)
  skipreason.go                -- controlled vocabulary const + metric helper
  config.go                    -- per-campaign config struct + validators
  metrics.go                   -- Prom counters/histograms
  filler_test.go
  claim_test.go
  release_test.go
  size_test.go
  query_test.go
  gates_test.go
  freqcap_test.go
  delayed_test.go
  schedule_test.go
  integration_test.go          -- testcontainers Valkey + MySQL
```

### 9.2 TypeScript (in `workers/`)

```
workers/src/
  hopper-mirror-writer.ts      -- consumes XSTREAM, batched MySQL INSERT
  hopper-recovery.ts           -- cold-start sweep: hopper_mirror → Valkey ZADD
workers/test/
  hopper-mirror-writer.test.ts
  hopper-recovery.test.ts
```

### 9.3 Shared

No new shared types beyond what F04 PLAN §7 already exposes via
`shared/lua/claim_lead_from_hopper.v1.lua` and `release_hopper_lock.v1.lua`.

---

## 10. Configuration knobs (per-campaign in DB)

Added to `campaigns` table (F02 PLAN coordination):

| Column | Type | Default | Notes |
|---|---|---|---|
| `dial_level` | DECIMAL(4,2) | 1.50 | Static for RATIO; written by E03 for ADAPT_* |
| `dial_timeout_sec` | SMALLINT | 22 | Originate timeout |
| `lock_ttl_sec` | SMALLINT | 30 | Validated > dial_timeout_sec + 5 |
| `min_hopper_level` | INT | 50 | Floor |
| `max_hopper_level` | INT | 5000 | Cap |
| `hopper_size_target` | INT | 0 | 0 = auto formula; >0 = manual override |
| `hopper_multiplier` | DECIMAL(3,1) | 1.5 | 2.0 for 25+ agents |
| `low_water_pct` | TINYINT | 25 | Pub/sub trigger threshold |
| `high_water_pct` | TINYINT | 90 | Stop-fill threshold |
| `over_fetch_ratio` | DECIMAL(3,1) | 1.5 | SQL LIMIT multiplier (compensates skip) |
| `default_recycle_delay_seconds` | INT | 600 | Fallback when status has no recycle_delay |
| `max_calls_per_lead` | TINYINT | 5 | Vicidial `dial_count_limit` |
| `dial_statuses` | JSON | `["NEW","NA","B","CALLBK"]` | Recallable statuses |
| `machine_terminal` | BOOL | true | AMD detection → terminate (not re-queue) |
| `lead_filter_sql` | TEXT NULL | NULL | Whitelisted SQL fragment (Phase 2) |
| `multi_list_mix` | ENUM('EVEN','MULTI','NONE') | 'EVEN' | Phase 2 = EVEN; MULTI Phase 3+ |

Per-status recycle_delay lives in D04's `statuses` table; per-campaign
overrides via `campaign_status_overrides (campaign_id, status_code, recycle_delay_seconds)`.

---

## 11. Metrics

All metrics under `vici2_dialer_*` prefix (per O01 conventions):

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `vici2_dialer_hopper_depth` | Gauge | `{campaign}` | ZCARD per campaign, scraped every 15s |
| `vici2_dialer_hopper_filler_duration_seconds` | Histogram | `{campaign}` | Buckets: 0.01, 0.1, 0.5, 1, 5, 10s |
| `vici2_dialer_hopper_inserts_total` | Counter | `{campaign, source}` | source = S/R/C/N/A |
| `vici2_dialer_hopper_claims_total` | Counter | `{campaign, outcome}` | outcome = bridged/no_answer/busy/machine/dropped/carrier_fail/tz_blocked/lead_deleted |
| `vici2_dialer_hopper_drain_events_total` | Counter | `{campaign}` | Filler ran, hopper still empty after — agent-starvation signal |
| `vici2_dialer_filler_skipped_total` | Counter | `{campaign, reason}` | 13-value enum (§4) |
| `vici2_dialer_filler_throughput` | Gauge | `{campaign}` | leads/sec rolling 1-min |
| `vici2_dialer_hopper_target_capped_total` | Counter | `{campaign}` | Hit max_hopper_level |
| `vici2_dialer_filler_dnc_degraded_total` | Counter | `{campaign}` | Bloom unavailable, fail-closed |
| `vici2_dialer_filler_freq_degraded_total` | Counter | `{campaign}` | Counter unavailable, fail-closed |
| `vici2_dialer_recovered_total` | Counter | `{campaign}` | Cold-start sweep restored leads |
| `vici2_dialer_delayed_set_size` | Gauge | `{campaign}` | ZCARD of delayed-set |
| `vici2_dialer_filler_lock_contention_total` | Counter | `{campaign}` | Filler tick skipped because lock held |

Alert recipes (handed to O01):

- `hopper_drain_events_total > 5/min` for 5min → page (agents starving).
- `hopper_target_capped_total > 0/min` for 30min → warn (config issue).
- `filler_dnc_degraded_total > 0` → page (compliance fail-closed firing).
- `delayed_set_size > 1000` for 30min → warn (TZ window starving campaign).

---

## 12. Open questions resolved (from RESEARCH §11)

| # | Question | Decision |
|---|---|---|
| 1 | Frequency-cap module ownership | **Inline in E01** (Phase 2). Promote to C05 in Phase 4 if needed. |
| 2 | Counter source for freq cap | **Redis counter + nightly MySQL reconciliation.** |
| 3 | Lead-filter DSL | **cel-go in Phase 3.** Phase 2 ships SQL-only with whitelisted parameterized fragments. |
| 4 | Cron driver | **In-process `time.NewTicker(30s)`** inside dialer. |
| 5 | Per-campaign filler isolation | **Goroutine-per-campaign + 10-slot global semaphore.** |
| 6 | Hopper insert ordering | **Single Valkey pipeline** for ZADD + stream XADD per fill cycle. |
| 7 | TZ delayed-set worker | **Piggyback on filler tick** — drain at start of `maybeFill(cid)`. |
| 8 | `ScheduleImmediate` bypass low-water? | **Yes** — callbacks insert regardless of hopper depth. |
| 9 | `hopper_mirror` write strategy | **Async-batched via Valkey Stream** consumed by `workers/src/hopper-mirror-writer.ts` (100 rows / 100ms). |
| 10 | `auto_trim_hopper` semantics | **Soft trim** — stop refilling when oversized; never actively prune in-flight. Active trim only if `dial_level` cut by 50%+ for >5min. |
| 11 | Filler-depth oscillation alarm | **Add Prometheus alert in O01** (depth/target swing > 0.1↔0.9 more than once per minute). |
| 12 | `no_hopper_dialing` mode | **Out of scope Phase 2.** Manual T04 dial bypasses hopper anyway. |
| 13 | Multi-list mix strategy | **EVEN** Phase 2; MULTI (admin-weighted) Phase 3+. |
| 14 | Recycle delay column ownership | **D04 owns `statuses.recycle_delay_seconds`** + per-campaign override via `campaign_status_overrides`. |
| 15 | `VICI2_HOPPER_DRY_RUN` flag | **Yes** — env-only (never campaign config); logs ZADDs but doesn't write; refuses to start if `ENVIRONMENT=production`. |

---

## 13. Test strategy

### 13.1 Unit tests

- `size.go`: every entry in §2.1 worked-example matrix → assert formula.
- `gates.go`: each stage in isolation with mocked D03/D05/C01 → assert
  return `skipReason` matches expectation; verify fail-fast (no later
  stages called when an earlier returns).
- `release.go`: each of 8 outcomes → assert correct Lua call shape.
- `skipreason.go`: assert all 13 values are present in the const enum;
  no other strings allowed.
- `config.go`: validator rejects `lock_ttl ≤ dial_timeout + 5`; rejects
  multiplier ≤ 0; rejects `lead_filter_sql` containing DDL keywords.

### 13.2 Integration tests (testcontainers Valkey + MySQL)

- **Concurrent claim:** 10 goroutines call `Claim` against a 5-lead
  hopper → exactly 5 distinct lead_ids returned, 5 nils.
- **Lock fence:** Claim, then Release with bad fence token → returns 0
  (no-op). Release with good token → returns 1.
- **Crash recovery:** populate hopper, claim 3 leads, kill the goroutine
  without Release; wait for lock TTL; run cold-start sweep → leads
  back in hopper.
- **DNC fail-closed:** mock `BF.EXISTS` to return error → all leads
  skipped with `dnc_degraded` metric incremented.
- **TCPA window:** lead in CA at 09:01 PT → ALLOW; same lead at 21:01
  PT → SKIP_UNTIL → push into delayed-set; advance clock → drain
  delayed-set → ALLOW.
- **Recycle delay:** lead with `last_local_call_time = NOW() - 200s`,
  status NA (recycle 300s) → SQL excludes; advance to 350s → SQL
  includes.
- **Freq-cap state:** seed FL phone with counter=3 → SKIP with
  `freq_cap_state`; counter=2 → ALLOW.
- **Filler lock:** two pods race → only one fills the campaign per tick;
  other emits `filler_lock_contention_total`.
- **ScheduleImmediate (callback):** insert callback at high priority →
  ZRANGE 0 0 returns the callback first.
- **Hopper-mirror writer:** filler ZADDs 1000 leads → within 200ms,
  hopper_mirror has 1000 rows; XACK count matches.

### 13.3 Performance benchmarks

- 1M-lead pool, 100 campaigns, p95 fill time < 5s. Profile if
  exceeded — most likely culprit is missing index on `leads`.
- 50 concurrent Claim ops/sec → no double-claim under chaos (Toxiproxy
  injects Valkey latency).

### 13.4 Run commands

```
make test-hopper                 # runs Go + TS suites
cd dialer && go test ./internal/hopper/...
cd workers && pnpm exec vitest run test/hopper
```

---

## 14. Risks (explicit + mitigations)

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Hot-DB filler queries at 10M+ leads** | High | High | Composite index `idx_t_list_status_modify` (F02 §4.13); `LIMIT N`; per-campaign `MAX_EXECUTION_TIME(2000)` hint; READ COMMITTED isolation; benchmarks in §13.3. |
| **In-flight orphan after dialer crash** | Medium | High | Lock TTL 30s + janitor sweep + cold-start `hopper_mirror` recovery. Worst case: 60–90s lead delay. |
| **Drop-rate threshold violation** | Low | Critical | E05 owns enforcement; E01 just respects E03's `dial_level`. If E03 cuts to 0, filler stops adding. |
| **DNC Bloom false positive (~0.1%)** | Always present | Low | MySQL fallback confirms. ~1 fallback per 1000 leads. |
| **Bloom filter unavailable (module not loaded)** | Low | High | Fail-closed: skip lead, alarm. Documented in HANDOFF. |
| **Frequency-cap counter drift** | Low | Medium (TCPA enforcement is for over-call, not under) | Nightly D04 reconciliation against `call_log`. |
| **`lead_filter_sql` SQL injection** | Medium (admin error) | High | Whitelist parser, keyword reject, `EXPLAIN` smoke at save time. |
| **Filler tick collisions across pods** | Medium | Low | Per-campaign Valkey lock + 10-slot semaphore + idempotent ZADD. |
| **Delayed-set unbounded growth** | Low | Medium | Per-tick drain; alert when ZCARD > 1000 for 30min. |
| **Schedule clock-skew between dialer pods** | Low | Medium | Pod NTP synced; gates re-check at originate (T04) anyway. |
| **`hopper_mirror` stream backlog if MySQL slow** | Medium | Low | Stream `MAXLEN ~ 100000`; lead is in Valkey already. Alert when XLEN > 10000. |

---

## 15. Hand-off to other modules

| Module | Hand-off content |
|---|---|
| **E02 (pacing)** | `Consumer.Claim` / `Release` API; freq-cap counter `INCR` semantics on success; pub/sub `t:{tid}:hopper:refill_request:{cid}` channel name; documented "Claim returns within 10ms" SLO. |
| **E03 (adaptive)** | E01 reads `t:{tid}:campaign:{cid}:dial_level` Valkey STRING; E03 writes it. Soft contract: change rate ≤ 1/15s. |
| **E04 (picker)** | E01 doesn't talk to E04 directly; E04 is event-driven on FS answer events. E01 has already produced the originate by then. |
| **E05 (drop guard)** | E05 owns drop% enforcement; E01 just stops adding when E03 cuts dial_level to 0. |
| **E06 (janitor)** | E06 owns sweeping orphaned `in_flight` HASH entries (per F04 PLAN §6.1 contract); E01's release script HDELs in-flight on success. |
| **C01 (TCPA gate)** | Imported as `c01.Check(lead, tz, when, EnforcementHopper)`. Returns ALLOW / SKIP_UNTIL / BLOCK_INVALID. |
| **D03 (TZ resolver)** | Imported as `d03.Resolve(lead)`; in-memory NPA-NXX + ZIP fallback. |
| **D05 (DNC)** | Direct Valkey reads (RESEARCH §4.2 option b); D05 owns populating Bloom + SETs. |
| **D04 (statuses)** | Reads `statuses.recycle_delay_seconds` via JOIN; per-campaign override via `campaign_status_overrides`. |
| **D06 (callbacks)** | D06 calls `Consumer.ScheduleImmediate(cid, leadID, priority)`; E01 runs gates before insert. |
| **F02** | Adds 16 columns to `campaigns` (§10); creates `campaign_status_overrides` table; uses `idx_t_list_status_modify` index already in F02 PLAN. |
| **F04** | Uses `claim_lead_from_hopper.v1.lua` and `release_hopper_lock.v1.lua` from F04 PLAN §6; uses helper-lib `HopperOps`. |
| **T04 (originate)** | E01 hands off LeadClaim; T04 runs final TCPA check (last-chance) before `bgapi originate`. |
| **O01 (metrics)** | Per-metric label sets in §11; alert rules at end of §11. |

---

## 16. Acceptance criteria (from E01.md, restated)

- [ ] Filler runs cron-ticker (30s) + pub/sub trigger; per-campaign lock prevents double-fill.
- [ ] Sizing formula matches §2.1; floor + cap honored.
- [ ] All 5 gate stages execute in order; first-NO short-circuits.
- [ ] Skip metric uses controlled vocabulary (§4); no high-cardinality labels.
- [ ] SKIP_UNTIL pushes to delayed-set; drained at next tick.
- [ ] BLOCK_INVALID marks lead status=INVALID with reason.
- [ ] `Claim` returns LeadClaim with fence token in <10ms p95 (no DB roundtrip).
- [ ] `Release` is idempotent (Lua fence prevents double-release corruption).
- [ ] Lock TTL = max(dial_timeout+5, 30); validator at campaign save.
- [ ] `hopper_mirror` writes async-batched via stream + worker.
- [ ] Cold-start sweep restores leads from `hopper_mirror`.
- [ ] All 8 outcomes mapped to correct Release action.
- [ ] D06 `ScheduleImmediate` runs gates and bypasses low-water.
- [ ] `VICI2_HOPPER_DRY_RUN=true` logs ZADDs but doesn't write; refuses prod.
- [ ] Coverage > 70% on hopper code; concurrent-claim integration test passes.
- [ ] p95 fill time < 5s for 1M-lead pool, 100 campaigns.

---

## 17. Filler trigger confirmation

**FINAL — Filler trigger: cron + depth-driven HYBRID.**

- 30-second in-process `time.NewTicker` runs `maybeFill` for every active
  campaign (steady-state baseline).
- Pub/sub channel `t:{tid}:hopper:refill_request:{cid}` from E02 pacing
  fires `maybeFill(cid)` when `ZCARD < target × 0.25` (low-water) or
  after 5 consecutive nil claims.
- Per-campaign Valkey advisory lock `t:{tid}:hopper:filler_lock:{cid}`
  via `SET NX EX 60` makes multi-pod safe.
- Goroutine-per-campaign + 10-slot global semaphore caps concurrency.
- 30s cron + idempotent ZADD makes pub/sub loss harmless (lost
  notification → next tick covers).

End of PLAN.md.
