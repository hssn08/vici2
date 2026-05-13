# E01 — Hopper Engine — RESEARCH

**Module:** E01 (Hopper engine: SQL→Redis filler + Redis→Originate consumer)
**Status:** RESEARCH (Wave 3; D03 + D05 RESEARCH races; both consumed via interface contracts)
**Date:** 2026-05-06
**Working scope:** Phase 2 auto-dialer; manual dial path (T04) bypasses hopper. US dialing only.

> **Why this matters.** The hopper is the *single point* where compliance gates (TCPA window, DNC, frequency caps) MUST be enforced before a number ever reaches the originate path. SPEC.md §4.1 makes hopper enforcement non-negotiable. Drop a check here and we can dial a Sunday in Alabama or a 9:01pm number in California — every miss = $500 statutory damages × class-action multiplier. The hopper also is the throughput regulator: starve it and agents idle (lost revenue); over-fill it and leads stale before they're dialed (wasted contacts + stale-data drift).

---

## 1. Executive summary (10 bullets)

1. **Vicidial reference: `AST_VDhopper.pl` runs every 60s via cron** with sources `S` (Standard) `R` (Recycle) `C` (Callback) `N` (Xth-NEW order) `A` (Auto-alt-dial) `P` (API-pushed) `Q` (no-hopper queue insert). Per-campaign filter pipeline = `dial_statuses` → `local_call_time` (federal+state) → `lead_filter_id` (admin SQL fragment) → `vicidial_dnc` (federal+internal) → `called_count <= dial_count_limit` → `recycle_delay_seconds` since last dial → DNC. The hopper itself is a `MEMORY` table; Vicidial uses a `drop-in lock` on `vicidial_hopper` via `LOCK TABLES` to serialize the per-campaign refill.
2. **Recommended trigger: cron + depth-driven hybrid.** A 30-second cron tick covers steady-state; a Valkey pub/sub message `t:{tid}:hopper:refill_request:{cid}` fires when ZCARD drops below `low_water` (= 25% of target). On boot or when target changes we also do a one-shot full fill. This converges to Vicidial behavior under steady state but eliminates the "agents starve while waiting for the next minute" failure mode that Vicidial's pure-cron design produces during burst dialing or long DNC scrubs.
3. **Hopper sizing formula = `ceil(active_agents × auto_dial_level × (60 / dial_timeout_sec) × hopper_multiplier)`** (Vicidial-compatible). For 30 agents @ ratio 2.0 @ 22s timeout @ multiplier 2.0 = `ceil(30 × 2 × 2.73 × 2)` = **328 leads**. Floor at `min_hopper_level` (default 50) so very-small campaigns still buffer 30 sec of dial demand. Multiplier ≥ 2.0 for ≥25 agents per ViciStack guidance; 1.5 for smaller campaigns.
4. **Per-lead compliance gates run BEFORE ZADD.** Order (cheap → expensive, fail-fast): (a) Lead state in campaign's `dial_statuses` set; (b) `called_count < dial_count_limit`; (c) recycle delay since `last_local_call_time`; (d) per-state frequency cap (FL, OK, MD = 3 calls / 24h same subject — counter from `call_log`); (e) D05 DNC scrub (federal Bloom → state SET → internal SET → litigator SET); (f) D03 TZ resolve + C01 TCPA window (federal floor + state-strictest + holiday + Sunday-blackout).
5. **Atomic claim already specified in F04 PLAN §6.1** — `claim_lead_from_hopper.v1.lua`: `ZPOPMIN` + `SET ... EX 30 NX` lock + `HSET in_flight`. Returns `lead_id` or nil. E01 wraps via `HopperOps.Claim(ctx, cid, instanceID, ttl)`. This is the production-grade pattern from the Svix / OneUptime references — naked `ZPOPMIN` loses the lead on consumer crash; the lock+HSET pair lets the janitor replay.
6. **Lock TTL strategy: 30s default, configurable.** Formula = `max(originate_timeout_sec + 5, 30)`. Vicidial uses `dial_timeout` (default 26s, recommended 18-22s) so 30s is safely > the longest dial attempt. On consumer crash mid-originate, the lock TTL fires → janitor's stream-claim sweep returns the lead to the hopper for the next filler pass. No double-dial because the lock is on `lead_lock:{cid}:{lead_id}` and `hopper_mirror.claimed_until` matches.
7. **Multi-instance consumer coordination is free** because every claim goes through the Lua script. N dialer pods can each call `HopperOps.Claim(...)` and Redis serializes them; whichever ZPOPMINs first gets the lead, the others get nil and pace down for that tick. No external coordinator needed (no ZooKeeper, no etcd).
8. **`hopper_mirror` (per F02 PLAN §4.17) is the crash-recovery anchor.** The filler writes Redis ZADD + `INSERT INTO hopper_mirror` in the same logical transaction (Redis first, MySQL second; idempotent UNIQUE on `(tenant, campaign, lead)`). On dialer cold-start, a recovery sweep reads `hopper_mirror WHERE claimed_until IS NULL OR claimed_until < NOW()` and `ZADD`s back any orphans. Makes "kill -9 the dialer" survivable without losing leads.
9. **E01 boundaries are sharp.** E01 produces *"this lead_id is claimed and ready to dial right now."* E02 (pacing) decides *how many* claims per second to make, based on `dial_level` and `dial_timeout`. E04 (picker) decides *which agent* the answered call bridges to. T04 (originate) is what actually fires `bgapi originate`. E01 doesn't know about agents, channels, or carriers — it only knows leads, campaigns, hoppers, locks.
10. **Performance budget: filler must complete < 5s p95 for 1M-lead pool, 100 campaigns.** Per-campaign filler is independent → run goroutine-per-campaign with a semaphore (max 10 concurrent). Primary index `idx_t_list_status_modify (tenant_id, list_id, status, modify_at)` is already in F02 PLAN §4.13. SELECT N rows where N = `target - ZCARD`, never the full pool. DNC + TCPA gates run in Go after the SELECT (Redis Bloom for DNC = O(1); D03 in-memory TZ table = O(1)). Skipped-leads emit `vici2_dialer_filler_skipped_total{reason}` so we can spot misconfig.

---

## 2. Vicidial reference (`AST_VDhopper.pl`) — what to keep, what to ditch

### 2.1 Source: `bin/AST_VDhopper.pl` (inktel/Vicidial mirror)

Header comments enumerate hopper *sources* (each a different SELECT path):
- `S` = Standard hopper load — primary SQL: `SELECT lead_id, list_id, gmt_offset_now, state, ... FROM vicidial_list WHERE list_id IN (...) AND status IN (dial_statuses) AND called_since_last_reset='N' AND gmt_offset_now BETWEEN $local_window_low AND $local_window_high ORDER BY <list_order_field>`
- `R` = Recycled leads — re-fed when `called_count < dial_count_limit` AND `now - last_local_call_time > recycle_delay`
- `C` = Scheduled callbacks (LIVE + due now)
- `N` = "Xth NEW lead order" mix (e.g., for every 5 standard, take 1 fresh-NEW)
- `A` = Auto-alt-dial (phone_alt / phone_alt2 after primary fails)
- `P` = External-API hopper push (3rd-party CRM pushes a lead via `non_agent_API`)
- `Q` = "no-hopper queue" insert (manual-flagged leads bypass hopper)

