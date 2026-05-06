# F04 — Redis State Schema + Helper Library — RESEARCH.md

**Module:** F04 (Foundation, Phase 1)
**Phase:** RESEARCH only (IMPLEMENT blocked on F01 — repo skeleton + dev env)
**Date:** 2026-05-06
**Author:** F04 sub-agent (Claude Opus 4.7)

> Goal of this document: settle the engine choice (Valkey vs Redis OSS vs KeyDB
> vs Dragonfly), the data-structure plan for every live-state use case, the
> atomicity story (Lua / Functions), the HA + persistence posture for Phase 1
> through Phase 3, and the memory budget. Output is the input to F04 PLAN.md
> (Lua scripts in full, helper-lib API, key namespace finalization).

---

## 1. Executive summary (10 bullets)

1. **Engine choice: Valkey 8.x (BSD-3-Clause, Linux Foundation).** Redis 7.4+ is
   under RSALv2/SSPLv1 (Redis 8 added AGPLv3 as a third option in May 2025).
   For an OSS dialer that we may want users to embed/redistribute or run as a
   managed service later, BSD is unambiguously the safer license. Valkey 7.2.x
   is wire-compatible with Redis 7.2; Valkey 8.0 added multi-threaded I/O on top
   and is what AWS ElastiCache and GCP Memorystore are already migrating
   defaults to. (See §2.)
2. **Single-node + RDB+AOF (everysec) for Phase 1; Sentinel (3 nodes) for
   Phase 2; Cluster only when we hit one-node RAM ceiling (>~64 GB working set
   or >~50k qps writes).** Vicidial-style call centers running 50–200 agents
   sit comfortably inside one Valkey node.
3. **The hopper is a ZSET keyed `t:{tid}:campaign:{cid}:hopper`** with
   `score = priority*1e10 + entry_ts_unix`. Atomic claim via a Lua script that
   `ZPOPMIN` + `SETEX` lock + `XADD` to a `claimed` audit stream — three
   commands in one round trip, replicated as a single transaction.
4. **Drop-window stays as a Stream** (`t:{tid}:campaign:{cid}:drop_window`,
   `XADD MAXLEN ~ 500000` per call attempt). Use `XLEN`/`XRANGE` for the rolling
   30-day window; the stream's listpack-radix-tree representation is ~13×
   cheaper memory than ZSET+HASH (antirez's published number) so 30 days × 50
   campaigns × ~10k attempts is trivial. A periodic `XTRIM MINID` cron handles
   the time-based trim that `MAXLEN` can't express precisely.
5. **WS fan-out: dual-channel.** Pub/Sub (per-agent screen-pop channel) is
   fire-and-forget but free; Streams (supervisor wallboard, audit replay) give
   consumer-group catch-up after WS reconnect. We need both — pub/sub for the
   agent UI's "you're now bridged to call X" push (loss = redraw on next
   heartbeat), Streams for `events:vici2.call.*` so a reconnecting supervisor
   can replay the last N seconds.
6. **Live agent state is a HASH** (`t:{tid}:agent:{user_id}`), with **secondary
   indexes** as ZSETs (`agents:by_status:READY`, `agents:by_campaign:{cid}:READY`).
   HASH gives us atomic per-field updates (`HSET status PAUSED, pause_code BIO`)
   without read-modify-write. We do **not** TTL the agent hash — agent existence
   is bounded by login/logout and a janitor sweep.
7. **Atomicity = Lua scripts loaded via `SCRIPT LOAD` on boot, called via
   `EVALSHA`.** Redis Functions (7.0+) are technically the modern replacement,
   but Lua is simpler, every client supports it, and our scripts are short
   (≤30 lines). We will use Functions only if we ever need cross-call shared
   state; we do not now. (See §4.)
8. **go-redis v9 for the Go dialer engine, ioredis for the Node API gateway.**
   Both support Sentinel and Cluster transparently, so the helper libs do not
   have to know the deployment topology. Configure pool size = 20–50 per
   process, RESP3 protocol opt-in for client-side caching of static config.
9. **Memory budget for the headline scenario (200 agents, 1 M leads ever, 50
   active campaigns, ~25k leads in hopper at any time, 30 days of drop_window):
   **~250–400 MB working set**. A 4-vCPU / 4–8 GB Valkey node is 10–20× over-
   provisioned. The dominant consumer is per-call ephemeral hashes, not the
   hopper. (See §8.)
10. **Eviction policy = `noeviction` for the production keyspace + a separate
    Valkey logical DB (or a separate instance) for caches with `volatile-lru`.**
    Live state must never be evicted silently — that would silently lose a call
    or an agent. Use a *cache* DB (DNC negative cache, lead-detail cache, status
    list) where `volatile-lru` is appropriate; everything tagged with TTL there.

**License recommendation: Valkey 8.x.** Strong consensus across AWS, Google,
Oracle, and Linux Foundation backing. BSD-3-Clause keeps every option open for
us (self-host, embed, eventually offer hosted vici2). Redis 8 under AGPLv3 is
viable for self-hosting only but the copyleft is a footgun if we ever bundle
the binary into a customer-shippable VM image. Defer Dragonfly to a later
"performance-rebuild" milestone — its BSL license blocks the managed-service
path we may want.

---

## 2. Engine comparison: Redis vs Valkey vs KeyDB vs Dragonfly

### 2.1 License landscape (May 2026)

| Engine    | Current license           | OSI open source? | Can offer as managed service? | Governance       |
|-----------|---------------------------|------------------|-------------------------------|------------------|
| Redis 7.2 | BSD-3-Clause              | Yes              | Yes                           | Redis Ltd.       |
| Redis 7.4 | RSALv2 + SSPLv1           | No               | No (without SSPL trigger)     | Redis Ltd.       |
| Redis 8.0+| RSALv2 + SSPLv1 + AGPLv3  | AGPL only        | AGPL terms only               | Redis Ltd.       |
| Valkey 7.2 / 8.x / 9.x | BSD-3-Clause | Yes            | Yes                           | Linux Foundation |
| KeyDB     | BSD-3-Clause (Snap-owned, low activity since acquisition) | Yes | Yes | Snap Inc.        |
| Dragonfly | BSL 1.1 → Apache 2.0 after change date | No (source-available) | No (until change date) | DragonflyDB Inc. |

