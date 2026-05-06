# F02 — HANDOFF

**Module:** F02 — MySQL Schema + Migrations
**Status:** DONE
**Date:** 2026-05-06
**Branch:** `feat/F02-mysql-schema`

---

## 1. Schema overview

| Section | Tables |
|---|---|
| Identity | `tenants`, `users`, `user_groups`, `sip_credentials`, `auth_config` |
| Campaigns | `campaigns`, `lists`, `campaign_lists`, `statuses`, `pause_codes`, `scripts`, `call_times` |
| Leads / DNC | `leads`, `dnc`, `phone_codes`, `phone_codes_overrides`, `zip_codes`, `callbacks`, `hopper_mirror`, `dispositions`, `recordings` |
| Telephony | `carriers`, `gateways`, `did_numbers`, `ingroups`, `ingroup_agents`, `ivr_trees` |
| Logs (partitioned) | `call_log`, `agent_log`, `recording_log`, `drop_log`, `audit_log` |
| Misc | `settings` |

**Total: 33 application tables** + Prisma's `_prisma_migrations`.

**Five partitioned tables** (`RANGE COLUMNS` monthly, +3 months pre-created
per F02 PLAN §6, +1 historical sentinel `p_pre`, +1 forward sentinel
`p_max`): `call_log`, `agent_log`, `recording_log`, `drop_log`,
`audit_log`.

Source-of-truth file: `api/prisma/schema.prisma`.

---

## 2. Amendments applied

| ID | Description | Where it landed |
|---|---|---|
| **A1** | `phone_codes` PK extended to `(area_code, exchange_code)` for NXX granularity (D03 split-state requirement). Added `county`, `confidence ENUM('NPA','NXX')`. | `schema.prisma` model `PhoneCode`, init migration. |
| **A2** | `users.totp_required BOOLEAN NOT NULL DEFAULT false` (F05 2FA hook). | `schema.prisma` model `User`. |
| **A3** | New single-row `auth_config` table (F05 hook): `id INT PK CHECK(id=1)`, `password_min_length`, `lockout_after_failures`, … | `schema.prisma` model `AuthConfig`; seeded with defaults. |
| **A4** | New `zip_codes` table for D03 ZIP cascade (tier 2 of resolver). `zip CHAR(5) PRIMARY KEY, tz_iana, state, confidence ENUM('ZIP')`. | `schema.prisma` model `ZipCode`; seeded from starter CSV. |
| **A5** | New `phone_codes_overrides` table — same shape as `phone_codes` plus `reason`, `created_by_user_id`, `created_at`. Read with override-priority by D03 resolver. | `schema.prisma` model `PhoneCodeOverride`. |
| **A6** | F02 ships `users.password_hash VARCHAR(255)` shape but does NOT seed the super-admin. Renamed env var to `BOOTSTRAP_SUPERADMIN_PASSWORD`; added `BOOTSTRAP_SUPERADMIN_EMAIL` and `BOOTSTRAP_SUPERADMIN_TENANT_ID` (default 1). | `.env.example`, `Makefile` (`db-bootstrap-superadmin` placeholder target). |

---

## 3. Migration files (intended order)

```
api/prisma/migrations/
├── 20260506201114_init/                  # all 33 tables + FKs
│   ├── migration.sql
│   └── migration.down.sql                # dev/test only — drops all 33 tables
├── 20260506201500_partition_log_tables/  # drops + recreates 5 log tables
│   ├── migration.sql                     # with RANGE COLUMNS partitioning
│   └── migration.down.sql                # intentionally empty (forward-fix)
├── 20260506201600_drop_partition_fks/    # safety SELECT against future drift
│   ├── migration.sql
│   └── migration.down.sql                # empty
├── 20260506201700_audit_grants/          # audit_log BEFORE UPDATE/DELETE triggers
│   ├── migration.sql
│   └── migration.down.sql                # drops triggers (dev only)
├── 20260506201800_pause_codes_unique/    # functional UNIQUE on (t, IFNULL(camp,…), code)
│   ├── migration.sql
│   └── migration.down.sql                # drops the index
└── migration_lock.toml                   # provider = mysql
```

`prisma migrate deploy` applies them in name order. `migration.down.sql`
files are NOT consumed by Prisma — they are dev/test-only artifacts (per
F02 PLAN §12). A future helper script `scripts/db-down.sh` (NOT in F02
scope; deferred) consumes them via `mysql < migration.down.sql`.

---

## 4. `my.cnf` — how to apply

