# F02 — MySQL 8 Schema + Migrations — PLAN

**Module:** F02 (Foundation, Phase 1)
**Author:** F02 PLAN sub-agent
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 43 citations behind every choice.

This plan is the implementation contract for the Phase-1 MySQL 8 schema. Once
approved, the public interface (table/column names, types, indexes,
partitioning grain, FK presence, seed contents) is FROZEN. Internal
migration ordering, raw-SQL phrasing, and seed-script structure can change
without RFC.

---

## 0. TL;DR (10 bullets)

1. **MySQL 8.0.40 in Phase 1, 8.4 LTS as the Phase 2 upgrade target.** Schema is
   8.4-compatible from day 1 (no MyISAM/MEMORY engines, no `TO_DAYS()` in DDL,
   no removed variables in `my.cnf`, no `mysql_native_password` users).
2. **Prisma Migrate is the only DDL tool** (per F02.md + SPEC §3.8). Migrations
   are committed, hand-edited where Prisma cannot express partitioning /
   `WITHOUT ROWID` / triggers. Atlas added in Phase 2 as a CI lint complement.
3. **Five tables are partitioned** by `RANGE COLUMNS(<datetime>)` monthly:
   `call_log`, `agent_log`, `recording_log`, `drop_log`, `audit_log`. Pre-create
   +3 months. C04 owns the rotation. **No FKs** on those tables (MySQL hard
   restriction); application + nightly reconciler enforce referential integrity.
4. **`tenant_id BIGINT NOT NULL DEFAULT 1` on every table.** Every composite
   index leads with `tenant_id`. A CI integration test (`migration.test.ts`)
   greps `information_schema.STATISTICS` and fails if any composite index on a
   tenant-scoped table starts with anything else. `phone_codes` is the only
   exception (global NANP reference data).
5. **`DATETIME(6)` for high-volume logs**, `DATETIME` (sec precision) for
   business rows, **never `TIMESTAMP`** (2038 + session-tz foot-gun).
   Server runs `default_time_zone='+00:00'`, all timestamps stored UTC.
6. **`BIGINT AUTO_INCREMENT` PKs** on every hot-write table; FreeSWITCH
   `uuid VARCHAR(40)` is a *secondary* unique index. UUIDv4 is never a PK.
7. **15 open questions resolved (12 from RESEARCH + 3 surfaced during PLAN);
   zero RFCs filed.** Notable commitments: compound `(tenant_id, id)` PK on
   `campaigns`; `down.sql` files for dev/test only; `leads.custom_data JSON`
   for Phase 1 with documented escape hatch; `tenants` table seeded with
   `id=1` row; encryption columns are `VARBINARY(512)` with a side-car
   `_kek_version SMALLINT` per encrypted column.
8. **Seed data:** 1 tenant (id=1, "default"), Vicidial-equivalent statuses
   (NEW, CALLBK, A, B, AA, AB, AL, ADC, NA, N, NI, SALE, DNC, DROP, XFER, AVMA,
   etc.), 7 pause codes, 1 default `call_times` row (09:00–21:00 with state
   overrides for WA/LA/MS), 800+ NANP `phone_codes`, and one super-admin
   user whose initial password is read from `VICI2_BOOTSTRAP_ADMIN_PASSWORD`
   env (no hard-coded creds; bootstrap fails loudly if env missing).
9. **Connection pooling:** Prisma `connection_limit=20` per Node process
   (api: 1 process; workers: 4 jobs × 5 = 20); Go dialer
   `database/sql` `SetMaxOpenConns=25`, `SetMaxIdleConns=10`,
   `SetConnMaxLifetime=5m`. With api(1) + workers(4) + dialer(1) on a
   dev box the steady ceiling is ~85 connections; `max_connections=500` in
   `my.cnf` leaves >5× headroom.
10. **Test discipline:** integration tests against a real MySQL container
    (matching F01's `mysql:8.0.40` service); per-test reset via dependency-
    ordered `TRUNCATE` with FK checks off; factory helpers in
    `api/test/factories/`; partitioning verified by `EXPLAIN PARTITIONS`
    smoke. Coverage target ≥ 70% on schema-touching code (factories +
    `lib/db.ts` + Prisma middleware).

---

## 1. Engine and version

| Item | Phase 1 | Phase 2 | Notes |
|---|---|---|---|
| Server | **MySQL 8.0.40** (community) | **MySQL 8.4.x LTS** | F01 pins `mysql:8.0.40` image. CI runs schema integration tests on both. [RESEARCH §2.1] |
| Storage engine | **InnoDB only** | InnoDB only | No MyISAM, no MEMORY, no Aria — Redis owns live state per SPEC §4.2. |
| Authentication plugin | `caching_sha2_password` | (default in 8.4) | Forces 8.4 cutover to be a binary swap. Compose flag in F01 already sets this. |
| Charset / collation | `utf8mb4` / `utf8mb4_0900_ai_ci` | same | Matches Prisma's MySQL provider defaults. |
| Replication | single primary | single primary + read replica | Schema is replication-friendly: `binlog_format=ROW`, GTID on. |

**Acceptable Percona swap.** Production deployments may use Percona Server for
MySQL 8.0.x as a drop-in. CI pins community 8.0.40 to keep us honest about
upstream behavior. Document in HANDOFF.

---

## 2. `my.cnf` baseline

Two presets. F01's compose currently passes minimal flags; F02 IMPLEMENT will
ship `mysql/conf.d/vici2.cnf` as a bind-mounted file picked up by the
`mysql:8.0.40` image (`-v ./mysql/conf.d:/etc/mysql/conf.d:ro`). PLAN
requests F01 add the bind mount (one-line compose change; non-controversial).

### 2.1 Phase 1 preset — 24 GB RAM dev/MVP box (matches DESIGN.md §10 sizing)

```ini
# /etc/mysql/conf.d/vici2.cnf
[mysqld]
# --- Engine + identity ---
default_storage_engine            = InnoDB
default_authentication_plugin     = caching_sha2_password
character_set_server              = utf8mb4
collation_server                  = utf8mb4_0900_ai_ci
default_time_zone                 = '+00:00'
sql_mode = 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION,NO_ZERO_DATE,NO_ZERO_IN_DATE,ERROR_FOR_DIVISION_BY_ZERO'

# --- Memory ---
innodb_buffer_pool_size           = 16G       # ~70% of 24 GB
innodb_buffer_pool_instances      = 8
innodb_buffer_pool_chunk_size     = 128M
innodb_dedicated_server           = OFF

# --- Redo log ---
innodb_redo_log_capacity          = 4G        # 8.0.30+ replaces innodb_log_file_size

# --- Durability (NOT NEGOTIABLE — telephony writes are TCPA evidence) ---
innodb_flush_log_at_trx_commit    = 1
sync_binlog                       = 1
innodb_flush_method               = O_DIRECT
innodb_doublewrite                = ON

# --- I/O (cloud NVMe baseline) ---
innodb_io_capacity                = 8000
innodb_io_capacity_max            = 16000
innodb_read_io_threads            = 8
innodb_write_io_threads           = 8

# --- Concurrency ---
innodb_thread_concurrency         = 0
innodb_purge_threads              = 4
innodb_adaptive_hash_index        = ON
innodb_adaptive_hash_index_parts  = 8

# --- Replication / binlog ---
log_bin                           = mysql-bin
binlog_format                     = ROW
binlog_row_image                  = MINIMAL
binlog_expire_logs_seconds        = 604800   # 7 days; do NOT use expire_logs_days (removed in 8.4)
gtid_mode                         = ON
enforce_gtid_consistency          = ON

# --- Connections ---
max_connections                   = 500      # see §10 pool budget
thread_cache_size                 = 100
table_open_cache                  = 4000

# --- Slow query log ---
slow_query_log                    = ON
long_query_time                   = 0.5
log_queries_not_using_indexes     = ON

# --- Misc safety ---
local_infile                      = OFF      # blocks `LOAD DATA LOCAL INFILE` exfil
```

### 2.2 Phase 2 preset — 64 GB RAM production box

Diff from §2.1:

```ini
innodb_buffer_pool_size           = 48G      # ~75% of 64 GB
innodb_buffer_pool_instances      = 16
innodb_redo_log_capacity          = 8G
innodb_io_capacity                = 12000
innodb_io_capacity_max            = 24000
max_connections                   = 1000     # 200 agents × ~3 + workers + ProxySQL pool
table_open_cache                  = 8000
```

**Justification of `=1` despite 5–10× short-OLTP penalty:** every hot-path
write that matters (call events, dispositions, DNC inserts, audit_log) is
batched in the writer (Go dialer multi-row INSERT every ~100 ms; api groups
disposition writes inside one transaction). Amortised across 50–500 rows per
commit, the durability tax collapses to <2×. The compliance cost of `=2`
(losing the trailing second on OS crash) is not worth that. [RESEARCH §2.2]

---

## 3. Prisma schema overview

Source of truth: `api/prisma/schema.prisma`. Generated client consumed by
`api/`, `workers/`, and re-exported through `shared/types/` for typed query
helpers. Section 4 lists every model. Mechanical conventions:

- **PK type:** `BigInt @id @default(autoincrement())` (maps to `BIGINT NOT NULL AUTO_INCREMENT`).
- **Tenant column:** `tenantId BigInt @default(1) @map("tenant_id")` everywhere except `phone_codes`.
- **Timestamps:** `createdAt DateTime @default(now()) @map("created_at") @db.DateTime(6)` and `updatedAt DateTime @updatedAt @map("updated_at") @db.DateTime(6)`. The `(6)` precision is global — uniform behavior across reports + CDR-style queries.
- **External UUIDs:** `uuid String @db.VarChar(40)` plus `@@unique([uuid, <partition_col>])` on partitioned tables (partition column must appear in every unique key) and `@@unique([uuid])` on non-partitioned tables.
- **JSON columns:** `Json` (Prisma type) → `JSON` (MySQL native). Validated via Zod schemas in app code (`shared/types/`).
- **Enum strategy:** Prisma `enum` for fixed business enums (`UserRole`, `Direction`, `DialMethod`, `RecordingMode`, `AmdResult`, `CallbackStatus`, `DropReason`, `DncSource`, `RouteKind`, `RingStrategy`, `IngroupOverflowAction`, `Gender`, `PauseCodesRequired`); `VARCHAR(N)` lookup-table for things that grow (statuses, pause_codes, audit_log.entity_type).
- **`@@map` and `@map`** consistently used: snake_case in DB, camelCase in Prisma.
- **No DB-level `ON UPDATE CURRENT_TIMESTAMP`** for `updated_at` — Prisma's `@updatedAt` writes the value on every Prisma update, which is what we want (DB-level `ON UPDATE` would also fire on raw SQL; we accept Prisma-only).

### 3.1 Migration files

Per F02.md, one migration per logical group, in this order (each Prisma's
default filename `YYYYMMDDHHMMSS_<desc>`):

```
20260506100000_init_tenants/                    # tenants
20260506100100_init_auth/                       # users, user_groups, sip_credentials, settings
20260506100200_init_carriers/                   # carriers, gateways, did_numbers
20260506100300_init_campaigns/                  # campaigns, lists, campaign_lists, statuses, pause_codes, scripts, call_times
20260506100400_init_leads/                      # leads, dispositions, hopper_mirror
20260506100500_init_dnc_callbacks/              # dnc, callbacks, phone_codes
20260506100600_init_inbound/                    # ingroups, ingroup_agents, ivr_trees, recordings (lifecycle table — see §4.18)
20260506100700_init_logs_partitioned/           # call_log, agent_log, recording_log, drop_log, audit_log (RAW SQL)
20260506100800_init_indexes_extra/              # any composite index Prisma can't express cleanly
20260506100900_init_seed_constraints/           # CHECK constraints, INSERT-only grants for audit_log
```

Each migration has a sibling `migration.down.sql` (dev/test only — see §12).

### 3.2 How Prisma + raw partition DDL co-exist

Per RESEARCH §3 and Prisma issue #1708, Prisma's schema language cannot
express `PARTITION BY`. We use the standard pattern:

1. Declare the model in `schema.prisma` with all columns, types, indexes,
   and `/// @@ignored` notes for FKs that don't apply (Prisma still generates
   the relation type for client codegen, but skips the DB-level constraint).
