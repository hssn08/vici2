# F02 Amendments — HANDOFF

| Field | Value |
|-------|-------|
| Branch | `feat/F02-amendments` (additive; merged to `main` via `--no-ff`) |
| Migrations added | 3 (timestamps `20260506204550`, `20260506204600`, `20260506204700`) |
| Source modules consolidated | C01 / T02 / D01 / D05 / E01 / T04 |
| Net additions | 6 new tables · 24 new columns · 2 new enums on existing tables · 9 brand-new enums · 8 new immutability triggers |
| Hard rules upheld | ADDITIVE only · `tenant_id` index leadership · partitioned tables have no FKs · partitioned tables use composite PK including partition column |

## 1. New tables (6)

| Table | Owner module | Partitioned? | Mutability | Notes |
|-------|--------------|--------------|------------|-------|
| `call_window_audit` | C01 | yes, monthly RANGE COLUMNS(`created_at`) | INSERT-only (triggers `_no_update`, `_no_delete`) | 4y retention; TCPA per-decision evidence; written by E01 hopper filler, T04 originate path, A04 manual dial |
| `state_holidays` | C01 | no | full DML (admin-editable lookup) | Global reference (no `tenant_id`); ~150 rows over 5y for all US states |
| `dnc_sync_config` | D05 | no | full DML (admin-editable cron config) | PK = `source` VARCHAR(32); examples: `federal`, `state:TX`, `litigator` |
| `dnc_sync_log` | D05 | yes, monthly RANGE COLUMNS(`started_at`) | INSERT-only (triggers `_no_update`, `_no_delete`) | 7y retention; sync run summaries (added/removed/error_count) |
| `originate_audit` | T04 | yes, monthly RANGE COLUMNS(`originated_at`) | INSERT + one-shot UPDATE (trigger `_one_shot_update`) | 7y retention; 30 cols; `attempt_uuid` is global idempotency key; UNIQUE (`attempt_uuid`, `originated_at`) |
| `campaign_status_overrides` | E01 | no | full DML (admin override config) | Composite PK (`tenant_id`, `campaign_id`, `status_code`); FK to `campaigns(tenant_id, id)` ON DELETE CASCADE |

## 2. New columns on existing tables (24 across 5 tables)

### `tenants` (+1)

| Column | Type | Default | Source |
|--------|------|---------|--------|
| `internal_dnc_retention_years` | SMALLINT | `5` | D05.4 |

Plus: row `id=0` with `name='__GLOBAL_DNC_SENTINEL__'` inserted via INSERT IGNORE under session `NO_AUTO_VALUE_ON_ZERO`.

### `campaigns` (+16)

| Column | Type | Default | Source |
|--------|------|---------|--------|
| `unknown_tz_policy` | ENUM(`deny`,`warn_pass`) | `deny` | C01.3 |
| `dial_level` | DECIMAL(4,2) | `1.50` | E01.1 |
| `lock_ttl_sec` | SMALLINT | `30` | E01.3 |
| `min_hopper_level` | INT | `50` | E01.4 |
| `max_hopper_level` | INT | `5000` | E01.5 |
| `hopper_buffer_multiplier` | DECIMAL(3,1) | `1.5` | E01.6 |
| `recycle_delay_seconds` | INT | `600` | E01.7 |
| `max_calls_per_lead` | TINYINT | `5` | E01.8 |
| `dial_statuses` | JSON | `JSON_ARRAY('NEW','NA','B','CALLBK')` | E01.9 |
| `low_water_pct` | TINYINT | `25` | E01.10 |
| `high_water_pct` | TINYINT | `90` | E01.11 |
| `over_fetch_ratio` | DECIMAL(3,1) | `1.5` | E01.12 |
| `machine_terminal` | BOOLEAN | `true` | E01.13 |
| `lead_filter_sql` | TEXT | NULL | E01.14 |
| `multi_list_mix` | ENUM(`EVEN`,`MULTI`,`NONE`) | `EVEN` | E01.15 |

### `carriers` (+5)

| Column | Type | Default | Source |
|--------|------|---------|--------|
| `send_pai` | BOOLEAN | `false` | T02.2 |
| `is_emergency` | BOOLEAN | `false` | T02.3 |
| `max_concurrent` | INT | NULL | T02.4 |
| `notes` | JSON | `JSON_OBJECT()` | T02.5 |
| `version` | INT | `1` | T02.6 |

Plus `carriers.kind` ENUM widened from 5 → 9 values (one legacy `telnyx` retained for back-compat; T02 IMPLEMENT retags rows).

### `gateways` (+4)

