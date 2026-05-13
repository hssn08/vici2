# F02 Amendments — VERIFY

| Field | Value |
|-------|-------|
| Branch | `feat/F02-amendments` |
| Migrations added | `20260506204550_f02_amendments` + `20260506204600_partition_amendment_tables` + `20260506204700_audit_grants_amendments` |
| Source modules consolidated | C01 / T02 / D01 / D05 / E01 / T04 |
| Date | 2026-05-13 |

## 1. Amendments applied (per module)

### C01 — TCPA call-window policy

| Item | Schema | Migration |
|------|--------|-----------|
| C01.1 `call_window_audit` partitioned table (19 cols + 5 idx) | `CallWindowAudit` @ schema.prisma L1259 | `20260506204600` L26-64 |
| C01.2 `state_holidays` table (admin lookup, NOT partitioned) | `StateHoliday` @ L1299 | `20260506204550` L102-114 |
| C01.3 `campaigns.unknown_tz_policy` ENUM `('deny','warn_pass')` | L341 | L35 |
| C01.4 `leads.tz_blocked` BOOLEAN | L584 | L72 |

### T02 — Carrier / gateway hardening

| Item | Schema | Migration |
|------|--------|-----------|
| T02.1 `carriers.kind` ENUM widened from 5 → 8 new values + legacy `telnyx` (9 total: `twilio`, `telnyx`, `telnyx-creds`, `telnyx-ip`, `signalwire`, `ringcentral`, `bandwidth`, `flowroute`, `byoc`) | `CarrierKind` @ L833 | L56 |
| T02.2 `carriers.send_pai` BOOLEAN | L860 | L57 |
| T02.3 `carriers.is_emergency` BOOLEAN | L861 | L58 |
| T02.4 `carriers.max_concurrent` INT NULL | L862 | L59 |
| T02.5 `carriers.notes` JSON DEFAULT `(JSON_OBJECT())` | L863 | L60 |
| T02.6 `carriers.version` INT DEFAULT 1 | L864 | L61 |
| T02.7 `gateways.weight` SMALLINT DEFAULT 100 | L906 | L65 |
| T02.8 `gateways.max_concurrent` INT NULL | L907 | L66 |
| T02.9 `gateways.version` INT DEFAULT 1 | L908 | L67 |
| T02.10 `gateways.cost_per_min_cents` INT NULL | L909 | L68 |

Legacy `telnyx` value retained for back-compat; T02 IMPLEMENT will retag rows to `telnyx-creds`/`telnyx-ip` based on `register` flag. No UPDATE in this additive migration.

### D01 — Lead optimistic locking

| Item | Schema | Migration |
|------|--------|-----------|
| D01.1 `leads.version` SMALLINT DEFAULT 1 | L586 | L73 |

### D05 — DNC sync infrastructure

| Item | Schema | Migration |
|------|--------|-----------|
| D05.1 `tenants` row `id=0` sentinel (so `dnc.fk_dnc_tenant` accepts global rows) | (data) | L131-143 (`SET sql_mode=NO_AUTO_VALUE_ON_ZERO` scoped → INSERT IGNORE) |
| D05.2 `dnc_sync_config` (per-source cron) | `DncSyncConfig` @ L1328 | L117-129 |
| D05.3 `dnc_sync_log` partitioned (sync run summaries) | `DncSyncLog` @ L1361 | `20260506204600` L71-97 |
| D05.4 `tenants.internal_dnc_retention_years` SMALLINT DEFAULT 5 | L97 | L31 |

### E01 — Hopper / pacing tunables

| Item | Schema | Migration |
|------|--------|-----------|
| E01.1 `campaigns.dial_level` DECIMAL(4,2) DEFAULT 1.50 | L343 | L36 |
| E01.3 `campaigns.lock_ttl_sec` SMALLINT DEFAULT 30 | L344 | L37 |
| E01.4 `campaigns.min_hopper_level` INT DEFAULT 50 | L345 | L38 |
| E01.5 `campaigns.max_hopper_level` INT DEFAULT 5000 | L346 | L39 |
| E01.6 `campaigns.hopper_buffer_multiplier` DECIMAL(3,1) DEFAULT 1.5 | L347 | L40 |
| E01.7 `campaigns.recycle_delay_seconds` INT DEFAULT 600 | L348 | L41 |
| E01.8 `campaigns.max_calls_per_lead` TINYINT DEFAULT 5 | L349 | L42 |
| E01.9 `campaigns.dial_statuses` JSON DEFAULT `(JSON_ARRAY('NEW','NA','B','CALLBK'))` | L350 | L43 |
| E01.10 `campaigns.low_water_pct` TINYINT DEFAULT 25 | L351 | L44 |
| E01.11 `campaigns.high_water_pct` TINYINT DEFAULT 90 | L352 | L45 |
| E01.12 `campaigns.over_fetch_ratio` DECIMAL(3,1) DEFAULT 1.5 | L353 | L46 |
| E01.13 `campaigns.machine_terminal` BOOLEAN DEFAULT true | L354 | L47 |
| E01.14 `campaigns.lead_filter_sql` TEXT NULL | L355 | L48 |
| E01.15 `campaigns.multi_list_mix` ENUM `('EVEN','MULTI','NONE')` DEFAULT 'EVEN' | L356 | L49 |
| E01.16 `campaign_status_overrides` table | `CampaignStatusOverride` @ L385 | L81-99 |

