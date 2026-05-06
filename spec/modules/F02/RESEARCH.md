# F02 — MySQL 8 Schema + Migrations — RESEARCH

**Module:** F02 — MySQL Schema + Migrations
**Phase:** 1 (MVP)
**Stack context:** Node 20 + Fastify + **Prisma** (api / workers); Go 1.22 + **sqlx** (dialer engine, narrow hot-path queries only); MySQL 8.x InnoDB single primary; Redis 7 owns all live state per SPEC §4.2.
**Date:** 2026-05-06
**Author agent:** F02 (research-only)

> Scope reminder. Per F02.md and SPEC.md §3.8, **schema changes only via Prisma migrations** — there is no Go-driven migration tool in our stack. The user prompt's mention of "golang-migrate vs Goose vs Atlas vs sqlc" is informational; the Go dialer service consumes the schema (sqlx queries), it does not own DDL. Section 3 below covers Prisma Migrate as the primary choice and Atlas as a complement, with golang-migrate / Goose / sqlc only as comparative context in case a future RFC re-opens the decision.

---

## 1. Executive Summary (10 bullets)

1. **Pin to MySQL 8.0.x for Phase 1, not 8.4 LTS.** 8.0 is what Vicidial operators run, what every BYOC reference deployment runs, what AWS/GCP managed offerings still default to in mid-2026, and 8.4's `caching_sha2_password`-by-default + dropped variables (e.g. `expire_logs_days`, `default_authentication_plugin`) introduce upgrade churn we don't need on day one. Track 8.4.x in CI as the upgrade target for Phase 2; the schema we write must be 8.4-compatible (no MyISAM, no removed replication keywords). [1, 2, 3]
2. **InnoDB `flush_log_at_trx_commit = 1` everywhere.** Telephony writes are compliance evidence (DNC adds, dispositions, drops, audit_log). Losing 1s of commits on power loss equals losing a TCPA defense. Sysbench shows 5–10× throughput swing 1→2; we'll buy back that gap with batched inserts (call_log, agent_log) and Redis-first state, not by relaxing durability. `sync_binlog = 1` paired. [4, 5, 6]
3. **Buffer pool 70–75% of dedicated DB box RAM**, `innodb_buffer_pool_instances ≈ size_in_GB / 4` (so 8 instances on 32 GB), `innodb_log_file_size` sized for ~1 hour of `Innodb_os_log_written`, `innodb_io_capacity` matched to the NVMe (10–20k for cloud NVMe), `innodb_flush_method = O_DIRECT` (already 8.4 default). DESIGN.md sizes the MVP DB at 32 GB / 500 GB NVMe → buffer pool 24 GB, 8 instances. [7, 8, 9]
4. **Partition the three log tables by `RANGE COLUMNS(<datetime_column>)` monthly**, not `RANGE(TO_DAYS(...))`. `RANGE COLUMNS` accepts a `DATETIME` directly with no expression — cleaner partition pruning, no `TO_DAYS()` reserved-keyword risk in 8.4, and `EXPLAIN PARTITIONS` reads naturally. Pre-create next-3-months partitions; rotate via `pt-archiver` to an `_archive` shadow table then `EXCHANGE PARTITION` + `DROP PARTITION`. C04 worker owns the maintenance loop. [10, 11, 12, 13]
5. **Foreign keys cannot live on partitioned tables in InnoDB.** This is a hard MySQL restriction (8.0 and 8.4). For `call_log`, `agent_log`, `recording_log`, `drop_log` we drop FK declarations and rely on application-layer enforcement plus indexed lookups. All other tables keep FKs `ON DELETE RESTRICT` per SPEC §3.8. Document this clearly in HANDOFF — it's the single most surprising choice in the schema. [14, 15, 16]
6. **Multi-tenant from day 1, single-tenant on day 1.** Every table has `tenant_id BIGINT NOT NULL DEFAULT 1` per SPEC §4.5. **Every composite index leads with `tenant_id`** — non-negotiable, enforced in PR review. Phase 4 will switch on a Prisma middleware that injects `tenant_id` into every query and lift the default; no schema migration needed. MySQL has no native row-level security like PG, so this is application-layer + index discipline. [17, 18, 19]
7. **Hot-path index plan.** (a) `leads (tenant_id, list_id, status, modify_at)` for hopper SELECT scans, plus `(tenant_id, phone_e164)` for lookup. (b) `dnc (tenant_id, phone_e164, source)` PK reordered to lead with tenant_id and phone (DNC scrub is the most-frequent SELECT in the dial loop — though §4 below recommends moving final DNC scrub to a Redis Bloom filter + MySQL fallback). (c) `call_log` covering index `(tenant_id, campaign_id, call_started)` matches every report query in DESIGN.md. (d) `audit_log` is append-only, `(tenant_id, created_at)` is enough.
8. **DATETIME(6) for high-volume logs (call_log, agent_log, recording_log, drop_log, audit_log).** Microsecond precision matters for ordering ESL events that arrive within the same millisecond, and for accurate `talk_seconds`/`ring_seconds` reporting. Wall-clock TIMESTAMP suffers the 2038 problem and silently converts on session timezone changes — a foot-gun for a multi-region call center. DATETIME stores the literal value. UTC convention enforced by `time_zone = '+00:00'` server-side. [20, 21, 22]
9. **BIGINT auto-increment PKs on every hot-write table; UUID only as a *secondary* unique key on externally-referenced rows.** UUIDv4 PKs cause 5–10× insert-rate degradation on InnoDB clustered indexes (Percona benchmark: 58k → 12k inserts/sec, 28× page splits). FreeSWITCH UUIDs (`call_log.uuid`, `recording_log.uuid`) get `VARCHAR(40)` with a separate UNIQUE index — not the PK. Recordings exposed in URLs use a `BINARY(16)` UUIDv7 derived externally if we want unguessable URLs in Phase 2. [23, 24, 25]
10. **Vicidial schema lessons: keep the table names operators recognise (`leads` vs `vicidial_list`, `call_log` vs `vicidial_log`), drop the 100+ legacy columns nobody uses, drop MyISAM entirely (Vicidial's table-locking nightmare under reports), drop MEMORY engine (Redis owns live state), normalise statuses into a per-tenant lookup table (Vicidial's `vicidial_statuses` is already this — keep that pattern), and offer an optional one-shot importer in Phase 2 that translates `vicidial_list` → `leads` for migration prospects.** [26, 27, 28]

