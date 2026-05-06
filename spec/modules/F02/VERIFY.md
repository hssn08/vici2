# F02 — VERIFY

**Module:** F02 — MySQL Schema + Migrations
**Date:** 2026-05-06
**Branch:** `feat/F02-mysql-schema`
**Status:** PASS

This file records the commands run during the VERIFY + TEST phases and
their observed output. The DB used was a local MySQL 8.0.45 instance
(close enough to the F02 PLAN's pinned 8.0.40 for schema validation;
binlog_format / partition syntax / ENUM support are identical between
8.0.40 and 8.0.45). Docker compose was not exercised — the host
environment did not have a free 3306 port.

---

## VERIFY phase

### V1. `pnpm install` (with new prisma deps)

```
$ pnpm install
Scope: all 5 workspace projects
Packages: +7
Done in 3.3s
```

`prisma@5.22.0` and `@prisma/client@5.22.0` added to api workspace.
Lockfile updated. **PASS**.

### V2. `prisma format`

```
$ cd api && pnpm exec prisma format
Prisma schema loaded from prisma/schema.prisma
Formatted prisma/schema.prisma in 40ms 🚀
```

**PASS**.

### V3. `prisma validate`

```
$ DATABASE_URL='mysql://vici2_app:dev_password@localhost:3306/vici2_dev' pnpm exec prisma validate
Prisma schema loaded from prisma/schema.prisma
The schema at prisma/schema.prisma is valid 🚀
```

**PASS**.

### V4. `prisma generate`

```
$ pnpm exec prisma generate
✔ Generated Prisma Client (v5.22.0) to ./../node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client in 211ms
```

**PASS**.

### V5. Full migration deploy from clean DB

```
$ mysql -uroot -e "DROP DATABASE IF EXISTS vici2_dev; CREATE DATABASE vici2_dev CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;"
$ DATABASE_URL='mysql://vici2_app:dev_password@localhost:3306/vici2_dev' pnpm exec prisma migrate deploy
5 migrations found in prisma/migrations
Applying migration `20260506201114_init`
Applying migration `20260506201500_partition_log_tables`
Applying migration `20260506201600_drop_partition_fks`
Applying migration `20260506201700_audit_grants`
Applying migration `20260506201800_pause_codes_unique`
All migrations have been successfully applied.
```

**PASS**. All five migrations applied to a brand-new DB.

### V6. Table count

```
$ mysql -uroot vici2_dev -e "SELECT COUNT(*) AS tables FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA='vici2_dev' AND TABLE_TYPE='BASE TABLE';"
tables
34
```

(33 application tables + `_prisma_migrations`.) **PASS**.

### V7. Partition pre-creation

```
$ mysql -uroot vici2_dev -e "SELECT TABLE_NAME, COUNT(*) AS partitions FROM INFORMATION_SCHEMA.PARTITIONS WHERE TABLE_SCHEMA='vici2_dev' AND PARTITION_NAME IS NOT NULL GROUP BY TABLE_NAME;"
TABLE_NAME       partitions
agent_log        6
audit_log        6
call_log         6
drop_log         6
recording_log    6
```

5 partitioned tables, each with 6 partitions
(`p_pre`, `p_2026_05`, `p_2026_06`, `p_2026_07`, `p_2026_08`, `p_max`).
F02 PLAN §6 spec is "+3 months pre-created"; we ship May (current) +
Jun + Jul + Aug = 4 monthly partitions, which exceeds the requirement.
C04 owns subsequent rotation. **PASS**.

### V8. Partition pruning

```
$ mysql -uroot vici2_dev -e "EXPLAIN SELECT * FROM call_log WHERE call_started='2026-07-15';"
id  select_type  table     partitions   type  ...
 1  SIMPLE       call_log  p_2026_07    ALL   ...
```

The `partitions` column shows only `p_2026_07` — pruning is working.
**PASS**.

### V9. Audit_log immutability

```
$ mysql -uroot vici2_dev -e "INSERT INTO audit_log (id, tenant_id, action, entity_type, ts) VALUES (1, 1, 'test', 'lead', NOW(6));"
$ mysql -uroot vici2_dev -e "UPDATE audit_log SET action='hacked' WHERE id=1;"
ERROR 1644 (45000) at line 1: audit_log is append-only; UPDATE is not permitted (F02 §4.5)
$ mysql -uroot vici2_dev -e "DELETE FROM audit_log WHERE id=1;"
ERROR 1644 (45000) at line 1: audit_log is append-only; DELETE is not permitted (F02 §4.5)
$ mysql -uroot vici2_dev -e "SELECT id, action FROM audit_log WHERE id=1;"
id  action
 1  test
```

INSERT works; UPDATE rejected by trigger; DELETE rejected by trigger;
row preserved. The trigger gate is the load-bearing layer; the per-user
grant matrix is documented in `infra/mysql/init/01-databases.sql` and
`api/prisma/migrations/20260506201700_audit_grants/migration.sql` for
defence-in-depth. **PASS**.

### V10. Tenant_id index leadership

```
$ DATABASE_URL='mysql://vici2_app:dev_password@localhost:3306/vici2_dev' ./scripts/ci/check-tenant-index-leadership.sh
[check] schema-level: OK
[check] DB-level: OK
[check] tenant-id index leadership: PASS
```