2. `prisma migrate dev --create-only --name init_logs_partitioned` to
   generate the SQL.
3. Hand-edit the resulting `migration.sql`: drop Prisma's `CREATE TABLE`,
   replace with our partitioned `CREATE TABLE`, drop any `FOREIGN KEY` lines
   Prisma added.
4. Commit. CI runs `prisma migrate deploy` on a fresh DB to verify. The
   `migration.test.ts` introspection asserts the partition layout matches.

---

## 4. Models — every Phase 1 table

Names in `code` are MySQL identifiers. Prisma model name is the PascalCase form. Every table has the conventions in §3 unless explicitly noted.

### 4.1 `tenants` — multi-tenant root (NEW; resolves Q6)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | Phase 1 single row id=1 seeded |
| `tenant_id` | (n/a — this IS the tenant) | This table has no `tenant_id` column |
| `name` | `VARCHAR(128) NOT NULL` | "default" in Phase 1 |
| `slug` | `VARCHAR(64) NOT NULL UNIQUE` | URL-safe identifier; "default" |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `settings` | `JSON NOT NULL` | `{}` in Phase 1; Phase 4 holds per-tenant overrides |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** PK only.
**FKs into:** none.

### 4.2 `users`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` ON DELETE RESTRICT |
| `username` | `VARCHAR(64) NOT NULL` | UNIQUE per tenant |
| `email` | `VARCHAR(128) NULL` | UNIQUE per tenant when not null |
| `password_hash` | `VARCHAR(128) NOT NULL` | Argon2id; F05 owns the hashing scheme |
| `full_name` | `VARCHAR(128) NULL` | |
| `role` | `ENUM('agent','supervisor','admin','superadmin') NOT NULL` | |
| `user_group_id` | `BIGINT NULL` | FK → `user_groups.id` |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `hotkeys_active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `last_login_at` | `DATETIME(6) NULL` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:**
- `UNIQUE (tenant_id, username)` — Phase 4 multi-tenant lets two tenants share `agent01`.
- `UNIQUE (tenant_id, email)` — same.
- `INDEX (tenant_id, user_group_id)` — group lookups.
- `INDEX (tenant_id, role, active)` — admin filters.

**Note:** `sip_password` from DESIGN.md §5.1 moves to its own table
`sip_credentials` (4.4) so we can rotate keys + version per credential. F05
will reference both. This is a refinement, not a contract break — DESIGN
already mentioned envelope encryption.

### 4.3 `user_groups`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `name` | `VARCHAR(64) NOT NULL` | UNIQUE per tenant |
| `allowed_campaigns` | `JSON NOT NULL DEFAULT (JSON_ARRAY())` | `["SOLAR_Q2","HEAT_Q3"]` |
| `allowed_ingroups` | `JSON NOT NULL DEFAULT (JSON_ARRAY())` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `UNIQUE (tenant_id, name)`.

### 4.4 `sip_credentials` — encrypted SIP creds (split out from `users`)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `user_id` | `BIGINT NOT NULL` | FK → `users.id` ON DELETE CASCADE |
| `sip_username` | `VARCHAR(64) NOT NULL` | typically equals `users.username` but separate so we can rotate |
| `sip_password_ct` | `VARBINARY(512) NOT NULL` | envelope-encrypted ciphertext |
| `kek_version` | `SMALLINT NOT NULL DEFAULT 1` | per-row KEK version (resolves Q5) |
| `last_rotated_at` | `DATETIME(6) NULL` | |
| `revoked_at` | `DATETIME(6) NULL` | soft-revoke; F05 enforces |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:**
- `UNIQUE (tenant_id, sip_username)`
- `INDEX (tenant_id, user_id, kek_version)` — bulk re-encryption pass during key rotation.

### 4.5 `audit_log` — partitioned, append-only

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT NOT NULL AUTO_INCREMENT` | part of composite PK |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | no FK (partitioned table) |
| `actor_user_id` | `BIGINT NULL` | NULL = system action |
| `actor_kind` | `ENUM('user','system','worker','external_api') NOT NULL DEFAULT 'user'` | |
| `action` | `VARCHAR(64) NOT NULL` | `lead.disposition`, `dnc.add`, `campaign.update`, etc. (resolves Q8: VARCHAR not ENUM) |
| `entity_type` | `VARCHAR(32) NOT NULL` | `lead`, `dnc`, `campaign`, … (Zod enum in app) |
| `entity_id` | `VARCHAR(64) NULL` | string to fit BIGINT or VARCHAR(32) campaign IDs |
| `before_json` | `JSON NULL` | snapshot before mutation |
| `after_json` | `JSON NULL` | snapshot after mutation |
| `request_id` | `VARCHAR(64) NULL` | trace correlation |
| `ip_address` | `VARCHAR(45) NULL` | IPv6-capable |
| `user_agent` | `VARCHAR(255) NULL` | |
| `ts` | `DATETIME(6) NOT NULL` | event time; partition column |
| `created_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | DB write time |
| `updated_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | (kept for schema uniformity; never updated — INSERT-only grant blocks it) |

**Composite PK:** `(id, ts)` (partition column required in PK).
**Indexes:**
- `INDEX (tenant_id, actor_user_id, ts)`
- `INDEX (tenant_id, entity_type, entity_id, ts)`
- `INDEX (tenant_id, action, ts)`

**Partitioning:** `RANGE COLUMNS(ts)` monthly, +3 months pre-created, retention 7 years (TCPA).

**Immutability mechanism (resolves part of C03 hand-off):**
- The Prisma client connects as `vici2_app`, which is GRANTed `INSERT, SELECT` on `audit_log` only — no `UPDATE`, no `DELETE`. Migration `20260506100900_init_seed_constraints/migration.sql` issues:
  ```sql
  REVOKE UPDATE, DELETE ON `vici2`.`audit_log` FROM `vici2`@`%`;
  ```
- Schema migrations run as `vici2_root` (separate user, not used by app).
- C04 partition rotation runs as `vici2_root` (DROP PARTITION is a privileged maintenance op).
- C03 IMPLEMENT will additionally write append-only S3 export. F02 only owns the in-DB grant.

### 4.6 `campaigns`

