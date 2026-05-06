# F04 — Live-State Engine + Helper Library — PLAN.md

**Module:** F04 (Foundation, Phase 1)
**Author:** F04 PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 40 citations behind every choice below.

This plan turns the F04 spec + RESEARCH findings into the exact engine
choice, deployment topology, key namespace, Lua source, helper-lib API,
and test/operational story the IMPLEMENT phase will deliver. Once
approved, the public interface is FROZEN (changes require RFC).

---

## 0. TL;DR (10 bullets)

1. **Engine: Valkey 8.x (BSD-3-Clause, Linux Foundation governance).**
   Wire-compatible with Redis 7.2 — `go-redis/v9` and `ioredis` work
   unmodified. License removes any future ambiguity around managed-
   service or VM-image redistribution paths. (RESEARCH §2.)
2. **Topology phasing:** Phase 1 single-node (RDB+AOF every-sec).
   Phase 2 Sentinel (3 nodes, quorum 2). Cluster only when working
   set > 16 GB or sustained writes > 50k/s.
3. **`docker-compose.yml` change:** rename `redis` service to `valkey`
   (alias `redis` retained for env-var back-compat), image
   `valkey/valkey:8.0-alpine`, healthcheck `valkey-cli ping`.
4. **Persistence:** `appendonly yes`, `appendfsync everysec`,
   `aof-use-rdb-preamble yes`, `save "3600 1 300 100 60 10000"`,
   nightly RDB → S3.
5. **Memory policy split:** DB 0 (live state) `noeviction`; DB 1
   (caches: DNC, lead-detail, status list) `volatile-lru`. Phase 1
   `maxmemory 4gb`.
6. **Key namespace** (every key tenant-prefixed, hash-tag wrapped on
   per-campaign keys for forward-compat with Cluster) is finalized in
   §4 below — no caller may hard-code key strings; typed builders only.
7. **Atomicity = Lua via `SCRIPT LOAD` + `EVALSHA`** with `NOSCRIPT`
   auto-reload. Five canonical scripts (full source in §6); each is
   < 30 lines, single-keyspace-tag-safe, and versioned.
8. **Streams design:** per-campaign `drop_window` (`MAXLEN ~ 500000` +
   nightly `XTRIM MINID` for exact 30-day window) + cross-cutting
   `events:vici2.<domain>.<event>` with consumer groups for wallboard,
   recording cache, and audit-export. `XAUTOCLAIM` 60s min-idle for
   stuck-message recovery.
9. **Helper libs:** Go (`dialer/internal/redis`) and TS
   (`api/src/lib/redis`) with parity APIs. Both opt into RESP3 +
   `CLIENT TRACKING ON BCAST PREFIX config:` for client-side caching of
   static config.
10. **Memory budget for headline 200-agent / 50-campaign / 30-day
    scenario: ~205 MB working set; 1 GB cap; 4 GB box.** Trivially
    over-provisioned vs needed.

**License/engine confirmation:** **Valkey 8.x — BSD-3-Clause — Linux
Foundation.** Final.

---

## 1. Engine choice — confirmation

Per RESEARCH §2, Valkey 8.x is the pick over Redis 7.4+/8 (RSAL+SSPL,
plus AGPL added May 2025), KeyDB (Snap-only governance, low activity),
and Dragonfly (BSL until change date — blocks managed-service path).

Key facts that drive the decision:

- **License:** BSD-3-Clause. Same license Redis used pre-2024. We can
  embed, redistribute, offer as a managed service, no obligations
  triggered.
- **Wire compatibility:** Valkey 7.2.x is a fork of Redis 7.2.4; Valkey
  8.0 added multi-threaded I/O. Every Redis client lib (`go-redis v9`,
  `ioredis`, `node-redis`, `jedis`, etc.) speaks Valkey unmodified.
- **Governance:** Linux Foundation; multi-vendor (AWS, Google, Oracle,
  Ericsson, Snap, Tencent). Sustainable.
- **Cloud parity:** AWS ElastiCache and GCP Memorystore have Valkey as
  default in 2026. No vendor lock-in.
- **Performance:** within 5–10% of Redis 7.2 on single-thread
  workloads; matches or exceeds with multi-threaded I/O on Valkey 8.
  Our workload (200 agents, ~5 k peak ops/s) is >>20× over-provisioned
  on a single Valkey node — performance is not the deciding factor.

**Versions to pin:**
- **Valkey 8.0.x** (exact patch chosen at IMPLEMENT time by latest
  stable on Docker Hub; Phase 1 dev: `valkey/valkey:8.0-alpine`).
- **Go client:** `github.com/redis/go-redis/v9` (latest stable 9.x).
- **Node client:** `ioredis` (latest stable 5.x).

---

## 2. Deployment topology

### 2.1 Phase 1 (MVP, ≤30 agents): single-node Valkey

- One container (Docker compose) on the same host as MySQL + FreeSWITCH.
- Persistence dual-mode: RDB (point-in-time, fast restart) + AOF
  (≤1s loss bound on `everysec`).
- Documented RTO: ~2 min (process restart + AOF replay). The dialer's
  reconcile-on-boot logic recovers any lost in-flight state from MySQL
  `call_log`; agents have to re-login.
- Single-node SPOF is accepted for Phase 1; mitigation = AOF + nightly
  RDB to S3.

### 2.2 Phase 2/3 (real production, 50–200 agents): Sentinel, 3 nodes

- 3 boxes; each runs (a) a Valkey replica (one is master), (b) a
  Sentinel daemon. Quorum = 2.
- Why not Cluster: dataset fits in one node's RAM (~205 MB working set
  estimated for 200 agents). Sentinel is operationally simpler and
  every client lib supports it natively.
- Master config: `min-replicas-to-write 1`, `min-replicas-max-lag 10`
  to fence split-brain writes.
- Failover end-to-end: ~10–30 s. Dialer pacing tolerates this via tick-
  skip safety check.
- Client config: `redis.NewFailoverClient` (Go) /
  `new Redis({ sentinels, name })` (Node). Master IP never hard-coded.

### 2.3 Phase 4+ (multi-tenant SaaS, 500+ agents): Cluster

- Trigger criteria: working set > 16 GB **OR** sustained > 50k writes/s.
- Minimum 6 nodes (3 masters + 3 replicas).
- Hash-tag convention from §4.7 ensures per-campaign multi-key Lua
  scripts colocate keys on the same shard.
- Sharded pub/sub (`SSUBSCRIBE`/`SPUBLISH`) limits cluster-bus chatter.

### 2.4 Explicitly NOT doing

- Redis Enterprise (license + cost).
- Active-Active CRDB (Enterprise-only, overkill).
- Self-rolled master/replica monitoring (Sentinel exists for a reason).
- Dragonfly drop-in replacement (revisit Phase 4+ if multi-core
  ceiling is hit and BSL changes).

---

## 3. Persistence + memory configuration

### 3.1 `valkey.conf` (Phase 1 baseline — full content)