| File | Where it goes | Bind mount |
|---|---|---|
| `infra/mysql/my.cnf` | bind-mounted into the `mysql:8.0.40` container at `/etc/mysql/conf.d/vici2.cnf` | `docker-compose.dev.yml` line: `./infra/mysql/my.cnf:/etc/mysql/conf.d/vici2.cnf:ro` |
| `infra/mysql/my.prod.cnf.example` | reference for production ops; copy + tune for the 64 GB box | not bind-mounted |
| `infra/mysql/init/01-databases.sql` | bind-mounted at `/docker-entrypoint-initdb.d/01-databases.sql`; runs ONCE on first container boot | `docker-compose.dev.yml` line: `./infra/mysql/init:/docker-entrypoint-initdb.d:ro` |

The `my.cnf` is the Phase-1 24 GB preset from F02 PLAN §2.1 verbatim
(`innodb_buffer_pool_size=16G`, `innodb_redo_log_capacity=4G`,
`innodb_flush_log_at_trx_commit=1`, `sync_binlog=1`, GTID, ROW
binlog, `local_infile=OFF`). Prod operator copies
`my.prod.cnf.example` → `my.cnf` and reloads.

---

## 5. Connection strings

### Prisma (Node `api/`, `workers/`)

```
DATABASE_URL=mysql://vici2_app:${VICI2_DB_PASSWORD}@mysql:3306/vici2?connection_limit=20&pool_timeout=10
```

The `connection_limit` defaults to `2 * num_cpus` when omitted; we cap
at 20 per service. `pool_timeout=10` is seconds before failing to
acquire a connection.

### Go dialer (`database/sql` + `go-sql-driver/mysql`)

```
DATABASE_DSN=vici2_app:${VICI2_DB_PASSWORD}@tcp(mysql:3306)/vici2?parseTime=true&loc=UTC&charset=utf8mb4&interpolateParams=true&maxAllowedPacket=67108864
```

`loc=UTC` is mandatory — matches `default_time_zone='+00:00'` in
`my.cnf`. Set:
```go
db.SetMaxOpenConns(25)
db.SetMaxIdleConns(10)
db.SetConnMaxLifetime(5 * time.Minute)
```
per F02 PLAN §10.

Both env vars are seeded in `.env.example`; copy to `.env` before
`make dev`.

---

## 6. Tenant_id enforcement pattern (Prisma middleware)

Every `tenant_id` column defaults to `1` at the schema level (Phase 1
single-tenant). Application code MUST inject the JWT-derived tenant id
into every read + every write. Suggested middleware (F05 ships the JWT
extraction; D01 wires the middleware below):

```ts
import { Prisma, PrismaClient } from '@prisma/client';

const TENANT_SCOPED_MODELS = new Set([
  'User', 'UserGroup', 'SipCredential', 'Campaign', 'List', 'CampaignList',
  'Status', 'PauseCode', 'Script', 'CallTime', 'Lead', 'Dnc', 'Callback',
  'HopperMirror', 'Recording', 'Disposition', 'Carrier', 'Gateway',
  'DidNumber', 'Ingroup', 'IngroupAgent', 'IvrTree', 'Setting',
]);

export function tenantMiddleware(getTenantId: () => bigint): Prisma.Middleware {
  return async (params, next) => {
    if (!params.model || !TENANT_SCOPED_MODELS.has(params.model)) return next(params);
    const tid = getTenantId();
    if (params.action === 'create' && params.args.data) {
      params.args.data.tenantId ??= tid;
    } else if (params.action === 'createMany' && Array.isArray(params.args.data)) {
      params.args.data = params.args.data.map((d: any) => ({ tenantId: tid, ...d }));
    } else if (['findUnique','findFirst','findMany','update','updateMany','delete','deleteMany','count','aggregate'].includes(params.action)) {
      params.args.where = { ...(params.args.where ?? {}), tenantId: tid };
    }
    return next(params);
  };
}
```

The CI script `scripts/ci/check-tenant-index-leadership.sh` enforces
that every composite index leads with `tenant_id` (with documented
exemptions for `phone_codes`, `phone_codes_overrides`, `zip_codes`,
`auth_config`, plus three indexes on `dnc.phone_only`, `call_log.uuid`,
`recording_log.uuid` per PLAN justifications).

Soft-delete on `leads`: every query MUST filter `WHERE deleted_at IS
NULL`. Add a parallel middleware in D01:

```ts
if (params.model === 'Lead' && params.action === 'findMany') {
  params.args.where = { deleted_at: null, ...params.args.where };
}
```

---

## 7. Partition rotation procedure (defers to C04)