Resolves Q1: **compound PK `(tenant_id, id)`**, `id` typed `VARCHAR(32)`.

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | part of PK; FK → `tenants.id` |
| `id` | `VARCHAR(32) NOT NULL` | per-tenant identifier, e.g. `SOLAR_Q2` |
| `name` | `VARCHAR(128) NOT NULL` | |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `dial_method` | `ENUM('MANUAL','RATIO','PROGRESSIVE','ADAPT_HARD','ADAPT_AVG','ADAPT_TAPERED') NOT NULL DEFAULT 'MANUAL'` | |
| `auto_dial_level` | `DECIMAL(4,2) NOT NULL DEFAULT 0.00` | |
| `adaptive_max_level` | `DECIMAL(4,2) NOT NULL DEFAULT 3.00` | |
| `adaptive_drop_pct` | `DECIMAL(4,2) NOT NULL DEFAULT 1.50` | safer than Vicidial's 3.00 |
| `dial_timeout_sec` | `SMALLINT NOT NULL DEFAULT 22` | |
| `wrapup_seconds` | `SMALLINT NOT NULL DEFAULT 10` | |
| `next_agent_call` | `ENUM('longest_wait','random','fewest_calls','rank') NOT NULL DEFAULT 'longest_wait'` | |
| `available_only_tally` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `hopper_size_target` | `INT NOT NULL DEFAULT 0` | 0 = auto |
| `hopper_multiplier` | `DECIMAL(3,1) NOT NULL DEFAULT 2.0` | |
| `caller_id_carrier_id` | `BIGINT NULL` | FK → `carriers.id` |
| `caller_id_override` | `VARCHAR(16) NULL` | E.164 |
| `recording_mode` | `ENUM('NEVER','ONDEMAND','ALL','ALLFORCE') NOT NULL DEFAULT 'ALL'` | |
| `amd_enabled` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `amd_action` | `ENUM('drop','vmdrop','agent') NOT NULL DEFAULT 'drop'` | |
| `vmdrop_audio` | `VARCHAR(255) NULL` | |
| `safe_harbor_audio` | `VARCHAR(255) NULL` | |
| `script_id` | `BIGINT NULL` | FK → `scripts.id` |
| `webform_url` | `VARCHAR(512) NULL` | |
| `dial_status_filter` | `JSON NOT NULL DEFAULT (JSON_ARRAY('NEW','NA','B','CALLBK'))` | |
| `call_time_id` | `BIGINT NULL` | FK → `call_times.id` |
| `use_internal_dnc` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `use_federal_dnc` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `use_state_dnc` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `pause_codes_required` | `ENUM('OFF','OPTIONAL','FORCE') NOT NULL DEFAULT 'OPTIONAL'` | |
| `hot_keys_active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `closer_ingroups` | `JSON NOT NULL DEFAULT (JSON_ARRAY())` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**PK:** `(tenant_id, id)`.
**Indexes:** `INDEX (tenant_id, active, dial_method)` for admin dashboards.
**FK incoming:** `lists` (via `campaign_lists`), `statuses`, `pause_codes`, `dispositions`, `callbacks`, `ingroups.closer_only` references, `did_numbers.route_kind=ingroup`, `scripts`. All compound `(tenant_id, campaign_id)`.

### 4.7 `lists`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `name` | `VARCHAR(128) NOT NULL` | |
| `description` | `TEXT NULL` | |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `reset_time` | `TIME NULL` | |
| `expiration` | `DATE NULL` | |
| `source` | `VARCHAR(64) NULL` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `UNIQUE (tenant_id, name)`, `INDEX (tenant_id, active)`.

### 4.8 `campaign_lists` — m2m

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | part of PK |
| `campaign_id` | `VARCHAR(32) NOT NULL` | FK compound `(tenant_id, campaign_id)` → `campaigns(tenant_id, id)` |
| `list_id` | `BIGINT NOT NULL` | FK → `lists.id` |
| `priority` | `SMALLINT NOT NULL DEFAULT 0` | |
| `created_at` | `DATETIME(6)` | |

**PK:** `(tenant_id, campaign_id, list_id)`.
**Indexes:** `INDEX (tenant_id, list_id)` for reverse lookup.

### 4.9 `statuses` — per-campaign disposition lookup

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | part of PK |
| `campaign_id` | `VARCHAR(32) NOT NULL` | part of PK; NULL means "system default" — but MySQL forbids NULL in PK, so we use the literal string `'__SYS__'` (32-char-fits) as the global-default sentinel. |
| `status` | `VARCHAR(8) NOT NULL` | `NEW`, `SALE`, `NA`, `B`, `DNC`, … |
| `description` | `VARCHAR(128) NOT NULL DEFAULT ''` | |
| `selectable` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `human_answered` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `sale` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `dnc` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `callback` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `not_interested` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `hotkey` | `CHAR(1) NULL` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**PK:** `(tenant_id, campaign_id, status)`.
**FK:** `(tenant_id, campaign_id)` → `campaigns(tenant_id, id)` ON DELETE CASCADE — only when campaign_id != '__SYS__'. Enforced by app + a CHECK in §4.21.
**Note:** D04 will model "dispositions" separately (see §4.20) — `statuses` is the small per-campaign vocabulary; `dispositions` is the per-call event log.

### 4.10 `pause_codes`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `campaign_id` | `VARCHAR(32) NULL` | NULL = global; FK to `campaigns(tenant_id, id)` when not null |
| `code` | `VARCHAR(16) NOT NULL` | |
| `name` | `VARCHAR(64) NOT NULL` | |
| `billable` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `UNIQUE (tenant_id, IFNULL(campaign_id,'__SYS__'), code)` — MySQL 8 supports functional UNIQUE indexes.

### 4.11 `scripts`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `name` | `VARCHAR(64) NOT NULL` | |
| `body` | `MEDIUMTEXT NOT NULL` | HTML w/ `{{lead.first_name}}` placeholders |
| `campaign_id` | `VARCHAR(32) NULL` | FK to `campaigns(tenant_id, id)` |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `INDEX (tenant_id, campaign_id)`.

### 4.12 `call_times`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `name` | `VARCHAR(64) NOT NULL` | |
| `default_start` | `TIME NOT NULL DEFAULT '09:00:00'` | |
| `default_end` | `TIME NOT NULL DEFAULT '21:00:00'` | |
| `state_overrides` | `JSON NOT NULL DEFAULT (JSON_OBJECT())` | `{"WA":["08:00","20:00"], …}` |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `UNIQUE (tenant_id, name)`.

### 4.13 `leads` — the heart

Resolves Q3 (custom_data JSON) and Q7 (soft delete).

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `list_id` | `BIGINT NOT NULL` | FK → `lists.id` ON DELETE RESTRICT |
| `status` | `VARCHAR(8) NOT NULL DEFAULT 'NEW'` | |
| `vendor_lead_code` | `VARCHAR(64) NULL` | |
| `source_id` | `VARCHAR(64) NULL` | |
| `phone_e164` | `VARCHAR(16) NOT NULL` | E.164 normalized at ingress |
| `phone_alt` | `VARCHAR(16) NULL` | |
| `phone_alt2` | `VARCHAR(16) NULL` | |
| `country_code` | `CHAR(2) NOT NULL DEFAULT 'US'` | |
| `title` | `VARCHAR(8) NULL` | |
| `first_name` | `VARCHAR(64) NULL` | |
| `middle_initial` | `VARCHAR(4) NULL` | |
| `last_name` | `VARCHAR(64) NULL` | |
| `address1` | `VARCHAR(128) NULL` | |
| `address2` | `VARCHAR(128) NULL` | |
| `city` | `VARCHAR(64) NULL` | |
| `state` | `CHAR(2) NULL` | for TCPA state-DNC + state-call-time overrides (C01) |
| `postal_code` | `VARCHAR(16) NULL` | |
| `email` | `VARCHAR(128) NULL` | |
| `date_of_birth` | `DATE NULL` | |
| `gender` | `ENUM('M','F','U') NOT NULL DEFAULT 'U'` | |
| `comments` | `TEXT NULL` | |
| `rank` | `INT NOT NULL DEFAULT 0` | priority bias |
| `owner_user_id` | `BIGINT NULL` | FK → `users.id` for owner-dialing |
| `custom_data` | `JSON NOT NULL DEFAULT (JSON_OBJECT())` | per-list arbitrary fields; Zod-validated at app ingress |
| `called_count` | `INT NOT NULL DEFAULT 0` | |
| `last_called_at` | `DATETIME(6) NULL` | |
| `last_local_call_time` | `TIME NULL` | for "wait N hours since last call" gates |
| `tz_offset_min` | `SMALLINT NULL` | minutes from UTC, signed; D03 fills |
| `known_timezone` | `VARCHAR(40) NULL` | IANA name (`America/New_York`) for C01 TCPA gate |
| `deleted_at` | `DATETIME(6) NULL` | soft-delete; resolves Q7 |
| `entry_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | |
| `modify_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | hopper-filler ordering key; updated by app on every mutation (NOT a DB-level ON UPDATE — Prisma writes it) |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:**
- `INDEX idx_t_list_status_modify (tenant_id, list_id, status, modify_at)` — primary hopper-filler scan (E01)
- `INDEX idx_t_phone (tenant_id, phone_e164)` — dedup, inbound match, manual dial
- `INDEX idx_t_status_modify (tenant_id, status, modify_at)` — cross-list status reports
- `INDEX idx_t_owner_status (tenant_id, owner_user_id, status)` — owner-dialing
- `INDEX idx_t_called_count (tenant_id, called_count)` — recycle filters
- `INDEX idx_t_state (tenant_id, state)` — state-DNC join, state-call-time gate
- `INDEX idx_t_postal (tenant_id, postal_code)` — postal-based TZ resolver
- `INDEX idx_t_vendor (tenant_id, vendor_lead_code)` — external CRM lookup
- `INDEX idx_t_deleted (tenant_id, deleted_at)` — soft-delete sweep

**Soft-delete query convention:** every Prisma query against `leads` includes `where: { deleted_at: null }` via Prisma middleware. Documented in HANDOFF for D01.

**Custom-fields escape hatch (resolves Q3):** Phase 1 uses `custom_data JSON`. If a customer needs to filter `WHERE custom.zipcode IN (...)` we add a per-tenant `lead_custom_fields` table (`lead_id, key, value, value_int, value_at`) in Phase 2 — non-breaking. Documented in HANDOFF.

### 4.14 `dnc`

Resolves Q4: PK reordered.

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | part of PK |
| `phone_e164` | `VARCHAR(16) NOT NULL` | part of PK |
| `source` | `ENUM('federal','state','internal','litigator','reassigned') NOT NULL` | part of PK |
| `state` | `CHAR(2) NOT NULL DEFAULT '__'` | part of PK; `'__'` sentinel for non-state-scoped |
| `campaign_id` | `VARCHAR(32) NOT NULL DEFAULT '__GLOBAL__'` | part of PK; `'__GLOBAL__'` sentinel for non-campaign-scoped |
| `added_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | |
| `added_by` | `BIGINT NULL` | FK → `users.id` (NULL for federal sync) |
| `expires_at` | `DATETIME(6) NULL` | NULL = permanent; some state DNCs expire |
| `notes` | `VARCHAR(255) NULL` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**PK:** `(tenant_id, phone_e164, source, state, campaign_id)`.
**Indexes:**
- `INDEX idx_phone_only (phone_e164)` — federal-scrub fast path
- `INDEX idx_t_source_added (tenant_id, source, added_at)` — sync reports