```conf
# === Networking ===
bind 0.0.0.0
port 6379
protected-mode yes
tcp-keepalive 300
timeout 0

# === Data dir ===
dir /data

# === Auth (Phase 1 dev: optional; Phase 2+ mandatory) ===
# requirepass ${VALKEY_PASSWORD}
# masterauth  ${VALKEY_PASSWORD}

# === Persistence — RDB ===
# save "<seconds> <changes>" — multiple lines OR
# Valkey accepts space-separated tuples:
save 3600 1 300 100 60 10000
rdbcompression yes
rdbchecksum yes
dbfilename dump.rdb
rdb-save-incremental-fsync yes

# === Persistence — AOF ===
appendonly yes
appendfilename "appendonly.aof"
appendfsync everysec
no-appendfsync-on-rewrite no
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
aof-load-truncated yes
aof-use-rdb-preamble yes

# === Memory ===
maxmemory 4gb
# Per-database eviction policies are NOT supported by Valkey directly;
# we enforce DB-0 noeviction at the global level and put cache keys
# in DB-1 with explicit TTLs (volatile-lru is honored even under
# noeviction global as long as TTL is set, since noeviction will
# refuse new writes — see §3.4 for the runtime split).
maxmemory-policy noeviction
maxmemory-samples 5

# === Replication (Phase 2+) ===
# replica-read-only yes
# min-replicas-to-write 1
# min-replicas-max-lag 10
# repl-backlog-size 64mb
# repl-backlog-ttl 3600

# === Slow log ===
slowlog-log-slower-than 10000
slowlog-max-len 256

# === Latency monitor ===
latency-monitor-threshold 100

# === Client output buffer ===
client-output-buffer-limit normal 0 0 0
client-output-buffer-limit replica 256mb 64mb 60
client-output-buffer-limit pubsub 32mb 8mb 60

# === Lua / scripts ===
lua-time-limit 5000

# === Stream defaults ===
# (per-stream MAXLEN/MINID controlled by helper lib)
stream-node-max-bytes 4096
stream-node-max-entries 100

# === Threads (Valkey 8 multi-threaded I/O) ===
io-threads 4
io-threads-do-reads yes
```

### 3.2 RDB snapshot triggers explanation

`save 3600 1 300 100 60 10000` → snapshot if:
- 3600 s passed AND ≥ 1 key changed, OR
- 300 s passed AND ≥ 100 keys changed, OR
- 60 s passed AND ≥ 10000 keys changed.

This is the canonical Redis OSS preset and works well for our churn
profile.

### 3.3 AOF rewrite tuning

- `auto-aof-rewrite-percentage 100`: rewrite when AOF doubles vs last
  rewrite.
- `auto-aof-rewrite-min-size 64mb`: skip rewrite if AOF is tiny
  (avoids nuisance rewrites in dev).
- `aof-use-rdb-preamble yes`: rewrite produces an RDB+AOF hybrid file
  for fast startup.

### 3.4 Eviction policy split (live state vs cache)

**Important nuance:** Valkey/Redis configures `maxmemory-policy`
**globally**, not per-database. To get our split (live = noeviction,
cache = LRU), we do **one of two things**:

- **Phase 1 (default):** single instance, global `noeviction`. Cache
  keys (DB 1) all carry explicit `EXPIRE` TTLs; they evict on TTL,
  never on memory pressure. If we hit `maxmemory`, **all writes fail
  loudly** — alarm fires, dialer pauses gracefully (helper lib treats
  any Valkey write error as non-fatal: log + pause-dialer + retry).
- **Phase 2+ (recommended once cache grows):** split into **two
  instances** — `valkey-state` (production, `noeviction`) and
  `valkey-cache` (`volatile-lru`). Helper libs accept two URLs:
  `VALKEY_STATE_URL` and `VALKEY_CACHE_URL`. Phase 1 sets both to the
  same instance; Phase 2 splits them.

The helper-lib API is designed for the split from day 1 — see §7.

### 3.5 Rationale for `noeviction` on live state

If we let Valkey silently evict an `agent:{id}` hash, an agent
disappears mid-call. That breaks recording, billing, and the WS push.
**Live state must never be evicted.** Hitting `maxmemory` is an
operator alarm, not a quietly-degraded service.

---

## 4. Key namespace (FROZEN once PLAN is approved)

All keys are **tenant-prefixed**: `t:{tenant_id}:...`. Phase 1
single-tenant always uses `tenant_id = 1`. Phase 4 multi-tenant just
flips that.

### 4.1 Hopper

| Field | Value |
|---|---|
| **Key** | `t:{tid}:campaign:{{cid}}:hopper` |
| **Type** | ZSET |
| **Score** | `(MAX_PRIO - priority) * 1e10 + entry_ts_unix` (lowest score wins; FIFO within priority via `ZPOPMIN`) |
| **Member** | `lead_id` (string-encoded int64) |
| **Insert** | `ZADD` from hopper-filler (E01), batched via pipeline |
| **Claim** | Lua `claim_lead_from_hopper` (§6.1) — atomic ZPOPMIN + lock + in-flight HSET |
| **Inspect** | `ZCARD`, `ZRANGE 0 9 WITHSCORES` for monitoring |
| **Encoding** | listpack ≤128, then skiplist; ~96 B/entry on skiplist |

### 4.2 Hopper claim lock (in-flight protection)

| Field | Value |
|---|---|
| **Key** | `t:{tid}:lead_lock:{{cid}}:{lead_id}` (note: `lead_lock` chosen over `hopper:lock` to make eviction-safe lock semantics explicit and to share the `{cid}` hash tag for cluster colocation) |
| **Type** | STRING |
| **TTL** | 30s (default; configurable per dialer instance) |
| **Value** | `{instance_id}:{claim_ts_ms}` |
| **Set** | `SET ... EX 30 NX` inside Lua |
| **Released** | `release_hopper_lock` Lua (§6.2) on success or failure |

### 4.3 Drop-window (TCPA 3% rolling 30-day)

| Field | Value |
|---|---|
| **Key** | `t:{tid}:campaign:{{cid}}:drop_window` |
| **Type** | STREAM |
| **Entry fields** | `{answered: 0|1, dropped: 0|1, ts: unix_ms, call_uuid}` |
| **Trim** | `XADD ... MAXLEN ~ 500000 *` on every write + nightly `XTRIM MINID <30d-ago-ms-id>` cron for exact 30-day window |
| **Read** | `XLEN`, `XRANGE` filtered by ts (O(log N + M)) |
| **Memory** | ~18 B/entry; 50 campaigns × 90 k entries ≈ 81 MB |

### 4.4 Campaign dial-level (adaptive engine)

| Field | Value |
|---|---|
| **Key** | `t:{tid}:campaign:{{cid}}:dial_level` |
| **Type** | STRING (decimal text, e.g., `"1.85"`) |
| **TTL** | none (persistent until campaign deleted) |
| **Cache** | RESP3 client-side cached via `CLIENT TRACKING` (changes ~every 15 s) |

### 4.5 Live agent state