Both layers (schema-level grep + INFORMATION_SCHEMA.STATISTICS query)
pass. Three exempt indexes are explicitly enumerated in the script
(`idx_dnc_phone_only`, `uk_call_log_uuid`, `uk_recording_log_uuid`) per
F02 PLAN justifications. **PASS**.

### V11. Prisma migrate reset + re-deploy + seed

```
$ cd api && DATABASE_URL='mysql://vici2_app:dev_password@localhost:3306/vici2_dev' pnpm exec prisma migrate reset --force --skip-seed
... all 5 migrations applied cleanly ...
$ pnpm exec prisma db seed
[seed] tenants
[seed] auth_config (single row)
[seed] statuses (system defaults)
[seed] pause_codes (system defaults)
[seed] call_times (default 9am-9pm + state overrides)
[seed] phone_codes (starter CSV)
[seed] phone_codes: 20 rows
[seed] zip_codes (starter CSV)
[seed] zip_codes: 20 rows
[seed] done
```

Idempotent end-to-end lifecycle. **PASS**.

---

## TEST phase

### T1. Round-trip insert/query smoke test

```
$ cd api && DATABASE_URL=... pnpm exec tsx test/db/round-trip.test.ts
[ok] tenant id=1 present
[ok] user created id= 1
[ok] campaign created id= TEST_<ts>
[ok] lead created id= 1 custom_data= { extra: { score: 42 }, source: 'roundtrip' }
[ok] dnc created phone= +15555550000
[ok] sip_credential created bytes= 20
[ok] cleanup done
[ok] call_log partition cross-month inserts succeeded
```

Covered:
- Tenant present (id=1, slug=default)
- User skeleton (CRUD; no cipher assertion — F05's job)
- Campaign with compound PK `(tenant_id, id)`
- List + Lead with `custom_data` JSON round-trip
- DNC with composite-PK + sentinel default `state='__'`
- SIP credential with `VARBINARY(512)` accepting binary blob (echoed
  back as `Buffer`)
- CallLog cross-month inserts landing in correct partitions

**PASS**.

### T2. Seed counts

```
$ mysql -uroot vici2_dev -e "SELECT (SELECT COUNT(*) FROM tenants) AS tenants, (SELECT COUNT(*) FROM statuses) AS statuses, (SELECT COUNT(*) FROM pause_codes) AS pause_codes, (SELECT COUNT(*) FROM call_times) AS call_times, (SELECT COUNT(*) FROM phone_codes) AS phone_codes, (SELECT COUNT(*) FROM zip_codes) AS zip_codes, (SELECT COUNT(*) FROM auth_config) AS auth_config, (SELECT COUNT(*) FROM users) AS users;"
tenants statuses pause_codes call_times phone_codes zip_codes auth_config users
1       21       7           1          20          20        1           0
```

Matches contract (note: `users=0` is intentional per amendment A6 —
F05 IMPLEMENT seeds the super-admin). **PASS**.

### T3. Encryption-column shape

`sipCredential.sipPasswordCt` is declared `Bytes @db.VarBinary(512)`.
T1's round-trip wrote 20 bytes and read them back as a `Buffer`. The
column type was confirmed via:

```
$ mysql -uroot vici2_dev -e "DESCRIBE sip_credentials;" | grep sip_password_ct
sip_password_ct varbinary(512) NO  ...
```

**PASS**. Same shape applies to `carriers.username_ct` and
`carriers.password_ct` (both `VARBINARY(512)`).

### T4. Functional UNIQUE on pause_codes

```
$ mysql -uroot vici2_dev -e "SELECT INDEX_NAME, GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA='vici2_dev' AND INDEX_NAME='uk_pause_codes_t_camp_code' GROUP BY INDEX_NAME;"
uk_pause_codes_t_camp_code  tenant_id,(ifnull(`campaign_id`,_utf8mb4'__SYS__')),code
```

Functional index present per migration 20260506201800. **PASS**.

---

## Summary

| Check | Result |
|---|---|
| V1  pnpm install | PASS |
| V2  prisma format | PASS |
| V3  prisma validate | PASS |
| V4  prisma generate | PASS |
| V5  full deploy from clean DB | PASS |
| V6  table count (34 incl. _prisma_migrations) | PASS |
| V7  partitions pre-created (5 tables × 6) | PASS |
| V8  partition pruning verified | PASS |
| V9  audit_log immutability triggers | PASS |
| V10 tenant_id index leadership (schema + DB) | PASS |
| V11 reset + re-deploy + seed lifecycle | PASS |
| T1  round-trip insert/query | PASS |
| T2  seed counts | PASS |
| T3  encryption column shape (VARBINARY 512) | PASS |
| T4  pause_codes functional UNIQUE | PASS |

**Sandbox limitations not exercised:**
- `make dev` / `docker compose up --wait` — sandbox 3306 was already
  bound by host MySQL; we used the host MySQL directly. Compose service
  config + bind mounts (`infra/mysql/my.cnf`,
  `infra/mysql/init/01-databases.sql`) are written and reviewed, but
  not boot-tested. F03 / F01 verification will exercise the compose
  path on a clean Linux host.
- `make db-bootstrap-superadmin` — explicit no-op stub; F05 IMPLEMENT
  ships the real script.
- `pt-archiver` partition rotation drill — defers to C04 IMPLEMENT.