### 2.2 Per-campaign filter loop (transcribed from source)

```
For each active campaign in vicidial_campaigns:
  1. Load: hopper_level, auto_dial_level, dial_timeout, local_call_time,
           lead_filter_id, use_internal_dnc, dial_method, available_only_ratio_tally,
           adaptive_dropped_percentage, adaptive_maximum_level, dial_statuses,
           list_order_mix, use_campaign_dnc, drop_lockout_time, no_hopper_dialing,
           auto_alt_dial_statuses, auto_hopper_multi, use_auto_hopper, auto_trim_hopper,
           lead_order_randomize, lead_order_secondary, state_call_times
  2. If use_auto_hopper='Y':
       hopper_level = ceil(auto_hopper_multi * (num_agents + num_paused_agents)
                          * auto_dial_level * (60 / dial_timeout))
  3. If auto_trim_hopper='Y' and current ZCARD > hopper_level:
       DELETE FROM vicidial_hopper WHERE campaign_id=? AND status IN ('READY')
                                     AND source IN ('S','N')
                                     ORDER BY priority DESC LIMIT excess
  4. Resolve list IDs from campaign_lists where active='Y'
  5. Fetch lead_filter_sql (raw SQL fragment, admin-defined, e.g., "state IN ('CA','OR')")
  6. Build local_call_time window:
       9am-9pm (federal floor) tightened by state_call_times for non-fed states
  7. SELECT candidates from vicidial_list with all filters, ORDER BY rank/random,
     LIMIT (hopper_level - current_ZCARD)
  8. For each candidate: re-check DNC (vicidial_dnc) and lead_filter; if pass, ZADD
  9. Update vicidial_campaign_stats with last-fill counters
  10. (LOCK TABLES vicidial_hopper) → INSERT batch → UNLOCK
```

### 2.3 Drop-in lock pattern

Vicidial uses `LOCK TABLES vicidial_hopper WRITE` to prevent concurrent VDhopper instances from inserting the same lead twice. We replace this with **per-campaign Redis advisory lock** (already designed in F04 PLAN §4.13):
```
SET t:{tid}:hopper:filler_lock:{cid} <instance_id> EX 60 NX
```
Only one filler per campaign per tick; multiple campaigns parallelize.

### 2.4 What to ditch

| Vicidial pattern | Why we don't keep it |
|---|---|
| `MEMORY` engine for `vicidial_hopper` | We use Redis ZSET (purpose-built; F04). |
| `LOCK TABLES` MyISAM-style serialization | Redis SET-NX advisory lock; per-campaign granularity. |
| 60s pure-cron cadence | Adds 30-60s latency under burst. We use 30s cron + depth-driven trigger. |
| Raw SQL in `lead_filter_sql` admin field | **Security risk** (SQL injection by admin error). We adopt a templated whitelist (parametrized fragments only; documented in E01.md Risks). |
| `auto_alt_dial` recursion in the same script | Split: alt-dial decision lives in disposition handler (D04) which writes a new hopper row; filler stays single-purpose. |
| Dial-method awareness in hopper | The hopper doesn't care about `RATIO/ADAPT_*`; that's E03's concern. Hopper sizing reads `dial_level` only. |

### 2.5 What to keep

| Pattern | Why |
|---|---|
| `auto_hopper_level` formula (multiplier × agents × dial_level × 60/timeout) | Battle-tested for 20 years; ViciStack still recommends. |
| Filter order (state → DNC → tz → recycle) | Matches our cheap→expensive ordering. |
| `auto_trim_hopper` | When `dial_level` drops mid-day, oversized hopper goes stale. We mirror with a periodic trim sweep. |
| `dial_statuses` list (NEW + recycled statuses) | D04 owns the status table; E01 reads campaign's whitelist. |
| Source codes (`S/R/C/N/A/P/Q`) | Useful for metrics: `vici2_dialer_hopper_inserts_total{source}` |

---

## 3. Filler trigger strategy: cron + depth-driven hybrid

### 3.1 The problem with pure-cron (Vicidial's choice)

If 50 agents are READY and `dial_level=3`, the dialer burns **150 leads/minute**. A 60s cron interval means the hopper is full → empty → full in one cycle. Any of the following causes idle agents:
- VDhopper takes 30s to run on a busy DB (not unusual at 5M+ leads).
- A burst of DNC hits during the run (e.g., a federal sync just ran).
- Cron was skipped due to overlapping previous run.
- Single-server bottleneck — Vicidial assumes you scale Asterisk, not the hopper.

### 3.2 The problem with pure-depth-driven (event-only)

- Thundering herd: 4 dialer pods all observe ZCARD < threshold simultaneously and 4 fillers race the same campaign.
- Lost trigger: pub/sub is fire-and-forget; if nobody is subscribed when the event fires, the hopper stays empty.
- No backstop for slow leak (e.g., a campaign nobody is consuming from but should still trim).

### 3.3 Hybrid recommendation

```
┌───────────────────────────────────────────────────────────┐
│  E01 Filler service (long-running Go process)              │
│                                                             │
│  ┌─────────────────────┐    ┌─────────────────────────┐   │
│  │ Cron tick (30s)     │    │ Pub/sub listener        │   │
│  │ For each campaign:  │    │ Channel:                │   │
│  │   maybeFill(cid)    │    │   t:{tid}:hopper:       │   │
│  └─────────┬───────────┘    │   refill_request:{cid}  │   │
│            │                 └────────────┬────────────┘   │
│            ▼                              ▼                │
│         maybeFill(cid):                                    │
│           lock = SET hopper:filler_lock:{cid} NX EX 60     │
│           if !lock: return (someone else's running)        │
│           target = computeTarget(cid)                      │
│           have   = ZCARD(hopper:{cid})                     │
│           if have >= target * 0.9: release lock; return    │
│           need = target - have                             │
│           rows = db.QueryLeadsForHopper(cid, need * 1.5)   │
│           inserted = 0                                      │
│           for r in rows:                                    │
│             if !checkAllGates(r): emit_skip; continue       │
│             pipe.ZADD; pipe.HopperMirrorInsert              │
│             inserted++                                      │
│             if inserted >= need: break                      │
│           pipe.Exec()                                       │
│           emit_metric(filler_duration, inserted)            │
│           release lock                                      │
│                                                             │
│  E02 (consumer pacing loop) emits:                         │
│    PUBLISH t:{tid}:hopper:refill_request:{cid} ""          │
│  whenever ZCARD < low_water (target * 0.25) after a claim. │
└───────────────────────────────────────────────────────────┘
```