| Field | Value |
|---|---|
| **Key** | `t:{tid}:agent:{user_id}` |
| **Type** | HASH |
| **Fields** | `status`, `campaign_id`, `lead_id`, `call_uuid`, `last_change_at`, `pause_code`, `ingroups`, `server`, `sip_state` |
| **TTL** | none; `DEL` on logout. Janitor sweeps stale (no heartbeat > 24 h) |
| **Update** | atomic `HSET ...` — never read-modify-write JSON |
| **Memory** | listpack ≤128 fields, ~250 B/agent; 200 agents = 50 KB |

### 4.6 Agent indexes (longest-waiting picker)

| Field | Value |
|---|---|
| **Global** | `t:{tid}:agents:by_status:{STATUS}` ZSET (score=`last_change_at`, member=`user_id`) |
| **Per-campaign** | `t:{tid}:agents:by_campaign:{{cid}}:by_status:{STATUS}` ZSET (same shape) |
| **Hot read** | `ZRANGE :READY 0 0 WITHSCORES` for longest-waiting; atomically picked via `pick_agent_for_call` Lua (§6.4) |
| **Maintained by** | `agent_state_transition` Lua (§6.5) — single source of truth for index updates |

`STATUS` enum: `READY | PAUSED | INCALL | RESERVED | WRAPUP | LOGOUT`.

### 4.7 Cluster hash tags (forward compatibility)

We adopt the convention: **per-campaign keys wrap `{cid}` as the hash
tag** so the hopper, hopper lock, drop_window, and active_calls for
the same campaign all colocate on one shard:

```
t:{tid}:campaign:{42}:hopper        → slot tag is "42"
t:{tid}:campaign:{42}:drop_window   → same slot
t:{tid}:lead_lock:{42}:12345        → same slot (note: tag is cid, not lead_id)
t:{tid}:campaign:{42}:dial_level    → same slot
t:{tid}:campaign:{42}:active_calls  → same slot
```

Per-tenant or global-fanout keys do **not** use `{...}` tags (so they
spread across shards). Examples without tags:

```
t:{tid}:agent:{user_id}                      ← user_id is part of name, no braces
t:{tid}:agents:by_status:READY               ← global per-tenant
events:vici2.call.answered                   ← cross-tenant
```

The helper libs build keys via typed builders that automatically apply
the `{...}` hash tag for per-campaign keys; callers cannot get this
wrong.

### 4.8 Active call state

| Field | Value |
|---|---|
| **Key** | `t:{tid}:call:{call_uuid}` |
| **Type** | HASH |
| **Fields** | `lead_id, campaign_id, agent_id, started_at, state, carrier_id` |
| **TTL** | `EXPIRE 24h` safety net; expected lifecycle `DEL` on `CHANNEL_HANGUP_COMPLETE` |
| **Membership** | `t:{tid}:call:active` SET — for "kill all calls" admin actions |
| **Per-campaign** | `t:{tid}:campaign:{{cid}}:active_calls` SET — for "active count per campaign" |

### 4.9 Pub/Sub channels (low-latency push)

| Channel | Purpose | Producer | Consumer |
|---|---|---|---|
| `t:{tid}:broadcast:agent:{user_id}` | Per-agent state push (screen pop, dispo update) | dialer / API | A03 WS gateway |
| `t:{tid}:broadcast:campaign:{cid}` | Campaign-wide events (drop% changed, ready count) | dialer | A03 (supervisor pop) |
| `t:{tid}:broadcast:wallboard` | Supervisor wallboard fan-out | dialer / workers | S01 |

**Loss tolerance:** all pub/sub. WS gateway issues a "full state
snapshot" REST call on reconnect. Lost events do not break correctness;
they only delay the first redraw.

### 4.10 Cross-cutting durable event streams

Tenant ID is in the payload, not the key, so consumer groups can fan
out cross-tenant for SaaS supervisors:

```
events:vici2.call.answered           STREAM
events:vici2.call.bridged            STREAM
events:vici2.call.ended              STREAM
events:vici2.call.dropped            STREAM
events:vici2.agent.state_changed     STREAM
```

**Consumer-group naming convention:** `<service-name>` (e.g.,
`wallboard`, `recording-cache`, `audit-export`). One consumer per
service replica. `XAUTOCLAIM` cadence: 60 s `min-idle-time` for
fast pipelines (wallboard); 300 s for slow ones (audit-export).

**Trim:** `MAXLEN ~ 1000000` per stream + nightly `XTRIM MINID
<7d-ago-ms-id>` (these are operational events, not the 30-day TCPA
window — 7-day retention is enough for forensic replay).

### 4.11 DNC negative cache (DB 1)

| Field | Value |
|---|---|
| **Key** | `cache:dnc:{tid}:{phone_e164}` (or `t:{tid}:dnc:cache:{phone_e164}` if single-DB) |
| **DB** | 1 (cache DB) |
| **Type** | STRING |
| **TTL** | 1h |
| **Value** | `"1"` (DNC) or absent (not DNC); cache MISS asks MySQL |
| **Eviction** | `volatile-lru` on cache DB |

### 4.12 Static config snapshots (Bloom-filter alternative TBD)

For very-large DNC lists (>1M numbers), a cache-per-number STRING is
wasteful. **Future enhancement** (deferred to a later module, likely
C01 DNC management): use a **Valkey Bloom filter** (`BF.RESERVE` from
`valkey-bloom` module) keyed `config:dnc:{tid}` for O(1) negative
checks with ~0.1% FPR. Phase 1 sticks with the per-number cache; we
flag this in HANDOFF.md so C01 can plan the migration.

### 4.13 Coordination primitives

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `t:{tid}:dialer:tick:{cid}` | STRING | 1s | `SET NX EX 1` to dedup pacing ticks across N dialer instances |
| `t:{tid}:janitor:lock` | STRING | 60s | Single-janitor election |
| `t:{tid}:adapt:lock:{cid}` | STRING | 15s | Single adaptive-engine tick per campaign |

### 4.14 In-flight tracking

| Key | Type | TTL | Purpose |
|---|---|---|---|
| `t:{tid}:campaign:{{cid}}:in_flight` | HASH | none | `lead_id → instance_id:claim_ts` map for currently-claimed-but-not-yet-originated leads. Maintained atomically by hopper Lua scripts. |

### 4.15 TTL summary table

| Key pattern | TTL | Why |
|---|---|---|
| `lead_lock:{cid}:{lead_id}` | 30s | Auto-cleanup if dialer crashes mid-originate |
| `call:{uuid}` | 24h | Safety net; normally `DEL` on hangup |
| `dnc:cache:{phone}` | 1h | Cache freshness |
| `dialer:tick:{cid}` | 1s | One tick per second, one dialer |
| `janitor:lock` | 60s | One janitor at a time |
| `adapt:lock:{cid}` | 15s | One adaptive tick per 15 s |
| `agent:{user_id}` | none | Bounded by login/logout + janitor |
| `campaign:{cid}:hopper` | none | Bounded by hopper-filler reconciliation |
| `campaign:{cid}:drop_window` | none (XTRIM) | 30-day window via stream trim |
| `campaign:{cid}:dial_level` | none | Persistent until campaign deleted |