**Why sentinel strings instead of NULL in PK:** MySQL InnoDB allows NULL in
PK only via "no NULL" enforcement; cleaner to use sentinels and avoid PK
ambiguity. App layer normalizes.

### 4.15 `phone_codes` — global NANP reference

| Column | Type | Notes |
|---|---|---|
| `area_code` | `CHAR(3) PK` | 800+ NANP rows |
| `state` | `CHAR(2) NULL` | |
| `country` | `CHAR(2) NOT NULL DEFAULT 'US'` | US/CA/etc. |
| `tz_name` | `VARCHAR(40) NOT NULL` | IANA: `America/New_York` |
| `tz_offset_min` | `SMALLINT NOT NULL` | seed-time DST snapshot (rebuilt twice yearly) |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**No `tenant_id` (sole exception)** — global reference, documented in HANDOFF.
**Indexes:** `INDEX (state)`, `INDEX (tz_name)`.

### 4.16 `callbacks`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `lead_id` | `BIGINT NOT NULL` | FK → `leads.id` ON DELETE CASCADE |
| `campaign_id` | `VARCHAR(32) NOT NULL` | FK compound → `campaigns(tenant_id, id)` |
| `user_id` | `BIGINT NULL` | NULL = anyone; FK → `users.id` ON DELETE SET NULL |
| `callback_at` | `DATETIME(6) NOT NULL` | |
| `comments` | `TEXT NULL` | |
| `status` | `ENUM('LIVE','PENDING','DONE','DEAD') NOT NULL DEFAULT 'PENDING'` | |
| `created_by` | `BIGINT NULL` | FK → `users.id` |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:**
- `INDEX idx_t_status_due (tenant_id, status, callback_at)` — "what's due now" scanner (D06)
- `INDEX idx_t_user_due (tenant_id, user_id, callback_at)` — agent's own callbacks
- `INDEX idx_t_lead (tenant_id, lead_id)` — per-lead history

### 4.17 `hopper_mirror` — persistent mirror of Redis hopper for crash recovery

(NEW table; not in DESIGN.md but required for E01 crash-recovery contract.)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `campaign_id` | `VARCHAR(32) NOT NULL` | FK compound → `campaigns(tenant_id, id)` |
| `lead_id` | `BIGINT NOT NULL` | FK → `leads.id` ON DELETE CASCADE |
| `priority` | `INT NOT NULL DEFAULT 0` | |
| `scheduled_at` | `DATETIME(6) NOT NULL` | when hopper inserted (mirrors Redis ZSET score) |
| `claimed_by` | `VARCHAR(64) NULL` | dialer instance hostname when leased |
| `claimed_until` | `DATETIME(6) NULL` | corresponds to Redis `hopper:lock:{cid}:{lead_id}` TTL |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:**
- `UNIQUE (tenant_id, campaign_id, lead_id)` — one entry per (campaign, lead)
- `INDEX idx_t_campaign_scheduled (tenant_id, campaign_id, scheduled_at)` — replay order on cold-start

**Lifecycle:** E01 (hopper filler) writes to MySQL inside the same transaction
as the Redis ZADD (best-effort ordering — Redis first, MySQL within 100 ms);
on dialer crash, a recovery sweep reads `hopper_mirror` and re-populates
Redis. Rows are deleted (not soft-deleted) on dial completion. Small,
hot-write table; no partitioning needed.

### 4.18 `recordings` — recording lifecycle (resolves Q11)

After review: **we keep `recording_log` (the per-recording fact row, partitioned)
AND add a small `recordings` table for multi-segment recording reassembly +
external sharing tokens.**

`recording_log` (in §4.24) is the partitioned write log. `recordings` is the
canonical "this is the file that exists in S3" table — non-partitioned, FK-able,
holds tokens for sharable URLs.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `recording_log_id` | `BIGINT NOT NULL` | logical pointer (no FK; partitioned target) |
| `share_token` | `BINARY(16) NULL UNIQUE` | UUIDv7 for unguessable browser URL |
| `share_token_expires_at` | `DATETIME(6) NULL` | |
| `legal_hold` | `BOOLEAN NOT NULL DEFAULT FALSE` | block deletion past retention if set |
| `lifecycle_state` | `ENUM('encoding','available','archived','deleted') NOT NULL DEFAULT 'encoding'` | |
| `s3_storage_class` | `VARCHAR(32) NULL` | `STANDARD`, `GLACIER`, etc. |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `INDEX (tenant_id, lifecycle_state)`, `UNIQUE (share_token)` enforced by Prisma. No FK to `recording_log` because it is partitioned; app+reconciler enforce.

### 4.19 `dispositions` — per-call disposition event (D04 owns)

(Distinct from `statuses` lookup table.)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `call_log_id` | `BIGINT NOT NULL` | logical (partitioned target; no FK) |
| `lead_id` | `BIGINT NOT NULL` | FK → `leads.id` |
| `campaign_id` | `VARCHAR(32) NOT NULL` | FK compound → `campaigns(tenant_id, id)` |
| `user_id` | `BIGINT NULL` | FK → `users.id` |
| `status_code` | `VARCHAR(8) NOT NULL` | matches `statuses.status` |
| `comments` | `TEXT NULL` | |
| `disposed_at` | `DATETIME(6) NOT NULL` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `INDEX (tenant_id, lead_id, disposed_at)`, `INDEX (tenant_id, campaign_id, disposed_at)`.

(Not partitioned in Phase 1 — volume is one row per disposed call, much
lower than call events. Revisit if it crosses 5M rows.)