**Knobs:**

| Setting | Default | Tunable per campaign |
|---|---|---|
| Cron interval | 30s | No (system-wide) |
| `low_water_pct` | 25% of target | Yes |
| `high_water_pct` | 90% of target | Yes |
| Filler lock TTL | 60s | No |
| Per-campaign filler concurrency | 1 (the lock) | No |
| Global filler concurrency | 10 (semaphore) | No |
| Over-fetch ratio | 1.5× (compensates for skip-rate) | Yes (raise for high-DNC tenants) |

**Why 30s instead of 60s:** with 100 agents @ ratio 3, that's 300 leads/min. Halving the cron interval halves the worst-case starvation gap from 60s → 30s. Yet keeps DB load < 2× Vicidial.

**Why pub/sub instead of `BZPOPMIN`-style blocking:** the filler is the *producer*; consumers (E02) are blocking on the hopper. We need a notification *to* the filler when the hopper is depleting — that's pub/sub from the consumer. (Inverse pattern from F04.)

### 3.4 First-run / cold-start

On boot:
1. Read `hopper_mirror WHERE tenant_id=? AND (claimed_until IS NULL OR claimed_until < NOW())`
2. Group by campaign_id; for each campaign, ZADD all rows (idempotent — Redis ZADD updates score if member exists).
3. Mark `recovered_total` metric.
4. Immediately run `maybeFill(cid)` for every active campaign (top-off).

Recovery is *additive* — we don't try to figure out what's already in Redis; we just push the persistent shadow back in. Drift is OK because Redis ZADD is idempotent on `lead_id` member.

---

## 4. Per-lead compliance gates in filler (with order)

### 4.1 Ordering principle

Cheap (memory only) → expensive (network) → semantic (legal). Fail-fast: first NO short-circuits.

```
Stage 0: Lead-state filter         (in SQL WHERE)
Stage 1: Campaign-attempt limits   (in SQL WHERE: called_count < dial_count_limit)
Stage 2: Recycle-delay             (in SQL WHERE: modify_at < now - recycle_seconds)
Stage 3: Frequency caps (per-state)        (Go: SELECT count(*) FROM call_log WHERE phone=? AND ts > now-24h)
Stage 4: DNC scrub (D05 — Bloom + SET)     (Go: 4 SISMEMBER + 1 BF.EXISTS)
Stage 5: TZ resolve (D03)                  (Go: in-memory NPA-NXX/ZIP lookup)
Stage 6: TCPA call-window (C01)            (Go: federal floor ∩ state ∩ campaign)
Stage 7: Lead-filter SQL fragment          (already in SQL WHERE if templated; else Go post-filter)
```

### 4.2 Stage detail

#### Stage 0–2 — pushed into the SQL `WHERE`

```sql
SELECT id, phone_e164, state, postal_code, known_timezone, tz_offset_min,
       rank, called_count, last_local_call_time
FROM   leads
WHERE  tenant_id   = ?
  AND  list_id     IN (?, ?, ...)
  AND  status      IN (?, ?, ...)               -- campaign.dial_statuses
  AND  called_count < ?                          -- campaign.dial_count_limit
  AND  (last_local_call_time IS NULL
        OR last_local_call_time < NOW() - INTERVAL ? SECOND)  -- per-status recycle delay (joined)
  AND  deleted_at IS NULL
  AND  modify_at <= NOW()
ORDER BY rank DESC, modify_at ASC
LIMIT ?;
```

Index: `idx_t_list_status_modify (tenant_id, list_id, status, modify_at)` — already F02 PLAN §4.13. EXPLAIN expected: `range` on the composite, no filesort because `ORDER BY rank DESC, modify_at ASC` matches; if rank breaks the index, fall back to filesort but expected row count is small (LIMIT 200-1000).

**Recycle delay is per-status:** Vicidial stores `dial_status_x_dial_delay` per status (e.g., NA=120s, B=60s). Implementation: `LEFT JOIN statuses st ON st.tenant_id = leads.tenant_id AND st.code = leads.status` and use `st.recycle_delay_seconds`. (D04 owns the `statuses` table — confirm join shape in PLAN.)

#### Stage 3 — Per-state frequency caps (FL/OK/MD = 3 calls / 24h same subject)

| State | Cap | Window | Cite |
|---|---|---|---|
| FL | 3 calls | 24h same subject | Fla. Stat. § 501.616 |
| OK | 3 calls | 24h same subject | 15 OK Stat. § 775C.4 |
| MD | 3 calls | 24h | Md. Com. Law 14-3201 |
| ME (autodialer) | 1 call | 8h | 10 M.R.S. § 1498 |

**Implementation:**
```go
if isFreqCappedState(lead.State) {
    n, err := db.CountRecentCallsByPhone(ctx, lead.PhoneE164, lead.CampaignID, 24*time.Hour)
    if err != nil || n >= 3 { skip("frequency_cap"); continue }
}
```
Index needed (NEW — flag for PLAN): `INDEX idx_call_log_phone_ts (tenant_id, phone_e164, started_at)` on `call_log`. Or — better — keep a Redis counter `t:{tid}:freq:{phone}:{campaign}` with `INCR` + `EXPIRE 86400` after each successful originate. Counter approach is O(1) and survives MySQL going slow. Frequency-cap design is **out-of-scope for E01 itself per C01 RESEARCH §3 footnote** but C01 explicitly calls out that filler must consult them — open question for PLAN whether E01 owns the cap-check or delegates to a future C05.

For Phase 2 MVP we recommend: **inline check via Redis counter; punt full module C05 to Phase 4.** Document in E01 PLAN.

#### Stage 4 — DNC (D05 contract)

D05 RESEARCH is racing; the contract per `D05.md` is:
```typescript
isDnc(phone, opts: { useFederal, useState, useInternal, useLitigator })
  → { dnc: boolean, sources: string[] }
```
For E01 (Go side) we either:
- (a) Call API service via gRPC — adds RTT per lead (~1ms × 1000 leads = 1s/cycle).
- (b) Read Redis directly using D05's documented key shape (`dnc:federal` SET / Bloom, `t:{tid}:dnc:internal` SET, `dnc:state:{state}` SET, `dnc:litigator` SET). O(1) per lead.

**Recommendation: (b) direct Redis.** Same client we already have; bypasses the API-Go-API round-trip; D05 owns *populating* the Redis structures. E01 just consumes.

For federal DNC at scale (~250M numbers — see D05.md Risks), the Bloom filter (`BF.EXISTS dnc:federal:bloom phone`) is mandatory; positive Bloom hits fall back to MySQL `SELECT 1 FROM dnc WHERE phone=? AND source='federal'` — but at 0.1% FPR that's 1 fallback per 1000 leads. Document in PLAN.

#### Stage 5 — TZ (D03)

D03 RESEARCH is racing; D03 contract per `D03.md`:
```typescript
resolvePhoneTz(e164) → { tzName, tzOffsetMin, state?, valid }
```