---

## 5. Streams design (consumer groups + recovery)

### 5.1 Stream-specific config

| Stream | Producer | Consumers (groups) | MAXLEN | Trim policy |
|---|---|---|---|---|
| `t:{tid}:campaign:{{cid}}:drop_window` | dialer (T01 ESL bridge) | dialer:adapt | ~500k | nightly `XTRIM MINID <30d-ago>` |
| `events:vici2.call.answered` | T01 | wallboard, recording-cache, audit-export | ~1M | nightly `XTRIM MINID <7d-ago>` |
| `events:vici2.call.bridged` | T01 | wallboard, audit-export | ~1M | same |
| `events:vici2.call.ended` | T01 | wallboard, recording-cache, audit-export | ~1M | same |
| `events:vici2.call.dropped` | T01 | wallboard, audit-export, compliance | ~1M | same |
| `events:vici2.agent.state_changed` | api / dialer | wallboard, audit-export | ~1M | same |

### 5.2 Consumer pattern (canonical)

```
XGROUP CREATE events:vici2.call.answered wallboard $ MKSTREAM
XREADGROUP GROUP wallboard $consumer-id COUNT 10 BLOCK 5000 STREAMS events:vici2.call.answered >
XACK events:vici2.call.answered wallboard <id>
```

### 5.3 Recovery via XAUTOCLAIM

Periodic loop in each consumer:

```
XAUTOCLAIM events:vici2.call.answered wallboard $consumer-id 60000 0 COUNT 10
```

Reclaims any message stuck in the PEL of a dead consumer for >60s.

### 5.4 Nightly trim cron (workers job)

```ts
// runs at 04:00 UTC
async function trimStreams() {
  const cutoff30d = Date.now() - 30 * 24 * 3600_000;
  const cutoff7d  = Date.now() -  7 * 24 * 3600_000;
  await valkey.xtrim(`t:1:campaign:{42}:drop_window`, 'MINID', cutoff30d);
  await valkey.xtrim('events:vici2.call.answered', 'MINID', cutoff7d);
  // ... etc per stream
}
```

The cron handler lives in `workers/src/jobs/stream-trim/` (workers
module) and is invoked by F04's cron registration helper.

---

## 6. Lua scripts (full source — FROZEN)

All scripts are stored in `shared/lua/` as `.lua` files, version-
suffixed (e.g., `claim_lead_from_hopper.v1.lua`). Helper libs load
each via `SCRIPT LOAD` at boot, cache the SHA1, and call via `EVALSHA`
with `NOSCRIPT` auto-reload. **Convention:** any change is a new file
(`.v2.lua`) — never mutate a deployed version's content.

### 6.1 `claim_lead_from_hopper.v1.lua`

```lua
-- Atomically pop the lowest-score lead from a hopper, set an in-flight
-- lock + in-flight HASH entry, and return the lead_id.
--
-- KEYS[1] = hopper ZSET                        e.g. t:1:campaign:{42}:hopper
-- KEYS[2] = lead_lock prefix (string concat)   e.g. t:1:lead_lock:{42}:
-- KEYS[3] = in-flight HASH                     e.g. t:1:campaign:{42}:in_flight
-- ARGV[1] = lock TTL seconds (string int, e.g. "30")
-- ARGV[2] = dialer instance id
-- ARGV[3] = now_ms (string int)
--
-- Returns: lead_id (string) or nil (empty hopper)

local popped = redis.call('ZPOPMIN', KEYS[1], 1)
if #popped == 0 then
  return nil
end
local lead_id = popped[1]
-- popped[2] is the score (priority+ts); we discard it (caller can re-derive on push-back)

local lock_key = KEYS[2] .. lead_id
local lock_val = ARGV[2] .. ':' .. ARGV[3]

-- SET NX EX — if a stale lock somehow exists (shouldn't, since we just popped), don't overwrite
local ok = redis.call('SET', lock_key, lock_val, 'EX', tonumber(ARGV[1]), 'NX')
if not ok then
  -- Extremely unlikely: lock exists for a lead we just popped from a different angle.
  -- Push the lead back into the hopper at original-ish position and return nil.
  -- (Caller treats nil as "no work this tick"; janitor reconciles.)
  redis.call('ZADD', KEYS[1], popped[2], lead_id)
  return nil
end

-- Track in-flight for janitor / observability
redis.call('HSET', KEYS[3], lead_id, lock_val)

return lead_id
```

### 6.2 `release_hopper_lock.v1.lua`

```lua
-- Idempotently release a hopper claim. Optionally re-add the lead to
-- the hopper (e.g., on originate failure that should retry).
--
-- KEYS[1] = lock key             e.g. t:1:lead_lock:{42}:12345
-- KEYS[2] = in-flight HASH       e.g. t:1:campaign:{42}:in_flight
-- KEYS[3] = hopper ZSET          e.g. t:1:campaign:{42}:hopper (only used if reinsert=1)
-- ARGV[1] = lead_id
-- ARGV[2] = "1" to reinsert, "0" to drop
-- ARGV[3] = score for reinsert (only used if reinsert=1)
-- ARGV[4] = expected lock value (instance_id:claim_ts) — fence against double-release
--
-- Returns: 1 if released, 0 if lock didn't match (no-op)

local current = redis.call('GET', KEYS[1])
if current and current ~= ARGV[4] then
  -- Lock was taken by someone else (we crashed and TTL fired); do nothing.
  return 0
end

redis.call('DEL', KEYS[1])
redis.call('HDEL', KEYS[2], ARGV[1])

if ARGV[2] == '1' then
  redis.call('ZADD', KEYS[3], tonumber(ARGV[3]), ARGV[1])
end

return 1
```

### 6.3 `record_call_outcome.v1.lua`

```lua
-- Atomically write a call outcome to the campaign drop_window and the
-- cross-cutting events stream, and clear in-flight tracking.
-- Either both writes succeed or neither does (preserves drop% accuracy).
--
-- KEYS[1] = drop_window stream    e.g. t:1:campaign:{42}:drop_window
-- KEYS[2] = events stream         e.g. events:vici2.call.<answered|dropped|ended>
-- KEYS[3] = in-flight HASH        e.g. t:1:campaign:{42}:in_flight
-- KEYS[4] = active call HASH      e.g. t:1:call:{uuid}
-- KEYS[5] = active calls SET      e.g. t:1:call:active
-- KEYS[6] = per-campaign active SET  e.g. t:1:campaign:{42}:active_calls
-- ARGV[1] = answered (0|1)
-- ARGV[2] = dropped  (0|1)
-- ARGV[3] = ts_ms
-- ARGV[4] = call_uuid
-- ARGV[5] = lead_id
-- ARGV[6] = campaign_id
-- ARGV[7] = tenant_id
-- ARGV[8] = drop_window MAXLEN (e.g. "500000")
-- ARGV[9] = events MAXLEN (e.g. "1000000")
--
-- Returns: 'OK'

redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[8], '*',
  'answered', ARGV[1], 'dropped', ARGV[2],
  'ts', ARGV[3], 'call_uuid', ARGV[4])

redis.call('XADD', KEYS[2], 'MAXLEN', '~', ARGV[9], '*',
  'tenant_id', ARGV[7], 'campaign_id', ARGV[6],
  'call_uuid', ARGV[4], 'lead_id', ARGV[5],
  'answered', ARGV[1], 'dropped', ARGV[2], 'ts', ARGV[3])

-- Clear in-flight + active state
redis.call('HDEL', KEYS[3], ARGV[5])
redis.call('DEL',  KEYS[4])
redis.call('SREM', KEYS[5], ARGV[4])
redis.call('SREM', KEYS[6], ARGV[4])

return 'OK'
```