Five tables are partitioned monthly. F02 ships:
- `p_pre` (catch-all for stale dates)
- `p_2026_05`, `p_2026_06`, `p_2026_07`, `p_2026_08` (current + 3 future)
- `p_max` (sentinel `VALUES LESS THAN (MAXVALUE)`)

C04 IMPLEMENT runs the monthly cron:

```sql
-- Add next month
ALTER TABLE call_log
  REORGANIZE PARTITION p_max INTO (
    PARTITION p_2026_09 VALUES LESS THAN ('2026-10-01'),
    PARTITION p_max     VALUES LESS THAN (MAXVALUE)
  );

-- Drop oldest past retention (e.g., 24mo for call_log → drop 2024-05)
CREATE TABLE call_log_archive_2024_05 LIKE call_log;
ALTER TABLE call_log_archive_2024_05 REMOVE PARTITIONING;
ALTER TABLE call_log EXCHANGE PARTITION p_2024_05 WITH TABLE call_log_archive_2024_05;
ALTER TABLE call_log DROP PARTITION p_2024_05;
-- Optional: ship call_log_archive_2024_05 to S3 / Glacier
```

Retention windows (informational; C04 enforces):
- `call_log` 24 months hot
- `agent_log` 13 months
- `recording_log` 7 years (TCPA / state recording laws)
- `drop_log` 7 years (TCPA evidence)
- `audit_log` 7 years (TCPA evidence)

Health metric: `vici2_db_partitions_total{table="..."}` (C04 owner).

`DROP PARTITION` does **not** fire row-level triggers, so the
audit_log immutability triggers do not block C04.

---

## 8. DB user grant matrix

Three users are bootstrapped by `infra/mysql/init/01-databases.sql` on
the FIRST container boot (idempotent re-run is safe):

| User | Hosts | Privileges | Used by |
|---|---|---|---|
| `vici2_app` | `%` | Schema-level DML on the app DB; INSERT+SELECT-only on `audit_log` (table-level grant overrides for documentation; runtime enforcement is the trigger pair below) | api, workers, dialer |
| `vici2_backup` | `%` | `SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER, RELOAD, REPLICATION CLIENT` on *.* | mysqldump (O02) |
| `vici2_root` | `%` | `ALL PRIVILEGES` on the schema | Prisma migrate, partition rotator (C04) |

Passwords come from `MYSQL_PASSWORD` / `MYSQL_ROOT_PASSWORD` env vars
that the operator sets in `.env`. The init script's hard-coded
placeholders (`change-me-backup-password`,
`change-me-root-runtime-password`) MUST be rotated before any non-dev
deployment.

For local dev: `make mysql-cli` opens the `vici2_app` shell;
`docker compose exec mysql mysql -uvici2_root -p` opens the schema
owner shell.

---

## 9. Audit_log immutability mechanism

Two layers of defence (per F02 PLAN §4.5):

1. **MySQL triggers** (load-bearing). Created by migration
   `20260506201700_audit_grants`:
   ```sql
   CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
     FOR EACH ROW SIGNAL SQLSTATE '45000'
       SET MESSAGE_TEXT = 'audit_log is append-only; UPDATE is not permitted (F02 §4.5)';
   CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
     FOR EACH ROW SIGNAL SQLSTATE '45000'
       SET MESSAGE_TEXT = 'audit_log is append-only; DELETE is not permitted (F02 §4.5)';
   ```
   Even root cannot mutate a row without first dropping the trigger
   (visible in audit log of the dropping action via C03).

2. **Grant matrix** (defence-in-depth). The `vici2_app` runtime user
   gets a table-level GRANT of INSERT, SELECT only on `audit_log` —
   the schema-level DML grant covers other tables.

   Note: MySQL takes the UNION of all granted privileges, so the
   table-level grant alone does NOT prevent UPDATE if the schema-level
   grant includes UPDATE. This is why the trigger pair is the
   load-bearing layer.

C03 IMPLEMENT additionally writes append-only S3 export. F02 owns the
in-DB enforcement only.

C04's `DROP PARTITION` does NOT fire row-level triggers — retention
rotation remains possible.

---

## 10. Encryption column conventions

Per F02 PLAN §4.4 / §4.20 + F05 PLAN §4 the at-rest secrets layout is:

| Column | Type | Notes |
|---|---|---|
| `sip_credentials.sip_password_ct` | `VARBINARY(512)` | required |
| `sip_credentials.kek_version` | `SMALLINT NOT NULL DEFAULT 1` | per-row |
| `carriers.username_ct` | `VARBINARY(512)` | nullable (some IP-auth carriers) |
| `carriers.password_ct` | `VARBINARY(512)` | nullable |
| `carriers.kek_version` | `SMALLINT NOT NULL DEFAULT 1` | per-row |