Per **C01 RESEARCH §4.2 "hybrid approach":** Go side gets a **local in-memory copy** of `phone_codes` (~280 NPAs × ~600 NXXs = ~168k rows, a few MB) loaded at boot, refreshed every 24h. Use 4-tier fallback (lead.known_timezone → lead.zip → state → NPA-NXX → BLOCK).

Library: `nyaruka/phonenumbers` (Go port of libphonenumber) — but per C01 RESEARCH §4.2.2, **only for E.164 parsing/validation, not for tz lookup** (libphonenumber is NPA-only and misses Indiana NXX splits).

#### Stage 6 — TCPA call-window (C01)

C01 RESEARCH already specifies the gate. E01 calls C01's `assertCallWindow(phone, campaign, when, enforcementPoint='hopper')`. Returns:
- `ALLOW` → continue.
- `SKIP_UNTIL nextOpenAt` → don't add to hopper now; instead enqueue into a **delayed-set** keyed by `nextOpenAt`. A separate worker (or our same filler on next tick) re-checks at-or-after `nextOpenAt`. Implement as `t:{tid}:hopper:delayed:{cid}` ZSET with score = `nextOpenAt_unix`; on each filler tick we `ZRANGEBYSCORE 0 NOW` and re-evaluate.
- `BLOCK` → mark `lead.tz_blocked = true` (one-shot column; surfaces in M03 admin UI for review). Don't try again this campaign run.

#### Stage 7 — Lead-filter SQL fragment

Vicidial's `lead_filter_id → lead_filter_sql` admin field is a raw SQL fragment (e.g., `state IN ('CA','OR','WA') AND custom_data->>'$.priority' = 'high'`). **SQL injection risk** if we just concatenate.

Recommendation (already in E01.md Risks): use a **whitelist DSL** — parsed by Go, compiled to a parameterized WHERE fragment. Allowed left-hand sides: column names from a static allowlist (`state`, `postal_code`, `vendor_lead_code`, `rank`, `called_count`, `custom_data` JSON path). Allowed operators: `=, !=, <, <=, >, >=, IN, NOT IN, IS NULL, IS NOT NULL, AND, OR`. Reject DDL keywords, `;`, `--`, `/*`, function calls. Document grammar in PLAN as `lead_filter.bnf`.

### 4.3 Skip-reason metric cardinality

`vici2_dialer_filler_skipped_total{reason}` — controlled vocabulary (no high-cardinality values):
```
reason ∈ {
  tcpa_window,
  tcpa_unknown_tz,
  dnc_federal, dnc_state, dnc_internal, dnc_litigator,
  freq_cap_state,
  recycle_delay,
  attempt_limit,
  lead_filter,
  duplicate_in_hopper,
  list_inactive,
  manual_block
}
```

---

## 5. Atomic claim Lua script (referenced from F04 PLAN)

F04 PLAN §6.1 already specifies `claim_lead_from_hopper.v1.lua`. E01 wraps it via `HopperOps.Claim` (F04 PLAN §7 helper API):

```go
// E01 consumer interface (signature; no implementation):
type HopperConsumer interface {
    Claim(ctx context.Context, campaignID int64) (LeadClaim, error)
    Release(ctx context.Context, claim LeadClaim, outcome ReleaseOutcome) error
}

type LeadClaim struct {
    LeadID    int64
    Campaign  int64
    LockValue string  // instance_id:claim_ts — fence for Release
    ClaimedAt time.Time
}

type ReleaseOutcome struct {
    Kind     enum: SUCCESS | RETRY | TERMINAL | TZ_BLOCKED
    NewScore *float64  // for RETRY: score for re-insert
}
```

**Claim flow:**
1. `EVALSHA claim_lead_from_hopper.v1` with `KEYS=[hopper, lock_prefix, in_flight]`, `ARGV=[ttl=30, instance_id, now_ms]`.
2. Returns `lead_id` or nil.
3. If nil → return `ErrEmptyHopper`; pacing loop pauses for 100ms.
4. If lead_id → wrap in `LeadClaim` and return.

**Release flow:**
1. `EVALSHA release_hopper_lock.v1` (F04 PLAN §6.2) with KEYS+ARGV.
2. Drives `outcome.Kind`:
   - SUCCESS → script `DEL lock`, `HDEL in_flight`, no re-insert. (`record_call_outcome.v1.lua` will fire from E02 separately.)
   - RETRY → script `DEL lock`, `HDEL in_flight`, `ZADD hopper newScore lead_id`. (Used when originate returned a soft failure: carrier 503, congestion. Not for compliance-fail at originate-time.)
   - TERMINAL → like SUCCESS, plus emit `vici2_dialer_filler_lead_terminal_total{reason}`. Lead is dead (e.g., DNC-late-add).
   - TZ_BLOCKED → like TERMINAL, but caller also enqueues to delayed-set with nextOpenAt.

### 5.1 Lock fencing

The lock value `{instance_id}:{claim_ts_ms}` is critical for `release_hopper_lock` correctness. If E01 dialer-pod-A claims lead 12345, then crashes, then 30s later another pod-B's filler re-emits 12345, then pod-A wakes up and tries to release — without fencing, it would corrupt pod-B's claim. The `ARGV[4] = expected lock value` check in F04 PLAN §6.2 fences this.

### 5.2 Janitor handoff

The 30s lock TTL fires automatically if Release isn't called. But the `in_flight` HASH entry doesn't TTL — that's the janitor's job (E06). Janitor sweep:
```lua
-- pseudocode for janitor: clear orphaned in_flight entries
HGETALL t:{tid}:campaign:{cid}:in_flight
for each (lead_id, lock_val):
  if not EXISTS lead_lock:{cid}:{lead_id}:
    HDEL in_flight lead_id
    -- and re-add to hopper if hopper_mirror still has it un-deleted
```

This is E06's responsibility but E01's contract guarantees that if `Claim` returns and `Release` is *never* called, the lead won't be lost — janitor restores it.

---

## 6. Hopper depth target formula

### 6.1 Vicidial-compatible auto-hopper

```
target = ceil(active_agents × auto_dial_level × (60 / dial_timeout_sec) × hopper_multiplier)
target = max(target, min_hopper_level)
target = min(target, max_hopper_level)        // 5000 default cap
```

Where:
- `active_agents` = count of READY+QUEUE+INCALL+CLOSER for this campaign (count from Redis `agents:by_campaign:{cid}:by_status:*` ZSETs)
- `auto_dial_level` = current value (RATIO mode = static; ADAPT_* = dynamic, written by E03 every 15s)
- `dial_timeout_sec` = campaign setting (default 22)
- `hopper_multiplier` = campaign setting (default 2.0; 1.5 for <15 agents, 2.0 for 25+)
- `min_hopper_level` = floor (default 50; prevents under-buffer for tiny campaigns)
- `max_hopper_level` = ceiling (default 5000; prevents memory bomb on bad config)