### 4.20 `carriers`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `name` | `VARCHAR(64) NOT NULL` | |
| `kind` | `ENUM('twilio','telnyx','signalwire','ringcentral','byoc') NOT NULL` | (added telnyx, signalwire — DESIGN's narrower list was illustrative) |
| `proxy` | `VARCHAR(255) NOT NULL` | sip host |
| `username_ct` | `VARBINARY(512) NULL` | encrypted (when not IP-auth) |
| `password_ct` | `VARBINARY(512) NULL` | encrypted |
| `kek_version` | `SMALLINT NOT NULL DEFAULT 1` | |
| `register` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `caller_id_e164` | `VARCHAR(16) NULL` | default outbound CID |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `ip_allowlist` | `JSON NOT NULL DEFAULT (JSON_ARRAY())` | inbound auth |
| `config_json` | `JSON NOT NULL DEFAULT (JSON_OBJECT())` | extra Sofia params |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `UNIQUE (tenant_id, name)`, `INDEX (tenant_id, active)`.

### 4.21 `gateways`

(NEW; T02 needs a separate row per Sofia gateway — a single carrier can have
N gateways for multi-region or multi-trunk.)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `carrier_id` | `BIGINT NOT NULL` | FK → `carriers.id` ON DELETE CASCADE |
| `name` | `VARCHAR(64) NOT NULL` | Sofia gateway name (unique within Sofia profile) |
| `proxy` | `VARCHAR(255) NOT NULL` | |
| `realm` | `VARCHAR(255) NULL` | |
| `from_user` | `VARCHAR(64) NULL` | |
| `from_domain` | `VARCHAR(255) NULL` | |
| `extension` | `VARCHAR(64) NULL` | |
| `register` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `expire_seconds` | `INT NOT NULL DEFAULT 3600` | |
| `retry_seconds` | `INT NOT NULL DEFAULT 30` | |
| `transport` | `ENUM('udp','tcp','tls') NOT NULL DEFAULT 'udp'` | |
| `priority` | `SMALLINT NOT NULL DEFAULT 100` | for round-robin / failover order |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `template_overrides` | `JSON NOT NULL DEFAULT (JSON_OBJECT())` | renderer hooks |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `UNIQUE (tenant_id, name)`, `INDEX (tenant_id, carrier_id, active, priority)`.

### 4.22 `did_numbers` (resolves Q12: name kept as `did_numbers`, Prisma model `DidNumber`)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `e164` | `VARCHAR(16) NOT NULL` | |
| `carrier_id` | `BIGINT NOT NULL` | FK → `carriers.id` ON DELETE RESTRICT |
| `route_kind` | `ENUM('ingroup','ivr','agent','ext','voicemail') NOT NULL` | |
| `route_target` | `VARCHAR(64) NOT NULL` | logical target id |
| `caller_id_name` | `VARCHAR(64) NULL` | |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `UNIQUE (tenant_id, e164)`, `INDEX (tenant_id, carrier_id)`, `INDEX (tenant_id, route_kind, route_target)`.

### 4.23 `ingroups`, `ingroup_agents`, `ivr_trees`

#### `ingroups` (renamed from DESIGN.md naming `ingroups`; also called `in_groups` in F02 prompt — we use `ingroups` internally with `Prisma model Ingroup`; `@@map("ingroups")` so SQL stays one word)

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | part of PK |
| `id` | `VARCHAR(32) NOT NULL` | per-tenant |
| `name` | `VARCHAR(128) NOT NULL` | |
| `music_on_hold` | `VARCHAR(128) NOT NULL DEFAULT 'default'` | |
| `max_queue` | `INT NOT NULL DEFAULT 100` | |
| `agent_wait_sec` | `INT NOT NULL DEFAULT 60` | |
| `ring_strategy` | `ENUM('ring_all','longest_idle_agent','round_robin','top_down','agent_with_least_talk_time') NOT NULL DEFAULT 'longest_idle_agent'` | |
| `priority` | `INT NOT NULL DEFAULT 50` | |
| `closer_only` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `recording_mode` | `ENUM('NEVER','ALL') NOT NULL DEFAULT 'ALL'` | |
| `no_agent_action` | `ENUM('voicemail','hangup','overflow_ingroup') NOT NULL DEFAULT 'voicemail'` | |
| `no_agent_target` | `VARCHAR(64) NULL` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**PK:** `(tenant_id, id)`.

#### `ingroup_agents`

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | part of PK |
| `ingroup_id` | `VARCHAR(32) NOT NULL` | part of PK; FK compound → `ingroups(tenant_id, id)` |
| `user_id` | `BIGINT NOT NULL` | part of PK; FK → `users.id` |
| `rank` | `INT NOT NULL DEFAULT 5` | skill / priority |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**PK:** `(tenant_id, ingroup_id, user_id)`.
**Indexes:** `INDEX (tenant_id, user_id)` for reverse "what queues is this agent on".

#### `ivr_trees` (NEW; I03 will populate detailed nodes; F02 only allocates the root table)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT PK AUTO_INCREMENT` | |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | FK → `tenants.id` |
| `name` | `VARCHAR(64) NOT NULL` | |
| `description` | `TEXT NULL` | |
| `tree_json` | `JSON NOT NULL` | full IVR node graph; Zod-validated in app |
| `active` | `BOOLEAN NOT NULL DEFAULT TRUE` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Indexes:** `UNIQUE (tenant_id, name)`.

### 4.24 `call_log` — partitioned

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT NOT NULL AUTO_INCREMENT` | part of composite PK |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | no FK |
| `uuid` | `VARCHAR(40) NOT NULL` | FreeSWITCH UUID |
| `parent_uuid` | `VARCHAR(40) NULL` | for transferred calls |
| `lead_id` | `BIGINT NULL` | logical FK |
| `campaign_id` | `VARCHAR(32) NULL` | logical FK |
| `list_id` | `BIGINT NULL` | logical FK |
| `user_id` | `BIGINT NULL` | logical FK |
| `direction` | `ENUM('out','in') NOT NULL` | |
| `phone_e164` | `VARCHAR(16) NOT NULL` | |
| `caller_id` | `VARCHAR(16) NULL` | |
| `carrier_id` | `BIGINT NULL` | logical FK |
| `gateway_id` | `BIGINT NULL` | logical FK |
| `call_started` | `DATETIME(6) NOT NULL` | partition column |
| `call_answered` | `DATETIME(6) NULL` | |
| `call_ended` | `DATETIME(6) NULL` | |
| `ring_seconds` | `INT NULL` | |
| `talk_seconds` | `INT NULL` | |
| `hold_seconds` | `INT NULL` | |
| `wrap_seconds` | `INT NULL` | |
| `status` | `VARCHAR(8) NULL` | final disposition (matches `statuses.status`) |
| `hangup_cause` | `VARCHAR(32) NULL` | |
| `amd_result` | `ENUM('none','machine','human','unknown') NOT NULL DEFAULT 'none'` | |
| `is_drop` | `BOOLEAN NOT NULL DEFAULT FALSE` | TCPA |
| `recording_id` | `BIGINT NULL` | logical FK to `recordings` |
| `created_at`, `updated_at` | `DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)` | |

**Composite PK:** `(id, call_started)`.
**Indexes:**
- `UNIQUE (uuid, call_started)`
- `INDEX (tenant_id, campaign_id, call_started)`
- `INDEX (tenant_id, lead_id, call_started)`
- `INDEX (tenant_id, user_id, call_started)`
- `INDEX (tenant_id, phone_e164, call_started)`
- `INDEX (tenant_id, status, call_started)`
- `INDEX (tenant_id, carrier_id, call_started)`

**Partitioning:** `RANGE COLUMNS(call_started)` monthly, +3 months pre-created, retention 24 months hot.

### 4.25 `agent_log` — partitioned

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT NOT NULL AUTO_INCREMENT` | part of composite PK |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | no FK |
| `user_id` | `BIGINT NOT NULL` | logical FK |
| `campaign_id` | `VARCHAR(32) NULL` | logical FK |
| `call_log_id` | `BIGINT NULL` | logical FK |
| `event_at` | `DATETIME(6) NOT NULL` | partition column |
| `event` | `ENUM('login','logout','pause','unpause','ready','call_start','call_end','dispo','transfer','hold','retrieve') NOT NULL` | |
| `pause_code` | `VARCHAR(16) NULL` | |
| `duration_sec` | `INT NULL` | |
| `metadata` | `JSON NULL` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Composite PK:** `(id, event_at)`.
**Indexes:**
- `INDEX (tenant_id, user_id, event_at)`
- `INDEX (tenant_id, campaign_id, event_at)`
- `INDEX (tenant_id, call_log_id)`

**Partitioning:** `RANGE COLUMNS(event_at)` monthly, +3 months, retention 13 months.

### 4.26 `recording_log` — partitioned

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT NOT NULL AUTO_INCREMENT` | part of composite PK |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | no FK |
| `uuid` | `VARCHAR(40) NOT NULL` | FreeSWITCH UUID |
| `call_log_id` | `BIGINT NULL` | logical FK |
| `lead_id` | `BIGINT NULL` | logical FK |
| `campaign_id` | `VARCHAR(32) NULL` | logical FK |
| `user_id` | `BIGINT NULL` | logical FK |
| `filename` | `VARCHAR(255) NOT NULL` | |
| `storage_url` | `VARCHAR(512) NULL` | `s3://bucket/path/file.mp3` |
| `start_time` | `DATETIME(6) NOT NULL` | partition column |
| `duration_sec` | `INT NULL` | |
| `size_bytes` | `BIGINT NULL` | |
| `encoded_at` | `DATETIME(6) NULL` | |
| `consent_status` | `ENUM('not_required','prompted_accepted','prompted_declined','assumed') NOT NULL DEFAULT 'not_required'` | C02 will populate |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Composite PK:** `(id, start_time)`.
**Indexes:**
- `UNIQUE (uuid, start_time)`
- `INDEX (tenant_id, lead_id, start_time)`
- `INDEX (tenant_id, campaign_id, start_time)`
- `INDEX (tenant_id, call_log_id)`
- `INDEX (tenant_id, user_id, start_time)`

**Partitioning:** `RANGE COLUMNS(start_time)` monthly, +3 months, retention 7 years.