Cipher choice (AES-GCM-256 envelope encryption with 96-bit IV +
table+column+row+tenant+kek-version AAD) is owned by F05; F02 only
ships the column shape so F05 can land without a migration.

KEK rotation: bump `kek_version` on re-encrypt; `idx_sip_creds_t_user_kek`
makes the bulk re-wrap pass cheap.

The `share_token` on the `recordings` table is a 16-byte UUIDv7 stored
as `BINARY(16) UNIQUE`, NOT envelope-encrypted (random opaque
identifier).

---

## 11. Bootstrap procedure

Per amendment **A6**, F02 does NOT seed the super-admin row.

1. Operator sets `BOOTSTRAP_SUPERADMIN_EMAIL`,
   `BOOTSTRAP_SUPERADMIN_PASSWORD` (12+ chars), and optionally
   `BOOTSTRAP_SUPERADMIN_TENANT_ID` (defaults to 1) in `.env`.
2. Run `make db-migrate && make db-seed` (creates schema + reference
   data, no users).
3. After F05 IMPLEMENT lands: `make db-bootstrap-superadmin` (current
   placeholder script in `Makefile` exits 0 with an explanatory echo;
   F05 will replace it with an Argon2id-hashing CLI).
4. Login at `https://<host>/admin/login`, rotate password, MFA-enrol.

---

## 12. Hand-off interfaces

Per F02 PLAN §13 with amendments accounted for:

| Module | What F02 provides |
|---|---|
| **D01** (lead CRUD) | `leads` table + 9 indexes; `deleted_at` soft-delete convention; tenant middleware example above. |
| **D02** (CSV import) | `leads` insert plan: app-batched 500 rows/tx via Prisma `createMany`; `local_infile=OFF` blocks LOAD DATA exfil. |
| **D03** (TZ resolver) | `phone_codes` (NPA + NXX), `zip_codes`, `phone_codes_overrides`; `leads.tz_offset_min`, `leads.known_timezone`, `leads.state`, `leads.postal_code`. Starter CSVs at `db/seeds/`. |
| **D04** (statuses) | `statuses` lookup (21 system defaults under `'__SYS__'`) + `dispositions` event table. |
| **D05** (DNC) | `dnc` with PK `(tenant, phone, source, state, campaign)`; `idx_phone_only` for federal fast-path. |
| **D06** (callbacks) | `callbacks` with `idx_t_status_due` for the "what's due now" scanner. |
| **F05** (auth) | `users.totp_required`, `users.password_hash VARCHAR(255)`, `auth_config` single-row, `sip_credentials.sip_password_ct VARBINARY(512)`, `audit_log` shape + immutability triggers. |
| **C01** (TCPA TZ) | `leads.known_timezone` (IANA), `leads.postal_code` ZIP, `leads.state`; `call_times.state_overrides` JSON. |
| **C03** (audit immutability) | trigger pair on `audit_log` + per-user grant matrix; C03 layers S3 export on top. |
| **C04** (retention/partitions) | partition naming `p_<yyyy>_<mm>` + `p_max` sentinel; rotation snippet in §7 above. |
| **E01** (hopper) | `hopper_mirror` table, `UNIQUE (tenant, campaign, lead)`; replay via `idx_t_camp_scheduled`. |
| **R01** (recording) | `recording_log` (partitioned write log) + `recordings` (lifecycle / share tokens). |
| **R02** (S3 upload) | `recordings.lifecycle_state`, `recordings.s3_storage_class`. |
| **T02** (carriers) | `carriers` + `gateways` (split for multi-trunk); `VARBINARY(512)` cred columns + `kek_version`. |
| **I01** (in-groups) | `ingroups`, `ingroup_agents`, `did_numbers`. |
| **I03** (IVR) | `ivr_trees.tree_json` JSON node graph. |
| **O02** (backup) | `vici2_backup` user grant matrix ready (see §8). |
| **N01** (external API) | `audit_log.actor_kind='external_api'`, `request_id` correlation. |

---

## 13. File inventory added by F02