### 6.2 Worked example

| Scenario | active_agents | dial_level | dial_timeout | mult | target |
|---|---|---|---|---|---|
| Small (5 agents, RATIO 1.5) | 5 | 1.5 | 22 | 1.5 | ceil(5 × 1.5 × 2.73 × 1.5) = **31** → floor to 50 |
| Medium (30 agents, ADAPT_TAPERED ~2.0) | 30 | 2.0 | 22 | 2.0 | ceil(30 × 2 × 2.73 × 2) = **328** |
| Large (100 agents, ADAPT 3.5) | 100 | 3.5 | 20 | 2.0 | ceil(100 × 3.5 × 3 × 2) = **2100** |
| Huge (200 agents, ADAPT 4.0, mult 2.5) | 200 | 4.0 | 18 | 2.5 | ceil(200 × 4 × 3.33 × 2.5) = **6660** → cap to 5000 |

The Huge case shows we need an alarm: `vici2_dialer_hopper_target_capped_total{cid}` — if a campaign hits the 5000 cap regularly, operator should split into multiple campaigns or raise `max_hopper_level`.

### 6.3 Manual override

Per F02 PLAN §4.10, `campaigns.hopper_size_target INT DEFAULT 0`. Semantics:
- `0` → auto formula.
- `>0` → fixed target (Vicidial's `hopper_level` static behavior).

E01 reads this and branches.

### 6.4 ADAPT-aware dial_level read

`dial_level` is in Redis (`t:{tid}:campaign:{cid}:dial_level` — F04 PLAN §4.4). E01's filler reads it on every tick. Cache via RESP3 `CLIENT TRACKING` (also F04 PLAN §4.4). Changes propagate within 15s.

---

## 7. Lease/lock TTL strategy

| Concern | TTL | Why |
|---|---|---|
| `lead_lock:{cid}:{lead_id}` | 30s default | `originate_timeout=22s + 5s carrier-PSTN slack + 3s buffer`; long enough that no dial can be in-flight when lock expires. Configurable per-campaign. |
| `hopper:filler_lock:{cid}` | 60s | Filler should never take >5s; 60s is generous safety net for pathological queries. |
| `hopper_mirror.claimed_until` | sync to `lead_lock` TTL | MySQL update on Claim: `claimed_by=instance_id, claimed_until=NOW() + INTERVAL 30 SECOND`. On Release: `DELETE FROM hopper_mirror WHERE ...` (terminal) or null out `claimed_by/claimed_until` (retry). |
| Per-state freq cap counter (Redis) | 24h sliding | TTL-based not exact 24h; close enough for FL/OK/MD enforcement. For exact compliance use `call_log` SQL count instead. |
| Delayed-set entries | none (score = unix ts) | Filler picks them up when score ≤ now. No TTL needed. |

### 7.1 Originate-timeout interaction

E02 (pacing) tells T04 to originate with a `dial_timeout` from the campaign. If `dial_timeout` > `lead_lock_ttl - 5s`, we have a race: lock expires while dial is still ringing. Mitigation in PLAN:
```go
if campaign.DialTimeoutSec > lockTTL - 5 {
    return errors.New("invalid config: lock TTL must exceed dial_timeout + 5s")
}
```
Validated at campaign save (M02), not just at runtime.

### 7.2 Crash recovery TTL chain

```
Filler ZADD lead 12345 → Mirror INSERT
   ↓
Pacing CLAIM → lead_lock SET 30s + Mirror UPDATE claimed_until=NOW+30s
   ↓
Originate fires → bgapi originate ... → carrier rings phone
   ↓
DIALER POD CRASHES (kill -9)
   ↓
30s passes → lead_lock auto-expires
   ↓
At T+60s: cron filler runs, ZCARD < target, query DB
   ↓
Mirror has the lead (claimed_until past, claimed_by=stale-pod)
   ↓
Janitor (E06) sweeps: HDEL in_flight, ZADD back to hopper
   ↓
Next tick: filler picks up the lead again (idempotent)
```

**Worst case:** lead waits 60-90s before re-attempt. Acceptable; better than double-dial.

### 7.3 What if FreeSWITCH crashed but dialer didn't?

T04 will see ESL connection drop → emit a "soft failure" outcome → E02 calls `Release(claim, RETRY)`. Lead goes back to hopper immediately. No TTL involved.

---

## 8. Multi-instance consumer coordination

### 8.1 Setup

N dialer pods, each running:
- 1 filler goroutine pool (per-campaign lock prevents collisions)
- M consumer/pacing goroutines (one per active campaign × pacing tick rate)

### 8.2 Filler coordination

Per-campaign lock `t:{tid}:hopper:filler_lock:{cid}` SET-NX-EX prevents two pods filling the same campaign at the same instant. If pod-A holds the lock and pod-B's cron tick fires for that campaign, pod-B's `maybeFill` sees `SETNX → false` and skips this tick. Next 30s tick, the lock is gone (auto-released or TTL'd) and either pod can take it.

This is correct because the cron is *idempotent at 30s* — missing a tick is harmless. We're not racing for *who* fills, only ensuring *one* fills per tick.

### 8.3 Consumer coordination — the `claim_lead_from_hopper.v1.lua` is the entire mechanism

Multiple pacing goroutines (across N pods) call `EVALSHA` simultaneously. Redis serializes; whichever script runs first ZPOPMINs lead 12345; the others get the next-lowest or nil. Atomic by Lua-script semantics.

No sticky-pod assignment, no campaign affinity, no consistent hashing. Phase 2 ships with this; Phase 3.5 (X02 Kamailio + X03 multi-FS affinity) may add per-FS-server affinity but that's an *outbound carrier* concern, not a hopper concern.

### 8.4 Backpressure

If E02 finds `Claim` returns nil:
- Pacing loop pauses 100ms before next attempt.
- After 5 consecutive nils, publish `t:{tid}:hopper:refill_request:{cid}` → wakes up filler.
- Continue pacing other campaigns concurrently (don't block the whole pod).

If `BF.EXISTS dnc:federal:bloom` returns "uncertain" (Bloom filter unavailable due to module not loaded), filler degrades gracefully:
- Treat as "DNC unknown" → BLOCK (fail-closed for compliance).
- Emit `vici2_dialer_filler_dnc_degraded_total`.
- Operator alarm.

---

## 9. Outcome handling (re-queue, callback, terminal)

### 9.1 Outcomes E01 cares about

| Outcome (from E02/T04 after dial) | E01 action | Lead state change |
|---|---|---|
| `BRIDGED_TO_AGENT` (success) | `Release(SUCCESS)` — no re-queue | D04 sets disposition based on agent action |
| `NO_ANSWER` after dial_timeout | `Release(RETRY)` if `called_count < limit`, else TERMINAL | D04 sets `NA`; recycle-delay applies |
| `BUSY` | `Release(RETRY)` | D04 sets `B`; shorter recycle |
| `MACHINE` (AMD detected) | `Release(SUCCESS)` (the call happened) | D04 sets `AVMA` |
| `DROPPED` (answered, no agent within 2s) | `Release(SUCCESS)` (counted in drop_window) | D04 sets `ADC` (auto-dropped); E05 emits safe-harbor |
| `CARRIER_FAIL` (503, etc.) | `Release(RETRY)` w/ small score bump | No state change |
| `TZ_BLOCKED_AT_ORIGINATE` (T04's last-chance gate fired) | `Release(TZ_BLOCKED)` → enqueue to delayed-set | No state change; lead returns when window opens |
| `LEAD_DELETED` mid-flight | `Release(TERMINAL)` | (lead is gone) |

### 9.2 Callback re-injection

When a callback fires (D06 worker), the callback writes a row to `hopper` directly (bypassing the SQL filter, but still going through compliance gates):

```go
// E01 public method
func (h *HopperOps) ScheduleImmediate(ctx, campaignID, leadID, priority int) error {
    // Run through compliance gates (TCPA window, DNC, freq) first
    if err := h.runGates(ctx, leadID, campaignID); err != nil {
        return err  // callback was due but TCPA gate now blocks; D06 handles reschedule
    }
    // ZADD with high-priority score
    score := (MAX_PRIO - priority) * 1e10 + float64(time.Now().UnixNano())
    return h.zaddHopper(ctx, campaignID, leadID, score)
}
```

D06 (callback worker) calls `ScheduleImmediate` for due callbacks. Source code = `C` in metrics.

### 9.3 Auto-alt-dial

When primary phone fails (NO_ANSWER), and campaign has `auto_alt_dial_statuses` configured, E04 (or D04 — TBD) writes a new hopper row pointing at the same lead but with `phone_alt`/`phone_alt2` flag. Source code = `A`.

E01 itself doesn't do this — it's a write-back from the disposition handler. E01 just consumes from the hopper and treats the alt-dial row as another lead-claim with a different phone field.

**Open Q for PLAN:** does the alt-dial path go via a separate `hopper:{cid}:alt` ZSET, or does it share `hopper:{cid}` with a different score band? Recommend single ZSET, source flag stored in a parallel `t:{tid}:campaign:{cid}:hopper_meta` HASH so we don't need to encode in ZSET member.

---

## 10. E01 ↔ E02 ↔ E04 boundary

```
                    ┌─────────────────────────────────────────────┐
                    │       MySQL: leads, dnc, callbacks,         │
                    │              hopper_mirror, call_log         │
                    └────────────────┬────────────────────────────┘
                                     │
                ┌────────────────────┼────────────────────────────┐
                │                    │                              │
                │  ┌─────────────────▼─────────────────┐           │
                │  │  E01 Filler (this module)         │           │
                │  │   - SQL → compliance gates → ZADD │           │
                │  │   - cron 30s + pub/sub trigger    │           │
                │  │   - Hopper writer + mirror writer │           │
                │  └─────────────────┬─────────────────┘           │
                │                    │ ZADD                         │
                │                    ▼                              │
                │   ┌──────────────────────────────────┐            │
                │   │ Redis ZSET t:{tid}:campaign:{cid}:hopper │     │
                │   └──────────────┬───────────────────┘            │
                │                  │                                │
   E01 │ E02    │                  │ Claim (Lua: ZPOPMIN+lock+HSET) │
   boundary     │                  ▼                                │
                │   ┌──────────────────────────────────┐            │
                │   │  E01 Consumer (this module)      │            │
                │   │   - Claim(cid) → LeadClaim       │            │
                │   │   - Release(claim, outcome)      │            │
                │   └──────────────┬───────────────────┘            │
                │                  │ LeadClaim                       │
                │                  ▼                                │
                │   ┌──────────────────────────────────┐            │
                │   │  E02 Pacing loop                 │            │
                │   │   - per-campaign tick (~3s)      │            │
                │   │   - reads dial_level             │            │
                │   │   - decides "claim K leads now"  │            │
                │   │   - calls E01.Claim K times      │            │
                │   │   - calls T04.Originate K times  │            │
                │   └──────────────┬───────────────────┘            │
                │                  │ Originate                       │
                │                  ▼                                │
                │   ┌──────────────────────────────────┐            │
                │   │  T04 Originate primitive (FS)    │            │
                │   │   - bgapi originate              │            │
                │   │   - returns call_uuid            │            │
                │   └──────────────┬───────────────────┘            │
                │                  │ on answer event                 │
                │                  ▼                                │
   E02 │ E04    │   ┌──────────────────────────────────┐            │
   boundary     │   │  E04 Picker (Lua: pick agent)    │            │
                │   │   - pick_agent_for_call.v1.lua   │            │
                │   │   - bridges customer-uuid into   │            │
                │   │     conference_${agent}@default  │            │
                │   └──────────────┬───────────────────┘            │
                │                  │ uuid_transfer                   │
                │                  ▼                                │
                │   ┌──────────────────────────────────┐            │
                │   │  Agent's conference (FreeSWITCH) │            │
                │   └──────────────────────────────────┘            │
                └──────────────────────────────────────────────────┘
```

### 10.1 Public interface E01 exposes (signatures only)

```go
// Filler — long-running goroutine inside the dialer process
type Filler interface {
    Start(ctx context.Context) error  // starts cron + pubsub listener
    Stop(ctx context.Context) error
    FillNow(ctx context.Context, campaignID int64) (insertedCount int, err error)
}

// Consumer — called from E02
type Consumer interface {
    Claim(ctx context.Context, campaignID int64) (LeadClaim, error)
    Release(ctx context.Context, claim LeadClaim, outcome ReleaseOutcome) error
    ScheduleImmediate(ctx, campaignID, leadID int64, priority int) error  // for D06 callbacks
}

// Metrics
type FillerMetrics struct {
    HopperDepth        *prom.GaugeVec     // {campaign}
    FillDuration       *prom.HistogramVec // {campaign}
    Inserts            *prom.CounterVec   // {campaign, source}
    Skipped            *prom.CounterVec   // {campaign, reason}
    DrainEvents        *prom.CounterVec   // {campaign}
    Recovered          prom.Counter       // total leads restored from mirror on cold-start
    ClaimsTotal        *prom.CounterVec   // {campaign, outcome}
    TargetCapped       *prom.CounterVec   // {campaign}
    DncDegraded        prom.Counter       // Bloom filter unavailable
}
```

### 10.2 What E02 expects

E02 expects:
- `Claim` returns within 10ms (Redis-only; no DB).
- `Claim` is non-blocking (returns nil, not a blocking-pop). Pacing controls cadence.
- `Release` is fire-and-forget (E02 calls in a goroutine; filler/janitor handle lock TTL fallback).

### 10.3 What E04 expects

E04 doesn't talk to E01 directly. E04 picks an agent when a call ANSWERS (an event from FS). E01 is upstream — E01 has already produced the originate; E04's input is the answered call's `call_uuid` + `lead_id` (already in `t:{tid}:call:{uuid}` HASH from T04 setup).

### 10.4 What D06 (callback) expects

D06 calls `ScheduleImmediate(...)`. E01 owns the gate-check before pushing to hopper. D06 doesn't reach into Redis directly.

---

## 11. Open questions for PLAN

1. **Frequency-cap module ownership.** Does E01 inline the FL/OK/MD 3-calls/24h check, or do we spin a tiny C05 module? Recommendation: **inline in E01 (Phase 2)** behind a `frequencyCap.go` file; promote to C05 in Phase 4 if feature creep (per-campaign caps, holiday-day caps, etc.).
2. **Counter source for freq cap: Redis vs MySQL.** Redis counter is O(1) but inexact (TTL-based, not sliding). MySQL count is exact but adds a query per lead. Recommendation: **Redis counter with `INCR` + `EXPIRE 86400`**, with daily reconciliation against `call_log` (D04 cron). Document acceptable inexactness in PLAN — TCPA enforcement actions for being *under* the limit by 1 are unprecedented.
3. **Lead-filter SQL DSL grammar.** Do we ship a parser in E01 or use an existing one (`govaluate`, `cel-go`)? Recommendation: **`cel-go`** (Google's Common Expression Language) — sandboxed, well-typed, expression-only, no side effects. Compiles to a Go function that takes a `lead` map; we then convert the AST to a parameterized SQL fragment for the WHERE clause.
4. **Cron driver: in-process ticker vs separate cron service.** Recommendation: **in-process ticker** (`time.NewTicker(30 * time.Second)`) inside the dialer process. Multiple pods → each tick; per-campaign lock arbitrates. Simpler than spinning a separate cron service.
5. **Per-campaign filler isolation.** If campaign A's filler hits a slow query (10s), does it block campaign B's filler? Recommendation: **no — goroutine-per-campaign with a shared semaphore (max=10)**. Slow campaigns get queued; fast ones run immediately.
6. **Hopper insert ordering — single pipe or one ZADD per lead?** Recommendation: **single Redis pipeline** with all `ZADD` + `HSET hopper_meta` + (optional) MySQL batch INSERT in a single tx. Reduces RTT to 1 round-trip.
7. **TZ delayed-set worker — separate goroutine or piggyback on filler tick?** Recommendation: **piggyback** — at the start of each `maybeFill(cid)`, do `ZRANGEBYSCORE hopper:delayed:{cid} 0 NOW LIMIT 0 100`; for each result, re-evaluate and re-route (pop, gate, ZADD hopper or re-ZADD delayed). Keeps it lean; one less long-running thing.
8. **Should `ScheduleImmediate` (callback path) bypass `low_water_pct` check?** Recommendation: **yes** — callbacks are time-sensitive; insert immediately regardless of hopper depth. Document in PLAN.
9. **`hopper_mirror` write strategy — sync or async to MySQL?** F02 PLAN §4.17 says "Redis first, MySQL within 100ms." Recommendation: **async batch** — push mirror writes to a buffered channel; a worker drains and INSERTs in 100-row batches every 100ms. Filler doesn't block on MySQL. Loss tolerance: a crash between Redis-success and MySQL-flush loses the mirror row but the lead is in Redis. On recovery the lead might be in Redis (good) or might be in neither if Redis also crashed (bad — but combined-crash is unlikely; we accept). Document tradeoff in PLAN.
10. **`auto_trim_hopper` semantics.** When `dial_level` drops mid-day (e.g., adapt engine cuts ratio from 3 → 1), the hopper becomes oversized. Vicidial deletes excess. Recommendation: **soft trim** — don't actively delete; just stop refilling. Excess leads will be claimed within ~minutes; no deletion = no "wasted compliance check" (we already gated them when adding). If E03 cuts dial_level by 50%+ for an extended period, then trim.
11. **Per-campaign filler-depth oscillation alarm.** Alarm if `hopper_depth / target` swings between <0.1 and >0.9 more than once a minute (indicates either runaway DNC scrub or pathological filter). Recommendation: **add Prometheus alert in O01**.
12. **`no_hopper_dialing` mode.** Vicidial supports a mode where the `Q` source bypasses the hopper entirely (manual API push, dial immediately). Phase 2 doesn't need this — manual dial path (T04) already bypasses E01 entirely. Document as out-of-scope.
13. **Multi-list `list_order_mix` strategy.** If a campaign has 3 active lists, do we round-robin? Weighted? FIFO? Vicidial offers NONE/EVEN/MULTI. Recommendation: **EVEN by default; MULTI (admin-set per-list weight) Phase 3+**. Phase 2 ships with EVEN only.
14. **Recycle delay column ownership — `statuses.recycle_delay_seconds` (D04) or `campaign_status_overrides`?** D04 owns `statuses`. Recommendation: D04 ships the global default per status; campaigns can override via `campaign_status_overrides (campaign_id, status, recycle_delay_seconds)` table. **Open for D04 + E01 PLAN coordination.**
15. **Sentinel-based feature flag for "compliance soft-mode" (dev/test only).** Should E01 support a `COMPLIANCE_DRY_RUN=true` env where gates are evaluated but never block? Useful for dev integration tests. Recommendation: **yes, but env-only** (never a campaign config); audit log records every soft-mode dial; refuses to start if `ENVIRONMENT=production`.

---

## 12. Citations

### Vicidial reference
1. Vicidial — `bin/AST_VDhopper.pl` (inktel mirror, GPLv2). https://github.com/inktel/Vicidial/blob/master/bin/AST_VDhopper.pl
2. Vicidial — `docs/PREDICTIVE.txt` (dial methods, ADAPT_*). https://github.com/inktel/Vicidial/blob/master/docs/PREDICTIVE.txt
3. Vicidial forum — Auto-hopper-multiplier formula explanation by Matt Florell. https://www.vicidial.org/VICIDIALforum/viewtopic.php?p=77343
4. Vicidial forum — original hopper level discussion (Florell, 2006). https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=68
5. Vicidial forum — hopper level vs dial level FAQ. https://www.vicidial.org/VICIDIALforum/viewtopic.php?t=11123

### Hopper sizing & predictive dialing
6. ViciStack — VICIdial Predictive Dialer Settings: 15 Configuration Changes. https://vicistack.com/blog/vicidial-predictive-dialer-settings/
7. ViciStack — VICIdial Dial Hopper: How It Works and Why Yours Is Empty. https://vicistack.com/blog/vicidial-dial-hopper-guide/
8. ViciStack — Hopper Level Optimization Guide. https://vicistack.com/settings/hopper-level/
9. ViciStack — Predictive vs Progressive vs Preview Dialing. https://vicistack.com/blog/predictive-vs-progressive-dialing/
10. Exotel — Optimising Predictive Dialer Pacing Ratios. https://exotel.com/blog/optimising-predictive-dialer-pacing-ratio-call-center/

### TCPA compliance (federal + state)
11. 47 CFR § 64.1200(c)(1) — Calling-times rule (8am-9pm called-party local). https://www.ecfr.gov/current/title-47/chapter-I/subchapter-B/part-64/subpart-L/section-64.1200
12. 47 CFR § 64.1200 (eCFR Mar 2026 snapshot) — Subpart L restrictions. https://www.ecfr.gov/compare/2026-03-25/to/2026-03-24/title-47/chapter-I/subchapter-B/part-64/subpart-L
13. FCC 24-24 — TCPA Consent Order, 10-business-day revocation rule. https://docs.fcc.gov/public/attachments/FCC-24-24A1.pdf
14. DA 26-12 — Section 64.1200(a)(10) waiver extension to Jan 31, 2027. https://docs.fcc.gov/public/attachments/DA-26-12A1.pdf
15. FCC 20-186 — Three-call-per-30-day exemption limits (analog for state freq caps). https://docs.fcc.gov/public/attachments/FCC-20-186A1.pdf
16. OCC Comptroller's Handbook — TCPA reference (2023). https://www.occ.gov/publications-and-resources/publications/comptrollers-handbook/files/telephone-consumer-protection-act/pub-ch-telephone-consumer-protection-act.pdf
17. Fla. Stat. § 501.616 — Florida Telephone Solicitation Act, 3-calls-per-24h. https://www.leg.state.fl.us/Statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599%2F0501%2FSections%2F0501.604.html
18. 15 Okl. St. § 775C.4 — Oklahoma OTSA frequency cap.
19. Md. Com. Law 14-3201 — Maryland Stop the Spam Calls Act.
20. 10 M.R.S. § 1498 — Maine autodialer 1-call-per-8h.

### Redis / Valkey patterns (atomic claim, Lua, sorted sets)
21. Redis docs — `ZPOPMIN`. https://redis.io/docs/latest/commands/zpopmin/
22. Redis (antirez) — Delayed queue pattern (sorted set + Lua + ZRANGEBYSCORE). https://redis.antirez.com/fundamental/delayed-queue.md
23. Svix — Reliable scheduled queue with atomic claim Lua script. https://www.svix.com/resources/redis/scheduled-queue/
24. OneUptime — Distributed task scheduler with Redis sorted sets. https://oneuptime.com/blog/post/2026-03-31-redis-distributed-task-scheduler/view
25. StackOverflow — Concurrent priority queue in Redis with ZPOPMIN/Lua. https://stackoverflow.com/questions/26369304/concurrent-priority-queue-in-redis
26. StackOverflow — Reliable Redis queue with timestamp-scored zset for crash recovery. https://stackoverflow.com/questions/67196575/redis-queues-how-to-resume

### Trigger patterns (cron vs event-driven hybrid)
27. Railway — Choose Between Cron, Background Workers, and Queues. https://docs.railway.com/guides/cron-workers-queues
28. Sujeet Jaiswal — Queues and Pub/Sub: Decoupling and Backpressure. https://sujeet.pro/articles/queues-and-pubsub
29. NILUS — Event-Driven Backpressure Patterns in Reactive Microservices. https://www.nilus.be/blog/event-driven_backpressure_patterns_in_reactive_microservices/
30. soderlind/redis-queue — scaling.md (cron + always-on hybrid). https://github.com/soderlind/redis-queue/blob/main/docs/scaling.md
31. Firebase — Rate-limiting & surge protection (token bucket + queue patterns). https://firebase.live/rate-limiting-surge-protection-for-cloud-functions-during-vi
32. bunqueue — Queue API with priorities, delays, deduplication. https://bunqueue.dev/guide/queue/

### Internal references (vici2 spec)
33. vici2 DESIGN.md — §1.1 component table; §1.5 lead lifecycle.
34. vici2 SPEC.md — §4.1 compliance hard floor; §4.2 Redis vs MySQL; §10 Phase 2 demo criteria.
35. vici2 spec/modules/E01.md — module spec.
36. vici2 spec/modules/F02/PLAN.md — `leads` (§4.13), `dnc` (§4.14), `phone_codes` (§4.15), `callbacks` (§4.16), `hopper_mirror` (§4.17), index plan.
37. vici2 spec/modules/F04/PLAN.md — Hopper ZSET (§4.1), lead lock (§4.2), in-flight HASH (§4.14), `claim_lead_from_hopper.v1.lua` (§6.1), `release_hopper_lock.v1.lua` (§6.2), helper API (§7).
38. vici2 spec/modules/C01/RESEARCH.md — TCPA gate algorithm (§6.2), state-rules matrix (§3), 4-tier TZ fallback (§5.2), three enforcement points (§7).
39. vici2 spec/modules/D03.md — `resolvePhoneTz` interface, IANA tz, NPA-NXX seed.
40. vici2 spec/modules/D05.md — `isDnc` interface, federal Bloom filter, sources enum.

---

## STOP. Do not proceed to PLAN. Awaiting checkpoint review.

Blocking dependencies before PLAN can proceed:
- **D03 RESEARCH** must finalize the resolver interface (currently a race; we coded against `D03.md` spec, may need adjustment).
- **D05 RESEARCH** must finalize the Redis key shape for federal Bloom + state SETs (currently a race; we assumed direct Redis access from Go).
- **D04 PLAN** must lock the `statuses.recycle_delay_seconds` ownership decision (Q14 above).
- **C01 PLAN** must decide whether `assertCallWindow` is gRPC-from-Go or Go-side native (C01 RESEARCH §11.9). E01 needs this to know whether to bundle a Go port of the C01 logic or call the Node API.
- **F04** (DONE — PLAN finalized).
- **F02** (DONE — PLAN finalized; tables and indexes confirmed).

When unblocked, the PLAN.md should:
1. Pin exact SQL for the per-campaign hopper SELECT (with bind-param signature)
2. Specify the `lead_filter` DSL grammar (`cel-go`-based) + parameterized SQL fragment compiler
3. Define `Filler` and `Consumer` Go interfaces with method-level contracts
4. Define the cron+pub/sub trigger plumbing (channel name, message format, dedup)
5. Enumerate gate-execution order in pseudocode with explicit error/skip routing
6. Define the metrics taxonomy (label sets, alert rules) — coordinate with O01 PLAN
7. Document the `hopper_mirror` async-write batching strategy (channel size, flush interval)
8. Define the freq-cap counter Redis key (`t:{tid}:freq:{phone}` STRING with INCR + 24h TTL)
9. Specify the delayed-set ZSET key (`t:{tid}:hopper:delayed:{cid}` with score=nextOpenAt_unix)
10. Define the campaign-config validators (lock TTL > dial_timeout + 5s, multiplier > 0, etc.)
11. Specify the auto-trim policy (when, what, how often)
12. Lock the `auto_alt_dial` source flag mechanism (parallel hopper_meta HASH vs separate ZSET)