---

## 2. MySQL Version + Tuning Recommendations

### 2.1 Version selection

| Option | Pro | Con | Verdict for Phase 1 |
|---|---|---|---|
| MySQL 8.0.39+ (current 8.0 community) | Default in AWS RDS / GCP CloudSQL / DigitalOcean managed; what every Vicidial cluster runs; `mysql_native_password` available for legacy SIP tooling that occasionally needs it; familiar to ops | Going EOL in community track — security fixes wind down 2026/2027 | **CHOSEN.** Phase 1 ships on 8.0.x [1, 3] |
| MySQL 8.4.x LTS (8.4.4+) | LTS through 2032; clean codebase | `caching_sha2_password` default breaks any old MySQL client that hasn't been updated; `expire_logs_days`, `default_authentication_plugin`, `INFORMATION_SCHEMA.TABLESPACES` removed → `my.cnf` edits will **prevent server start** if not cleaned; new reserved words (`MANUAL`, `PARALLEL`, `QUALIFY`, `TABLESAMPLE`); spatial-index corruption bug in 8.4.0–8.4.3 (fixed 8.4.4) | Phase 2 upgrade target. CI must run schema integration tests on 8.4 starting Phase 1 to catch regressions [1, 2] |
| MySQL 9.x Innovation | Vector search, latest features | Short support window (~6 months per release); not in managed offerings | No |
| Percona Server for MySQL 8.0/8.4 | Drop-in compatible; `pt-online-schema-change` from same vendor; better default `innodb_io_capacity` (10000 vs 200) | Slight ops divergence | Acceptable in production; pin community 8.0 in CI to keep us honest [3] |

**Schema-portability rule:** No MyISAM. No MEMORY engine (we have Redis). No `mysql_native_password` users (force `caching_sha2_password` so the 8.4 cutover is a binary swap). Avoid `TO_DAYS()` in DDL — write `RANGE COLUMNS(date_col)` instead, which is also clearer.

### 2.2 InnoDB tuning baseline (DESIGN.md spec: 8-core, 32 GB, 500 GB NVMe)

```ini
# /etc/mysql/conf.d/vici2.cnf
[mysqld]
# --- Memory ---
innodb_buffer_pool_size           = 24G       # 75% of 32GB
innodb_buffer_pool_instances      = 8         # ~3GB per instance, > 1GB minimum
innodb_buffer_pool_chunk_size     = 128M
innodb_dedicated_server           = OFF       # we set everything explicitly

# --- Redo log (ring buffer) ---
# Sized so ~1 hr of writes fits; check Innodb_os_log_written delta.
# Per Percona, larger buffer absorbs hotter pages → fewer disk writes.
innodb_redo_log_capacity          = 4G        # MySQL 8.0.30+ replaces innodb_log_file_size

# --- Durability (NOT NEGOTIABLE for telephony) ---
innodb_flush_log_at_trx_commit    = 1         # full ACID; one fsync per commit
sync_binlog                       = 1         # binlog fsync per commit
innodb_flush_method               = O_DIRECT  # avoid double-buffering w/ OS cache
innodb_doublewrite                = ON        # torn-page protection

# --- I/O ---
innodb_io_capacity                = 8000      # cloud NVMe; tune to 75% of measured
innodb_io_capacity_max            = 16000
innodb_read_io_threads            = 8
innodb_write_io_threads           = 8

# --- Concurrency ---
innodb_thread_concurrency         = 0         # let InnoDB decide, 8.0 is fine
innodb_purge_threads              = 4
innodb_adaptive_hash_index        = ON        # Vicidial-style point-lookup heavy
innodb_adaptive_hash_index_parts  = 8

# --- Replication / binlog ---
log_bin                           = mysql-bin
binlog_format                     = ROW       # required for partitioned tables + safe replication
binlog_row_image                  = MINIMAL
binlog_expire_logs_seconds        = 604800    # 7 days (NOT expire_logs_days — removed in 8.4)
gtid_mode                         = ON
enforce_gtid_consistency          = ON

# --- Time / charset / SQL mode ---
default_time_zone                 = '+00:00'  # all DATETIME values are UTC
character_set_server              = utf8mb4
collation_server                  = utf8mb4_0900_ai_ci
sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'

# --- Connection limits ---
max_connections                   = 500       # 200 agents * ~2 + workers + pool
thread_cache_size                 = 100
table_open_cache                  = 4000

# --- Slow query log ---
slow_query_log                    = ON
long_query_time                   = 0.5
log_queries_not_using_indexes     = ON
```

**Justification of `innodb_flush_log_at_trx_commit = 1`** despite the well-known 5–10× throughput penalty: every benchmark cited [4, 5, 6] makes the assumption that the workload is short OLTP transactions. Our workload is *not* uniformly short OLTP — the highest-frequency writes are call events (1 row per phone-state-change ESL event), which we already plan to **batch** in the Go dialer (`MULTI-VALUE INSERT` of N events per ~100 ms tick). With batching, the fsync amortises across 50–500 rows per commit, and the 5–10× single-row penalty collapses to <2×. The compliance and TCPA-evidence cost of `=2` (losing the last second on OS crash) is not worth the gain. VoIPmonitor's playbook of `=0` + disabled doublewrite is for stateless packet sniffers; we are storing the source of truth. [29]

**Buffer-pool monitoring contract** (consumed by O01 dashboards): expose `Innodb_buffer_pool_read_requests`, `Innodb_buffer_pool_reads` (target hit rate >99%), `Innodb_os_log_fsyncs` (sanity check that `=1` is taking effect), `Innodb_log_writes`, `Threads_running`, `Innodb_row_lock_waits`.