### 6.4 `pick_agent_for_call.v1.lua`

```lua
-- Atomically pick the longest-waiting READY agent in a campaign and
-- transition them to RESERVED. Race-safe across N dialer instances
-- and N concurrent answered customer calls.
--
-- KEYS[1] = agents-by-campaign-READY ZSET   e.g. t:1:agents:by_campaign:{42}:by_status:READY
-- KEYS[2] = agents-by-status-READY ZSET     e.g. t:1:agents:by_status:READY (global per-tenant)
-- KEYS[3] = agents-by-campaign-RESERVED     e.g. t:1:agents:by_campaign:{42}:by_status:RESERVED
-- KEYS[4] = agents-by-status-RESERVED       e.g. t:1:agents:by_status:RESERVED
-- KEYS[5] = agent HASH key prefix           e.g. t:1:agent:  (concat with user_id)
-- ARGV[1] = call_uuid
-- ARGV[2] = ts_ms
--
-- Returns: user_id (string) or nil (no READY agent)

local picked = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
if #picked == 0 then
  return nil
end
local user_id = picked[1]

-- Atomic state transition: remove from READY indexes, add to RESERVED indexes
redis.call('ZREM', KEYS[1], user_id)
redis.call('ZREM', KEYS[2], user_id)
redis.call('ZADD', KEYS[3], tonumber(ARGV[2]), user_id)
redis.call('ZADD', KEYS[4], tonumber(ARGV[2]), user_id)

-- Update agent hash
local agent_key = KEYS[5] .. user_id
redis.call('HSET', agent_key,
  'status', 'RESERVED',
  'call_uuid', ARGV[1],
  'last_change_at', ARGV[2])

return user_id
```

**Note on pub/sub from inside Lua:** Valkey Lua scripts CAN call
`PUBLISH`, but doing so inside a critical-path script adds latency
(client buffers, etc.). We do **NOT** publish from inside this script;
the caller publishes after `EVALSHA` returns. That keeps the script
~10 lines and the publish out-of-band.

### 6.5 `agent_state_transition.v1.lua`

```lua
-- Atomically transition an agent from one status to another, keeping
-- both global and per-campaign indexes consistent.
-- Validates the from-state to prevent invalid transitions (e.g.,
-- LOGOUT -> READY without re-login).
--
-- KEYS[1] = agent HASH                       e.g. t:1:agent:7
-- KEYS[2] = old global ZSET                  e.g. t:1:agents:by_status:READY
-- KEYS[3] = old per-campaign ZSET            e.g. t:1:agents:by_campaign:{42}:by_status:READY
-- KEYS[4] = new global ZSET                  e.g. t:1:agents:by_status:INCALL
-- KEYS[5] = new per-campaign ZSET            e.g. t:1:agents:by_campaign:{42}:by_status:INCALL
-- ARGV[1] = user_id
-- ARGV[2] = expected current status (or "" to skip check)
-- ARGV[3] = new status
-- ARGV[4] = ts_ms
-- ARGV[5..n] = optional extra HSET pairs (lead_id, call_uuid, pause_code, ...)
--
-- Returns: 1 on success, 0 if expected status didn't match (caller retries / errors)

if ARGV[2] ~= '' then
  local cur = redis.call('HGET', KEYS[1], 'status')
  if cur ~= ARGV[2] then
    return 0
  end
end

-- Remove from old indexes
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])

-- Add to new indexes
redis.call('ZADD', KEYS[4], tonumber(ARGV[4]), ARGV[1])
redis.call('ZADD', KEYS[5], tonumber(ARGV[4]), ARGV[1])

-- Update HASH
local sets = {'status', ARGV[3], 'last_change_at', ARGV[4]}
for i = 5, #ARGV, 2 do
  table.insert(sets, ARGV[i])
  table.insert(sets, ARGV[i+1])
end
redis.call('HSET', KEYS[1], unpack(sets))

return 1
```

### 6.6 Script hygiene rules

- All scripts < 30 lines.
- No loops > O(N where N is small, fixed).
- All keys passed as `KEYS[]` (Cluster routing requirement).
- All non-key data passed as `ARGV[]`.
- Use `redis.call` (raises errors) — let the client surface them.
- `lua-time-limit 5000` ms guards runaway scripts.
- Scripts versioned by filename suffix; no in-place edits.

### 6.7 SCRIPT LOAD bootstrap

Each helper-lib client, on connect, runs:

```
for each *.lua in shared/lua/
  sha = SCRIPT LOAD <content>
  cache[name] = sha
```

Helper API: `client.lua.claimLeadFromHopper(...)` calls `EVALSHA`,
catches `NOSCRIPT`, re-loads, retries once.

---

## 7. Helper library API (parity Go + TS)

### 7.1 Configuration / connection

**Env vars:**
- `VALKEY_URL` (default for Phase 1; both state + cache)
- `VALKEY_STATE_URL` (Phase 2+ split; falls back to `VALKEY_URL`)
- `VALKEY_CACHE_URL` (Phase 2+ split; falls back to `VALKEY_URL`)
- `VALKEY_PASSWORD` (Phase 2+)
- `REDIS_URL` (alias for `VALKEY_URL` — back-compat with code that
  was written against Redis branding)

**Go (`dialer/internal/redis`):**