### 4.27 `drop_log` — partitioned

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGINT NOT NULL AUTO_INCREMENT` | part of composite PK |
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | no FK |
| `call_log_id` | `BIGINT NULL` | logical FK |
| `campaign_id` | `VARCHAR(32) NOT NULL` | |
| `phone_e164` | `VARCHAR(16) NOT NULL` | |
| `dropped_at` | `DATETIME(6) NOT NULL` | partition column |
| `drop_reason` | `ENUM('no_agent','timeout','queue_full') NOT NULL` | |
| `safe_harbor_played` | `BOOLEAN NOT NULL DEFAULT FALSE` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**Composite PK:** `(id, dropped_at)`.
**Indexes:**
- `INDEX (tenant_id, campaign_id, dropped_at)`
- `INDEX (tenant_id, call_log_id)`

**Partitioning:** `RANGE COLUMNS(dropped_at)` monthly, +3 months, retention 7 years.

### 4.28 `settings`

| Column | Type | Notes |
|---|---|---|
| `tenant_id` | `BIGINT NOT NULL DEFAULT 1` | part of PK |
| `k` | `VARCHAR(64) NOT NULL` | part of PK |
| `v` | `JSON NOT NULL` | |
| `created_at`, `updated_at` | `DATETIME(6)` | |

**PK:** `(tenant_id, k)`.

---

## 5. Migration tooling

- **Tool:** Prisma Migrate. Filename convention `YYYYMMDDHHMMSS_<snake_description>` (Prisma default).
- **Local dev:** `make db-migrate` runs `prisma migrate dev`.
- **CI:** `prisma migrate deploy` against an ephemeral MySQL service. F01's compose `api-migrate` one-shot already handles this.
- **Prod:** `prisma migrate deploy` only. No `migrate dev` ever in prod.
- **Linting:** Phase 2 adds Atlas as `atlas migrate lint` over `api/prisma/migrations/` to flag dangerous patterns (DROP, missing indexes on FK columns). Not blocking in Phase 1 but specced for O04 to wire when ready.
- **Rollbacks:** see §12.

---

## 6. Partitioning strategy

| Table | Grain | Key | Pre-create | Retention | Owner of rotation |
|---|---|---|---|---|---|
| `call_log` | monthly | `RANGE COLUMNS(call_started)` | +3 months | 24 months hot, then archive | C04 |
| `agent_log` | monthly | `RANGE COLUMNS(event_at)` | +3 months | 13 months | C04 |
| `recording_log` | monthly | `RANGE COLUMNS(start_time)` | +3 months | 7 years | C04 |
| `drop_log` | monthly | `RANGE COLUMNS(dropped_at)` | +3 months | 7 years | C04 |
| `audit_log` | monthly | `RANGE COLUMNS(ts)` | +3 months | 7 years | C04 |

**Rotation procedure (contract for C04):**

1. Monthly cron + nightly safety check.
2. **Add next-month partition:** `ALTER TABLE <t> REORGANIZE PARTITION p_max INTO (PARTITION p_<yyyy>_<mm> VALUES LESS THAN ('<next-month-1st>'), PARTITION p_max VALUES LESS THAN (MAXVALUE));`
3. **Drop oldest past retention:** create archive shadow `<t>_archive_<yyyy>_<mm>` (identical schema, unpartitioned), `EXCHANGE PARTITION p_<yyyy>_<mm> WITH TABLE <t>_archive_<yyyy>_<mm>`, then `DROP PARTITION p_<yyyy>_<mm>`.
4. Optional: ship archive table to S3 / Glacier.
5. Use `pt-archiver` (Percona Toolkit) when row counts must be verified before drop.
6. Health metric: `vici2_db_partitions_total{table="..."}`.

---

## 7. FK strategy

- **Tables that drop FKs (partitioned, MySQL hard restriction):** `call_log`, `agent_log`, `recording_log`, `drop_log`, `audit_log`. Application + nightly reconciler enforce. The reconciler is a hand-off to D04 / C04: nightly LEFT-JOIN sweep flags orphans, emits `vici2_db_orphan_rows_total{table,column}` Prometheus metric, optionally inserts placeholder "deleted lead/campaign" rows to restore JOIN integrity in reports.
- **Everywhere else:** FKs ON, `ON DELETE RESTRICT` by default per SPEC §3.8. CASCADE only on:
  - `sip_credentials.user_id` (delete user → delete creds)
  - `gateways.carrier_id` (delete carrier → delete gateways)
  - `callbacks.lead_id` (delete lead → delete callbacks)
  - `hopper_mirror.lead_id` (delete lead → drop hopper entry)
  - `ingroup_agents.user_id` (delete user → drop queue memberships)

**App-layer enforcement pattern (HANDOFF to consumers):**
- Prisma's `Relation` declarations preserve type-level navigation even without a DB FK. Use `@relation(..., map: "fk_…", onDelete: ..., onUpdate: ...)` on non-partitioned tables; use `@relation(...)` without DB-level mapping (no `references:` index) on partitioned-target relations and document.
- Every write to a partitioned table validates the referenced row exists *in the same transaction* via a guarded `prisma.$transaction([…])` or a Go `Tx` block. Cheap, only happens on write.

---

## 8. Index plan — concrete `CREATE INDEX` per table

(All indexes here are also declared in `schema.prisma` via `@@index([...])` so Prisma is the source of truth; the SQL is shown for clarity. Prisma generates the `CREATE INDEX` automatically — only the partitioned-table indexes are written by hand because they live in the raw migration file.)

```sql
-- leads
CREATE INDEX idx_t_list_status_modify ON leads (tenant_id, list_id, status, modify_at);
CREATE INDEX idx_t_phone               ON leads (tenant_id, phone_e164);
CREATE INDEX idx_t_status_modify       ON leads (tenant_id, status, modify_at);
CREATE INDEX idx_t_owner_status        ON leads (tenant_id, owner_user_id, status);
CREATE INDEX idx_t_called_count        ON leads (tenant_id, called_count);
CREATE INDEX idx_t_state               ON leads (tenant_id, state);
CREATE INDEX idx_t_postal              ON leads (tenant_id, postal_code);
CREATE INDEX idx_t_vendor              ON leads (tenant_id, vendor_lead_code);
CREATE INDEX idx_t_deleted             ON leads (tenant_id, deleted_at);

-- dnc
CREATE INDEX idx_phone_only            ON dnc (phone_e164);
CREATE INDEX idx_t_source_added        ON dnc (tenant_id, source, added_at);

-- call_log (in raw migration)
KEY uk_uuid                (uuid, call_started),  -- via UNIQUE
KEY idx_t_camp_started     (tenant_id, campaign_id, call_started),
KEY idx_t_lead_started     (tenant_id, lead_id, call_started),
KEY idx_t_user_started     (tenant_id, user_id, call_started),
KEY idx_t_phone_started    (tenant_id, phone_e164, call_started),
KEY idx_t_status_started   (tenant_id, status, call_started),
KEY idx_t_carrier_started  (tenant_id, carrier_id, call_started)

-- agent_log
KEY idx_t_user_event       (tenant_id, user_id, event_at),
KEY idx_t_camp_event       (tenant_id, campaign_id, event_at),
KEY idx_t_call             (tenant_id, call_log_id)

-- recording_log
KEY uk_uuid                (uuid, start_time),
KEY idx_t_lead_started     (tenant_id, lead_id, start_time),
KEY idx_t_camp_started     (tenant_id, campaign_id, start_time),
KEY idx_t_call             (tenant_id, call_log_id),
KEY idx_t_user_started     (tenant_id, user_id, start_time)

-- drop_log
KEY idx_t_camp_dropped     (tenant_id, campaign_id, dropped_at),
KEY idx_t_call             (tenant_id, call_log_id)

-- audit_log
KEY idx_t_actor_ts         (tenant_id, actor_user_id, ts),
KEY idx_t_entity           (tenant_id, entity_type, entity_id, ts),
KEY idx_t_action_ts        (tenant_id, action, ts)

-- hopper_mirror
UNIQUE (tenant_id, campaign_id, lead_id),
KEY idx_t_camp_scheduled   (tenant_id, campaign_id, scheduled_at)

-- sip_credentials
UNIQUE (tenant_id, sip_username),
KEY idx_t_user_kek         (tenant_id, user_id, kek_version)