### 2.3 Phase 2 / scale-out levers (NOT in F02 implement)

- **Read replica + ProxySQL**: writes → primary, reports & supervisor dashboards → replica. Configured via ProxySQL `mysql_replication_hostgroups` + per-query routing rules. Replica lag monitored by ProxySQL Monitor. [30, 31]
- **`pt-online-schema-change`** for any later DDL on `leads` (which can grow to 10M+ rows per DESIGN.md) so we never lock the table.
- **Per-tenant sharding** when tenant_id distribution becomes uneven (Phase 4).

---

## 3. Migration Tooling Decision Matrix

### 3.1 Comparison

| Tool | Primary lang | Migration format | Declarative? | Computed rollback | Drift detection | MySQL 8 partition support | TS / Go ergonomics | Notes for vici2 |
|---|---|---|---|---|---|---|---|---|
| **Prisma Migrate** | Node/TS | Generated SQL from `.prisma` schema | Yes (schema is source of truth) | No (forward-only; new migration to undo) | Yes (shadow DB diff) | **Partial** — model the table, write `PARTITION BY` in raw migration; partitions are opaque to Prisma client (use `findMany` on the parent, fine) | First-class TS types, used by api+workers anyway | **CHOSEN.** Mandated by F02.md + SPEC §3.8 [32, 33, 34] |
| Atlas | Go | HCL or versioned SQL; can ingest Prisma schema | Yes | Computed (from diff) | Yes | Better — supports views, triggers, procedures, partition DDL natively | Optional add-on; can run on top of Prisma | Strong **complement**, not replacement: use Atlas in CI for `migrate lint` / drift detection on the Prisma-generated SQL. Phase 2 RFC. [35, 36] |
| golang-migrate | Go | Hand-written `up.sql` / `down.sql` | No (imperative) | Explicit `down.sql` | No | Yes (raw SQL) | Pure SQL, no codegen | Ruled out: no schema diffing; we'd write the same SQL by hand twice |
| Goose | Go | SQL or Go funcs, sequential | No | Explicit `-- +goose Down` | No | Yes (raw SQL) | Lightweight | Ruled out: no diff, our Node side already needs Prisma |
| sqlc | Go | Generates Go from queries; **does not handle migrations** | — | — | — | — | — | Useful in the Go dialer service to generate query-level types **after** F02 schema lands. RFC for D03 / hopper queries. Combined w/ Atlas per [37] |
| Flyway / Liquibase | Java | SQL/XML/YAML | No / partial | Explicit | Yes | Yes | JVM dependency in our build | Ruled out: heavy JVM ops |

### 3.2 Recommendation

- **Schema source of truth: `api/prisma/schema.prisma`.** Prisma owns model definitions; api + workers consume the generated client.
- **Migrations are committed SQL files** (`prisma migrate dev --create-only` then hand-edit) so we can:
  - Add `PARTITION BY RANGE COLUMNS(...)` to `call_log` / `agent_log` / `recording_log` / `drop_log` (Prisma cannot generate this).
  - Add `WITH SYSTEM VERSIONING`-style audit triggers later if needed.
  - Encode `ON DELETE RESTRICT` overrides where Prisma's defaults differ.
- **Go dialer side: `sqlx` + raw queries**, types generated by **sqlc** in a follow-up module (out of F02 scope). Until then, hand-typed `struct`s in Go. No DDL ownership.
- **CI lint: Atlas** as a *secondary* tool in Phase 2: `atlas migrate lint` against the Prisma migration directory catches dangerous patterns (data-loss DROPs, missing indexes on FK columns). Not blocking Phase 1.
- **Reversibility**: SPEC §3.8 demands every `up` has a `down`. Prisma is forward-only by design, so we adopt the convention of placing a `migration.down.sql` next to each `migration.sql`, run manually via `mysql < ...` in DR drills. Captured in HANDOFF as the operational contract. (This is friction we accept; alternative is migrating to Atlas, which is a Phase 2 RFC.)

### 3.3 Open question for PLAN

- Do we actually need `down.sql` files for production? Production rollback is "deploy previous app + new migration that adds back the column"; we never run downs in prod. SPEC §3.8 says "reversible" but never says when. Decide: dev/test only, or formal `down.sql` per migration. **Recommendation: dev/test only, codified in HANDOFF.**

---

## 4. Partitioning Strategy

### 4.1 Which tables, and why

| Table | Growth | Partition? | Key | Retention |
|---|---|---|---|---|
| `call_log` | 1 row per dial attempt; ~1M rows/month at 50 agents | **Yes**, monthly | `RANGE COLUMNS(call_started)` | 24 months hot, then archive |
| `agent_log` | 1 row per agent state event; ~1–5M rows/month at 50 agents | **Yes**, monthly | `RANGE COLUMNS(event_at)` | 13 months (a year + cushion) |
| `recording_log` | 1 row per recording; ~0.5M rows/month at 50 agents | **Yes**, monthly | `RANGE COLUMNS(start_time)` | 7 years (TCPA evidence) |
| `drop_log` | 1 row per dropped call; small but compliance-critical | **Yes**, monthly | `RANGE COLUMNS(dropped_at)` | 7 years |
| `audit_log` | 1 row per admin action / DNC mutation | **Yes**, monthly | `RANGE COLUMNS(created_at)` | 7 years |
| `dnc` | grows slowly; queried in dial path | No (rather: secondary `phone_e164` hash + Redis Bloom for hot path) | — | indefinite |
| `leads` | 10M+ rows possible | **No (Phase 1)**; revisit if >50M with `RANGE COLUMNS(list_id)` or per-tenant range | — | indefinite |
| `callbacks` | small | No | — | until status=DONE/DEAD then aged |
| Everything else (campaigns, statuses, users, carriers, etc.) | small | No | — | indefinite |

**Why monthly, not weekly or hourly?** VoIPmonitor uses hourly because their CDR rate is 3000/sec. Our spec is ~50–200/sec aggregate. Monthly partitions × 24 active partitions stays well within MySQL's 8192-partition ceiling and matches operator reporting cadence ("last 30 / 60 / 90 days"). Hourly would create 17,520 partitions per 2-year window. [29, 12]