```go
package vredis  // imports github.com/redis/go-redis/v9

type Config struct {
    StateURL  string
    CacheURL  string
    Password  string
    PoolSize  int           // default 30
    MinIdle   int           // default 5
    MaxIdle   time.Duration // default 5*time.Minute
    DialTO    time.Duration // default 3s
    ReadTO    time.Duration // default 2s
    WriteTO   time.Duration // default 2s
    Protocol  int           // default 3 (RESP3 for client-side caching)
    UseRESP3  bool          // default true
    TenantID  int64         // default 1 (Phase 1)
}

type Client struct {
    State *redis.Client    // DB 0
    Cache *redis.Client    // DB 1 (or separate instance)
    lua   map[string]string  // name -> SHA1
    cfg   Config
}

func New(cfg Config) (*Client, error)
func (c *Client) Close() error
func (c *Client) Ping(ctx context.Context) error

// Typed key builders (no string concatenation in caller code)
type Keys struct{ tid int64 }
func (c *Client) Keys() Keys
func (k Keys) Agent(userID int64) string
func (k Keys) AgentsByStatus(status AgentStatus) string
func (k Keys) AgentsByCampaignStatus(cid int64, status AgentStatus) string
func (k Keys) CampaignHopper(cid int64) string
func (k Keys) LeadLock(cid, leadID int64) string
func (k Keys) CampaignDropWindow(cid int64) string
func (k Keys) CampaignDialLevel(cid int64) string
func (k Keys) CampaignActiveCalls(cid int64) string
func (k Keys) CampaignInFlight(cid int64) string
func (k Keys) Call(uuid string) string
func (k Keys) CallActive() string
func (k Keys) BroadcastAgent(userID int64) string
func (k Keys) BroadcastCampaign(cid int64) string
func (k Keys) BroadcastWallboard() string
func (k Keys) DialerTick(cid int64) string
func (k Keys) JanitorLock() string
func (k Keys) AdaptLock(cid int64) string
func (k Keys) DNCCache(phoneE164 string) string

// Domain operations (built on top of keys + Lua)
func (c *Client) Hopper() *HopperOps
func (c *Client) Agents() *AgentOps
func (c *Client) Calls() *CallOps
func (c *Client) Streams() *StreamOps
func (c *Client) PubSub() *PubSubOps
func (c *Client) Cache() *CacheOps

// Hopper
func (h *HopperOps) Push(ctx, cid, leadID int64, priority int, ts int64) error
func (h *HopperOps) PushBatch(ctx, cid int64, leads []HopperEntry) error
func (h *HopperOps) Claim(ctx, cid int64, instanceID string, lockTTL time.Duration) (leadID int64, lockVal string, err error)
func (h *HopperOps) Release(ctx, cid, leadID int64, lockVal string, reinsert bool, score float64) error
func (h *HopperOps) Size(ctx, cid int64) (int64, error)

// Agents
func (a *AgentOps) Get(ctx, userID int64) (*AgentState, error)
func (a *AgentOps) Set(ctx, userID int64, state AgentState) error
func (a *AgentOps) Transition(ctx, userID int64, fromStatus, toStatus AgentStatus, fields map[string]string) (bool, error)
func (a *AgentOps) PickForCall(ctx, cid int64, callUUID string) (userID int64, err error)
func (a *AgentOps) Delete(ctx, userID int64) error

// Calls
func (c *CallOps) Set(ctx, callUUID string, state CallState) error
func (c *CallOps) Get(ctx, callUUID string) (*CallState, error)
func (c *CallOps) RecordOutcome(ctx, callUUID string, o CallOutcome) error
func (c *CallOps) ActiveByCampaign(ctx, cid int64) ([]string, error)

// Streams
func (s *StreamOps) PublishCallEvent(ctx, event string, fields map[string]any) (id string, err error)
func (s *StreamOps) ReadGroup(ctx, stream, group, consumer string, count int, block time.Duration) ([]StreamEntry, error)
func (s *StreamOps) Ack(ctx, stream, group string, ids ...string) error
func (s *StreamOps) AutoClaim(ctx, stream, group, consumer string, minIdle time.Duration) ([]StreamEntry, error)
func (s *StreamOps) TrimByMinID(ctx, stream string, cutoffMs int64) (int64, error)

// PubSub
func (p *PubSubOps) Publish(ctx, channel string, payload any) error
func (p *PubSubOps) Subscribe(ctx, channel string) (*PubSubSub, error)

// Cache (DB 1)
func (c *CacheOps) DNCGet(ctx, phoneE164 string) (bool, error)         // returns true if DNC hit
func (c *CacheOps) DNCSet(ctx, phoneE164 string, isDNC bool, ttl time.Duration) error
func (c *CacheOps) ConfigGet(ctx, key string) ([]byte, error)
func (c *CacheOps) ConfigSet(ctx, key string, v []byte, ttl time.Duration) error
```

**TS (`api/src/lib/redis`):** mirror this surface.

```ts
// api/src/lib/redis/index.ts
import IORedis from 'ioredis';

export interface VRedisConfig {
  stateUrl: string;
  cacheUrl: string;
  password?: string;
  tenantId?: number;        // default 1
  poolSize?: number;        // default 30
  protocol?: 3 | 2;         // default 3
}

export class VRedisClient {
  state: IORedis;          // DB 0
  cache: IORedis;          // DB 1 (or separate instance)
  keys: Keys;
  hopper: HopperOps;
  agents: AgentOps;
  calls: CallOps;
  streams: StreamOps;
  pubsub: PubSubOps;
  cacheOps: CacheOps;

  static async create(cfg: VRedisConfig): Promise<VRedisClient>;
  async close(): Promise<void>;
  async ping(): Promise<void>;
}

// keys.ts — same builder list as Go
export class Keys { /* mirrors Go Keys */ }

// agent.ts, hopper.ts, calls.ts, streams.ts, pubsub.ts, cache.ts —
// each a class with the same methods as the Go Ops above.
```

### 7.2 RESP3 + client-side caching

Both clients opt into RESP3 (`Protocol: 3` in go-redis,
`enableAutoPipelining: true` + RESP3 negotiation in ioredis 5).

Static config keys (campaign, status enum, dial-level, DNC config —
**not** DNC negative cache) are tracked via:

```
CLIENT TRACKING ON BCAST PREFIX cache:config:
```

Cache invalidation push messages arrive on the client channel and
auto-evict. This saves a round-trip on every dialer tick that reads
the dial level.

### 7.3 Connection retry + circuit breaker

Both clients:
- Exponential backoff on connect failure (250ms → 4s, capped, jitter).
- Circuit breaker: 3 consecutive errors → open for 5 s → half-open
  probe. While open, hopper claims short-circuit return nil; helper
  emits `vici2_<service>_valkey_circuit_open_total` Prom counter.
- All write errors are non-fatal upstream — caller pauses dialer
  gracefully.

### 7.4 No string concat in caller code (lint rule)

- Go: a `golangci-lint` custom rule (or eyeballed in code review)
  forbids any string containing `t:` outside `dialer/internal/redis/keys.go`.
- TS: an `eslint` rule (custom or `no-restricted-syntax`) forbids
  template literals matching `t:${...}`.

### 7.5 Files to create (IMPLEMENT phase)

```
shared/lua/
  claim_lead_from_hopper.v1.lua
  release_hopper_lock.v1.lua
  record_call_outcome.v1.lua
  pick_agent_for_call.v1.lua
  agent_state_transition.v1.lua

dialer/internal/redis/
  client.go        — VRedisClient + config
  keys.go          — typed key builders
  scripts.go       — embed + SCRIPT LOAD + EVALSHA wrappers (NOSCRIPT retry)
  hopper.go        — HopperOps
  agent.go         — AgentOps
  calls.go         — CallOps
  streams.go       — StreamOps
  pubsub.go        — PubSubOps
  cache.go         — CacheOps
  types.go         — AgentState, CallState, AgentStatus enum, etc.
  metrics.go       — Prom counters (script_eval_total, circuit_open_total, etc.)
  client_test.go
  hopper_test.go   — concurrency test (10 goroutines claim, no double-claim)
  agent_test.go
  scripts_test.go  — Lua unit tests
  integration_test.go — testcontainers Valkey

api/src/lib/redis/
  index.ts         — VRedisClient + factory
  keys.ts
  scripts.ts       — SCRIPT LOAD wrapper
  hopper.ts
  agent.ts
  calls.ts
  streams.ts
  pubsub.ts
  cache.ts
  types.ts
  metrics.ts
api/test/redis/
  hopper.test.ts
  agent.test.ts
  scripts.test.ts
  integration.test.ts  — testcontainers Valkey
```