```
api/prisma/
  schema.prisma                                            (full schema, 33 models)
  seed.ts                                                  (idempotent reference data)
  migrations/
    20260506201114_init/migration.{sql,down.sql}
    20260506201500_partition_log_tables/migration.{sql,down.sql}
    20260506201600_drop_partition_fks/migration.{sql,down.sql}
    20260506201700_audit_grants/migration.{sql,down.sql}
    20260506201800_pause_codes_unique/migration.{sql,down.sql}
    migration_lock.toml
api/test/db/
  round-trip.test.ts                                       (insert/query smoke)

db/seeds/
  phone_codes_starter.csv                                  (20 rows; D03 owns full)
  zip_codes_starter.csv                                    (20 rows; D03 owns full)
  README.md                                                (format + refresh pipeline)

infra/mysql/
  my.cnf                                                   (Phase 1 24GB preset)
  my.prod.cnf.example                                      (Phase 2 64GB preset)
  init/01-databases.sql                                    (vici2_backup, vici2_root creation)

scripts/ci/
  check-tenant-index-leadership.sh                         (PR-blocking lint)

api/package.json                                           (prisma + @prisma/client deps;
                                                            db:* scripts; prisma config block)
Makefile                                                   (db-generate / db-migrate / db-migrate-dev /
                                                            db-deploy / db-reset / db-seed / db-studio /
                                                            db-bootstrap-superadmin / lint-tenant-index)
docker-compose.dev.yml                                     (mysql service: my.cnf + init mounts;
                                                            healthcheck includes app DB)
.env.example                                               (BOOTSTRAP_SUPERADMIN_*, vici2_app default,
                                                            DATABASE_DSN for Go dialer)

spec/modules/F02/
  VERIFY.md                                                (verification + test transcripts)
  HANDOFF.md                                               (this file)
```

---

## 14. Known limitations / deferred work

- **Compose stack not boot-tested in F02 sandbox.** Host MySQL was used
  for verification (docker bind on 3306 already taken). The compose file
  diff is reviewed; F03 / next compose-rerun will exercise it.
- **NANP `phone_codes` is starter only** (20 rows). Full ~165k row
  ingestion is D03's pipeline (`scripts/build-phone-codes.go` lands
  with D03 IMPLEMENT). Same for `zip_codes` (~33k US ZIPs).
- **`auth_config` single-row table** is seeded with PLAN-default values;
  F05 IMPLEMENT will tune `password_min_length` / `lockout_*` as needed
  via UPDATE.
- **`make db-bootstrap-superadmin` is a stub** that explains it requires
  F05 IMPLEMENT and exits 0.
- **No `down.sql` runner** ships in F02 — `migration.down.sql` files are
  written for dev/test reference. `scripts/db-down.sh` is a future hand
  in O04 / C04 if needed for DR drills.
- **Per-row KEK rewrap worker** is F05's; F02 only ships the
  `kek_version` column.
- **ProxySQL** (Phase 2) is documented in PLAN §10 but not in F02 scope.
- **Atlas migrate lint** (Phase 2 add-on per PLAN §5) is out of scope.
- **ERD doc** at `docs/db/erd.md` is deferred to D04 — no module is
  blocked by it. The Prisma schema itself is the authoritative model
  source.
- **Pause-codes-required-without-DB** integration with the `statuses`
  table is enforced by app + a CHECK constraint deferred to a follow-on
  forward migration when D04 + M07 wire up.

---

## 15. Quick-start (for any downstream module IMPLEMENT)

```bash
# Once per developer setup:
cp .env.example .env       # set BOOTSTRAP_SUPERADMIN_PASSWORD at minimum
pnpm install               # installs prisma + lefthook
make dev                   # docker compose up

# Then any time:
make db-reset              # drop + create
make db-migrate            # apply all 5 migrations
make db-seed               # tenants, statuses, phone_codes, …

# After F05 IMPLEMENT lands:
make db-bootstrap-superadmin

# Generate Prisma client (CI does this; needed if you change schema.prisma):
make db-generate

# Open Prisma Studio:
make db-studio
```

To talk to the DB directly:
```bash
make mysql-cli                                  # vici2_app shell
docker compose exec mysql mysql -uvici2_root -p # schema-owner shell (migrate / partition ops)
```

---

## 16. References

- [PLAN.md](./PLAN.md) — frozen blueprint
- [RESEARCH.md](./RESEARCH.md) — 43 citations behind the design
- [VERIFY.md](./VERIFY.md) — verification transcripts
- [F02.md](../F02.md) — original module spec (status now DONE)
- [F05/PLAN.md](../F05/PLAN.md) — auth amendments source (A2, A3, A6)
- [D03/RESEARCH.md](../D03/RESEARCH.md) — phone-code amendments source (A1, A4, A5)
- [F01/HANDOFF.md](../F01/HANDOFF.md) — repo conventions inherited
- [SPEC.md §3](../../../SPEC.md) — repo conventions (canonical)
- [DESIGN.md §5](../../../DESIGN.md) — original schema sketch