**Why `RANGE COLUMNS(datetime_column)` and not `RANGE(TO_DAYS(call_started))`?** Both work. `RANGE COLUMNS` accepts a `DATETIME`/`DATE` directly; partition pruning is identical; the DDL is more readable. The DESIGN.md example uses `TO_DAYS()` which is fine but slightly less clean. PLAN should ratify the switch. [10, 11]

### 4.2 DDL skeleton (illustrative — actual SQL is for PLAN/IMPLEMENT)

```sql
CREATE TABLE call_log (
  id            BIGINT NOT NULL AUTO_INCREMENT,
  tenant_id     BIGINT NOT NULL DEFAULT 1,
  uuid          VARCHAR(40) NOT NULL,                  -- FreeSWITCH UUID
  -- ... all DESIGN.md §5 fields ...
  call_started  DATETIME(6) NOT NULL,
  -- Partition key MUST be in EVERY unique index (incl. PK).
  PRIMARY KEY (id, call_started),
  UNIQUE KEY uk_call_log_uuid (uuid, call_started),
  KEY idx_tenant_campaign_started (tenant_id, campaign_id, call_started),
  KEY idx_tenant_lead          (tenant_id, lead_id),
  KEY idx_tenant_user_started  (tenant_id, user_id, call_started),
  KEY idx_phone_started        (tenant_id, phone_e164, call_started)
)
ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci
PARTITION BY RANGE COLUMNS(call_started) (
  PARTITION p_pre      VALUES LESS THAN ('2026-01-01'),
  PARTITION p_2026_05  VALUES LESS THAN ('2026-06-01'),
  PARTITION p_2026_06  VALUES LESS THAN ('2026-07-01'),
  PARTITION p_2026_07  VALUES LESS THAN ('2026-08-01'),
  PARTITION p_2026_08  VALUES LESS THAN ('2026-09-01'),  -- pre-create +3 months
  PARTITION p_max      VALUES LESS THAN (MAXVALUE)
);
```

### 4.3 Rotation procedure (owned by C04)

C04 is the partition-maintenance worker (per DESIGN.md service list). RESEARCH for C04 will detail; F02 only specifies the contract:

**Monthly job (1st of each month, off-peak):**

1. **`REORGANIZE PARTITION p_max`** to insert next month's partition before `MAXVALUE`. Always keep `p_max` empty (split has zero overhead). [12]
   ```sql
   ALTER TABLE call_log REORGANIZE PARTITION p_max INTO (
     PARTITION p_2026_09 VALUES LESS THAN ('2026-10-01'),
     PARTITION p_max     VALUES LESS THAN (MAXVALUE)
   );
   ```
2. **Drop oldest partition past retention.** For `call_log` (24 months retention):
   - Create `call_log_archive_2024_05` table with identical structure, NOT partitioned.
   - `pt-archiver` rows from partition `p_2024_05` to the archive table (verifies row counts), or use `EXCHANGE PARTITION`:
     ```sql
     ALTER TABLE call_log EXCHANGE PARTITION p_2024_05 WITH TABLE call_log_archive_2024_05;
     ALTER TABLE call_log DROP PARTITION p_2024_05;
     ```
   - Optionally compress + ship the archive table to S3 (R02 / recordings-archive-style worker).

3. **Health check:** `SELECT TABLE_NAME, PARTITION_NAME, TABLE_ROWS FROM information_schema.PARTITIONS WHERE TABLE_NAME = 'call_log';` and emit `vici2_db_partitions_total{table}` to Prometheus.

**Pre-creation lookahead:** at least 3 months ahead. Job runs monthly, but cron is monthly + nightly safety check that "next month" partition exists.

### 4.4 The FK-on-partitioned-table problem (CRITICAL)

`InnoDB` does not allow foreign keys on partitioned tables, **and** does not allow other tables' FKs to point at a partitioned table. [14, 15, 16]

For F02, this means:
- `call_log.lead_id`, `call_log.campaign_id`, `call_log.user_id`, `call_log.carrier_id`, `call_log.recording_id` → **no FK declarations**. Indexed only.
- `agent_log.user_id`, `agent_log.campaign_id`, `agent_log.call_log_id` → **no FK declarations**.
- `recording_log.call_log_id`, `recording_log.lead_id`, `recording_log.campaign_id`, `recording_log.user_id` → **no FK declarations**.
- `drop_log.call_log_id`, `drop_log.campaign_id` → **no FK declarations**.
- `audit_log.user_id` → **no FK declarations**.