---

## 8. `docker-compose.yml` amendment to F01's

Replace the `redis` service from F01 PLAN §3 with:

```yaml
  valkey:
    image: valkey/valkey:8.0-alpine
    container_name: vici2_valkey
    restart: unless-stopped
    command: ["valkey-server", "/etc/valkey/valkey.conf"]
    volumes:
      - valkey_data:/data
      - ./valkey/valkey.conf:/etc/valkey/valkey.conf:ro
    ports:
      - "127.0.0.1:6379:6379"      # loopback only — no public exposure
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 3s
      timeout: 2s
      retries: 5
      start_period: 5s
    networks: [vici2_default]
```

And in `volumes:` add `valkey_data:` (rename from `redis_data:`).

**Env-var alias note:** for back-compat, leave `REDIS_URL` and add
`VALKEY_URL` (same value, points at `valkey:6379`). Helper libs prefer
`VALKEY_STATE_URL` then `VALKEY_URL` then `REDIS_URL` in that order.
This avoids forcing every other service to rename env vars in
lockstep.

**New file in repo:** `valkey/valkey.conf` containing the §3.1 config.

**F01 dependency:** F01 PLAN.md §3 currently lists a `redis` service.
F01 IMPLEMENT must adopt this F04 PLAN's `valkey` service definition
verbatim (or F04 IMPLEMENT will issue an amendment PR before its own
work). Coordination handled at orchestrator level.

---

## 9. Memory budget (sized for Phase 1 + Phase 2)

### 9.1 Headline scenario: 200 agents, 50 campaigns, 30-day drop window

| Key category | Count | Per-entry | Subtotal |
|---|---:|---:|---:|
| `agent:{user_id}` HASH (listpack, 9 fields) | 200 | ~250 B | 50 KB |
| `agents:by_status:*` ZSETs (listpack ≤200) | 6 statuses | 32 B × 200 | 38 KB |
| `agents:by_campaign:{cid}:by_status:*` ZSETs | 50 × 6 | listpack avg | 96 KB |
| `campaign:{cid}:hopper` ZSET (skiplist 500 ea) | 50 | 96 B × 500 | 2.4 MB |
| `campaign:{cid}:drop_window` STREAM (90k entries, 30d) | 50 | 18 B × 90k | 81 MB |
| `events:vici2.call.*` STREAMs (5 streams × 1.35M entries, 7d) | 5 | 18 B × 1.35M | ~120 MB |
| `call:{uuid}` HASH (active ~100) | 100 | 300 B | 30 KB |
| `cache:dnc:*` STRING (10k cached) | 10k | 80 B | 800 KB |
| `lead_lock:*` STRING (peak ~200) | 200 | 80 B | 16 KB |
| `campaign:{cid}:in_flight` HASH | 50 | 80 B avg | 4 KB |
| Misc (dial_level, tick locks, janitor lock) | ~150 | 80 B | 12 KB |
| **Working set subtotal** | | | **~205 MB** |
| Allocator fragmentation (jemalloc, ~10–20%) | | | +30 MB |
| Replication backlog (`repl-backlog-size`) | | | +50 MB |
| AOF rewrite peak (transient fork COW) | | | +1× working set |
| **Comfortable cap: 1 GB; box sizing: 4 GB Phase 1** | | | |

### 9.2 Scaling

- Per +100 agents: +~40 MB (mostly drop_window + event streams; agents
  themselves are negligible).
- Per +30 days drop_window retention: +80 MB.
- 1M leads in MySQL has zero memory impact (only what's in the hopper
  matters; hopper is sized to ready_agents × dial_level × 60s).

### 9.3 Sizing rule

`maxmemory` = ~70% of physical RAM (leaves headroom for fork COW
during BGSAVE / AOF rewrite, plus OS buffers).

---

## 10. Backup + restore strategy

### 10.1 Backup (handed to O02)

- **Nightly `BGSAVE`** triggered by cron at 02:00 UTC → copy
  `/data/dump.rdb` to S3:
  `s3://vici2-backups/valkey/{tenant}/{yyyy-mm-dd}/dump.rdb`
- **Retention:** 7 daily, 4 weekly, 12 monthly.
- **Encryption:** S3 SSE-KMS at rest; TLS in transit.
- **AOF is NOT backed up** (it's just journaling; RDB is the canonical
  recoverable snapshot).
- **Pub/sub messages are not persisted** — fire-and-forget by design.

### 10.2 Restore (HANDOFF.md runbook)

```
1. systemctl stop valkey  # (or `docker compose stop valkey`)
2. aws s3 cp s3://.../dump.rdb /data/dump.rdb
3. chown valkey:valkey /data/dump.rdb
4. systemctl start valkey
5. valkey-cli INFO persistence  # verify rdb_last_save_time
6. valkey-cli DBSIZE             # sanity check
```

### 10.3 What persistence does NOT save us from

- Pub/Sub messages (subscribers must reconcile on reconnect).
- Lua scripts (helper lib re-loads on `NOSCRIPT`; benign).
- Client-side caches (invalidated on reconnect).
- Stream consumer-group PEL is persisted by RDB+AOF, so consumer
  state survives restart — no special handling needed.

---

## 11. Hand-off to other modules

| Module | Hand-off content |
|---|---|
| **T01 (ESL bridge)** | `Streams().PublishCallEvent` for `events:vici2.call.*`; `PubSub().Publish` for `broadcast:*`; `Calls().Set` / `Calls().RecordOutcome` for active-call lifecycle. |
| **E01 (hopper filler)** | `Hopper().Push` / `PushBatch` API; documented backpressure (target hopper size = ready_agents × dial_level × 60s). |
| **E02–E06 (dialer engine)** | `Hopper().Claim` (atomic Lua), `Calls().RecordOutcome` (atomic Lua), `Streams()` for adapt-loop reads of drop_window, `Agents().PickForCall` (atomic Lua). |
| **A03 (WS gateway)** | `PubSub().Subscribe` per agent + per campaign; documented "no-replay-on-disconnect" semantic — re-snapshot via REST. |
| **S01 (wallboard)** | `Streams().ReadGroup` consumer-group reads + `Streams().AutoClaim`; documented per-stream MAXLEN. |
| **C03 (audit log)** | `Streams().ReadGroup('events:vici2.*', 'audit-export')`; consumer responsible for durable persistence to S3 / cold MySQL. |
| **O01 (metrics)** | `valkey_exporter` Prometheus scrape; helper lib emits `vici2_*_valkey_*` counters (script eval count, circuit-open count, EVALSHA NOSCRIPT-reload count, pool-exhaustion count). |
| **O02 (backup)** | RDB-to-S3 cron procedure (§10.1). |
| **F01 (compose)** | Replace `redis` service with `valkey` service per §8. |