| Column | Type | Default | Source |
|--------|------|---------|--------|
| `weight` | SMALLINT | `100` | T02.7 |
| `max_concurrent` | INT | NULL | T02.8 |
| `version` | INT | `1` | T02.9 |
| `cost_per_min_cents` | INT | NULL | T02.10 |

### `leads` (+2)

| Column | Type | Default | Source |
|--------|------|---------|--------|
| `tz_blocked` | BOOLEAN | `false` | C01.4 |
| `version` | SMALLINT | `1` | D01.1 (optimistic-lock token; D01 PLAN §13.1 PATCH `If-Match`) |

### `lists` (+2)

| Column | Type | Default | Source |
|--------|------|---------|--------|
| `caller_id_override` | VARCHAR(16) | NULL | T04.3 |
| `caller_id_name` | VARCHAR(32) | NULL | T04.4 |

## 3. ENUM widening on existing tables

| Table.column | Old values (5) | New values (9; +4 + 1 legacy retained) |
|--------------|----------------|----------------------------------------|
| `carriers.kind` | `twilio`, `telnyx`, `signalwire`, `ringcentral`, `byoc` | `twilio`, `telnyx` (legacy), `telnyx-creds`, `telnyx-ip`, `signalwire`, `ringcentral`, `bandwidth`, `flowroute`, `byoc` |

## 4. New enums (Prisma) introduced

| Enum | Values | Used by |
|------|--------|---------|
| `UnknownTzPolicy` | `deny`, `warn_pass` | `campaigns.unknown_tz_policy` |
| `MultiListMix` | `EVEN`, `MULTI`, `NONE` | `campaigns.multi_list_mix` |
| `CwaDecision` | `ALLOW`, `ALLOW_WARN`, `SKIP_UNTIL`, `BLOCK_INVALID` | `call_window_audit.decision` |
| `CwaTzConfidence` | `KNOWN`, `ZIP`, `NXX`, `NPA`, `STATE_DEFAULT`, `CAMPAIGN_DEFAULT`, `NONE` | `call_window_audit.tz_confidence` |
| `CwaEnforcementPoint` | `hopper_filler`, `originate_path`, `pacing`, `manual_dial` | `call_window_audit.enforcement_point` |
| `DncSyncCadence` | `daily`, `weekly`, `monthly`, `quarterly` | `dnc_sync_config.cadence` |
| `DncSyncKind` | `delta`, `full`, `bulk` | `dnc_sync_log.kind` |
| `DncSyncOutcome` | `success`, `partial`, `failed` | `dnc_sync_log.outcome` |
| `OriginateMode` | `PROGRESSIVE`, `PREDICTIVE`, `MANUAL`, `PREVIEW` | `originate_audit.mode` |
| `OriginateDialTarget` | `CONFERENCE`, `PARK` | `originate_audit.dial_target` |
| `OriginateCidSource` | `per_call`, `per_list`, `local_presence`, `campaign_default` | `originate_audit.caller_id_source` |
| `OriginateTcpaDecision` | `ALLOW`, `BLOCK`, `SKIP` | `originate_audit.tcpa_decision` |
| `OriginateDncDecision` | `ALLOW`, `BLOCK` | `originate_audit.dnc_decision` |
| `OriginateConsentDecision` | `ALLOW`, `PROMPT`, `SKIP_RECORDING`, `BLOCK` | `originate_audit.consent_decision` |
| `OriginateOutcome` | `SUCCESS`, `TCPA_BLOCKED`, `DNC_BLOCKED`, `CONSENT_BLOCKED`, `GATEWAY_LIMIT`, `RATE_LIMITED`, `GATEWAY_FAIL`, `TIMEOUT`, `JOB_ORPHANED`, `OTHER` (4 new originate-fail statuses) | `originate_audit.outcome` |

## 5. Immutability triggers added (8 — 3 tables)

All triggers `SIGNAL SQLSTATE '45000'`; partition rotation by C04 uses `ALTER TABLE … DROP PARTITION` (DDL) which does NOT fire row-level triggers, so retention remains possible.

| Table | Trigger | Event | Behaviour |
|-------|---------|-------|-----------|
| `call_window_audit` | `call_window_audit_no_update` | BEFORE UPDATE | Always rejects |
| `call_window_audit` | `call_window_audit_no_delete` | BEFORE DELETE | Always rejects |
| `dnc_sync_log` | `dnc_sync_log_no_update` | BEFORE UPDATE | Always rejects |
| `dnc_sync_log` | `dnc_sync_log_no_delete` | BEFORE DELETE | Always rejects |
| `originate_audit` | `originate_audit_one_shot_update` | BEFORE UPDATE | Rejects if `OLD.outcome != 'OTHER'` OR `OLD.outcome_at IS NOT NULL` — i.e. row already finalized |
| `originate_audit` | `originate_audit_no_delete` | BEFORE DELETE | Always rejects |