We compensate with:
- **Application-layer enforcement** in api / dialer (Prisma's relations still work for client codegen even without DB-level FK; we just lose `ON DELETE RESTRICT`).
- **Indexed lookups** on each "would-be FK" column.
- **Audit reconciler** (cron, in C04 or a sibling): nightly `LEFT JOIN` of `call_log` against `leads` flags orphans. Out of F02 scope but documented in HANDOFF.

The trigger-based FK workaround [38] is **rejected** — too much locking overhead in the hot dial path. Application + reconciler is the standard pattern at scale.

---

## 5. Index Plan per Table

Driven by the queries spelled out in DESIGN.md §6 (hopper filler, reports), F04 (Redis hopper consumption), and SPEC §4 invariants.

### 5.1 `leads` (the heart, never partitioned in Phase 1)

| Index | Columns | Purpose | DESIGN.md query |
|---|---|---|---|
| PK | `(id)` | clustered insert order | — |
| `idx_tenant_list_status_modify` | `(tenant_id, list_id, status, modify_at)` | Hopper filler scan: `WHERE list_id IN (...) AND status IN (...) ORDER BY modify_at` | §6.1 |
| `idx_tenant_phone` | `(tenant_id, phone_e164)` | Lead lookup by phone (inbound match, manual dial) | §6.6 manual dial |
| `idx_tenant_status_modify` | `(tenant_id, status, modify_at)` | Cross-list "status=NEW" reports | reports |
| `idx_tenant_owner_status` | `(tenant_id, owner_user_id, status)` | Owner-dialing campaigns | dialer |
| `idx_tenant_called_count` | `(tenant_id, called_count)` | Recycle / max-attempts filters | hopper |

**Note:** `tenant_id` first on every composite. SPEC §4.5 + multi-tenant index discipline [17, 18, 19].

### 5.2 `dnc`

PK redesign vs DESIGN.md draft:

```
PRIMARY KEY (tenant_id, phone_e164, source, state, campaign_id)
KEY idx_phone_only (phone_e164)              -- federal scrub fast-path
```

Why: DNC scrub query is `SELECT 1 FROM dnc WHERE phone_e164=? AND ...` in the hopper. Leading with `tenant_id, phone_e164` makes it a 2-column index seek. Dial path will additionally consult a Redis Bloom filter (D05) — DNC is the most-frequent SELECT in the dial loop and we want zero MySQL RTT in the happy path. PLAN should specify the Bloom + DB fallback.

### 5.3 `call_log` (partitioned)

See §4.2 above. Critical indexes:

```
PRIMARY KEY            (id, call_started)
UNIQUE KEY uk_uuid     (uuid, call_started)            -- FS UUID lookup
KEY idx_t_camp_started (tenant_id, campaign_id, call_started)  -- campaign reports
KEY idx_t_lead         (tenant_id, lead_id)            -- lead history
KEY idx_t_user_started (tenant_id, user_id, call_started)      -- agent reports
KEY idx_t_phone_started (tenant_id, phone_e164, call_started)  -- phone history
KEY idx_t_status_started (tenant_id, status, call_started)     -- "all sales last 30d"
```

### 5.4 `agent_log` (partitioned)

```
PRIMARY KEY            (id, event_at)
KEY idx_t_user_event   (tenant_id, user_id, event_at)
KEY idx_t_camp_event   (tenant_id, campaign_id, event_at)
KEY idx_t_call         (tenant_id, call_log_id)
```

### 5.5 `recording_log` (partitioned)

```
PRIMARY KEY            (id, start_time)
UNIQUE KEY uk_uuid     (uuid, start_time)
KEY idx_t_lead         (tenant_id, lead_id)
KEY idx_t_camp         (tenant_id, campaign_id, start_time)
KEY idx_t_call         (tenant_id, call_log_id)
KEY idx_t_user         (tenant_id, user_id, start_time)
```

### 5.6 `drop_log` (partitioned)

```
PRIMARY KEY            (id, dropped_at)
KEY idx_t_camp_dropped (tenant_id, campaign_id, dropped_at)   -- 30-day rolling drop% reconciler (SPEC §4.1)
KEY idx_t_call         (tenant_id, call_log_id)
```

### 5.7 `audit_log` (partitioned, append-only)

```
PRIMARY KEY            (id, created_at)
KEY idx_t_actor_created (tenant_id, user_id, created_at)
KEY idx_t_entity        (tenant_id, entity_type, entity_id)
KEY idx_t_action_created (tenant_id, action, created_at)
```

### 5.8 `callbacks`

```
PRIMARY KEY            (id)
KEY idx_t_due_status   (tenant_id, status, callback_at)   -- the "what's due now" scanner
KEY idx_t_user_due     (tenant_id, user_id, callback_at)  -- agent's own callbacks
KEY idx_t_lead         (tenant_id, lead_id)
```

### 5.9 `campaigns`, `statuses`, `pause_codes`, `users`, `carriers`

Small tables, mostly point lookups + short scans. PKs as DESIGN.md, plus `(tenant_id, ...)` composites where natural.

- `users`: PK `(id)`, UNIQUE `(tenant_id, username)`, UNIQUE `(tenant_id, email)` (so multi-tenant Phase 4 can have collisions across tenants).
- `campaigns`: PK `(id)` (VARCHAR(32)) — the ID space is per-tenant in app code; consider compound PK `(tenant_id, id)` to be future-proof. **PLAN to decide.**
- `statuses`: PK `(tenant_id, campaign_id, status)`.
- `pause_codes`: UNIQUE `(tenant_id, campaign_id, code)`.
- `carriers`: PK `(id)`, UNIQUE `(tenant_id, name)`.
- `did_numbers`: UNIQUE `(tenant_id, e164)` so two tenants can theoretically share an inbound number space (rare, but cheap to allow now).

### 5.10 `phone_codes` (NANP seed table)

PK `(area_code)` — this is global reference data, not tenant-scoped (NANP is NANP regardless of tenant). The exception that justifies `tenant_id` on every *user-data* table: lookup tables seeded from public data don't need it. Document the exception in HANDOFF.

---

## 6. Multi-Tenant Strategy

Per SPEC §4.5: every table gets `tenant_id BIGINT NOT NULL DEFAULT 1`. Phase 1 single-tenant uses 1. Phase 4 lifts the default and Prisma middleware injects from JWT.

### 6.1 Why we cannot use database-native row-level security

MySQL has no Postgres-style `CREATE POLICY`. Azure SQL has it; MySQL does not. Workarounds in MySQL:
- **Views per tenant**: doesn't scale to thousands of tenants; no DML through views.
- **Stored procedures**: hostile to Prisma + ORMs.
- **Application-layer + index discipline**: this is what every public MySQL multi-tenant SaaS (Shopify, Basecamp, GitHub) does. [17]

**Decision:** application-layer enforcement (Prisma middleware), backed by:
1. **Index discipline:** every composite index leads with `tenant_id`. Enforced in PR review and in the migration.test.ts integration test (assert that every index on every table whose first column is not `id` starts with `tenant_id`).
2. **Prisma middleware** (lands in F05 / F02 HANDOFF example): auto-injects `where: { tenant_id: ctx.tenantId }` on every query.
3. **Defence in depth (Phase 4 RFC):** create one MySQL user per tenant, GRANT only on `WHERE tenant_id = N`-filtered views — but this is heavy and unnecessary at Phase 1. Captured as future work.

### 6.2 Index leadership rule (PR-blocking)

> **Every multi-column index whose table has a `tenant_id` column MUST list `tenant_id` first.** Exception: `phone_codes` (global reference). Single-column indexes on `id` PK or natural-key columns are fine.

The integration test enforces:
```sql
SELECT TABLE_NAME, INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
GROUP BY TABLE_NAME, INDEX_NAME
HAVING cols NOT LIKE 'tenant_id%' AND cols NOT LIKE 'id%' AND TABLE_NAME NOT IN ('phone_codes', '_prisma_migrations');
```
Empty result == passing.

### 6.3 Why this generalises cleanly to Phase 4

- All Redis keys are already `t:{tenant_id}:*` per SPEC §4.5.
- All API requests carry `tenant_id` from JWT.
- Lifting the `DEFAULT 1` is a one-line migration; no data movement.
- We *could* later partition `leads` and `call_log` by `tenant_id` for very large tenants, but at the cost of FK loss — punt to Phase 4 RFC.

---

## 7. Vicidial Schema Lessons

Source: `inktel/Vicidial` `extras/MySQL_AST_CREATE_tables.sql`, ViciWiki, ViciStack ops blogs. [26, 27, 28]

### 7.1 What to keep (good patterns)

| Pattern | Where in our schema |
|---|---|
| **Per-campaign status normalisation** (`vicidial_statuses`) — not an ENUM | Our `statuses (tenant_id, campaign_id, status, ...)` lookup table |
| **`vendor_lead_code` field linking external CRM IDs** | `leads.vendor_lead_code` |
| **`source_id` for list provenance** | `leads.source_id` |
| **Per-list, per-campaign call-time windows with state overrides** | `call_times.state_overrides JSON` |
| **`alt_dial` field name** for which alternate phone was used | We carry as `phone_alt`, `phone_alt2`; call_log records which was used |
| **`called_count`, `last_local_call_time`, `entry_date` on lead** | All preserved in `leads` |
| **Phone code → timezone seed table** | `phone_codes` |
| **`vicidial_dnc` central + `vicidial_campaign_dnc` per-campaign** | Our `dnc.campaign_id NULL = global` pattern unifies this |
| **Recording log separate from call log** | `recording_log` |
| **Closer/inbound separate from outbound logs** is **not** kept — we unify into `call_log.direction` (inbound vs outbound) and `agent_log.event` values, simplifying reports |

### 7.2 What to drop / redesign

| Anti-pattern | Why drop | Our replacement |
|---|---|---|
| **MyISAM as default engine** | Table-level locking; one slow report blocks every insert. Matt Florell's "do not use InnoDB" advice is for Vicidial's existing Perl daemons that assume MyISAM semantics — N/A for greenfield design. [26] | InnoDB everywhere |
| **MEMORY tables for live state** (`vicidial_live_agents`, `vicidial_auto_calls`, `vicidial_hopper`, `vicidial_live_sip_channels`) | RAM-resident table semantics duplicated by Redis; restart loses everything; no pub/sub | Redis hashes + sorted sets per DESIGN.md §5.2 |
| **`vicidial_list` 50+ columns including 99 `q01..q99` TINYINT extension fields** | Schema-as-bag-of-fields; uncountable indexes; everyone pays for fields nobody uses [27] | `leads.custom_data JSON` for tenant-specific arbitrary fields; Zod schema in app code |
| **`vicidial_log.uniqueid VARCHAR(20) PRIMARY KEY`** (Asterisk uniqueid) | Random-ish string PK → InnoDB clustered-index page splits | `call_log.id BIGINT AUTO_INCREMENT` PK + `uuid VARCHAR(40)` UNIQUE |
| **Multiple parallel call-log tables** (`vicidial_log`, `vicidial_closer_log`, `call_log` (Asterisk), `vicidial_carrier_log`, `vicidial_log_extended`) | Reports must `UNION ALL` 4 tables; archive scripts touch each separately | Single `call_log` with `direction`, `kind`, plus partition rotation. Optional `recording_log` and `drop_log` because their cardinality is much lower. |
| **No `tenant_id`** | Vicidial multi-tenancy is via separate MySQL databases (one per tenant) | `tenant_id` from day 1 |
| **`vicidial_hopper`** as a MySQL MEMORY table | Cross-instance coordination via DB MEMORY = lock contention, no atomic claim, no priority | Redis sorted set, atomic `ZPOPMIN` claim with `SETNX` lease |
| **No microsecond precision on `call_date`** | Same-millisecond ESL events sort indeterminately | `DATETIME(6)` |
| **`processed ENUM('Y','N')`** unused | Dead column | Drop |
| **Replication-via-MyISAM-binlog quirks** | Statement-based replication fragility | ROW-format binlog, GTID |

### 7.3 Migration path (importer for prospects coming from Vicidial)

Out of F02 scope but referenced for PLAN:

- **Phase 2 module D02b** (or a one-shot CLI in `tools/`): reads `vicidial_list` + `vicidial_dnc` via mysqldump, transforms into our schema's `leads` + `dnc`, INSERTs by tenant. Field mapping table:
  - `vicidial_list.lead_id` → `leads.id` (preserved if `--preserve-ids`)
  - `vicidial_list.list_id` → `leads.list_id`
  - `vicidial_list.phone_number + phone_code` → `leads.phone_e164` (E.164 normalisation)
  - `vicidial_list.gmt_offset_now` → `leads.tz_offset_min` (Vicidial uses fractional hours; we store minutes)
  - `vicidial_list.q01..q99` → `leads.custom_data JSON` if `extended_vl_fields=1`
  - `vicidial_dnc.phone_number` → `dnc(phone_e164, source='internal')`
- We do **not** import `vicidial_log` historical data — too messy, different schema; expose Phase 2 read-only "legacy archive" mounted under `/admin/legacy-reports`.

---

## 8. Open Questions for PLAN

1. **`campaigns.id` PK shape: `VARCHAR(32)` PK, or compound `(tenant_id, id)`?**
   DESIGN.md says `VARCHAR(32) PRIMARY KEY`. For multi-tenant collision safety in Phase 4, compound is cleaner. Recommendation: **compound `(tenant_id, id)`** with FK rewrites in `campaign_lists`, `statuses`, etc. Trades 8 bytes per row for safety.

2. **`down.sql` files: are we writing them?**
   SPEC §3.8 says reversible. Production rollback is "deploy old app + new forward migration." Recommendation: **`down.sql` for dev/test only**, codified in HANDOFF as the meaning of "reversible".

3. **`leads.custom_data` JSON vs separate `lead_custom_fields` table?**
   JSON is lighter for typical 5–20 custom fields per list; a normalised table wins if customers will index on custom fields (filter "all leads where custom.zipcode in (...)"). Recommendation: **JSON for Phase 1, with a documented escape hatch** to introduce a per-tenant `lead_custom_fields` table when first customer asks. Validate JSON via Zod at ingress.

4. **DNC primary key shape vs DESIGN.md.**
   DESIGN.md PK: `(phone_e164, source, state, campaign_id)`. Recommendation: prepend `tenant_id`, reorder to `(tenant_id, phone_e164, source, state, campaign_id)` for hot-path scrub. Confirm impact on D05.

5. **Encryption of secrets (carrier passwords, SIP creds).**
   SPEC §3.7 says envelope encryption with key from env. Decision needed: column type (`VARBINARY(255)`), KMS abstraction (env-var key vs hashicorp Vault later), key rotation story. F02 just allocates the columns; F05 / S01 implements.

6. **Phase 4 multi-tenant: do we add a `tenants` table now (with id=1 row seeded) for FK ergonomics?**
   Recommendation: **yes, seed a `tenants` table** with `(id BIGINT PK, name VARCHAR(128), created_at, settings JSON)`. Then `tenant_id` columns can FK to it (where partitioning allows) and the upgrade story is just "add a row."

7. **Soft delete vs hard delete on `leads`.**
   SPEC §3.8 says soft delete only where lifecycle requires — `leads` qualifies. Add `deleted_at DATETIME NULL` and a partial-style `idx_tenant_list_status_modify_active` (MySQL 8 has no partial indexes, so we do `WHERE deleted_at IS NULL` in queries; index covers it via `tenant_id, list_id, status, modify_at` plus implicit row filter).

8. **`audit_log.entity_type` ENUM vs VARCHAR?**
   ENUM is faster and smaller, but adding new event types requires `ALTER TABLE`. VARCHAR is flexible. Recommendation: **VARCHAR(32)** + an enforcement constant set in app code (Zod enum). Match the philosophy of statuses being a lookup table.

9. **Read-replica strategy for Phase 1?**
   DESIGN.md §10 implies single primary at MVP. Recommendation: **single primary in Phase 1**, document the ProxySQL + replica plan in HANDOFF for Phase 2. Schema is replication-friendly (`binlog_format=ROW`, GTID on).

10. **Connection pooling: where does it live?**
    Prisma has a built-in pool (`pool_timeout`, `connection_limit` in DATABASE_URL). For Go dialer, we'll use `database/sql` SetMaxOpen. ProxySQL only enters Phase 2. **No work for F02**, but document the connection-string format.

11. **`recordings` table or just `recording_log`?**
    DESIGN.md only spec'd `recording_log`. Storage URL + metadata is enough; the file lives in S3. Confirm we don't need a separate "recording lifecycle" table.

12. **Naming: `did_numbers` vs `dids` vs `inbound_numbers`?**
    DESIGN.md says `did_numbers`. T02 needs to match. Lock the name in PLAN.

---

## 9. Citations

[1] Oracle, "What Is New in MySQL 8.4 since MySQL 8.0," MySQL 8.4 Reference Manual, 2026. https://docs.oracle.com/cd/E17952_01/mysql-8.4-en/mysql-nutshell.html

[2] Percona, "Breaking and incompatible changes in 8.4 — Percona Server for MySQL." https://www.percona.com/doc/percona-server/8.0/security/8.4-breaking-changes.html

[3] D. Endress, "Comparison: Percona Server for MySQL 8.4.2 vs 8.0.40," Percona, Mar. 2025. https://www.percona.com/blog/percona-server-for-mysql-8-4-2-vs-8-0-40-comparison-of-variables-and-keywords/

[4] Y. Trudeau & F. Bordenave, "Tuning MySQL/InnoDB Flushing for a Write-Intensive Workload," Percona, May 2020. https://www.percona.com/blog/tuning-mysql-innodb-flushing-for-a-write-intensive-workload/

[5] Oracle, "10.5.2 Optimizing InnoDB Transaction Management," MySQL 8.4 Reference Manual. https://docs.oracle.com/cd/E17952_01/mysql-8.4-en/optimizing-innodb-transaction-management.html

[6] N. Dhandala, "How to Configure innodb_flush_log_at_trx_commit in MySQL," OneUptime, Mar. 2026. https://oneuptime.com/blog/post/2026-03-31-mysql-innodb-flush-log-at-trx-commit/view

[7] W. Leutwyler, "InnoDB Buffer Pool Tuning: From Rule-of-Thumb to Real Signals," Percona Community, Apr. 2026. https://percona.community/blog/2026/04/02/innodb-buffer-pool-tuning-from-rule-of-thumb-to-real-signals/

[8] ScaleGrid, "MySQL InnoDB_Buffer_Pool_Size Configuration," 2026. https://scalegrid.io/blog/calculating-innodb-buffer-pool-size-for-your-mysql-server/

[9] Oracle, "17.5.1 Buffer Pool," MySQL 8.4 Reference Manual. https://dev.mysql.com/doc/refman/en/innodb-buffer-pool.html

[10] Oracle, "26.2.1 RANGE Partitioning," MySQL 8.4 Reference Manual. https://dev.mysql.com/doc/refman/en/partitioning-range.html

[11] Oracle, "26.3.1 Management of RANGE and LIST Partitions," MySQL 8.4 Reference Manual. https://dev.mysql.com/doc/refman/en/partitioning-management-range-list.html

[12] AWS, "Archiving data in partitioned tables," AWS Prescriptive Guidance, 2022. https://docs.aws.amazon.com/prescriptive-guidance/latest/archiving-mysql-data/archive-partitioned-tables.html

[13] Percona, "pt-archiver — Percona Toolkit Documentation." https://www.percona.com/doc/percona-toolkit/LATEST/pt-archiver.html

[14] Oracle, "15.1.20.5 FOREIGN KEY Constraints," MySQL 8.4 Reference Manual. https://dev.mysql.com/doc/en/create-table-foreign-keys.html

[15] Oracle, "26.6 Restrictions and Limitations on Partitioning," MySQL 8.0 Reference Manual. https://docs.oracle.com/cd/E17952_01/mysql-8.0-en/partitioning-limitations.html

[16] Oracle, "26.6.2 Partitioning Limitations Relating to Storage Engines," MySQL 8.4 Reference Manual. https://dev.mysql.com/doc/en/partitioning-limitations-storage-engines.html

[17] ZTABS, "MySQL for Multi-Tenant SaaS Databases Development," 2026. https://ztabs.co/technologies/mysql-for-multi-tenant-saas-databases

[18] A. Ramesh, "Multi-Tenant SaaS Architecture: Row-Level Security vs. Schema-Per-Tenant," Hunchbite, Mar. 2026. https://hunchbite.com/guides/multi-tenant-saas-architecture

[19] OneUptime, "How to Design a Multi-Tenant Data Isolation Strategy on Azure SQL Database," Feb. 2026. https://oneuptime.com/blog/post/2026-02-16-how-to-design-a-multi-tenant-data-isolation-strategy-on-azure-sql-database-using-row-level-security/view

[20] Oracle, "13.2.6 Fractional Seconds in Time Values," MySQL 9.7 Reference Manual. https://dev.mysql.com/doc/refman/9.7/en/fractional-seconds.html

[21] Oracle, "13.2.2 The DATE, DATETIME, and TIMESTAMP Types," MySQL 8.4 Reference Manual. https://dev.mysql.com/doc/en/datetime.html

[22] OneUptime, "MySQL DATETIME vs TIMESTAMP: Which to Use," Mar. 2026. https://oneuptime.com/blog/post/2026-03-31-mysql-datetime-vs-timestamp-which-to-use/view

[23] Y. Trudeau, "UUIDs are Popular but Bad for Performance — Let's Discuss," Percona, Nov. 2019. https://www.percona.com/blog/uuids-are-popular-but-bad-for-performance-lets-discuss

[24] A. Rao, "Stop Using UUIDv4 as Your Primary Key — A Deep-Dive on Insert Speed, Index Bloat & Better Alternatives," Beyond The Semicolon, Jul. 2025. https://www.beyondthesemicolon.com/stop-using-uuidv4-as-your-primary-key-a-deep-dive-on-insert-speed-index-bloat-better-alternatives/

[25] THEJORD Team, "UUID vs Auto-Increment: Which to Choose," Jan. 2026. https://thejord.it/en/blog/uuid-vs-autoincrement-which-to-choose

[26] ViciStack, "VICIdial MySQL Optimization: Queries, Indexes & Tuning," Mar. 2026. https://vicistack.com/blog/vicidial-mysql-optimization/

[27] inktel/Vicidial, "extras/MySQL_AST_CREATE_tables.sql," GitHub. https://github.com/inktel/Vicidial/blob/master/extras/MySQL_AST_CREATE_tables.sql

[28] ViciWiki, "Vicidial Database Structure." http://viciwiki.com/index.php/Vicidial_Database_Structure

[29] VoIPmonitor, "High-Performance VoIPmonitor and MySQL Setup Manual." https://www.voipmonitor.org/doc/High-Performance_VoIPmonitor_and_MySQL_Setup_Manual

[30] ProxySQL, "How to Configure ProxySQL for MySQL for the First Time." https://proxysql.com/documentation/proxysql-configuration

[31] ProxySQL Blog, "MySQL read/write split with ProxySQL." https://proxysql.com/blog/configure-read-write-split/

[32] Codelit, "Database Migration Tools Compared: Flyway, Liquibase, Prisma Migrate, Atlas & goose," Mar. 2026. https://codelit.io/blog/database-migration-tools-comparison

[33] Prisma, "MySQL database connector." https://www.prisma.io/docs/v6/orm/overview/databases/mysql

[34] Prisma, "Prisma Migrate: Database, Schema, SQL Migration Tool." https://www.prisma.io/docs/guides/migrate/developing-with-prisma-migrate

[35] Prisma, "Advanced Database Schema Management with Atlas & Prisma ORM," Dec. 2024. https://prisma.io/blog/advanced-database-schema-management-with-atlas-and-prisma-orm

[36] Atlas, "Why use Atlas with your ORM?" https://atlasgo.io/orms/why-atlas-for-your-orm

[37] M. Mackintosh, "Managing Your Database Migrations and Seeds in Go," Jan. 2023. https://www.mikemackintosh.com/managing-your-database-migrations-and-seeds-in-go/

[38] C. Tutte, "Using Referential Constraints with Partitioned Tables in InnoDB," Percona, Dec. 2019. https://www.percona.com/blog/using-referential-constraints-with-partitioned-tables-in-innodb/

[39] Prisma, "Indexes (Prisma Schema docs)." https://prisma.io/docs/orm/prisma-schema/data-model/indexes

[40] Prisma, "Working with Json fields." https://www.prisma.io/docs/orm/prisma-client/special-fields-and-types/working-with-json-fields

[41] Prisma GitHub Issue #1708, "Table Partitioning." https://github.com/prisma/prisma/issues/1708

[42] ViciStack, "VICIdial DNC List Management: Federal, State & Internal," Mar. 2026. https://vicistack.com/blog/vicidial-dnc-management/

[43] ViciStack, "VICIdial Database Maintenance," Mar. 2026. https://vicistack.com/blog/vicidial-database-maintenance/

---

**Status:** RESEARCH complete. STOP. Do not proceed to PLAN until F01 (Docker Compose with MySQL service) PLAN is approved by the orchestrator.