---

## 12. Test strategy

### 12.1 Unit tests

- **Key builders:** round-trip every builder; assert the expected
  string. Reject malformed inputs (negative IDs, non-E.164 phones).
- **Agent state-machine validators:** allowed transitions table,
  disallowed transitions return error.
- **Lua script unit tests** (using a real Valkey via testcontainers,
  one container per package, `FLUSHDB` between tests):
  - `claim_lead_from_hopper`: empty hopper → nil; happy path → lead +
    lock + in_flight set.
  - `release_hopper_lock`: lock-mismatch → no-op; reinsert flag works;
    idempotent on double-release.
  - `record_call_outcome`: both streams written or neither (kill
    Valkey mid-script and assert on restart).
  - `pick_agent_for_call`: 10 concurrent calls into 5 agents → exactly
    5 picks, 5 nils; no double-pick.
  - `agent_state_transition`: bad from-state → 0; good → 1 + indexes
    consistent.

### 12.2 Integration tests

- **Concurrent claim:** 10 goroutines claim from a 5-lead hopper →
  exactly 5 leads claimed, 5 nils, 5 distinct lead_ids.
- **Stream consumer group:** 2 consumers, publish 100 messages, assert
  each message goes to exactly one consumer; XAUTOCLAIM after killing
  consumer 1 mid-stream re-delivers in-flight to consumer 2.
- **Pub/sub disconnect/reconnect:** subscribe, kill connection,
  reconnect; assert no crash, subscribe re-issued.
- **Persistence smoke:** push 100 leads, kill Valkey, restart, assert
  hopper preserved (RDB+AOF).
- **Memory measurement:** populate the headline scenario via fixtures,
  call `MEMORY USAGE` per key category, log to a CSV that gets
  committed to `spec/modules/F04/VERIFY.md`.

### 12.3 Test infrastructure

- **Go:** `testcontainers-go` spins up `valkey/valkey:8.0-alpine`
  per-package; `FLUSHDB` between tests.
- **TS:** `@testcontainers/redis` (works with Valkey image — wire
  protocol is identical) per-suite; `FLUSHDB` between tests.
- **CI:** integration tests run in the GitHub Actions matrix; cached
  Docker image reuse.
- **Coverage target:** > 70% on helper-lib code (per SPEC.md §3).

### 12.4 Run commands

```
make test-redis          # runs both Go and TS suites
cd dialer && go test ./internal/redis/...
cd api && pnpm exec vitest run test/redis
```

---

## 13. Risks and open questions

### 13.1 Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| **Phase 1 single-node SPOF** | Low | High | Documented 2-min RTO; AOF + nightly RDB; dialer reconcile-on-boot recovers from MySQL. Phase 2 Sentinel rollout planned. |
| **Lua script perf on hot path** | Low | Medium | Scripts kept < 30 lines, no loops; `lua-time-limit 5000` ms guard; integration tests benchmark each script. |
| **`MAXLEN ~` leaves > 30 days in drop_window** | Low | Medium | Nightly `XTRIM MINID` cron re-trims exactly. Test simulates 35-day data. |
| **Type drift Go ↔ TS for AgentState / CallState** | Medium | Medium | Phase 1: shared JSON Schema in `shared/events/`, hand-validated parity tests. Phase 4: code-gen from a single source. |
| **Lua eviction on dev restart** | High in dev | Low | Helper-lib re-loads scripts on `NOSCRIPT` automatically; transparent. |
| **RESP3 client-side caching invalidation lag** | Low | Low | Static config (campaign, dial level) tolerates ~10 ms staleness. Documented in HANDOFF. |
| **Forgetting `{cid}` hash-tag wrapping in a new key** | Medium (regression) | Medium (Phase 4 only) | Typed key builders are the only allowed path; lint rule forbids raw `t:` in caller code. |
| **Cache DB 1 evicted key with no TTL** | Medium | Low | Helper `Cache().Set` requires a TTL parameter (no nullable default). |
| **F01 `redis` service rename collision** | Low | Low | Coordinated at orchestrator level; back-compat env var alias documented. |

### 13.2 Open questions (deferred to IMPLEMENT or to later modules)

1. **Bloom filter for very-large DNC lists (>1M numbers)** — defer to
   C01. Current per-number STRING cache is fine up to ~100k entries.
2. **Per-tenant Valkey instance vs shared with `t:{tid}:` prefix** —
   Phase 1 single-tenant, moot. Phase 4 SaaS: PLAN proposes shared
   with prefix; revisit if hard isolation (billing/quota) is needed.
3. **Whether to use Redis Functions (libraries) instead of EVAL in a
   future phase** — defer; EVAL works on Valkey 8/9 forever (compat is
   sacred), and Functions don't ship with Valkey core anyway.
4. **Sharded pub/sub (`SSUBSCRIBE`/`SPUBLISH`) at Cluster time** —
   helper lib will gain a flag at Phase 4, no API change.
5. **Whether to colocate Valkey container with MySQL/FreeSWITCH or
   separate host in Phase 1 prod** — F01-side decision; PLAN assumes
   colocate for Phase 1 dev, separate at first real production
   deployment.

---

## 14. Acceptance criteria (from F04.md, restated against this PLAN)

- [ ] Helper libs exist in both Go and TS with parity APIs (§7).
- [ ] All keys built via typed builders; no string concatenation in
      caller code (lint rule enforces — §7.4).
- [ ] All five Lua scripts atomic-tested (§12.1).
- [ ] TTLs documented for every transient key (§4.15).
- [ ] At least one consumer-group test for streams (§12.2).
- [ ] Pub/sub disconnect-recovery tested (§12.2).
- [ ] Memory usage per key category measured + recorded in VERIFY.md
      (§12.2).
- [ ] Both libs handle `MOVED`/cluster redirects even on Phase 1
      single-node (go-redis and ioredis do this automatically; we
      add a smoke test).
- [ ] `docker-compose.yml` swaps Redis → Valkey per §8.
- [ ] `valkey/valkey.conf` matches §3.1 verbatim.
- [ ] `valkey-exporter` scrape endpoint reachable for O01.

---

## 15. Final license + engine confirmation

- **Engine:** **Valkey 8.x**
- **License:** **BSD-3-Clause**
- **Governance:** **Linux Foundation**
- **Image:** `valkey/valkey:8.0-alpine` (Phase 1 dev); pinned exact
  patch at IMPLEMENT time.
- **Wire protocol:** Redis 7.2 / RESP2 + RESP3.
- **Clients:** `github.com/redis/go-redis/v9` (Go), `ioredis` v5 (Node).
- **Reasoning summary:** OSS license keeps every future deployment
  option open (self-host, embed, managed-service); LF governance is
  multi-vendor and stable; wire-compat means zero client-code change;
  cloud parity (AWS ElastiCache, GCP Memorystore default) removes
  vendor lock-in; performance is identical for our workload.

End of PLAN.md.