E01.2 (rename `dial_timeout_sec`) — not required; column already exists with that name.

### T04 — Originate audit

| Item | Schema | Migration |
|------|--------|-----------|
| T04.1 `originate_audit` partitioned (30 cols) | `OriginateAudit` @ L1440 | `20260506204600` L108-158 |
| T04.3 `lists.caller_id_override` VARCHAR(16) NULL | L416 | L77 |
| T04.4 `lists.caller_id_name` VARCHAR(32) NULL | L417 | L78 |

T04.2 (seed 4 D04 statuses TCPA / CONSENT_NOT_OBTAINED / CARRIER_FAIL / GATEWAY_LIMIT_TRY_LATER under `__SYS__`) — **DEFERRED to D04 PLAN/IMPLEMENT**. Seeds live in `api/prisma/seed.ts`; D04 has not landed yet, so the canonical status set is incomplete and the codes don't have agreed `selectable`/`humanAnswered`/`sale`/etc flags. The originate path will use them at IMPLEMENT time once D04 defines them. Schema header at L70-72 documents the contract.

## 2. Audit-grants for amendment tables (decision matrix)

| Table | Pattern | Triggers | Rationale |
|-------|---------|----------|-----------|
| `call_window_audit` | INSERT-only | `_no_update`, `_no_delete` | C01 §8.1 — TCPA decision log, 4y retention; mirrors `audit_log` |
| `dnc_sync_log` | INSERT-only | `_no_update`, `_no_delete` | D05 §6.5 — sync run evidence, 7y retention |
| `originate_audit` | INSERT + one-shot UPDATE | `_one_shot_update`, `_no_delete` | T04 RESEARCH §7 — DAL inserts with `outcome='OTHER'` before T01.Originate, finalizes once via UPDATE. Trigger forbids further UPDATEs after finalization (OLD.outcome != 'OTHER' OR OLD.outcome_at IS NOT NULL) |
| `campaign_status_overrides` | Fully mutable | none | Admin-editable override config; mutation history captured via `audit_log` |
| `state_holidays` | Fully mutable | none | Admin-editable reference (citation/date corrections expected) |
| `dnc_sync_config` | Fully mutable | none | Per-source cron config, edited via admin UI |

All immutability triggers live in `api/prisma/migrations/20260506204700_audit_grants_amendments/migration.sql`. Partition rotation uses DDL `DROP PARTITION` which does NOT fire row-level triggers, so retention rotation remains possible.

## 3. `prisma validate` result

```
$ DATABASE_URL=mysql://x:y@localhost:3306/z npx prisma validate \
    --schema=api/prisma/schema.prisma
Prisma schema loaded from prisma/schema.prisma
The schema at prisma/schema.prisma is valid 🚀
```

Exit code: 0.

## 4. Migration apply result (fresh DB)

A clean MySQL 8.0.40 container was started on `127.0.0.1:33307`, bootstrap files from `infra/mysql/init/` mounted, and `prisma migrate deploy` was invoked.

```
$ DATABASE_URL=mysql://root:***@127.0.0.1:33307/vici2 \
    npx prisma migrate deploy --schema=api/prisma/schema.prisma

8 migrations found in prisma/migrations
Applying migration `20260506201114_init`
Applying migration `20260506201500_partition_log_tables`
Applying migration `20260506201600_drop_partition_fks`
Applying migration `20260506201700_audit_grants`
Applying migration `20260506201800_pause_codes_unique`
Applying migration `20260506204550_f02_amendments`
Applying migration `20260506204600_partition_amendment_tables`
Applying migration `20260506204700_audit_grants_amendments`
All migrations have been successfully applied.
```

Exit code: 0.

### Post-apply DB inspection

- 8 partitioned tables × 6 partitions each (`p_pre`, `p_2026_05..08`, `p_max`):
  `agent_log`, `audit_log`, `call_log`, `call_window_audit`, `dnc_sync_log`,
  `drop_log`, `originate_audit`, `recording_log`.