**Key historical timeline:**
- Mar 2024: Redis Ltd. switches Redis from BSD-3 to RSAL+SSPL — kicked off the schism. ([Percona](https://percona.com/about-percona/newsroom/press-releases/valkey-emerges-as-leading-open-source-alternative-to-redis-after-relicensing-row))
- Mar 2024: Linux Foundation announces Valkey, fork of Redis 7.2.4. ([Better Stack](https://betterstack.com/community/comparisons/redis-vs-valkey))
- Sep 2024: Valkey 8.0 ships with multi-threaded I/O. AWS ElastiCache + GCP Memorystore announce Valkey-default trajectory. ([AWS](https://aws.amazon.com/elasticache/redis))
- Nov 2024: antirez (Salvatore Sanfilippo) returns to Redis Ltd.
- May 2025: Redis 8.0 adds AGPLv3 as a third licensing option alongside RSAL/SSPL. ([devtoolswatch comparison](https://devtoolswatch.com/en/redis-vs-valkey-vs-dragonfly-2026))
- ~75% of surveyed Redis users were "testing, considering, or have already adopted Valkey" within ~6 months of the relicense. ([Percona report](https://percona.com/about-percona/newsroom/press-releases/valkey-emerges-as-leading-open-source-alternative-to-redis-after-relicensing-row))

### 2.2 Performance (May 2026 benchmarks)

[centminmod's host-networked v5 benchmark](https://github.com/centminmod/redis-comparison-benchmarks)
on a 4-vCPU runner, 4 IO threads, 1:15 SET:GET, 512B values:

| Engine     | Peak ops/s | Avg latency | p99      |
|------------|-----------:|------------:|---------:|
| Redis 7.2  | 125,524    | 3.18 ms     | 7.65 ms  |
| Dragonfly  | 119,615    | 3.39 ms     | 8.19 ms  |
| KeyDB      | 114,455    | 3.51 ms     | ~10 ms   |
| Valkey     | 98,119     | 4.15 ms     | ~10 ms   |

[repoflow's M4 benchmark](https://www.repoflow.io/blog/redis-vs-valkey-vs-dragonflydb-vs-keydb-benchmarks) (Redis 8.4, Valkey 9.0, Dragonfly 1.37, KeyDB 6.3): Dragonfly leads on writes/reads and memory efficiency; Valkey leads on batched/pipelined; Redis 8.4 has the cleanest p95 latency on simple patterns; KeyDB trails.

[DragonflyDB's own benchmark](https://www.dragonflydb.io/content/the-definitive-in-memory-data-store-benchmark-report) claims 25× Redis throughput at scale (single-node, multi-core saturation). Take with salt: vendor benchmarks are vendor benchmarks. The independent picture is "Dragonfly wins single-node multi-core throughput by 1.5–3×, Valkey within 5–10% of Redis OSS, KeyDB stagnant."

**For our workload (50–200 agents, ~10–100 ops/s/agent of state churn, peak ~5k ops/s under predictive burst):** **all four engines are >>20× over-provisioned at single-node.** Performance is not the deciding factor. License + ecosystem are.

### 2.3 Decision matrix

| Criterion                     | Weight | Redis 8 (AGPL) | Valkey | KeyDB | Dragonfly |
|-------------------------------|--------|----------------|--------|-------|-----------|
| OSS-friendly license          | High   | Medium (AGPL)  | **Best** | Good | Bad (BSL) |
| Long-term governance health   | High   | Medium (single-vendor) | **Best** (LF + multi-vendor) | Bad (Snap-only, low activity) | Medium (single-vendor) |
| Performance for 200-agent CC  | Low    | Plenty         | Plenty | Plenty | Plenty (overkill) |
| Stream + Lua + Sentinel + Cluster parity | High | Reference   | **100% parity** (forked from 7.2.4) | Mostly | Stream/Lua compat partial |
| Managed-service path (future) | Med    | AGPL only      | **Free** | Free | Blocked    |
| Client lib support (go-redis v9, ioredis) | High | Yes | **Yes — same protocol** | Yes | Yes |
| Cloud-provider managed offerings | Med | Redis Cloud only | **AWS ElastiCache, GCP Memorystore default** | Few | DragonflyDB Cloud |
| **Verdict**                   |        | Backup option  | **Pick** | Avoid | Reconsider Phase 4+ |

**Recommendation: Valkey 8.x.**
- License removes future ambiguity. We don't need to do legal review every time we ship.
- Wire-compatible: every client lib (go-redis v9, ioredis, jedis, etc.) speaks Valkey unmodified.
- Multi-cloud managed-service availability removes lock-in concerns.
- Multi-threaded I/O in Valkey 8 closes the ~5–10% throughput gap vs Redis OSS for our workload.
- We can document the upgrade path to Dragonfly as a future optimization if and only if a deployment hits the multi-core ceiling.

---

## 3. Data structure plan per use case (with key naming conventions)

All keys are prefixed `t:{tenant_id}:` per SPEC.md §4.5. Phase 1 tenant_id always = 1.

### 3.1 Hopper (the dialer queue)
- **Key:** `t:{tid}:campaign:{cid}:hopper`
- **Type:** ZSET
- **Score:** `priority * 1e10 + entry_ts_unix` (priority desc, then FIFO within priority — `ZPOPMIN` pops earliest). Higher-priority leads have *lower* score by negating priority before the multiply, so lowest score = highest priority.
- **Member:** `lead_id` (string-encoded int64).
- **Operations:**
  - Insert: `ZADD` from hopper-filler (E01), batched in pipeline.
  - Claim: Lua script `ZPOPMIN` + `SETEX` lock → atomic. (See §4.)
  - Inspect: `ZCARD`, `ZRANGE 0 9 WITHSCORES` for monitoring.
- **Memory:** ~96B per entry on skiplist encoding, ~32B on listpack (≤128 entries). At 25k entries × 96B ≈ 2.4 MB per campaign × 50 campaigns ≈ 120 MB worst case. ([techplained](https://www.techplained.com/redis-data-structures-sets-sorted-sets-hashes-streams))
- **Why ZSET:** Vicidial uses MEMORY-engine `vicidial_hopper`. We need (a) sorted by priority+arrival, (b) atomic pop, (c) cardinality query. ZSET is the canonical fit. List would lose ordering by priority; Set loses ordering entirely; Stream is append-only and can't reorder. ([antirez delayed-queue pattern](https://redis.antirez.com/fundamental/delayed-queue.md), [Svix scheduled queue](https://www.svix.com/resources/redis/scheduled-queue/))

### 3.2 Hopper claim lock (in-flight protection)
- **Key:** `t:{tid}:hopper:lock:{cid}:{lead_id}` STRING TTL 30s.
- **Why:** Prevents another dialer instance from re-claiming the same lead if originate is in-flight; the TTL acts as automatic cleanup if the dialer crashes mid-originate.
- **Value:** dialer instance ID + claim timestamp (for diagnostics).

### 3.3 Drop-window (TCPA 3% rolling 30-day)
- **Key:** `t:{tid}:campaign:{cid}:drop_window`
- **Type:** STREAM
- **Entry fields:** `{answered: 0|1, dropped: 0|1, ts: unix_ms, call_uuid: string}` (call_uuid optional; useful for forensic audits).
- **Trim policy:** `XADD ... MAXLEN ~ 500000` on every write (caps per-campaign growth). Plus a daily janitor cron `XTRIM MINID <30d-ago-ms-id>` for time-based exact trim. (`MAXLEN ~` is the approximate-and-fast trim that stops at macro-node boundaries; `MINID` is exact and slower but correct for our 30-day TCPA window.) ([Redis XADD docs](https://redis.io/docs/latest/commands/xadd/), [Redis XTRIM docs](https://redis.io/commands/xtrim/))
- **Read for adaptive engine:** `XLEN` for total, `XRANGE`/`XREVRANGE` filtered by ts. Streams read sequential ranges in O(log N + M). Zero copy of trimmed entries.
- **Why STREAM and not ZSET counter:** the alternatives are (a) `INCR` per-second buckets in 2592000 keys per campaign (90 days × 30s? complicated, lossy on bucket boundaries), or (b) ZSET keyed by ts. Streams are an order of magnitude more memory-efficient than ZSET+HASH for time-ordered entries — antirez's published microbenchmark: 1M time-series entries cost 220 MB as ZSET+HASH vs 16.8 MB as a Stream. ([antirez blog](https://antirez.com/news/128)) Plus Streams give us consumer groups for the audit-export pipeline (T01 downstream).

### 3.4 Campaign dial-level (adaptive engine)
- **Key:** `t:{tid}:campaign:{cid}:dial_level` STRING decimal (e.g., `"1.85"`).
- **Why STRING:** single scalar, written infrequently (every 15s by adapt loop), read at every dial tick. Could be RESP3 client-side cached.

### 3.5 Live agent state
- **Key:** `t:{tid}:agent:{user_id}` HASH.
- **Fields:** `status`, `campaign_id`, `lead_id`, `call_uuid`, `last_change_at`, `pause_code`, `ingroups` (CSV or repeated field), `server`, `sip_state`.
- **TTL:** none; manually `DEL` on logout. Janitor sweeps stale (login_ts > 24h, no heartbeat).
- **Why HASH not JSON STRING:** atomic `HSET status PAUSED pause_code BIO last_change_at <ts>` does the three-field update in one round trip without read-modify-write. JSON STRING needs `GET → mutate → SET`, racing.
- **Encoding:** ≤128 fields → listpack (~20–40 B/field); above → hashtable (~64 B/field). Our 9-ish fields stay listpack: ~250 B per agent. 200 agents = 50 KB. Trivial. ([techplained encoding details](https://www.techplained.com/redis-data-structures-sets-sorted-sets-hashes-streams))

### 3.6 Agent indexes (for "longest-waiting READY in campaign X")
- **Keys:**
  - `t:{tid}:agents:by_status:READY` ZSET, score = `last_change_at`, member = user_id.
  - `t:{tid}:agents:by_campaign:{cid}:READY` ZSET, same shape.
- **Operation pattern:** every state change rewrites both indexes (delete from old status zset, add to new). Agent picker (E04) does `ZRANGE :READY 0 0` for the longest-waiting and `ZREM` to claim atomically. (See §4.)
- **Why two ZSETs not one + filter:** picking the longest-waiting READY agent in campaign X is the hottest read path; pre-filtered index is O(log N) vs O(N) over a global "all READY" set.

### 3.7 Active call state
- **Key:** `t:{tid}:call:{uuid}` HASH `{lead_id, campaign_id, agent_id, started_at, state, carrier_id}`.
- **TTL:** `EXPIRE 24h` as a safety net; expected lifecycle is `DEL` on `CHANNEL_HANGUP_COMPLETE`. The TTL only fires if the ESL handler crashes mid-call, in which case a janitor reconciles.
- **`t:{tid}:call:active`** SET of all currently-active call UUIDs — for "kill all calls in this campaign" admin actions.

### 3.8 DNC negative cache
- **Key:** `t:{tid}:dnc:cache:{phone_e164}` STRING TTL 1h.
- **Value:** "1" (DNC) or absent (not DNC). Cache MISS = ask MySQL, populate.
- **Eviction:** if we use a separate cache DB with `volatile-lru`, this is automatic. Otherwise the TTL handles it.

### 3.9 Pub/Sub channels
- `t:{tid}:broadcast:agent:{user_id}` — per-agent state push (screen pop, dispo updates pushed to that one browser).
- `t:{tid}:broadcast:campaign:{cid}` — campaign-wide events (drop% changed, ready-count update).
- `t:{tid}:broadcast:wallboard` — supervisor wallboard fan-out.
- **Loss tolerance:** all pub/sub. If the WS gateway disconnects, missed events are not replayed via pub/sub — the API gateway issues a "full state snapshot" REST call on WS reconnect (read agent HASH, drop-window XLEN, etc.).

### 3.10 Cross-cutting event streams (durable)
- `events:vici2.call.answered`
- `events:vici2.call.bridged`
- `events:vici2.call.ended`
- `events:vici2.call.dropped`
- `events:vici2.agent.state_changed`

These are consumer-grouped streams (NOT tenant-prefixed; tenant_id lives in the payload). T01 (ESL bridge) is the producer; A03 (WS push) and S01 (wallboard) are consumer-group readers. `XAUTOCLAIM` with 60s `min-idle-time` recovers from a crashed consumer. ([Stanza failure-handling guide](https://www.stanza.dev/courses/redis-messaging/stream-reliability/redis-messaging-failure-handling), [antirez stream consumer patterns](https://redis.antirez.com/fundamental/streams-consumer-patterns.md))

### 3.11 Coordination primitives
- `t:{tid}:dialer:tick:{cid}` STRING TTL 1s — `SET NX EX 1` to dedup pacing ticks across multiple dialer-engine instances. Whoever gets the lock runs the tick.
- `t:{tid}:janitor:lock` STRING TTL 60s — single janitor instance.

### 3.12 Cluster hash tags (forward compatibility)
If we ever shard via Cluster, the hash slot is computed from the substring inside `{...}`. We need keys that must live on the same shard (hopper + lock + drop_window per campaign) to share a tag. **Convention:** wrap the campaign id: `t:{tid}:campaign:{{cid}}:hopper`, `t:{tid}:campaign:{{cid}}:drop_window`, etc., with `{cid}` as the slot tag. (Two braces deliberately — one is JSON noise, the inner `{cid}` is the actual hash tag — actual key on disk is `t:1:campaign:{42}:hopper`.) Document this in F04 PLAN.md.

---

## 4. Atomicity patterns: Lua scripts (and when to choose Functions)

### 4.1 Why Lua, not Functions
Redis 7 Functions ([release post](https://redis.io/docs/latest/develop/whats-new/7-2/)) are the modern replacement for `EVAL`/`EVALSHA`. They live in libraries, are persisted to RDB, replicate as functions instead of as resolved commands, and don't need to be re-loaded after `FLUSHALL`/restart. Triggers and Functions (`TFCALL`) extend this to event-driven JavaScript code — but Triggers and Functions is a **Redis Stack module**, not in Valkey.

For F04 we want to stay portable across Redis OSS, Valkey, and (eventually) Dragonfly. So:
- **Use Lua via `SCRIPT LOAD` + `EVALSHA`** — universal, works on every engine.
- Cache the SHA1 in the helper lib at boot.
- Handle `NOSCRIPT` errors with auto-reload (every client lib has this; both go-redis and ioredis transparently).
- Defer Functions to a later phase if and only if we want server-side replication of cross-shard logic.

### 4.2 Atomic operations needed (sketches; full source in PLAN.md)

**A. `claim_lead_from_hopper`**
- Inputs: hopper key, lock prefix, lock TTL seconds, dialer instance id.
- Steps: `ZPOPMIN` hopper (returns lead_id or nil) → `SETEX` `<lock_prefix>:<lead_id>` `<ttl>` `<instance_id>` → return lead_id (or nil).
- Why atomic: prevents double-claim across N dialer instances.

**B. `release_hopper_lock`**
- Inputs: lock key, hopper key, lead_id, score (original).
- Steps: `DEL` lock → if `argv[reinsert] == 1` then `ZADD` hopper to retry → return.
- Used after originate failure to push the lead back into the hopper.

**C. `record_call_outcome`** (drop-window write)
- Inputs: drop-window stream key, events stream key, answered, dropped, ts, call_uuid, campaign_id, tenant_id.
- Steps: `XADD drop_window MAXLEN ~ 500000 *` … → `XADD events:vici2.call.<dropped|answered> MAXLEN ~ 1000000 *` … → return OK.
- Why atomic: a drop must hit *both* streams or *neither*; we never want the audit stream to disagree with the campaign drop_window.

**D. `pick_agent_for_call`**
- Inputs: agents-by-campaign-READY ZSET key, agent-state hash key prefix, call_uuid, ts.
- Steps: `ZRANGE …READY 0 0 WITHSCORES` → if empty return nil → `ZREM …READY` → `HSET agent:<id> status RESERVED, call_uuid, last_change_at` → publish to `broadcast:agent:<id>` → return agent_id.
- Why atomic: race between two answered customer calls picking the same agent.

**E. `agent_state_transition`**
- Inputs: agent hash key, two ZSETs (old status, new status), agent_id, new_status, ts.
- Steps: `HGET agent old_status` → `ZREM` old index → `ZADD` new index → `HSET` fields → publish.
- Why atomic: a half-transitioned agent (in two indexes) breaks "longest-waiting" picks.

The full source code lives in F04 PLAN.md per the F04 spec deliverable list (we will not emit code in RESEARCH).

### 4.3 Lua hygiene rules
- Keep scripts short — Redis is single-threaded; long scripts block the whole server.
- Always use `KEYS[]` for keys (so Cluster routing works); `ARGV[]` for non-key args. Hard-coding key names inside a script breaks cluster mode.
- Reload `NOSCRIPT` lazily on first use after restart.
- `redis.call` (raises errors) vs `redis.pcall` (returns errors as values): we use `redis.call` and let go-redis/ioredis surface the error.

---

## 5. HA strategy

### 5.1 Phase 1 (MVP, ≤30 agents): single Valkey node
- **Acceptable downtime:** ~5 minutes for Valkey restart (the dialer engine's reconcile-on-boot logic recovers state from MySQL).
- **Persistence:** RDB snapshots every 5 minutes + AOF `everysec`. Dual-mode = fast restart from RDB plus ≤1s loss bound from AOF. ([Redis persistence guide](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/))
- **Backups:** RDB file copied to S3 nightly via cron.
- **Operational note:** a single Valkey node is a SPOF for live state. The dialer engine's recovery semantics (reconcile call_log on boot, agents have to re-login) means it's not catastrophic — a 30s outage maps to 30s of dialer pause, not 30s of data loss.

### 5.2 Phase 2/3 (real production, 50–200 agents): Sentinel with 3 nodes
- **Topology:** 3 boxes; each runs (a) Valkey replica (one is master), (b) Sentinel. Quorum = 2.
- **Why Sentinel and not Cluster:** dataset fits in one node's RAM (we estimated ~250–400 MB working set for 200 agents — see §8); no need for sharding. Sentinel is dramatically simpler operationally and every client lib (go-redis v9, ioredis) supports it natively. ([Redis Sentinel docs](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/), [KX Sentinel guide](https://kx.cloudingenium.com/en/redis-sentinel-high-availability-automatic-failover-guide), [ITNotes Sentinel-vs-Cluster](https://itnotes.dev/redis-sentinel-vs-redis-cluster-surviving-production-failures/))
- **Failover guarantees:** SDOWN (~5s) → ODOWN (quorum-confirmed) → leader election → replica promotion → clients reconnect. End-to-end ~10–30s. The dialer pacing loop tolerates this (it has a tick-skip safety check).
- **Split-brain mitigation:** `min-replicas-to-write 1`, `min-replicas-max-lag 10` on master. Lose more than one replica's lag-bound and the master refuses writes.
- **Sentinel checklist:** (paraphrased from KX guide and Redis docs)
  - 3 Sentinels on 3 separate physical/AZ boxes (never colocate all 3 with one master).
  - `requirepass` and `masterauth` identical on master + replicas.
  - `replica-read-only yes`.
  - go-redis `redis.NewFailoverClient` with `MasterName` + `SentinelAddrs` slice (never hardcode master IP).
  - Failover drill quarterly.

### 5.3 Phase 4+ (multi-tenant SaaS, 500+ agents per cluster): Cluster
- Trigger criteria: working set > 16 GB (or 80% of one node's RAM), or sustained >50k ops/s writes.
- Minimum 6 nodes (3 masters + 3 replicas).
- Hash-tag convention from §3.12 makes per-campaign keys colocate on the same shard; cross-campaign or cross-tenant operations route per-key.
- Sharded pub/sub (Redis 7+ `SSUBSCRIBE`/`SPUBLISH`) limits cluster-bus chatter. ([Redis Pub/Sub docs](https://redis.io/docs/latest/develop/pubsub/))
- Multi-key Lua scripts in Cluster require all keys to share a hash tag — already enforced by §3.12 convention.

### 5.4 What we deliberately are NOT doing
- **Not** running Redis Enterprise (license + cost).
- **Not** rolling our own master-replica monitoring (that's Sentinel's job).
- **Not** using Active-Active CRDB (overkill, Enterprise-only).

---

## 6. Persistence + backup strategy

### 6.1 Configuration
```
appendonly yes
appendfsync everysec
auto-aof-rewrite-percentage 100
auto-aof-rewrite-min-size 64mb
save 900 1
save 300 10
save 60 10000
rdb-save-incremental-fsync yes
aof-use-rdb-preamble yes
```

- **`appendfsync everysec`:** balances durability (≤1s loss bound) with throughput. `always` is too slow; `no` loses 30s of writes. ([Redis durability eBook](https://redis.com/ebook/part-2-core-concepts/chapter-4-keeping-data-safe-and-ensuring-performance/4-1-persistence-options/))
- **RDB+AOF combined:** at startup Redis loads AOF if present (more complete); otherwise falls back to RDB. AOF rewrite runs in background, uses RDB preamble for speed.
- **Stream persistence:** Streams are persisted by both RDB and AOF. The PEL of consumer groups is also persisted; consumer state survives restart.

### 6.2 Backup
- Nightly `BGSAVE` triggered by cron → copy `dump.rdb` to S3 (`s3://vici2-backups/redis/{tenant}/{yyyy-mm-dd}/dump.rdb`).
- Retention: 7 daily, 4 weekly, 12 monthly.
- AOF is not backed up (it's just journaling; RDB is the canonical recoverable snapshot).
- Encrypted at rest (S3 SSE-KMS).

### 6.3 Restore
- Documented runbook (F04 HANDOFF.md): stop Valkey → drop new RDB into `dir` → start Valkey → verify with `INFO persistence` and `DBSIZE`.

### 6.4 What persistence does NOT save us from
- Pub/Sub messages — fire-and-forget, never persisted. (Subscribers must reconcile on reconnect.)
- Lua scripts — `SCRIPT LOAD` is in-memory only. Helper lib re-loads on `NOSCRIPT`.
- Client-side caches — invalidated on reconnect.

---

## 7. Client library choice

### 7.1 go-redis v9 (Go dialer engine)
**Confirmed.** Latest stable as of May 2026. Supports Sentinel, Cluster, RESP2/RESP3, pipelines, transactions, streams. ([go-redis docs](https://redis.io/docs/latest/integrate/go-redis/), [go-redis cluster guide](https://redis.uptrace.dev/guide/go-redis-cluster.html))

Pool tuning per [git-push-and-run guide](https://manuelfedele.github.io/posts/use-redis-with-golang/):
```go
redis.NewClient(&redis.Options{
    Addr:           env.RedisAddr,
    PoolSize:       30,         // per process; 30 × N_dialer_instances ≤ Valkey maxclients
    MinIdleConns:   5,
    MaxIdleTime:    5*time.Minute,
    DialTimeout:    3*time.Second,
    ReadTimeout:    2*time.Second,
    WriteTimeout:   2*time.Second,
    MaxRetries:     3,
    Protocol:       3,           // RESP3 for client-side caching of static config
})
```

For Sentinel: `redis.NewFailoverClient(&redis.FailoverOptions{ MasterName: "vici2-master", SentinelAddrs: []string{...} })`.

For pipelines / transactions:
- `Pipelined(ctx, fn)` — non-atomic batch round-trip. Used for hopper bulk-add.
- `TxPipelined(ctx, fn)` — `MULTI`/`EXEC` atomic batch. Used where atomicity matters but Lua isn't needed.
- For Lua: `Eval`/`EvalSha`; cache the SHA at boot.

### 7.2 ioredis (Node API gateway)
Reasoning: Fastify ecosystem norm; native TS types; Sentinel + Cluster + Streams support. Alternative `node-redis` v5 is fine too, but ioredis has more battle-testing in the WS-gateway pattern we need.

(Fastify-specific: `fastify-redis` plugin wraps it.)

### 7.3 Why not write our own client
We use the helper-lib layer in F04 to wrap typed key-builders, Lua-script SHAs, and the hopper/agent operation API. Underneath it's whichever client. The wrapper exposes parity APIs in Go and TS so swapping clients is local.

---

## 8. Memory budget estimate

### 8.1 Per-element costs (Valkey 8 / Redis 7+, 64-bit jemalloc)

Source: [techplained encoding details](https://www.techplained.com/redis-data-structures-sets-sorted-sets-hashes-streams), [oneuptime memory calc](https://oneuptime.com/blog/post/2026-03-31-redis-calculate-memory-usage-data-types/view), antirez's stream microbenchmark.

| Structure | Encoding | ≈ Memory per entry (incl overhead) |
|---|---|---|
| String, short value (~16 chars key + 16 chars value) | sds | ~56–80 B |
| HASH listpack (≤128 fields, values ≤64B) | listpack | ~20–40 B per field |
| HASH hashtable (>128 fields) | hashtable | ~64 B per field + bucket |
| ZSET listpack (≤128 members) | listpack | ~32 B per element |
| ZSET skiplist (>128 members) | skiplist | ~96–128 B per element |
| SET intset (all integers, ≤512) | intset | 4–8 B per element |
| SET listpack | listpack | ~16 B per element |
| STREAM | listpack-node + radix tree | ~16–18 B per entry (delta-compressed) |

### 8.2 Headline scenario: 200 agents, 50 active campaigns, 1M leads in DB, 25k leads in hopper

| Key category | Count | Per-entry | Subtotal |
|---|---:|---:|---:|
| `agent:{user_id}` HASH (9 fields, listpack) | 200 | ~250 B | 50 KB |
| `agents:by_status:READY` ZSET (≤200) | 1 | listpack-32 B × 200 | 6.4 KB |
| `agents:by_campaign:{cid}:READY` ZSETs | 50 | listpack × ~4 each | 6.4 KB |
| `campaign:{cid}:hopper` ZSETs (skiplist, 500 ea) | 50 | 96 B × 500 | 2.4 MB |
| `campaign:{cid}:drop_window` STREAMs (30d × ~3000 calls/day = 90k entries) | 50 | 18 B × 90k | 81 MB |
| `events:vici2.call.*` STREAMs (5 streams × ~1.35M entries/30d at 200 agents pace) | 5 | 18 B × 1.35M | ~120 MB |
| `call:{uuid}` HASH (active, ~100 concurrent peak) | 100 | 300 B | 30 KB |
| `dnc:cache:*` STRING (10k cached numbers) | 10k | 80 B | 800 KB |
| `hopper:lock:*` STRING (peak ~200) | 200 | 80 B | 16 KB |
| Misc (dial_level, tick locks, janitor lock) | ~100 | 80 B | 8 KB |
| **Working set subtotal** | | | **~205 MB** |
| Allocator fragmentation (jemalloc, ~10–20%) | | | +30–40 MB |
| Replication backlog buffer (`repl-backlog-size`) | | | +50 MB |
| AOF rewrite peak (transient fork COW) | | | +1× working set |
| **Comfortable plan: 1 GB cap, 4 GB box** | | | |

### 8.3 Per-100-agent and per-1M-leads
- **+100 agents:** +25 KB hashes + ~50% more drop_window entries (call rate scales with agents) → +~40 MB.
- **+1M leads in MySQL:** zero impact unless they enter the hopper. The hopper holds the *ready-to-dial* slice; size capped by `hopper_size_target = ready_agents × dial_level × (60/dial_timeout) × multiplier`. So 1M leads in MySQL still maps to ~500 leads in hopper per campaign.
- **+30 days drop_window:** ~80 MB additional.

### 8.4 Eviction policy
- **Production keyspace (DB 0):** `maxmemory-policy noeviction`. **Live state must never be evicted silently.** If Valkey hits `maxmemory`, writes fail loudly — operator alarm fires, dialer pauses gracefully (we treat any Valkey write error as a non-fatal pause).
- **Cache DB (DB 1, separate logical database):** `maxmemory-policy volatile-lru` — DNC cache, lead-detail cache, status-list cache. All entries have TTLs.
- **Sizing rule:** set `maxmemory` to ~70% of physical RAM to leave headroom for fork (`BGSAVE`/AOF rewrite COW) and OS buffers.

---

## 9. How vicidial does this in MySQL — and why we changed

Vicidial centralizes everything in MySQL. The hot tables that we are explicitly *replacing* with Redis:

| Vicidial MySQL table | Engine | Vicidial purpose | What goes wrong | Vici2 Redis equivalent |
|---|---|---|---|---|
| `vicidial_hopper` | MEMORY | Pre-dial queue per campaign. `AST_VDhopper.pl` fills every ~60s; `AST_VDauto_dial.pl` reads every 2.5–3s | MEMORY tables don't replicate; restart drops the queue; row-locks on multi-server | `t:{tid}:campaign:{cid}:hopper` ZSET + Lua claim |
| `vicidial_live_agents` | MEMORY | Per-agent live state (status, last-change ts, current call) | Hot row contention; concurrent updates from agent UI + dialer collide | `t:{tid}:agent:{user_id}` HASH + indexes |
| `vicidial_auto_calls` | MEMORY | Currently-active originated calls | Same hot-row issue, plus full-table scan to count "active per campaign" | `t:{tid}:call:{uuid}` HASH + `t:{tid}:campaign:{cid}:active_calls` SET |
| `vicidial_drop_log` (rolling window in queries) | InnoDB | 30-day drop count, queried every 15s by adapt | Range-scan over millions of rows × per-campaign × every 15s = repeated I/O | `t:{tid}:campaign:{cid}:drop_window` STREAM, `XLEN`/`XRANGE` |
| `web_client_sessions` (live) | MEMORY | WS push approximation | Polling-driven; no real fan-out | Pub/Sub `broadcast:agent:*` |

**Why MySQL hit the wall (Vicidial's documented issue, paraphrased from
[design doc §8.3 risks](DESIGN.md), [Vicidial AST_VDauto_dial cycle](DESIGN.md#L19) and the broader MySQL dialer literature):**

1. **MEMORY engine is single-server.** Multi-server Vicidial setups must replicate the MEMORY tables via "live" cluster nodes — a fragile pattern.
2. **Row-level lock contention** on hot rows during predictive bursts (MEMORY uses table-level locks in many ops; InnoDB row locks accumulate on the same agents/campaigns).
3. **Polling-based UI** — Vicidial's agent UI polls `vicidial_live_inbound_agents` etc. every 1–3s. With 100+ agents, that's 100+ qps just to draw the UI. Pub/Sub fan-out collapses this to one publish per state change.
4. **Adaptive engine reads `vicidial_log` 30-day window** repeatedly. Even with proper indexing, this is many MB of I/O per 15s tick.
5. **No atomic claim-from-hopper.** `AST_VDauto_dial.pl` uses `UPDATE … LIMIT 1` patterns with their own race-condition footnotes.

Redis's data-structure-server design eliminates all five: ZSET ordering + atomic ZPOPMIN, Pub/Sub fan-out, Stream-based time-series with O(log N) range queries, listpack-encoded hash overhead. Plus Lua scripts give multi-step atomicity that MySQL `BEGIN; … COMMIT;` would tie up dozens of row-locks for.

**This is why the design rule (SPEC.md §4.2) is absolute:** *Live state in Redis, persistent state in MySQL.* If you find yourself reading agent state from MySQL in a hot path, you've broken the model.

---

## 10. Open questions for PLAN.md

1. **Hash-tag policy in keys: bare `{cid}` or richer `{cid:42}` form?** Only matters at Cluster time; can defer but should pick a convention now to avoid renaming all keys later.
2. **`MAXLEN ~ 500000` for drop_window — does the approximate trim ever leave us with > 30 days of entries that confuse XLEN-based drop% math?** Likely no because the periodic `XTRIM MINID` re-trims exactly. Need a unit test that simulates 35 days of data and verifies the 30-day window is correct.
3. **Should agent state changes go through Lua or be pipelined?** Lua wins on atomicity; pipeline wins on simplicity. Recommendation in §4 was Lua; PLAN should commit.
4. **Use Redis Functions instead of Lua now, in case Valkey 9 deprecates EVAL?** Survey: Valkey 9 still supports EVAL (compat is sacred). Defer.
5. **Per-tenant Valkey instance vs shared with `t:{tid}:` prefix?** Phase 1 single-tenant so moot. Phase 4 multi-tenant SaaS — the `t:{tid}:` prefix is good enough for soft isolation; hard isolation (one Valkey per tenant) costs more but simplifies billing/quota.
6. **RESP3 + client-side caching — worth turning on for static config (campaign list, status list, DNC cache)?** Saves round-trips on every dialer tick. Yes, worth turning on; the implementation cost is minor (`Protocol: 3` in go-redis options + `CLIENT TRACKING ON BCAST PREFIX config:`). Document in PLAN.
7. **Where does Phase 1 host Valkey — same Docker host as MySQL/FreeSWITCH or separate?** Operationally separate is cleaner (can restart Valkey without touching FS), but for Phase 1 dev a single docker-compose file is fine. F01's job to decide.
8. **Backup target: S3 only, or also a local NAS?** S3 only is simpler; local NAS adds RTO recovery speed. Defer to ops.
9. **Stream consumer-group naming convention** — `vici2.call.answered:cg:wallboard`? `events:vici2.call.answered` group `wallboard`? PLAN should pick one.
10. **`XAUTOCLAIM` cadence and min-idle-time per stream** — 60s for fast pipelines, 5–10 min for slow audit pipelines. Per-stream config table in PLAN.

---

## 11. Citations

1. [Percona — "Valkey Emerges as Leading Open Source Alternative to Redis After Relicensing Row" (Sep 2024)](https://percona.com/about-percona/newsroom/press-releases/valkey-emerges-as-leading-open-source-alternative-to-redis-after-relicensing-row)
2. [Percona Experience Center — Redis vs Valkey at a glance](https://experience.percona.com/valkey-redis/valkey-vs-redis/redis-and-valkey-at-a-glance)
3. [AWS — "Redis OSS vs. Valkey — Difference Between Caches"](https://aws.amazon.com/elasticache/redis)
4. [Better Stack — "Valkey vs Redis: How to Choose in 2026"](https://betterstack.com/community/comparisons/redis-vs-valkey)
5. [DevToolsWatch — "Redis vs Valkey vs Dragonfly 2026: Full Comparison"](https://devtoolswatch.com/en/redis-vs-valkey-vs-dragonfly-2026)
6. [Pavan Rangani — "Redis 8 vs Valkey Fork Comparison" (2026)](https://blogs.pavanrangani.com/redis-8-vs-valkey-fork-comparison/)
7. [Redis 7.2 release notes (`redis/redis` 7.2 branch)](https://github.com/redis/redis/blob/7.2/00-RELEASENOTES)
8. [Redis 7.2 docs — what's new](https://redis.io/docs/latest/develop/whats-new/7-2/)
9. [Redis docs — Streams data type](https://redis.io/docs/latest/develop/data-types/streams/)
10. [Redis docs — XADD / XTRIM (MAXLEN ~ semantics)](https://redis.io/docs/latest/commands/xadd/), [XTRIM](https://redis.io/commands/xtrim/)
11. [antirez — "Redis Streams as a pure data structure" (memory comparison)](https://antirez.com/news/128)
12. [antirez — "Streams consumer patterns"](https://redis.antirez.com/fundamental/streams-consumer-patterns.md)
13. [antirez — "Delayed queue" (ZSET-as-scheduler pattern)](https://redis.antirez.com/fundamental/delayed-queue.md)
14. [Svix — "How to Build a Scheduled Queue in Redis" (Lua atomic claim pattern)](https://www.svix.com/resources/redis/scheduled-queue/)
15. [Stanza course — "Handling Consumer Failures" (XAUTOCLAIM, PEL)](https://www.stanza.dev/courses/redis-messaging/stream-reliability/redis-messaging-failure-handling)
16. [Redis docs — XAUTOCLAIM](https://redis.io/docs/latest/commands/xautoclaim)
17. [Redis docs — XREADGROUP](https://redis.io/docs/latest/commands/xreadgroup)
18. [Redis docs — Pub/Sub (incl. sharded pub/sub)](https://redis.io/docs/latest/develop/pubsub/)
19. [Redis blog — "What to Choose for Your Synchronous and Asynchronous Communication Needs—Redis Streams, Redis Pub/Sub, Kafka, etc."](https://redis.io/blog/what-to-choose-for-your-synchronous-and-asynchronous-communication-needs-redis-streams-redis-pub-sub-kafka-etc-best-approaches-synchronous-asynchronous-communication)
20. [Redis docs — High availability with Redis Sentinel](https://redis.io/docs/latest/operate/oss_and_stack/management/sentinel/)
21. [KX — Redis Sentinel HA & Failover Guide (3-node deployment, quorum 2)](https://kx.cloudingenium.com/en/redis-sentinel-high-availability-automatic-failover-guide)
22. [ITNotes — "Redis Sentinel vs. Redis Cluster" (when to escalate)](https://itnotes.dev/redis-sentinel-vs-redis-cluster-surviving-production-failures/)
23. [Redis docs — Persistence (RDB, AOF, fsync policies)](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
24. [Redis ebook — "Durable Redis"](https://redis.com/ebook/part-2-core-concepts/chapter-4-keeping-data-safe-and-ensuring-performance/4-1-persistence-options/)
25. [Redis docs — go-redis client](https://redis.io/docs/latest/integrate/go-redis/), [pipelines & transactions](https://redis.io/docs/latest/develop/clients/go/transpipe), [connect](https://redis.io/docs/latest/develop/clients/go/connect/)
26. [go-redis Cluster guide (uptrace)](https://redis.uptrace.dev/guide/go-redis-cluster.html)
27. [git-push-and-run — "Redis in Go with go-redis/v9" (pool tuning)](https://manuelfedele.github.io/posts/use-redis-with-golang/)
28. [centminmod — "Redis vs KeyDB vs Dragonfly vs Valkey Performance Comparison"](https://github.com/centminmod/redis-comparison-benchmarks)
29. [repoflow — "Redis vs Valkey vs DragonflyDB vs KeyDB Benchmarks" (M4 2026)](https://www.repoflow.io/blog/redis-vs-valkey-vs-dragonflydb-vs-keydb-benchmarks)
30. [DragonflyDB — vendor benchmark report](https://www.dragonflydb.io/content/the-definitive-in-memory-data-store-benchmark-report)
31. [DragonflyDB — "Future-Proof Alternative to Redis" (BSL license rationale)](https://dragonflydb.io/blog/dragonfly-the-future-proof-alternative-to-redis)
32. [techplained — Redis Data Structures memory characteristics](https://www.techplained.com/redis-data-structures-sets-sorted-sets-hashes-streams)
33. [oneuptime — "How to Calculate Memory Usage for Redis Data Types"](https://oneuptime.com/blog/post/2026-03-31-redis-calculate-memory-usage-data-types/view)
34. [Redis docs — MEMORY USAGE](https://redis.io/commands/memory-usage)
35. [oneuptime — "How to Build a Call Queue System with Redis" (mirrors our hopper + agent picker pattern)](https://oneuptime.com/blog/post/2026-03-31-redis-call-queue-system/view)
36. [Redis docs — CLIENT TRACKING (server-assisted client-side caching)](https://redis.io/docs/latest/commands/client-tracking/)
37. [Redis docs — Client-side caching introduction](https://redis.io/docs/latest/develop/clients/client-side-caching/)
38. [antirez — "Client side caching"](https://redis.antirez.com/fundamental/client-side-caching.md)
39. [Redis Insight — Manage streams and consumer groups](https://redis.io/docs/latest/develop/tools/insight/insight-stream-consumer/)
40. [Stack Overflow — "What are the main differences between Redis Pub/Sub and Streams?" (canonical comparison)](https://stackoverflow.com/questions/59540563/what-are-the-main-differences-between-redis-pub-sub-and-redis-stream)

---

## Stop here. F04 IMPLEMENT is blocked on F01 (repo skeleton + dev environment).

Next deliverable when F01 is DONE: `spec/modules/F04/PLAN.md` per the F04 spec
(confirmed key namespace, full Lua source, helper-lib API in TS+Go, test strategy).