-- callbacks
KEY idx_t_status_due       (tenant_id, status, callback_at),
KEY idx_t_user_due         (tenant_id, user_id, callback_at),
KEY idx_t_lead             (tenant_id, lead_id)
```

---

## 9. Multi-tenant rule (PR-blocking)

> Every multi-column index whose table has a `tenant_id` column **MUST** list `tenant_id` first. Single-column indexes on `id` PK or natural-key columns are fine. `phone_codes` is the only exception.

**Enforcement script (ships with F02 IMPLEMENT under `api/test/db/multi_tenant_index.test.ts`):**

```ts
// 1) parse api/prisma/schema.prisma — confirm every @@index([...]) on a model
//    that has a tenantId field starts with tenantId.
// 2) connect to the test MySQL after migrations apply, run:
//    SELECT TABLE_NAME, INDEX_NAME,
//           GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
//    FROM information_schema.STATISTICS
//    WHERE TABLE_SCHEMA = DATABASE()
//      AND INDEX_NAME != 'PRIMARY'
//    GROUP BY TABLE_NAME, INDEX_NAME
//    HAVING (SELECT COUNT(*) FROM STATISTICS s2
//             WHERE s2.TABLE_NAME = STATISTICS.TABLE_NAME
//               AND s2.COLUMN_NAME = 'tenant_id') > 0
//       AND cols NOT LIKE 'tenant_id%'
//       AND cols NOT LIKE 'id%'
//       AND TABLE_NAME NOT IN ('phone_codes', '_prisma_migrations');
// 3) assert empty result.
```

A grep companion (CI-friendly, no DB needed) lives at `scripts/check_index_tenant_lead.sh`:

```bash
#!/usr/bin/env bash
# fails if any @@index([...]) line in schema.prisma does NOT start with tenantId
# (excluding model PhoneCode block).
set -euo pipefail
awk '
  /^model PhoneCode/ { in_pc=1 }
  /^}/                { in_pc=0 }
  !in_pc && /@@index/ {
    if (!match($0, /@@index\(\[\s*tenantId/)) {
      print FILENAME":"NR": composite index does not lead with tenantId: "$0
      bad=1
    }
  }
  END { exit bad?1:0 }
' api/prisma/schema.prisma
```

Both run in `make lint` and CI.

---

## 10. Connection pooling

| Service | Driver | Pool config | Worst-case connections |
|---|---|---|---|
| api (Node + Fastify + Prisma) | Prisma `mysql` | `?connection_limit=20&pool_timeout=10` in `DATABASE_URL` | 20 |
| workers (Node + Prisma) | Prisma `mysql` | `?connection_limit=10` × ≤5 worker processes | 50 |
| dialer (Go + go-sql-driver/mysql + sqlx) | `database/sql` | `SetMaxOpenConns=25`, `SetMaxIdleConns=10`, `SetConnMaxLifetime=5m` | 25 |
| Prisma migrate one-shot | Prisma | default 5 | 5 |
| ProxySQL (Phase 2) | external | configured at the proxy | n/a |

Phase 1 ceiling ≈ 100 connections; `max_connections=500` leaves >5× headroom.

**Connection-string format (HANDOFF):**

```
DATABASE_URL="mysql://vici2:${VICI2_DB_PASSWORD}@mysql:3306/vici2?connection_limit=20&pool_timeout=10&connect_timeout=5&socket_timeout=30"
DATABASE_DSN="vici2:${VICI2_DB_PASSWORD}@tcp(mysql:3306)/vici2?parseTime=true&loc=UTC&charset=utf8mb4&interpolateParams=true&maxAllowedPacket=67108864"
```

Note `loc=UTC` on the Go DSN — matches `default_time_zone='+00:00'` server-side.

---

## 11. Seed data

`api/prisma/seed.ts` (TypeScript, executed by `pnpm exec prisma db seed`). Idempotent — safe to re-run.

### 11.1 `tenants`

```ts
{ id: 1, name: "default", slug: "default", active: true, settings: {} }
```

### 11.2 `users` — bootstrap super-admin

Reads `VICI2_BOOTSTRAP_ADMIN_PASSWORD` from env. Fails loudly if unset.
Username `admin`, role `superadmin`, `tenant_id=1`. Password hashed with
Argon2id via shared lib (F05 will own the hashing util; seed imports a
stub that delegates to the eventual util).

After successful seed, prints:

```
[seed] super-admin created: admin / <env-supplied password>
[seed] please rotate via /admin/users after first login.
```

Writes to `.bootstrap-admin.txt` (gitignored) for ops record.

### 11.3 `phone_codes` — NANP

Source: `db/seeds/phone_codes.csv` committed to repo. Built from the public
NANPA dump + Wikipedia "List of NANP area codes" + IANA tzdata. ~800 rows
US + Canada + Caribbean. Seed batch-INSERTs in chunks of 200 rows.

Build script: `scripts/build-phone-codes.sh` (out of F02 scope but specced
here for D03 follow-up — fetches NANPA, normalises, writes CSV).

### 11.4 `statuses` — system defaults (campaign_id = `'__SYS__'`)

Vicidial-equivalent set, kept conservative:

| status | desc | selectable | human | sale | dnc | callback | not_int | hotkey |
|---|---|---|---|---|---|---|---|---|
| NEW | New lead | F | F | F | F | F | F | – |
| NEW_PENDING | Pre-loaded | F | F | F | F | F | F | – |
| NA | No answer | T | F | F | F | F | F | a |
| B | Busy | T | F | F | F | F | F | b |
| AB | Answering machine | T | F | F | F | F | F | – |
| AA | Answering machine voicemail | T | F | F | F | F | F | – |
| AL | Answering machine left | T | F | F | F | F | F | – |
| ADC | Disconnected | T | F | F | F | F | F | – |
| AVMA | AMD voicemail auto | F | F | F | F | F | F | – |
| N | No (not interested) | T | T | F | F | F | T | n |
| NI | Not interested | T | T | F | F | F | T | i |
| NP | Not in party | T | T | F | F | F | F | – |
| LB | Language barrier | T | T | F | F | F | F | – |
| WN | Wrong number | T | T | F | F | F | F | w |
| DNC | Internal DNC | T | T | F | T | F | F | d |
| DEC | Declined | T | T | F | F | F | T | – |
| CALLBK | Callback set | T | T | F | F | T | F | c |
| XFER | Transferred | T | T | F | F | F | F | – |
| SALE | Sale | T | T | T | F | F | F | s |
| DROP | Dropped (TCPA) | F | F | F | F | F | F | – |

20 default statuses. Per-campaign overrides are added by admin UI (M07) at runtime.

### 11.5 `pause_codes` — system defaults (campaign_id NULL)

| code | name | billable |
|---|---|---|
| BREAK | Break | T |
| LUNCH | Lunch | F |
| BIO | Restroom | T |
| TRAIN | Training | T |
| TECH | Tech issue | T |
| ADMIN | Admin | T |
| MEET | Meeting | T |

### 11.6 `call_times` — default 9–9 with state overrides

```ts
{
  id: 1,
  tenant_id: 1,
  name: "Default 9am-9pm with state safe overrides",
  default_start: "09:00:00",
  default_end:   "21:00:00",
  state_overrides: {
    WA: ["08:00", "20:00"],
    LA: ["08:00", "20:00"],
    MS: ["08:00", "20:00"],
  },
}
```

### 11.7 Other seeds

- `settings` — empty (modules add as needed).
- One demo carrier row is **not** seeded (operator-specific).

---

## 12. Down migrations policy

- **Prisma generates `migration.sql` (forward) only.** F02 IMPLEMENT writes a
  sibling `migration.down.sql` for each migration (manual). Convention:
  `api/prisma/migrations/<ts>_<name>/migration.down.sql`.
- **Dev / test:** `make db-migrate-down` runs the latest `migration.down.sql`
  via `mysql < ...` (helper script `scripts/db-down.sh`). Used in DR drills
  and local hacking.
- **Production:** never auto-rolls forward. Forward-fix only.
  - To "undo" a deployed migration in prod: ship a new forward migration
    that reverses the change (a new `ALTER TABLE`).
  - For app rollback: deploy previous app version with the *new* schema
    still in place (schema is forward-compatible by construction — adding
    nullable columns, adding tables, adding indexes; never renaming or
    dropping in the same release as code changes).
- **Log-table partition migrations are explicitly non-rollbackable.** Their
  `migration.down.sql` is `-- intentionally empty: partitioned table; rotate via C04`.
- **Reversibility of `audit_log`:** down only applies in dev; the
  `REVOKE UPDATE,DELETE` is reversed by the down (`GRANT UPDATE,DELETE`).

---

## 13. Hand-off interfaces

What each downstream module gets from F02:

| Module | What F02 provides | Where to look |
|---|---|---|
| **D01** (lead CRUD) | `leads` table + 9 indexes; soft-delete convention via `deleted_at`; Prisma middleware example for `tenant_id` injection in HANDOFF | §4.13 |
| **D02** (CSV import) | `leads` insert performance plan: chunked INSERT 500 rows/tx, `LOAD DATA LOCAL INFILE` disabled by `local_infile=OFF` so CSV import goes via app-layer batched INSERT; `tz_offset_min` filled by D03 hook | §4.13, §2 |
| **D03** (TZ resolver) | `phone_codes` table, seeded at boot; `leads.tz_offset_min` + `leads.known_timezone` columns. NANP source: in-repo CSV at `db/seeds/phone_codes.csv` (resolves an open question — file, not external service). | §4.15, §11.3 |
| **D04** (statuses) | `statuses` lookup + `dispositions` event table + system defaults seeded. | §4.9, §4.19 |
| **D05** (DNC) | `dnc` table with PK reordered for hot-path scrub; `idx_phone_only` for federal fast-path; Redis Bloom filter contract documented in HANDOFF | §4.14 |
| **D06** (callbacks) | `callbacks` table + 3 indexes including the "due now" scanner | §4.16 |
| **F05** (auth) | `users`, `user_groups`, `tenants`, `sip_credentials` tables; encryption columns specced (`VARBINARY(512)`, `kek_version SMALLINT`); bootstrap admin seed contract | §4.1–§4.4, §11.2 |
| **C01** (TCPA TZ) | `leads.known_timezone` (IANA), `leads.zip` (postal_code), `leads.state` columns + indexes; `call_times.state_overrides` JSON | §4.13, §4.12 |
| **C03** (audit) | `audit_log` table + INSERT-only grant; partitioned monthly; HANDOFF documents the immutability mechanism + S3 export contract | §4.5 |
| **C04** (retention/partitions) | Rotation procedure spec; partition naming convention `p_<yyyy>_<mm>` and `p_max` sentinel; `EXCHANGE PARTITION` worker contract | §6 |
| **E01** (hopper) | `hopper_mirror` table; lifecycle = mirror Redis ZSET, used for crash recovery; UNIQUE constraint per (tenant, campaign, lead) | §4.17 |
| **I01** (in-groups) | `ingroups`, `ingroup_agents`, `did_numbers` tables | §4.22, §4.23 |
| **R01** (recording) | `recording_log` (partitioned, write log) + `recordings` (lifecycle, FK-able) | §4.18, §4.26 |
| **R02** (S3 upload) | `recordings.lifecycle_state`, `recordings.s3_storage_class` | §4.18 |
| **T02** (carriers) | `carriers` + `gateways` (split for multi-trunk); encrypted credential columns | §4.20, §4.21 |
| **N01** (external API) | `audit_log.actor_kind='external_api'` + `request_id` correlation column | §4.5 |

---

## 14. Resolved open questions

| # | Question | Resolution | Rationale |
|---|---|---|---|
| 1 | `campaigns` PK shape | **Compound `(tenant_id, id VARCHAR(32))`** | Multi-tenant safety in Phase 4 with zero migration cost; 8 extra bytes per campaign row × ~thousands = trivial. All cross-references use compound FK. |
| 2 | `down.sql` policy | **Dev/test only**, codified in HANDOFF | Production is forward-fix; downs are a footgun in prod and Prisma is forward-only by design. We keep downs for DR drills + local dev. |
| 3 | `leads` custom fields shape | **`custom_data JSON` for Phase 1**, escape hatch documented | JSON wins for typical 5–20 fields; if customer needs to filter on a custom field, we add `lead_custom_fields` non-breakingly. |
| 4 | DNC PK reorder | **`(tenant_id, phone_e164, source, state, campaign_id)`** with sentinel strings | Hot-path scrub becomes a 2-column seek; sentinel strings (`'__'`, `'__GLOBAL__'`) avoid NULL-in-PK ambiguity. |
| 5 | Secrets encryption | **`VARBINARY(512)` ciphertext columns + per-row `kek_version SMALLINT`** | Per-row KEK version makes key rotation a background re-encryption pass; F05/S01 supply the KEK abstraction (env-var key now, Vault later). |
| 6 | Seed `tenants` table | **Yes, seed `id=1` row** | FK target for `tenant_id` everywhere; Phase 4 just inserts new rows. |
| 7 | Soft-delete on leads | **Yes — `deleted_at DATETIME(6) NULL`** | Lifecycle requires lead retention for TCPA; Prisma middleware filters automatically; index `idx_t_deleted` for sweep. |
| 8 | `audit_log.entity_type` shape | **`VARCHAR(32)`** + Zod enum in app | New event types should not require ALTER TABLE; aligns with statuses-as-lookup philosophy. |
| 9 | Phase-1 read replica? | **No.** Single primary in Phase 1; replica is Phase 2 RFC | DESIGN.md §10 implies single primary at MVP; `binlog_format=ROW` + GTID makes future replica zero-schema-change. |
| 10 | Connection pooling specifics | **Prisma `connection_limit` per service; Go `SetMaxOpenConns=25`. ProxySQL Phase 2.** | Documented in §10. Total ≤100 connections vs `max_connections=500`. |
| 11 | `recordings` table or just `recording_log`? | **Both** — `recording_log` partitioned write log + `recordings` non-partitioned lifecycle | Partitioned tables can't be FK target; `recordings` holds shareable tokens, lifecycle state, legal hold; `recording_log` stays as the high-volume facts table. |
| 12 | `did_numbers` vs `dids` vs `inbound_numbers` | **`did_numbers`** SQL name; Prisma model `DidNumber` | DESIGN.md says `did_numbers`; T02 uses the same. |

**Surfaced during PLAN (also resolved here):**

- **Q13: Where does `gateways` live (separate from `carriers`)?** → New table `gateways` (§4.21). T02 needs it; carriers can have multi-trunk.
- **Q14: How to seed NANP `phone_codes`?** → `db/seeds/phone_codes.csv` committed to repo, generated from public NANPA + tzdata. Build script lives outside F02 scope.
- **Q15: `dispositions` table?** → Yes (§4.19), distinct from the `statuses` lookup.

**No RFCs filed.** Every question is decidable inside the existing design constraints; no SPEC change required.

---

## 15. Testing strategy

Per F02.md and SPEC §3.10. All tests run against a real MySQL container
(matching F01's compose service). Pattern:

- **`api/test/db/migration.test.ts`** — runs `prisma migrate deploy` against a fresh test DB, asserts every Phase-1 table + column + index is present (queries `information_schema`).
- **`api/test/db/multi_tenant_index.test.ts`** — the §9 enforcement check.
- **`api/test/db/seed.test.ts`** — runs the seed; asserts `phone_codes >= 800`, `statuses >= 20`, `pause_codes = 7`, `call_times = 1`, `tenants = 1`, super-admin user exists.
- **`api/test/db/partition.test.ts`** — inserts rows into `call_log`, `agent_log`, `recording_log`, `drop_log`, `audit_log` across month boundaries; asserts `EXPLAIN PARTITIONS SELECT ... WHERE <date_col>='YYYY-MM-DD'` prunes to one partition.
- **`api/test/db/fk.test.ts`** — for every FK in the schema, attempt to insert a row referencing a non-existent parent and assert a constraint failure; for partitioned tables, assert the application-layer guard fires.
- **`api/test/db/tenant_default.test.ts`** — for every table that has `tenant_id`, insert a row with no `tenant_id` and assert the default `1` is applied.

**Test reset between cases:** dependency-ordered `TRUNCATE` with `SET FOREIGN_KEY_CHECKS=0; … SET FOREIGN_KEY_CHECKS=1;` wrapping. Helper `api/test/db/reset.ts`.

**Factories** in `api/test/factories/`:
- `tenantFactory()` (returns the seeded id=1 by default)
- `userFactory({ role })`
- `campaignFactory({ dialMethod })`
- `listFactory()`
- `leadFactory({ list, status, phone })`
- `dncFactory({ phone, source })`
- `callbackFactory({ lead })`
- `carrierFactory()` + `gatewayFactory({ carrier })`
- `dispositionFactory()`

These are referenced by every downstream module's tests, so factories
become a HANDOFF artifact.

**Test runner:** `vitest` (matches F01's pin); `cd api && pnpm test`. Target ≥ 70% coverage on `prisma/`, `lib/db.ts`, factories, middleware.

---

## 16. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Application-layer FK enforcement burden on the 5 partitioned tables | High | Medium | Nightly orphan reconciler in C04 emits `vici2_db_orphan_rows_total`; PR template asks "did you write to call_log/agent_log/recording_log/drop_log/audit_log? did you guard the FK in code?" |
| Per-row `kek_version` re-encryption pass required when keys rotate | Medium | Medium | Background worker in F05; documented; column already in place so no future migration |
| `RANGE COLUMNS` partitions overflow `p_max` if C04 scheduler fails | Low | High | Nightly safety check in C04 (in addition to monthly cron); +3-month pre-creation gives long buffer; alert if `p_max` row count > 0 |
| `local_infile=OFF` blocks future bulk-load tools | Low | Low | We toggle on for one-shot loaders that need it; default-off is the safe stance |
| Sentinel strings (`'__SYS__'`, `'__GLOBAL__'`, `'__'`) leak into UI | Low | Low | App-layer null-coalesce wrappers; documented; rejected in API request schemas |
| Composite FKs (`(tenant_id, campaign_id)`) interact awkwardly with Prisma's relation declarations | Medium | Low | Use Prisma's `@relation(fields: [...], references: [...], map: "...")` with both columns; tested by `migration.test.ts` |
| 7-year retention for `recording_log`, `drop_log`, `audit_log` blows past partition limit (8192) | Low (84 monthly partitions) | Low | 84 partitions per table is well below ceiling; no action |
| Bootstrap admin password env not set in dev | Medium | Low | Seed prints clear error; `make db-seed` aborts with "set VICI2_BOOTSTRAP_ADMIN_PASSWORD" |
| `caching_sha2_password` breaks legacy MySQL clients | Low | Low | Documented; Go driver and Prisma both support; only matters if ops uses an old `mysql` CLI |

---

## 17. Acceptance criteria (restated from F02.md, with PLAN-level adds)

- [ ] All Phase-1 tables from DESIGN.md §5 plus `tenants`, `sip_credentials`, `gateways`, `dispositions`, `hopper_mirror`, `recordings`, `ivr_trees`, `audit_log` present and named exactly as in §4.
- [ ] Every table has `tenant_id` (except `phone_codes`), `created_at`, `updated_at`.
- [ ] Every composite index on a tenant-scoped table leads with `tenant_id` (verified by §9 test).
- [ ] All indexes from §8 present (verified by `migration.test.ts`).
- [ ] `down.sql` exists for every migration (dev/test contract).
- [ ] Seeds populate `tenants(1)`, `phone_codes(800+)`, `statuses(20+ system defaults)`, `pause_codes(7)`, `call_times(1)`, super-admin user.
- [ ] Five partitioned tables created with `RANGE COLUMNS`; +3 months pre-created; `p_max` exists; partition pruning verified.
- [ ] `audit_log` has `INSERT, SELECT` grant only for `vici2_app`; `UPDATE`/`DELETE` revoked.
- [ ] Prisma client generates clean for both `api` and `workers`.
- [ ] ERD published in `docs/db/erd.md` (Mermaid).
- [ ] `make db-migrate` from a clean DB completes; `make db-reset` works.
- [ ] All open questions in RESEARCH.md closed (zero outstanding).

---

## 18. File list to be created in IMPLEMENT (preview, not part of this PLAN's scope)

```
api/prisma/schema.prisma                                 (full schema)
api/prisma/migrations/20260506100000_init_tenants/migration.sql
                                                  /migration.down.sql
api/prisma/migrations/20260506100100_init_auth/...
api/prisma/migrations/20260506100200_init_carriers/...
api/prisma/migrations/20260506100300_init_campaigns/...
api/prisma/migrations/20260506100400_init_leads/...
api/prisma/migrations/20260506100500_init_dnc_callbacks/...
api/prisma/migrations/20260506100600_init_inbound/...
api/prisma/migrations/20260506100700_init_logs_partitioned/migration.sql       (raw SQL)
                                                       /migration.down.sql      (intentionally empty)
api/prisma/migrations/20260506100800_init_indexes_extra/...
api/prisma/migrations/20260506100900_init_seed_constraints/migration.sql        (REVOKE etc.)
                                                       /migration.down.sql

api/prisma/seed.ts
api/prisma/seed/                       (helper modules called by seed.ts)
db/seeds/phone_codes.csv
db/seeds/statuses.json
db/seeds/pause_codes.json

api/src/lib/db.ts                       (singleton Prisma client, tenant middleware)
api/src/lib/tenancy.ts                  (Prisma middleware that injects tenant_id)
api/src/lib/encrypt.ts                  (envelope-encryption stub; F05 will fill the KEK source)

api/test/db/migration.test.ts
api/test/db/multi_tenant_index.test.ts
api/test/db/seed.test.ts
api/test/db/partition.test.ts
api/test/db/fk.test.ts
api/test/db/tenant_default.test.ts
api/test/db/reset.ts
api/test/factories/index.ts

scripts/check_index_tenant_lead.sh
scripts/db-down.sh

mysql/conf.d/vici2.cnf                  (Phase 1 preset; F01 adds bind mount)
mysql/conf.d/vici2.prod.cnf.example     (Phase 2 preset; ops reference)

docs/db/erd.md                          (Mermaid; generated at impl time via prisma-erd-generator)
```

End of PLAN.md.