- 39 tables present total — 33 from F02 init + 6 new (`call_window_audit`,
  `dnc_sync_log`, `originate_audit`, `state_holidays`, `dnc_sync_config`,
  `campaign_status_overrides`).
- 8 immutability triggers installed: 2 each on `audit_log`, `call_window_audit`,
  `dnc_sync_log`; 2 on `originate_audit` (one-shot UPDATE + no-DELETE).
- `tenants` row `id=0` present (`__GLOBAL_DNC_SENTINEL__`, `active=0`,
  `internal_dnc_retention_years=5`).

### Smoke tests run

| Test | Expected | Result |
|------|----------|--------|
| `INSERT INTO call_window_audit (...)` then `UPDATE` | UPDATE fails with SQLSTATE 45000 | PASS |
| `INSERT INTO originate_audit (...)` with default outcome=`OTHER`, then `UPDATE outcome='SUCCESS'` (1st), then `UPDATE outcome='OTHER'` (2nd) | 1st passes, 2nd fails with SQLSTATE 45000 ("row already finalized") | PASS |
| `SELECT * FROM tenants WHERE id=0` | One row, slug `__global_dnc_sentinel__`, retention=5 | PASS |
| `bash scripts/ci/check-tenant-index-leadership.sh` (schema + DB layers) | PASS | PASS |

## 5. CI index-leadership script update

`scripts/ci/check-tenant-index-leadership.sh` was extended (per F02 PLAN §9) to:

- Add `StateHoliday`, `DncSyncConfig`, `DncSyncLog` to `EXEMPT_MODELS_REGEX`
  (no `tenant_id` — global reference / system-scoped tables).
- Add `OriginateAudit.uq_originate_audit_attempt` and
  `OriginateAudit.idx_originate_audit_call_uuid` to per-index exemptions
  (attempt_uuid global idempotency + call_log join via uuid; T04 RESEARCH §7).
- Mirror the same exemptions in the DB-level INFORMATION_SCHEMA cross-check.

## 6. Gaps deferred to downstream IMPLEMENTs

| Module | Item | Reason |
|--------|------|--------|
| D04 IMPLEMENT | Seed 4 new system statuses under `campaign_id='__SYS__'`: `TCPA`, `CONSENT_NOT_OBTAINED`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER` | D04 owns the canonical status vocabulary and the `selectable`/`humanAnswered`/`sale`/etc flag semantics; T04 IMPLEMENT needs these codes but cannot define their flags unilaterally |
| T02 IMPLEMENT | Backfill `carriers.kind` rows currently set to `telnyx` → `telnyx-creds`/`telnyx-ip` based on `carriers.register` flag | Data migration (separate from schema); F02 amendment kept ENUM widening additive only |
| C04 IMPLEMENT | Monthly partition rotation for `call_window_audit`, `dnc_sync_log`, `originate_audit` | C04 is the partition rotator owner; F02 ships current month + 3 forward + p_max sentinel |
| D05 IMPLEMENT | Encrypt secrets stored in `dnc_sync_config.config_json` via F05 KEK helper | F05 is the cipher owner |

## 7. Decision log

- **Why split into 3 migration files?** Mirrors the existing F02 init → partition split (Prisma cannot emit `PARTITION BY`). File 1 is pure ALTER + non-partitioned CREATE; file 2 is raw `CREATE TABLE … PARTITION BY`; file 3 is trigger DDL. Each file is independently re-runnable.
- **Why retain legacy `telnyx` ENUM value?** Additive-only rule; T02 IMPLEMENT data-migration retags existing rows after this amendment lands.
- **Why no FKs on the new partitioned tables?** MySQL hard rule (foreign keys on partitioned tables are not supported). Referential integrity enforced at the app layer.
- **Why a session-scoped `sql_mode` toggle for the sentinel insert?** `INSERT … VALUES (0, …)` is treated by MySQL as "use next AUTO_INCREMENT value" unless `NO_AUTO_VALUE_ON_ZERO` is set. Scoping it to the session avoids global side-effects.
- **Why no grant changes for the new audit tables?** The existing F02 init grant policy gives `vici2_app` full DML on every table except `audit_log`. Defence-in-depth at the SQL layer comes from row-level triggers — the same pattern as `20260506201700_audit_grants`. Adding table-level REVOKEs for the new audit tables would require updating `infra/mysql/init/01-databases.sql`; the trigger gate is load-bearing and sufficient (an attacker would need to DROP TRIGGER first, which requires SUPER/TRIGGER privilege not granted to `vici2_app`).
