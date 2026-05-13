# C04 — Monthly Partition Rotator — PLAN

| Field | Value |
|---|---|
| Track | Compliance / Infrastructure |
| Phase | 1 |
| Effort | 3 days |
| Owner agent type | backend-node (BullMQ cron worker) + dba (vici2_partition_admin grants) |
| Status | PLAN |
| Depends-on | F02 (partitioned tables created), F02 amendments (call_window_audit, dnc_sync_log, originate_audit), C03 (audit_log immutability, attestation gate, vici2_partition_admin user) |
| Blocks | Operational rotation of all partitioned log/audit tables |

---

## 0. TL;DR — 10-bullet decision summary

1. **BullMQ cron job** fires at `02:00 UTC on the 25th of each month`. Runs inside the existing `api` Node 20 process (no separate worker binary needed for Phase 1). Job name: `partition-rotate`.
2. **Partition naming convention**: `p_YYYY_MM` (matches F02 PLAN §3). The next partition added is always for the month *after* the currently newest named partition (excluding `p_pre` and `p_max`).
3. **Per-table transactions**: each table gets its own `ADD PARTITION` / `DROP PARTITION` DDL in sequence. Failure of one table logs the error, fires an alert, and continues to the next table (no all-or-nothing atomism — DDL cannot be rolled back in MySQL anyway).
4. **ADD before DROP**: the new partition is always added first (before `p_max` sentinel). If ADD fails, DROP is skipped for that table, guarding against the window where `p_max` would absorb next month's data temporarily while the ADD is retried.
5. **Merkle-attestation gate for immutable tables**: before dropping any partition from `audit_log`, `call_window_audit`, `dnc_sync_log`, `originate_audit`, `consent_log`, the rotator queries `audit_attestation` to confirm the last day of the partition window has a verified attestation. If absent, DROP is skipped and a `drop-blocked` alert fires.
6. **Disk-free pre-flight**: before any DROP, the rotator estimates the partition size (via `INFORMATION_SCHEMA.PARTITIONS.DATA_LENGTH + INDEX_LENGTH`) and confirms the MySQL data directory has ≥ 20% free space relative to that size. If not, DROP is skipped and a `disk-low` alert fires. (Adding a partition does not require a disk-free check — ADD only reorganises the `p_max` sentinel.)
7. **Dry-run mode**: controlled by `PARTITION_ROTATOR_DRY_RUN=true` env var (default `true` for safety). In dry-run, all SQL is logged but not executed. Admin flips to `false` after confirming first run in staging.
8. **Manual trigger**: `POST /api/admin/partition-rotate` (superadmin only). Accepts optional `{ dryRun: boolean, tables: string[] }` body for targeted operations.
9. **Audit trail**: every ADD and DROP (or skip) writes a row to `audit_log` (action `partition.add` / `partition.drop` / `partition.drop.skipped`). `vici2_partition_admin` user issues the DDL; the audit row is written by `vici2_app` before DDL executes.
10. **Alerts**: three alert types — `drop-blocked` (attestation absent), `partition-missing` (expected partition not found), `retention-violation` (partition older than window should have been dropped but wasn't). Phase 1: log at ERROR level + emit Prometheus counter `vici2_partition_alert_total{type}`. Phase 2: PagerDuty webhook.

---

## 1. Goals + non-goals

### 1.1 Goals

- **G1.** Add the next `p_YYYY_MM` partition for every managed table (ADD before `p_max`) on the 25th of each month.
- **G2.** Drop partitions that have aged out of their retention window (after attestation check + disk-free check).
- **G3.** Never silently skip — every outcome (add, drop, skip, error) is persisted to `audit_log` and emitted as a structured log line.
- **G4.** Provide dry-run mode and manual-trigger API for ops/staging confidence.
- **G5.** Prometheus metrics for operational observability.

### 1.2 Non-goals

- **NG1.** Schema creation of partitioned tables — owned by F02 and F02 amendments.
- **NG2.** Attestation computation — owned by C03. C04 only reads `audit_attestation` as a gate.
- **NG3.** S3 archival of dropped partition data — MySQL `ALTER TABLE … DROP PARTITION` physically deletes the `.ibd` file; data must be in S3 (via O02 backups) before this runs. C04 does not manage S3.
- **NG4.** `p_pre` sentinel — never dropped by C04 (contains data predating the partition scheme; archived manually).
- **NG5.** `p_max` sentinel — never dropped by C04 (it is the overflow catcher; only exists as a reference boundary).

---

## 2. Retention matrix

| Table | Partition column | Retention window | Attestation gate? | Owner spec |
|---|---|---|---|---|
| `call_log` | `call_started` | **4 years (48 months)** | No | F02 |
| `recording_log` | `start_time` | **7 years (84 months)** | No | F02 |
| `audit_log` | `ts` | **7 years (84 months)** | **Yes** | F02 / C03 |
| `agent_log` | `event_at` | **13 months** | No | F02 |
| `drop_log` | `dropped_at` | **7 years (84 months)** | No | F02 / E05 |
| `call_window_audit` | `created_at` | **4 years (48 months)** | **Yes** | F02 amendments / C01 |
| `dnc_sync_log` | `started_at` | **7 years (84 months)** | **Yes** | F02 amendments / D05 |
| `originate_audit` | `originated_at` | **7 years (84 months)** | **Yes** | F02 amendments / T04 |
| `drop_gate_transition_log` | `created_at` | **7 years (84 months)** | No | E05 |
| `import_errors` | `created_at` | **90 days** | No | D02 |
| `queue_calls` | `enqueued_at` | **90 days** | No | I01 |
| `queue_log` | `created_at` | **90 days** | No | I01 |
| `consent_log` | `created_at` | **7 years (84 months)** | **Yes** | C02 |

> **Note on tables not-yet-created**: `drop_gate_transition_log`, `queue_calls`, `queue_log`, `consent_log`, `import_errors` are planned by their owner modules. C04's table registry is data-driven; the rotator will silently skip any table whose partition metadata does not exist in `INFORMATION_SCHEMA.PARTITIONS`. This means C04 ships before those modules and gains those tables for free as they arrive.

---

## 3. Partition naming + ADD logic

### 3.1 Partition name format

`p_YYYY_MM` — e.g. `p_2026_09` for September 2026.
The `VALUES LESS THAN` boundary is the first day of `YYYY_(MM+1)`:
```
p_2026_09  VALUES LESS THAN ('2026-10-01')
```

### 3.2 ADD algorithm (per table)

1. Query `INFORMATION_SCHEMA.PARTITIONS` for all `p_YYYY_MM` partitions of the table, sorted DESC.
2. Take the newest named partition's `PARTITION_DESCRIPTION` (e.g. `'2026-09-01'`) → the target boundary for the partition to ADD is the month starting at that date.
3. Compute `nextPartitionName = p_YYYY_MM` where `YYYY-MM` is the month of `targetBoundary`.
4. Compute `nextBoundary = first day of month(targetBoundary) + 1 month` as a `YYYY-MM-DD` string.
5. SQL: `ALTER TABLE <table> REORGANIZE PARTITION p_max INTO (PARTITION p_YYYY_MM VALUES LESS THAN ('nextBoundary'), PARTITION p_max VALUES LESS THAN (MAXVALUE))`.
6. Use `REORGANIZE PARTITION` rather than `ADD PARTITION` because `p_max` (MAXVALUE) cannot coexist with a new partition without reorganization.

### 3.3 Only add if not already present

If `p_YYYY_MM` for the target month already exists in `INFORMATION_SCHEMA.PARTITIONS`, skip silently (idempotent — important for manual-trigger retries and CI runs).

---

## 4. DROP algorithm (per table)

1. Query all `p_YYYY_MM` partitions for the table, sorted ascending.
2. For each partition whose upper boundary is ≤ `(today − retentionWindow)`:
   a. If table is attestation-gated: query `audit_attestation` for `(table_name, last_day_of_window)`. If no verified row → emit `drop-blocked` alert, write audit row, **skip**.
   b. Disk-free pre-flight: query `INFORMATION_SCHEMA.PARTITIONS` for `DATA_LENGTH + INDEX_LENGTH`. Query OS disk free (`df` call or `statvfs` via native module). If disk free < 20% of partition size, emit `disk-low` alert, write audit row, **skip**.
   c. Write `audit_log` row: `action = 'partition.drop'`, `entity_type = '<table>'`, `entity_id = '<partition_name>'`.
   d. SQL: `ALTER TABLE <table> DROP PARTITION <partition_name>`.
   e. On success: write completion log line + increment `vici2_partitions_dropped_total`.
   f. On error: catch, log at ERROR, emit `partition.drop.error` alert, continue to next partition.

---

## 5. Database user

C03 PLAN §0 establishes `vici2_partition_admin` with `ALTER` privilege on partitioned tables only. C04 does **not** create this user — it is assumed to be provisioned by C03's migration. C04 uses a separate MySQL connection (pool of 1) for DDL, authenticated as `vici2_partition_admin` via `DATABASE_URL_PARTITION_ADMIN` env var.

The regular `vici2_app` connection (Prisma) is used for:
- Reading `INFORMATION_SCHEMA.PARTITIONS`
- Reading `audit_attestation`
- Writing `audit_log` rows

---

## 6. BullMQ cron job

```typescript
// Queue: vici2:queue:partition-rotate
// Cron: '0 2 25 * *'  (02:00 UTC on 25th of every month)
// Concurrency: 1 (single worker, serialized per-table)
// Job options: attempts=1, removeOnComplete=1 day, removeOnFail=7 days
```

The job is registered at server startup (same pattern as D02's import queue). The worker function calls `runPartitionRotation({ dryRun })` which is the core exported function.

---

## 7. Manual trigger API

```
POST /api/admin/partition-rotate
Authorization: Bearer <superadmin token>
Body (optional): { "dryRun": true, "tables": ["call_log", "audit_log"] }
```

Response: `{ jobId, status: "enqueued" | "dry_run_complete", results: [...] }`.

For `dryRun: true` with `tables`, the handler runs synchronously and returns the plan without enqueuing. For production runs without `dryRun`, it enqueues a BullMQ job.

---

## 8. Alerts

| Alert type | Condition | Severity | Metric label |
|---|---|---|---|
| `drop-blocked` | Attestation absent for partition window | SEV2 | `type="drop_blocked"` |
| `disk-low` | Disk free < 20% of partition size | SEV2 | `type="disk_low"` |
| `partition-missing` | Expected `p_YYYY_MM` absent after ADD | SEV1 | `type="partition_missing"` |
| `retention-violation` | Partition is >7 days past its drop deadline | SEV2 | `type="retention_violation"` |
| `drop-error` | DDL `DROP PARTITION` threw an exception | SEV1 | `type="drop_error"` |

Phase 1: `pino` logger at `error` level + Prometheus counter `vici2_partition_alert_total{type}`.
Phase 2: POST to `ALERT_WEBHOOK_URL` env var (PagerDuty/Slack).

---

## 9. Prometheus metrics

| Metric | Type | Labels |
|---|---|---|
| `vici2_partitions_added_total` | Counter | `table` |
| `vici2_partitions_dropped_total` | Counter | `table` |
| `vici2_partitions_skipped_total` | Counter | `table`, `reason` |
| `vici2_partition_alert_total` | Counter | `type` |
| `vici2_partition_rotate_duration_seconds` | Histogram | `table` |
| `vici2_partition_rotate_run_total` | Counter | `status` (`ok`, `error`, `dry_run`) |

---

## 10. Dependencies

| Dependency | What C04 needs | Status |
|---|---|---|
| F02 `partition_log_tables` migration | Partitioned tables with `p_max` | DONE |
| F02 amendments `partition_amendment_tables` | `call_window_audit`, `dnc_sync_log`, `originate_audit` | DONE |
| C03 `vici2_partition_admin` user | `ALTER` privilege for DDL | PLAN (grants) |
| C03 `audit_attestation` table | Attestation gate reads | PLAN |
| BullMQ (already in `package.json`) | Cron job scheduler | DONE |
| `prom-client` (already in `package.json`) | Metrics | DONE |
| `mysql2` (transitive via Prisma) | Raw DDL connection | Available |

---

## 11. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| `REORGANIZE PARTITION` on large table takes > 5 minutes | Medium | Run at 02:00 UTC (low-traffic window); set `NET_WRITE_TIMEOUT=600` on partition_admin connection; monitor with BullMQ job timeout = 10 min |
| Attestation row absent because C03 worker was down | Low | `drop-blocked` alert fires; human reviews; manually trigger after attestation confirmed |
| `p_max` corruption from concurrent ADD | Very Low | BullMQ concurrency=1; only one cron instance runs at a time |
| 90-day tables generate many partitions at once (catch-up) | Low | DROP loop handles multiple partitions per run; bounded by retention window |
| Tables owned by future modules not yet created | Certain (by design) | Table registry checks `INFORMATION_SCHEMA.PARTITIONS` first; unknown tables are no-ops |
| Disk estimation inaccurate (InnoDB buffer pool effects) | Low | 20% threshold is conservative; documented as "estimate" in alerts |

---

## 12. File structure

```
api/src/services/partition/
  index.ts                  — public API: runPartitionRotation, registerPartitionRotateJob
  registry.ts               — TABLE_REGISTRY constant (retention matrix, attestation flags)
  rotator.ts                — core ADD + DROP logic per table
  attestation-gate.ts       — query audit_attestation for partition window
  disk-check.ts             — OS disk free pre-flight
  metrics.ts                — Prometheus counters + histograms
  admin-route.ts            — POST /api/admin/partition-rotate route handler

api/src/services/partition/__tests__/
  rotator.spec.ts           — unit tests (mock MySQL + happy path + retention math)
  registry.spec.ts          — retention window validation tests
  attestation-gate.spec.ts  — gate logic tests
  disk-check.spec.ts        — disk check logic tests
```

---

## 13. Audit-log contract

Every ADD, DROP, skip, and error writes to `audit_log`:

| Field | Value |
|---|---|
| `actor_kind` | `worker` |
| `actor_user_id` | NULL |
| `action` | `partition.add` / `partition.drop` / `partition.drop.skipped` / `partition.add.error` / `partition.drop.error` |
| `entity_type` | table name (e.g. `call_log`) |
| `entity_id` | partition name (e.g. `p_2026_05`) |
| `after_json` | `{ "dryRun": bool, "reason"?: string, "boundaryDate": "YYYY-MM-01" }` |

---

## 14. Migration validation script

`scripts/validate-partitions.ts` — reads `INFORMATION_SCHEMA.PARTITIONS` for all managed tables and checks:
1. Every table has a `p_max` partition.
2. No partition is older than its retention window + 7-day grace period.
3. Partition names follow the `p_YYYY_MM` convention.
4. No gap in partition sequence (consecutive months, no missing months).

Exits non-zero if any check fails. Intended for CI and post-deploy health checks.

---

## 15. Open issues / Phase 2

| Item | Phase |
|---|---|
| PagerDuty / Slack webhook for alerts | 2 |
| Trillian / blockchain root anchoring | 4 |
| `p_pre` archival procedure | 2 |
| Per-tenant retention override (regulatory hold) | 3 |
| Automated S3 export before DROP (O02 integration) | 2 |
| Partition rotate status dashboard (Grafana) | 2 |
| `queue_calls` + `queue_log` tables (I01 must ship first) | I01 |
| `consent_log` (C02 must ship first) | C02 |
| `drop_gate_transition_log` (E05 must ship first) | E05 |
| `import_errors` (D02 must ship first) | D02 |