## 6. CI / lint changes

| File | Change |
|------|--------|
| `scripts/ci/check-tenant-index-leadership.sh` | Added `StateHoliday`, `DncSyncConfig`, `DncSyncLog` to `EXEMPT_MODELS_REGEX` (no `tenant_id` column). Added `originate_audit.uq_originate_audit_attempt` and `originate_audit.idx_originate_audit_call_uuid` to per-index exemptions (attempt-uuid global idempotency + call_uuid join with `call_log`). DB-level INFORMATION_SCHEMA query mirrors these exemptions. |

## 7. Downstream modules unblocked

| Module | What it can now build |
|--------|------------------------|
| C01 IMPLEMENT | TCPA gate (`Check API`) reads `campaigns.unknown_tz_policy`, surfaces `tz_blocked` leads to M03, writes every decision to `call_window_audit`. Admin lookup of `state_holidays`. |
| C04 IMPLEMENT | Partition rotator covers `call_window_audit`, `dnc_sync_log`, `originate_audit` in addition to the original 5 log tables. |
| D01 IMPLEMENT | `PATCH /api/leads/:id` optimistic-lock via `If-Match: <version>` → SQL `WHERE version=? AND id=?`; bumps `version` atomically. |
| D04 IMPLEMENT | Seed 4 new system statuses (`TCPA`, `CONSENT_NOT_OBTAINED`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`) under `campaign_id='__SYS__'`. **Open**: D04 owns the `selectable`/`humanAnswered`/`sale`/`callback`/`notInterested`/`hotkey` flags for each. |
| D05 IMPLEMENT | Cron-driven sync (`dnc_sync_config.cadence` + `next_run_at`); each run inserts one row into `dnc_sync_log`. Internal DNC retention = `tenants.internal_dnc_retention_years`. Federal/state/litigator DNC rows live under `tenant_id=0` (sentinel). |
| E01 IMPLEMENT | Hopper-filler reads the 16 new `campaigns.*` columns. Per-campaign-per-status overrides via `campaign_status_overrides`. |
| T02 IMPLEMENT | Carrier admin UI surfaces `send_pai`, `is_emergency`, `max_concurrent`, `notes`, `version`. Gateway distributor (Phase 2) uses `gateways.weight` + `max_concurrent` + `cost_per_min_cents`. Data-migration step retags `kind='telnyx'` rows → `telnyx-creds` / `telnyx-ip`. |
| T04 IMPLEMENT | Insert `originate_audit` row BEFORE T01.Originate (outcome=`OTHER`); finalize via one-shot UPDATE after BACKGROUND_JOB. `attempt_uuid` is the dial pipeline idempotency key. Per-list `caller_id_override` in the 4-tier waterfall. |
| F03/F04/F05 | No direct dependencies on these amendments. F05 may persist its own KEK metadata; `dnc_sync_config.config_json` holds source-API secrets via F05 KEK helper. |

## 8. Not in scope for this amendment (deferred)

| Item | Why | Owner |
|------|-----|-------|
| Seed 4 new system statuses (`TCPA`, `CONSENT_NOT_OBTAINED`, `CARRIER_FAIL`, `GATEWAY_LIMIT_TRY_LATER`) | D04 owns the canonical status vocabulary semantics | D04 PLAN/IMPLEMENT |
| Backfill `carriers.kind='telnyx'` rows | Data migration; additive amendment only widens ENUM | T02 IMPLEMENT |
| Monthly partition rotation for new audit tables | C04 is the rotator owner | C04 IMPLEMENT |
| `dnc_sync_config.config_json` envelope encryption | F05 cipher | F05 / D05 IMPLEMENT |
| Audit-log row generation for `campaign_status_overrides` / `state_holidays` / `dnc_sync_config` mutations | Standard `audit_log` ingestion at the API layer | F03 / D04 / D05 IMPLEMENT |

## 9. Re-running these migrations

All three new migration files are idempotent (`CREATE TABLE IF NOT EXISTS` is not used because Prisma needs the table not to exist; however `prisma migrate deploy` only re-applies migrations not yet recorded in `_prisma_migrations`). The trigger migration uses `DROP TRIGGER IF EXISTS` before `CREATE TRIGGER`, so the trigger DDL is safe to re-run if Prisma is bypassed.

Tested fresh: starting from an empty DB, `prisma migrate deploy` applies all 8 migrations cleanly (3 init + 2 partition + 3 amendment files).
