# O02 — Backup + Restore — PLAN.md

**Module:** O02 (Operations, Phase 1)
**Author:** O02 PLAN sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** PROPOSED — awaiting orchestrator/human review.
**Companion:** [RESEARCH.md](./RESEARCH.md) — 40+ citations behind every
choice below.

This plan turns the O02 spec + RESEARCH findings into the exact tooling
choice, script contracts, S3 layout, encryption story, retention policy,
restore procedure, RTO/RPO targets, hand-offs, risks, and acceptance
criteria the IMPLEMENT phase will deliver. Once approved, the public
interfaces (script CLI args, S3 layout, KEK alias, metric names) are
FROZEN — changes require RFC.

---

## 0. TL;DR (10 bullets)

1. **MySQL Phase 1: `mysqldump --single-transaction --quick --routines
   --triggers --events --hex-blob --set-gtid-purged=OFF` piped to `zstd`,
   uploaded with `aws s3 cp --sse aws:kms --sse-kms-key-id
   alias/vici2-backup-kek`.** Phase 2 swaps to Percona XtraBackup once
   the DB exceeds ~50 GB or restore time exceeds RTO; full
   migration playbook documented as a side-doc, not implemented Phase 1.
2. **Valkey: `valkey-cli BGSAVE` + poll `LASTSAVE` until completion +
   copy `dump.rdb` out + `zstd` + S3.** AOF stays on host; not shipped.
3. **FreeSWITCH: `tar -czf` of `/etc/freeswitch` excluding `tls/`** (TLS
   secrets backed up via O05's separate pipeline).
4. **S3 layout:** `s3://vici2-backups/<env>/<service>/<YYYY>/<MM>/<DD>/<artifact>{,.sha256}`.
   SSE-KMS with dedicated `alias/vici2-backup-kek` (separate from app
   KEK). CRR on for prod, off for staging.
5. **Lifecycle:** STANDARD → STANDARD_IA at 30d → GLACIER_IR at 90d →
   DEEP_ARCHIVE at 365d (yearly only) → expire (30d daily / 13mo
   monthly / 4yr yearly), driven by `backup_class` object tag.
6. **Scheduler:** systemd timers at 02:00 UTC nightly on Phase 1 host
   (Persistent=true, RandomizedDelaySec=300s). Phase 4 swaps to k8s
   `CronJob`; identical script bodies.
7. **Restore script:** `scripts/restore/from-s3.sh --service mysql|valkey|freeswitch
   --date YYYY-MM-DD [--target staging|prod-emergency]`. Verifies
   sibling SHA256 before decompression. Prod-emergency requires
   explicit `--confirm-destroy`.
8. **Restore-test cron:** weekly automated restore of latest MySQL dump
   to disposable staging instance; emits `vici2_restore_test_rto_seconds`
   + `vici2_restore_test_failures_total`. Alerts at >60min RTO or any
   failure.
9. **RTO/RPO targets:** RPO 24h, RTO < 60min for MySQL (<10GB Phase 1).
   Documented in `spec/runbooks/restore.md` with per-service numbers
   and procedure to measure on demand.
10. **Hand-offs:** F02 needs `vici2_backup` MySQL user; F04 needs no
    new permission Phase 1; F03 lends `/etc/freeswitch` exclusion list;
    O01 consumes `vici2_backup_*` Prom metrics; O04 wires CI dry-run;
    O05 owns KEK rotation; C04 must NOT overlap 02:00–02:30 UTC.

---

## 1. Tooling decision

| Service | Phase 1 tool | Phase 2 tool | Why |
|---|---|---|---|
| **MySQL** | `mysqldump` + `zstd` + `aws s3 cp` | Percona XtraBackup + binlog streaming for PITR | Logical dump is portable, zero new deps, sufficient for ≤10 GB; XtraBackup adds PITR + faster restore once DB grows. |
| **Valkey** | `valkey-cli BGSAVE` + RDB → S3 | unchanged (Sentinel replica RDB ship) | RDB is the canonical recoverable artifact; AOF is journaling, not a backup. |
| **FreeSWITCH config** | `tar -czf /etc/freeswitch` minus `tls/` | unchanged | Configs are mostly in git; tarball is insurance. |
| **Encryption at rest** | SSE-KMS `alias/vici2-backup-kek` | unchanged + S3 Object Lock evaluation | KMS key history makes rotation cheap. |
| **Compression** | `zstd -3` (daily), `zstd -19` (monthly/yearly) | unchanged | Best ratio + speed, lowest CPU. |
| **Cross-region replication** | S3 CRR on for prod | unchanged | Operationally trivial; satisfies 3-2-1 offsite. |
| **Scheduler** | systemd timers | k8s `CronJob` | Reliable + missed-run catch-up. |
| **Integrity** | sibling `.sha256` + S3 native checksum | unchanged | Decoupled from S3, portable. |
| **Restore-test cadence** | weekly | weekly + quarterly cross-region drill | Cheap, catches regressions early. |

Backup tool is **not** `restic` (deduplication ratio collapses on
nightly-changing zstd output — see RESEARCH §8). Backup tool is **not**
AWS Backup service (couples us to AWS; we don't use any AWS-native
storage primitives).

---

## 2. `scripts/backup/mysql.sh` — full contract

### 2.1 Invocation

```bash
scripts/backup/mysql.sh \
  --env prod|staging|dev \
  --archive-class daily|monthly|yearly \
  [--db-host vici2_mysql] \
  [--db-port 3306] \
  [--db-name vici2] \
  [--bucket vici2-backups] \
  [--kek-alias alias/vici2-backup-kek] \
  [--dry-run]
```

Defaults pulled from env vars when flags omitted (`VICI2_ENV`,
`VICI2_DB_HOST`, etc., per `.env.example` convention).

### 2.2 Behaviour

1. Resolve credentials. The script reads MySQL credentials from
   `~/.my.cnf` of the `vici2-backup` Linux user OR from
   `/etc/vici2/mysql-backup.cnf` (mode 0600, owner `vici2-backup`).
   No password ever appears on the command line (rejects `-p<pass>`).
2. Compute timestamps:
   - `TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)`
   - `YYYY=$(date -u +%Y)`, `MM=$(date -u +%m)`, `DD=$(date -u +%d)`.
3. Choose zstd level: `-3` for `daily`, `-19` for `monthly` and `yearly`.
4. Stream the dump:
   ```bash
   mysqldump \
     --defaults-extra-file="${MYSQL_CNF}" \
     --host="${DB_HOST}" --port="${DB_PORT}" \
     --single-transaction \
     --quick \
     --routines \
     --triggers \
     --events \
     --hex-blob \
     --set-gtid-purged=OFF \
     --skip-lock-tables \
     --default-character-set=utf8mb4 \
     --no-autocommit \
     --databases "${DB_NAME}" \
     | zstd "-${ZSTD_LEVEL}" -c \
     | tee >(sha256sum > /tmp/dump.sha256) \
     | aws s3 cp - "s3://${BUCKET}/${ENV}/mysql/${YYYY}/${MM}/${DD}/dump-${TS}.sql.zst" \
         --sse aws:kms --sse-kms-key-id "${KEK_ALIAS}" \
         --checksum-algorithm sha256 \
         --metadata "service=mysql,env=${ENV},archive_class=${ARCHIVE_CLASS},kek_version=1,backup_tool=mysqldump,backup_tool_version=$(mysqldump --version | awk '{print $3}')" \
         --tagging "backup_class=${ARCHIVE_CLASS}&service=mysql&env=${ENV}"
   ```
5. Upload sibling SHA256:
   ```bash
   aws s3 cp /tmp/dump.sha256 \
     "s3://${BUCKET}/${ENV}/mysql/${YYYY}/${MM}/${DD}/dump-${TS}.sql.zst.sha256" \
     --sse aws:kms --sse-kms-key-id "${KEK_ALIAS}" \
     --tagging "backup_class=${ARCHIVE_CLASS}&service=mysql&env=${ENV}"
   ```
6. Emit Prom metrics via the textfile collector convention:
   `/var/lib/node_exporter/textfile_collector/vici2_backup_mysql.prom`:
   ```
   vici2_backup_last_success_timestamp{service="mysql",env="prod"} 1746497345
   vici2_backup_size_bytes{service="mysql",env="prod"} 4823432111
   vici2_backup_duration_seconds{service="mysql",env="prod"} 312
   vici2_backup_failures_total{service="mysql",env="prod"} 0
   ```
   On failure, `vici2_backup_failures_total` increments and exit code != 0.
7. Emit a structured JSON log line to stdout (captured by journald):
   ```json
   {"ts":"2026-05-06T02:05:31Z","level":"info","service":"vici2-backup",
    "module":"O02","backup_service":"mysql","env":"prod",
    "archive_class":"daily","s3_uri":"s3://...","size_bytes":4823432111,
    "duration_sec":312,"sha256":"abc...","msg":"backup completed"}
   ```

### 2.3 Failure modes + handling

- `mysqldump` exits non-zero (e.g., MDL contention with DDL): script
  exits non-zero; sidecar SHA256 NOT uploaded; metric increments
  `vici2_backup_failures_total{reason="mysqldump"}`.
- `zstd` exits non-zero (rare; usually OOM): same — clean abort.
- `aws s3 cp` exits non-zero (transient network): retry up to 3 times
  with exponential backoff (1s, 4s, 16s); fail after 3rd attempt.
- KMS access denied: hard fail; do not retry; alert immediately
  (someone broke the IAM policy).

### 2.4 Dry-run mode

`--dry-run` runs the entire pipeline but pipes to `wc -c` instead of
`aws s3 cp`. Confirms mysqldump connects, output is non-empty, zstd
works. Used by O04 CI as a smoke test on every PR.

### 2.5 File path

`scripts/backup/mysql.sh` (per F01 PLAN §4.1 + O02.md spec).
Bash, shellcheck-clean, `set -euo pipefail`, structured logging.

---

## 3. `scripts/backup/valkey.sh` — full contract

### 3.1 Invocation

```bash
scripts/backup/valkey.sh \
  --env prod|staging|dev \
  --archive-class daily|monthly|yearly \
  [--valkey-host vici2_valkey] \
  [--valkey-port 6379] \
  [--valkey-password "$VALKEY_PASSWORD"] \
  [--data-dir /var/lib/docker/volumes/vici2_valkey_data/_data] \
  [--bucket vici2-backups] \
  [--kek-alias alias/vici2-backup-kek] \
  [--dry-run]
```

### 3.2 Behaviour

1. Read pre-save LASTSAVE: `PRE=$(valkey-cli LASTSAVE)`.
2. Trigger BGSAVE: `valkey-cli BGSAVE` (expect `Background saving
   started` reply).
3. Poll until success or 10-minute timeout:
   ```bash
   for i in $(seq 1 300); do
     POST=$(valkey-cli LASTSAVE)
     STATUS=$(valkey-cli INFO persistence | awk -F: '/^rdb_last_bgsave_status:/{print $2}' | tr -d '\r\n')
     if [ "$POST" -gt "$PRE" ] && [ "$STATUS" = "ok" ]; then break; fi
     sleep 2
   done
   [ "$POST" -gt "$PRE" ] || { echo "BGSAVE timeout"; exit 1; }
   ```
4. Locate `dump.rdb`:
   - In Docker dev: `docker cp vici2_valkey:/data/dump.rdb /tmp/dump.rdb`.
   - In bare-metal Phase 2+: `cp ${DATA_DIR}/dump.rdb /tmp/dump.rdb`.
5. Compute SHA256 of the uncompressed RDB (so the verifier can `zstd -d`
   and re-hash without bothering about compressor determinism):
   ```bash
   sha256sum /tmp/dump.rdb | awk '{print $1}' > /tmp/dump.rdb.sha256
   ```
6. Compress + upload:
   ```bash
   zstd "-${ZSTD_LEVEL}" -c < /tmp/dump.rdb \
     | aws s3 cp - "s3://${BUCKET}/${ENV}/valkey/${YYYY}/${MM}/${DD}/dump-${TS}.rdb.zst" \
         --sse aws:kms --sse-kms-key-id "${KEK_ALIAS}" \
         --metadata "service=valkey,env=${ENV},archive_class=${ARCHIVE_CLASS},kek_version=1" \
         --tagging "backup_class=${ARCHIVE_CLASS}&service=valkey&env=${ENV}"
   aws s3 cp /tmp/dump.rdb.sha256 \
     "s3://${BUCKET}/${ENV}/valkey/${YYYY}/${MM}/${DD}/dump-${TS}.rdb.sha256" \
     --sse aws:kms --sse-kms-key-id "${KEK_ALIAS}" \
     --tagging "backup_class=${ARCHIVE_CLASS}&service=valkey&env=${ENV}"
   ```
7. `rm /tmp/dump.rdb /tmp/dump.rdb.sha256`.
8. Emit Prom metrics + JSON log (parallels §2.6).

### 3.3 fork-OOM mitigation

The script exits with a clear error message if `BGSAVE` returns
`ERR Background save already in progress` (a previous backup or the
auto-save schedule already started one) — operator action: wait, then
retry.

PLAN includes a `scripts/backup/preflight-host.sh` (one-shot) that
asserts `vm.overcommit_memory=1` on the host and prints a remediation
message if not. Run by `make dev` first time.

### 3.4 File path

`scripts/backup/valkey.sh` (note: filename is `valkey.sh`, not
`redis.sh` per O02.md spec — the spec was written before F04 settled
on Valkey, but PLAN aligns to F04's naming. We accept the spec drift
as a cosmetic delta documented in HANDOFF.md.)

A symlink `scripts/backup/redis.sh -> valkey.sh` is created for
back-compat with the spec.

---

## 4. `scripts/backup/freeswitch-config.sh` — full contract

### 4.1 Invocation

```bash
scripts/backup/freeswitch-config.sh \
  --env prod|staging|dev \
  --archive-class daily|monthly|yearly \
  [--source /etc/freeswitch] \
  [--bucket vici2-backups] \
  [--kek-alias alias/vici2-backup-kek] \
  [--dry-run]
```

### 4.2 Behaviour

1. Verify `/etc/freeswitch` exists and is readable.
2. Tar + gzip + upload (single pipeline, no temp file):
   ```bash
   tar --exclude='./tls' \
       --exclude='./*/tls' \
       --exclude='*.gitkeep' \
       --exclude='*.bak' \
       --exclude='*~' \
       -C "${SOURCE}" \
       -czf - . \
     | tee >(sha256sum > /tmp/etc-fs.sha256) \
     | aws s3 cp - "s3://${BUCKET}/${ENV}/freeswitch/${YYYY}/${MM}/${DD}/etc-freeswitch-${TS}.tar.gz" \
         --sse aws:kms --sse-kms-key-id "${KEK_ALIAS}" \
         --metadata "service=freeswitch,env=${ENV},archive_class=${ARCHIVE_CLASS}" \
         --tagging "backup_class=${ARCHIVE_CLASS}&service=freeswitch&env=${ENV}"
   aws s3 cp /tmp/etc-fs.sha256 \
     "s3://${BUCKET}/${ENV}/freeswitch/${YYYY}/${MM}/${DD}/etc-freeswitch-${TS}.tar.gz.sha256" \
     --sse aws:kms --sse-kms-key-id "${KEK_ALIAS}" \
     --tagging "backup_class=${ARCHIVE_CLASS}&service=freeswitch&env=${ENV}"
   ```
3. Emit Prom metrics + JSON log.

### 4.3 Why gzip not zstd

Tarball is small (<1 MB, mostly XML config files). `gzip` is universally
present at restore time without dependency surprises. Cost saving from
zstd is single-digit kilobytes — not worth the dep.

### 4.4 File path

`scripts/backup/freeswitch-config.sh`.

---

## 5. `scripts/restore/from-s3.sh` — full contract

### 5.1 Invocation

```bash
scripts/restore/from-s3.sh \
  --service mysql|valkey|freeswitch \
  --date YYYY-MM-DD \
  [--archive-class daily|monthly|yearly]   # picks newest if omitted
  [--target staging|prod-emergency|local]  # default staging
  [--env prod|staging|dev]                 # source env to restore from
  [--bucket vici2-backups] \
  [--confirm-destroy]                       # required for prod-emergency
```

### 5.2 Behaviour (per service)

#### MySQL restore

1. List artifacts: `aws s3 ls s3://${BUCKET}/${ENV}/mysql/${YYYY}/${MM}/${DD}/`.
   If `--archive-class` set, filter by tag (downloads tags via `head-object`).
2. Pick most recent (or only) matching artifact.
3. Download artifact + `.sha256`.
4. Verify integrity:
   ```bash
   ARTIFACT_HASH=$(sha256sum dump.sql.zst | awk '{print $1}')
   EXPECTED_HASH=$(awk '{print $1}' dump.sql.zst.sha256)
   [ "$ARTIFACT_HASH" = "$EXPECTED_HASH" ] || { echo "SHA256 mismatch — REFUSING TO RESTORE"; exit 1; }
   ```
5. Decompress: `zstd -d dump.sql.zst -o dump.sql`.
6. Pre-restore safety:
   - If `--target prod-emergency` and `--confirm-destroy` not set: exit
     with helpful message about the flag and what it does.
   - If `--target prod-emergency`: print 5-second-countdown banner with
     destination DB name, source artifact path, current row counts in
     `call_log`/`leads`/`audit_log` (so operator sees what's about to
     be replaced).
7. Restore:
   - `staging` / `local`: `mysql -h <staging-host> < dump.sql` (creates
     a fresh DB; `mysqldump` includes `CREATE DATABASE` since we used
     `--databases`).
   - `prod-emergency`: requires `--confirm-destroy`; runs `mysql -h
     <prod-host> < dump.sql`; logs every step to journald.
8. Post-restore verification:
   - Run `SELECT COUNT(*) FROM <table>` on a curated set
     (`leads`, `call_log`, `audit_log`, `users`, `campaigns`).
   - Compare with metadata stored in S3 object metadata at backup time
     (Phase 2 enhancement; Phase 1 just logs the counts).
9. Emit `vici2_restore_test_rto_seconds` + result.

#### Valkey restore

1. Download `dump.rdb.zst` + `.sha256`.
2. Verify `zstd -d` output's SHA256 matches sidecar.
3. Stop Valkey: `docker compose stop valkey` (or `systemctl stop valkey`).
4. Replace data dir's `dump.rdb`:
   ```bash
   cp dump.rdb /var/lib/docker/volumes/vici2_valkey_data/_data/dump.rdb
   chown 999:999 .../dump.rdb     # valkey UID inside container
   chmod 0640 .../dump.rdb
   ```
5. Start Valkey: `docker compose start valkey`.
6. Verify: `valkey-cli INFO persistence` (`rdb_last_load_keys_loaded` > 0)
   and `valkey-cli DBSIZE`.

#### FreeSWITCH restore

1. Download `etc-freeswitch-*.tar.gz` + `.sha256`.
2. Verify integrity.
3. Backup current `/etc/freeswitch` to `/etc/freeswitch.pre-restore-${TS}`.
4. Extract: `tar -xzf etc-freeswitch-*.tar.gz -C /etc/freeswitch/`.
5. NOTE: extraction excludes `tls/` (the tarball never contained it);
   any pre-existing `tls/` is preserved.
6. ESL reload: `fs_cli -x reloadxml` + `fs_cli -x 'sofia profile
   external rescan'`.

### 5.3 Refuse-by-default semantics

| Target | Default behavior | Override |
|---|---|---|
| `staging` (default) | restores into a disposable staging instance | n/a |
| `local` | restores into the current host's DB (dev safety) | requires interactive `y/N` confirmation |
| `prod-emergency` | refuses unless `--confirm-destroy` is set | `--confirm-destroy` flag |

A misfired `from-s3.sh --target prod-emergency` without
`--confirm-destroy` exits with:

> ERROR: --target prod-emergency requires --confirm-destroy.
> This operation will OVERWRITE the production database with the
> chosen backup. To proceed, re-run with --confirm-destroy. Make
> sure you have a fresh backup taken in the last 5 minutes (run
> scripts/backup/mysql.sh first).

### 5.4 File path

`scripts/restore/from-s3.sh`.

### 5.5 Makefile target

`make restore-from-backup BACKUP=<artifact-key>` (per O02.md spec
public interface) wraps the above with sensible defaults:

```makefile
restore-from-backup:
	@scripts/restore/from-s3.sh \
	  --service mysql \
	  --date $$(echo "$(BACKUP)" | grep -oE '[0-9]{4}/[0-9]{2}/[0-9]{2}' | tr / -) \
	  --target staging
```

---

## 6. `spec/runbooks/restore.md` — outline

PLAN content that IMPLEMENT must turn into the actual runbook:

1. **Overview** — what this runbook covers, expected RTO/RPO, who to
   call.
2. **Pre-flight checklist:**
   - Verify AWS CLI v2 installed + IAM role assumable.
   - Verify KMS key access (`aws kms describe-key --key-id alias/vici2-backup-kek`).
   - Verify destination DB/Valkey/FS reachable.
   - Verify enough disk space (3× compressed artifact size).
3. **Per-service restore procedures** — MySQL, Valkey, FreeSWITCH each
   with step-by-step commands + expected output + troubleshooting.
4. **RTO measurement procedure** — how to time a restore; where to log;
   the metric the restore-test cron emits.
5. **RPO measurement procedure** — how to compute "last successful
   backup timestamp" from S3 LIST + JSON log search; the metric to read.
6. **Cross-region failover** — restore from `vici2-backups-prod-dr`
   bucket when primary region is down.
7. **KEK rotation interaction** — what happens when KMS rotates the
   `vici2-backup-kek` (older backups remain decryptable; nothing for
   operator to do unless full re-encryption pass triggered).
8. **Rollback procedure** — how to revert a botched restore (the
   `pre-restore-${TS}` snapshot path; the prod-emergency safety net).
9. **Common errors** + fixes:
   - SHA256 mismatch (re-download or restore from prior day)
   - KMS access denied (IAM role drifted)
   - mysqldump partial restore (foreign keys / partition mismatch)
   - Valkey BGSAVE stuck (overcommit_memory=0)
10. **Contacts** — who to escalate to.

File: `spec/runbooks/restore.md`. ~300–500 lines.

---

## 7. Cron schedule (systemd timers Phase 1)

### 7.1 Files

```
/etc/systemd/system/vici2-backup-mysql.timer
/etc/systemd/system/vici2-backup-mysql.service
/etc/systemd/system/vici2-backup-mysql-monthly.timer
/etc/systemd/system/vici2-backup-mysql-monthly.service
/etc/systemd/system/vici2-backup-mysql-yearly.timer
/etc/systemd/system/vici2-backup-mysql-yearly.service
/etc/systemd/system/vici2-backup-valkey.timer
/etc/systemd/system/vici2-backup-valkey.service
/etc/systemd/system/vici2-backup-valkey-monthly.timer
/etc/systemd/system/vici2-backup-valkey-monthly.service
/etc/systemd/system/vici2-backup-freeswitch.timer
/etc/systemd/system/vici2-backup-freeswitch.service
/etc/systemd/system/vici2-restore-test.timer
/etc/systemd/system/vici2-restore-test.service
/etc/systemd/system/vici2-backup-tip-verify.timer
/etc/systemd/system/vici2-backup-tip-verify.service
```

### 7.2 Schedule

| Unit | OnCalendar | Notes |
|---|---|---|
| `vici2-backup-mysql.timer` | `*-*-* 02:00:00 UTC` | nightly daily |
| `vici2-backup-mysql-monthly.timer` | `*-*-01 02:30:00 UTC` | 1st of month |
| `vici2-backup-mysql-yearly.timer` | `*-01-01 03:00:00 UTC` | Jan 1 |
| `vici2-backup-valkey.timer` | `*-*-* 02:15:00 UTC` | nightly daily |
| `vici2-backup-valkey-monthly.timer` | `*-*-01 02:45:00 UTC` | 1st of month |
| `vici2-backup-freeswitch.timer` | `*-*-* 02:20:00 UTC` | nightly daily |
| `vici2-restore-test.timer` | `Mon *-*-* 04:00:00 UTC` | weekly |
| `vici2-backup-tip-verify.timer` | `*-*-* 02:55:00 UTC` | nightly, after all backups complete |

Every timer carries `Persistent=true` and `RandomizedDelaySec=300`.
Every service has `Type=oneshot`, `User=vici2-backup`,
`StandardOutput=journal`, `StandardError=journal`,
`TimeoutStartSec=3600`.

### 7.3 Phase 4 K8s equivalent

`infra/k8s/cronjobs/vici2-backup-mysql.yaml` etc. — same script body,
scheduler shell swapped. Documented in HANDOFF.md as a side-doc.

---

## 8. S3 layout (FROZEN once approved)

```
s3://vici2-backups-{prod|staging|dev}/
└── <env>/
    ├── mysql/
    │   └── <YYYY>/<MM>/<DD>/
    │       ├── dump-<TS>.sql.zst                  (object tag: backup_class=daily|monthly|yearly)
    │       └── dump-<TS>.sql.zst.sha256
    ├── valkey/
    │   └── <YYYY>/<MM>/<DD>/
    │       ├── dump-<TS>.rdb.zst
    │       └── dump-<TS>.rdb.sha256                (note: hash is of the UNCOMPRESSED rdb)
    └── freeswitch/
        └── <YYYY>/<MM>/<DD>/
            ├── etc-freeswitch-<TS>.tar.gz
            └── etc-freeswitch-<TS>.tar.gz.sha256
```

### 8.1 Bucket naming

- `vici2-backups-prod` (us-east-1)
- `vici2-backups-prod-dr` (us-west-2; CRR target)
- `vici2-backups-staging` (us-east-1)
- `vici2-backups-dev` (us-east-1, optional; dev usually targets MinIO)

### 8.2 Bucket-level configuration

- Versioning: ON (required for CRR).
- Default encryption: SSE-KMS with the bucket's regional KEK; bucket
  policy `Deny` any PUT without `s3:x-amz-server-side-encryption=aws:kms`.
- Public access: blocked (all 4 toggles).
- Object Lock: deferred to Phase 2 evaluation.

---

## 9. Retention policy (S3 lifecycle)

### 9.1 Rule definitions

```yaml
LifecycleConfiguration:
  Rules:
    - Id: daily-retention
      Status: Enabled
      Filter:
        Tag: { Key: backup_class, Value: daily }
      Transitions:
        - Days: 30
          StorageClass: STANDARD_IA
      Expiration:
        Days: 90

    - Id: monthly-retention
      Status: Enabled
      Filter:
        Tag: { Key: backup_class, Value: monthly }
      Transitions:
        - Days: 30
          StorageClass: STANDARD_IA
        - Days: 90
          StorageClass: GLACIER_IR
      Expiration:
        Days: 395                # 12 months + 30d slack

    - Id: yearly-retention
      Status: Enabled
      Filter:
        Tag: { Key: backup_class, Value: yearly }
      Transitions:
        - Days: 30
          StorageClass: STANDARD_IA
        - Days: 90
          StorageClass: GLACIER_IR
        - Days: 365
          StorageClass: DEEP_ARCHIVE
      Expiration:
        Days: 1460               # 4 years (TCPA window)

    - Id: abort-incomplete-mpu
      Status: Enabled
      AbortIncompleteMultipartUpload:
        DaysAfterInitiation: 7

    - Id: noncurrent-version-expiry
      Status: Enabled
      NoncurrentVersionExpiration:
        NoncurrentDays: 30
```

### 9.2 Effective coverage

- 30 daily snapshots (always in STANDARD or STANDARD_IA — instant
  retrieval).
- 12 monthly snapshots (in STANDARD_IA or GLACIER_IR — instant or
  minute-scale retrieval).
- 4 yearly snapshots (in GLACIER_IR or DEEP_ARCHIVE — 12-48h restore
  for the oldest).

### 9.3 Cost guardrail

We respect every S3 minimum-storage-duration:
- 30d in STANDARD before STANDARD_IA transition (S3 minimum: 30d).
- 90d in STANDARD_IA before GLACIER_IR transition (S3 GLACIER_IR
  minimum: 90d).
- 365d in GLACIER_IR before DEEP_ARCHIVE transition (S3 DEEP_ARCHIVE
  minimum: 180d, well exceeded).
- All expirations after the relevant minimum.

---

## 10. Encryption: SSE-KMS with `alias/vici2-backup-kek`

### 10.1 KEK provisioning (one-time, owned by O05)

- Customer-managed symmetric KMS key per environment.
- Aliases:
  - `alias/vici2-backup-kek-prod` (us-east-1) and
    `alias/vici2-backup-kek-prod-dr` (us-west-2)
  - `alias/vici2-backup-kek-staging` (us-east-1)
- Annual rotation enabled (`EnableKeyRotation`).
- Key policy grants:
  - `kms:Encrypt`, `kms:GenerateDataKey`, `kms:DescribeKey` to the
    backup-write IAM role (the role the systemd timer assumes).
  - `kms:Decrypt`, `kms:DescribeKey` to the backup-read IAM role
    (the restore script uses this).
  - `kms:ReEncrypt*` to a separate "rotation" role (used during
    O05's rotation procedure).
  - No access to root by default beyond what KMS requires
    (administrative split).
- S3 Bucket Keys enabled on every backup bucket — drops KMS API
  cost ~99%.

### 10.2 Separation from app KEK

The app envelope-encryption KEK (used by F05 to encrypt
`sip_password_ct`, `password_ct`, etc., per F02 PLAN §4.4) is a
**different KMS key**: `alias/vici2-app-kek-<env>`. Reason: blast-radius
isolation. A compromised backup KEK does not let an attacker decrypt
encrypted columns inside an obtained dump (the columns are still
ciphertext under the app KEK).

### 10.3 KEK rotation interaction

KMS automatic rotation appends new key material; old material is
retained for decrypt operations. Older backups remain decryptable
without re-encryption. We document this in `spec/runbooks/restore.md`.

If a future O05 procedure mandates full re-encryption (e.g., a key
compromise event), the path is `aws s3api update-object-encryption`
or S3 Batch Operations Copy. Out of scope for Phase 1 nightly work.

---

## 11. Cross-region replication (prod only)

### 11.1 Configuration (Terraform sketch — IMPLEMENT phase fills in)

```hcl
resource "aws_s3_bucket_replication_configuration" "prod" {
  bucket = aws_s3_bucket.vici2_backups_prod.id
  role   = aws_iam_role.replication.arn

  rule {
    id       = "replicate-all-to-dr"
    status   = "Enabled"
    priority = 0

    filter {}

    destination {
      bucket        = aws_s3_bucket.vici2_backups_prod_dr.arn
      storage_class = "STANDARD"

      encryption_configuration {
        replica_kms_key_id = aws_kms_key.vici2_backup_kek_prod_dr.arn
      }
    }

    source_selection_criteria {
      sse_kms_encrypted_objects {
        status = "Enabled"
      }
    }

    delete_marker_replication {
      status = "Disabled"           # do not propagate accidental deletes
    }
  }
}
```

### 11.2 Monitoring

- CloudWatch alarm on `ReplicationLatency > 900` (15 min).
- Quarterly drill: restore from `prod-dr` bucket to staging; verify
  identical row counts vs primary-region restore.

### 11.3 Staging + dev

No CRR — single region only.

---

## 12. Restore-test cron (weekly)

### 12.1 Behaviour

`scripts/restore/restore-test.sh`:

1. Spin up a fresh staging MySQL instance (Docker container with a
   throwaway data dir).
2. Find the latest `daily` backup (highest date prefix +
   highest TS) for the prod environment.
3. Run `scripts/restore/from-s3.sh --service mysql --date <today-1>
   --target staging --env prod`.
4. Time the entire operation; emit:
   ```
   vici2_restore_test_rto_seconds{service="mysql",env="prod"} 412
   vici2_restore_test_failures_total{service="mysql",env="prod"} 0
   vici2_restore_test_last_success_timestamp{service="mysql",env="prod"} 1746497345
   ```
5. Run a sanity SQL pass (counts on `users`, `leads`, `campaigns`,
   `audit_log`); assert non-zero where appropriate.
6. Tear down the staging container.

### 12.2 Alerts (consumed by O01)

- `vici2_restore_test_rto_seconds > 3600` (RTO breach) → page-able alert.
- `vici2_restore_test_failures_total` increment → page-able alert
  after 2 consecutive failures (avoids alarm fatigue from one-off
  network blips).
- `time() - vici2_restore_test_last_success_timestamp > 14*86400`
  (no successful test in 14 days) → page-able alert.

### 12.3 File

`scripts/restore/restore-test.sh`. systemd timer:
`vici2-restore-test.timer` (Mon 04:00 UTC).

---

## 13. Backup integrity (sibling SHA256 + tip-verify)

### 13.1 Sibling SHA256

Already covered in §2–§4 (every artifact gets a `<artifact>.sha256`
sidecar uploaded with the same SSE-KMS key + same backup_class tag).

### 13.2 Nightly tip-verify cron

`scripts/backup/tip-verify.sh` runs after all nightly backups complete
(02:55 UTC):

1. For each service (mysql, valkey, freeswitch):
   a. List today's prefix.
   b. Download the `.sha256` sidecar.
   c. `aws s3api head-object --checksum-mode ENABLED` to read S3's
      native SHA256 for the artifact.
   d. Compare base64-encoded values.
   e. If mismatch: emit metric `vici2_backup_integrity_failure_total`,
      structured-log error, exit non-zero (page operator).
2. Emit `vici2_backup_tip_verify_last_success_timestamp`.

S3 native SHA256 is computed at upload time (we set
`--checksum-algorithm sha256` on every `aws s3 cp`). Comparison is
free — just an API call.

---

## 14. RTO/RPO targets

| Service | RPO | RTO (Phase 1, ~5 GB DB) | RTO (Phase 2, ~50 GB DB) |
|---|---|---|---|
| MySQL | 24h (nightly) | < 30 min | < 60 min (XtraBackup migration triggered if exceeded) |
| Valkey | 24h | < 5 min (RDB load is fast) | unchanged |
| FreeSWITCH | 24h (config) | < 2 min (tar -xz + reloadxml) | unchanged |
| Cross-region (prod) | 24h (CRR lag <15min for objects, but RPO bound by backup cadence) | < 90 min (region failover overhead) | < 120 min |

Documented in `spec/runbooks/restore.md` with the procedure to
measure on demand. Met by:

- Weekly restore-test cron measures + emits actual RTO; alerts on
  breach.
- RPO is tautologically bounded by backup cadence (nightly) +
  most-recent-success metric `vici2_backup_last_success_timestamp`
  monitored by O01.

---

## 15. Hand-offs

### 15.1 To F02 (MySQL)

**Need from F02:**
1. Create dedicated read-only MySQL user `vici2_backup` with grants:
   ```sql
   CREATE USER 'vici2_backup'@'%' IDENTIFIED BY '<random-32B>';
   GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, PROCESS ON vici2.* TO 'vici2_backup'@'%';
   FLUSH PRIVILEGES;
   ```
2. Stash credentials at `/etc/vici2/mysql-backup.cnf` (mode 0600,
   owner `vici2-backup` Linux user) at provisioning.
3. Document the "no DDL during 02:00–02:30 UTC" window as a hard
   constraint: any DDL (online schema change, partition rotation)
   must be scheduled outside this window or risk MDL contention with
   `mysqldump --single-transaction`.

**Give to F02:** confirm Phase 2 XtraBackup will need additional
grants (`BACKUP_ADMIN`, `RELOAD`, `LOCK TABLES`, `REPLICATION CLIENT`,
`CREATE TABLESPACE`); seed in HANDOFF.md so F02 doesn't fight us on
PR review when we add them.

### 15.2 To F04 (Valkey)

**Need from F04:**
- Phase 1: no ACL — `valkey-cli BGSAVE` works without auth.
- Phase 2+ when ACL is mandatory: provision a `vici2_backup` ACL user
  with permissions `+bgsave +info +lastsave -@all +client|getname`.

**Give to F04:**
- Recommend `vm.overcommit_memory=1` on the host (added to F04 PLAN
  §3 deployment notes).
- Confirm `dump.rdb` location: `/data` inside container,
  `/var/lib/docker/volumes/vici2_valkey_data/_data` on host.

### 15.3 To F03 (FreeSWITCH)

**Need from F03:**
- Confirm `/etc/freeswitch/tls/` is the sole secrets path; PLAN
  excludes that directory from the tarball.

**Give to F03:** none (config is an O02-internal concern).

### 15.4 To O01 (observability)

**Metrics to scrape:**
```
# nightly backup health
vici2_backup_last_success_timestamp{service,env}
vici2_backup_size_bytes{service,env}
vici2_backup_duration_seconds{service,env}
vici2_backup_failures_total{service,env,reason}

# integrity
vici2_backup_integrity_failure_total{service,env}
vici2_backup_tip_verify_last_success_timestamp{service,env}

# restore testing
vici2_restore_test_rto_seconds{service,env}
vici2_restore_test_failures_total{service,env}
vici2_restore_test_last_success_timestamp{service,env}
```

Source: `node_exporter` textfile collector at
`/var/lib/node_exporter/textfile_collector/vici2_backup_*.prom`.

**Dashboards/alerts O01 wires up:**
- Backup freshness (alarm if `now - last_success > 30h`).
- RTO breach (alarm if `restore_test_rto_seconds > 3600`).
- Failure counter increment (alarm after 2 consecutive failures).
- Integrity failure (page immediately).

### 15.5 To O04 (CI/CD)

**Need from O04:**
- CI workflow `ci-backup-scripts.yml` running on every PR that touches
  `scripts/backup/` or `scripts/restore/`:
  1. `shellcheck scripts/backup/*.sh scripts/restore/*.sh`
  2. `bash -n scripts/backup/*.sh scripts/restore/*.sh` (syntax)
  3. Spin up MySQL + LocalStack S3 in CI (docker-compose-ci.yml);
     run `scripts/backup/mysql.sh --env dev --archive-class daily
     --bucket vici2-backups-ci`; verify object exists in LocalStack.
  4. Run `scripts/restore/from-s3.sh --service mysql --date <today>
     --target local --env dev`; verify row counts.

### 15.6 To O05 (security)

**Need from O05:**
- Provision `alias/vici2-backup-kek-{prod,prod-dr,staging,dev}` KMS
  keys per §10.1.
- Provision IAM roles: `vici2-backup-write`, `vici2-backup-read`,
  `vici2-backup-rotate` with the policies from §10.1.
- Document the KEK rotation runbook for `vici2-backup-kek` (including
  the optional full-re-encryption path via S3 Batch Operations Copy).

**Give to O05:** the `kek_version` metadata convention so O05 can
filter and re-encrypt latest backups under a new KEK after rotation.

### 15.7 To C04 (retention/partition rotation)

**Coordination:** C04's monthly partition rotation cron MUST NOT run
between 02:00–02:30 UTC (mysqldump's quiet window). PLAN suggests
03:30 UTC for C04's monthly rotation as a safe non-overlapping slot.

### 15.8 Boundary with R02 (recordings)

Recordings already live in `s3://vici2-recordings`. R02 owns:
- Recordings bucket setup and lifecycle.
- Cross-region replication of recordings.
- Recordings encryption (SSE-KMS, separate KEK per R02).

O02 does **not** back up recordings. Hard boundary.

---

## 16. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | Silent backup corruption | Low | High | Sibling SHA256 + S3 native SHA256 + nightly tip-verify + weekly restore-test |
| 2 | mysqldump `--single-transaction` MDL contention with DDL | Medium (when C04 runs) | Medium | "No DDL 02:00–02:30 UTC" window; C04 rotation pinned to 03:30 UTC |
| 3 | S3 cost growth at scale (large hot DBs) | Low (Phase 1) → Medium (Phase 4) | Medium | Lifecycle aggressive transitions; cost monitor monthly |
| 4 | KEK rotation interaction (older backups undecryptable) | Low | High | KMS retains key history; documented; no re-encryption needed |
| 5 | CRR fails silently (replication lag, IAM drift) | Low | High | CloudWatch ReplicationLatency alarm; quarterly cross-region restore drill |
| 6 | Valkey BGSAVE fork-OOM | Low (4GB box, 200 MB working set) | High | `vm.overcommit_memory=1`; preflight check |
| 7 | Restore-test alarm fatigue | Medium | Low | 2-consecutive-failure threshold |
| 8 | Operator runs `from-s3.sh --target prod-emergency` accidentally | Low | Catastrophic | Mandatory `--confirm-destroy` flag; pre-restore snapshot of current state |
| 9 | Phase 1 mysqldump exceeds 60-min RTO at unexpected DB growth | Low (Phase 1) | High | `vici2_restore_test_rto_seconds` weekly alarm; XtraBackup migration playbook ready |
| 10 | Backup user credentials leak | Low | Medium | `vici2_backup` is read-only on `vici2.*`; cannot delete or modify; cannot read other DBs |
| 11 | LocalStack KMS test in CI doesn't catch real-AWS KMS quirks | Medium | Low | Manual smoke test against real-AWS staging before merging O02 IMPLEMENT PR |
| 12 | Spec calls service `redis.sh`, PLAN uses `valkey.sh` | Low | Low | Symlink `redis.sh -> valkey.sh`; HANDOFF note |

---

## 17. Acceptance criteria (mapped to O02.md spec)

- [ ] `scripts/backup/mysql.sh` exists, shellcheck-clean, `--dry-run`
      works.
- [ ] `scripts/backup/valkey.sh` exists (with `redis.sh` symlink),
      shellcheck-clean.
- [ ] `scripts/backup/freeswitch-config.sh` exists, excludes `tls/`.
- [ ] `scripts/restore/from-s3.sh` exists, refuses prod-emergency
      without `--confirm-destroy`, verifies SHA256 before restore.
- [ ] `spec/runbooks/restore.md` exists, ≥300 lines, covers all 3
      services + RTO measurement procedure + KEK rotation interaction.
- [ ] systemd timer + service unit files committed to
      `infra/systemd/` (or appropriate path per F01 IMPLEMENT
      placement).
- [ ] S3 lifecycle policy committed as Terraform (or AWS CLI JSON) at
      `infra/aws/s3-lifecycle.{tf,json}`; matches §9.1 verbatim.
- [ ] KMS key policy + IAM role policies committed at
      `infra/aws/iam-backup-roles.tf` (or equivalent).
- [ ] Prom metric textfile collector wiring documented; metric names
      match §15.4 exactly.
- [ ] Nightly backup runs in dev environment, S3 (LocalStack) has
      artifacts (verified manually + recorded in VERIFY.md).
- [ ] Restore from S3 (LocalStack) into a test MySQL instance
      succeeds; data correct (recorded in VERIFY.md).
- [ ] **Acceptance from O02.md:** Nightly backups; verified upload. ✓
- [ ] **Acceptance from O02.md:** Tested restoration. ✓
- [ ] **Acceptance from O02.md:** Retention policy enforced. ✓ (S3
      lifecycle rules in place)
- [ ] **Acceptance from O02.md:** Runbook clear. ✓
      (`spec/runbooks/restore.md`)
- [ ] **Acceptance from O02.md:** Encryption at rest in S3. ✓
      (SSE-KMS with `alias/vici2-backup-kek`)
- [ ] **Acceptance from O02.md:** RTO < 60min; RPO < 24h documented
      and met. ✓ (per §14)
- [ ] CI workflow `ci-backup-scripts.yml` exists and passes on a
      sample PR.
- [ ] HANDOFF.md written: contains backup schedule, restore steps,
      encryption-key location, hand-off list (§15), open issues.

---

## 18. Files to create (IMPLEMENT phase)

```
scripts/backup/mysql.sh
scripts/backup/valkey.sh
scripts/backup/redis.sh                          # symlink → valkey.sh (back-compat with O02 spec)
scripts/backup/freeswitch-config.sh
scripts/backup/tip-verify.sh
scripts/backup/preflight-host.sh                 # checks vm.overcommit_memory etc.
scripts/restore/from-s3.sh
scripts/restore/restore-test.sh

spec/runbooks/restore.md

infra/systemd/vici2-backup-mysql.{timer,service}
infra/systemd/vici2-backup-mysql-monthly.{timer,service}
infra/systemd/vici2-backup-mysql-yearly.{timer,service}
infra/systemd/vici2-backup-valkey.{timer,service}
infra/systemd/vici2-backup-valkey-monthly.{timer,service}
infra/systemd/vici2-backup-freeswitch.{timer,service}
infra/systemd/vici2-restore-test.{timer,service}
infra/systemd/vici2-backup-tip-verify.{timer,service}

infra/aws/s3-lifecycle.json                      # bucket lifecycle rules
infra/aws/s3-bucket-policy-prod.json             # KMS-required, no-public, etc.
infra/aws/iam-backup-write-role.json
infra/aws/iam-backup-read-role.json
infra/aws/iam-backup-rotate-role.json
infra/aws/replication-config.tf                  # CRR for prod
infra/aws/kms-keys.tf                            # alias/vici2-backup-kek-* (owned by O05; O02 references)

.github/workflows/ci-backup-scripts.yml          # CI workflow (handed to O04 to land)

Makefile                                          # add `restore-from-backup` target

spec/modules/O02/HANDOFF.md                      # final HANDOFF (post-IMPLEMENT)
spec/modules/O02/VERIFY.md                       # post-VERIFY phase
```

**Files to modify:**
- `Makefile` (add `restore-from-backup` target).
- `.env.example` (add `VICI2_BACKUP_BUCKET`, `VICI2_BACKUP_KEK_ALIAS`,
  `VICI2_BACKUP_AWS_REGION`).
- `spec/modules/F02/PLAN.md` HANDOFF section (add `vici2_backup` user
  + the 02:00–02:30 UTC DDL window) — coordinated with F02 owner.

---

## 19. Open questions (deferred)

1. **Object Lock (Compliance vs Governance mode) for yearly archives** —
   defer to Phase 2 evaluation; need legal sign-off on TCPA defense
   posture vs operational risk of an immutable mistake.
2. **Binary-log streaming for sub-24h RPO** — defer to Phase 3 once
   real customer SLAs demand it.
3. **Per-tenant backup buckets** — Phase 4 multi-tenant SaaS may want
   per-tenant `s3://vici2-backups-prod/<tenant_id>/...` paths and
   per-tenant KEKs. Helper script structure already supports this via
   `--env`/`--bucket` flags; Phase 1 is single-tenant `tenant_id=1` and
   the prefix is just the env name.
4. **MinIO target for self-hosted Hetzner deployment** — `aws s3 cp` is
   S3-API compatible with MinIO; we add a `--endpoint-url` knob in the
   IMPLEMENT phase. Documented as a Phase 4+ deployment option per
   O04 PLAN.
5. **Continuous-data-protection / log-shipping** for sub-1h RPO —
   future work; out of scope.

---

## 20. Final summary

- **Tooling:** mysqldump + Valkey BGSAVE + tar (Phase 1); plain
  `aws s3 cp` to SSE-KMS-encrypted S3 with sibling SHA256;
  weekly automated restore-test; systemd timers.
- **RPO:** 24h.
- **RTO:** < 60 min for MySQL (Phase 1 ~5 GB DB; XtraBackup migration
  documented for Phase 2 when DB > 50 GB).
- **Encryption:** SSE-KMS with dedicated `alias/vici2-backup-kek`
  (separate from app KEK); CRR on for prod with separate destination
  KEK in DR region.
- **Retention:** 30 daily + 12 monthly + 4 yearly via S3 lifecycle
  driven by `backup_class` object tag; STANDARD → STANDARD_IA →
  GLACIER_IR → DEEP_ARCHIVE → expire.
- **Integrity:** sibling SHA256 + S3 native SHA256 + nightly
  tip-verify cron.
- **Hand-offs:** F02 (`vici2_backup` user + DDL window), F04
  (`vm.overcommit_memory=1`), F03 (`/etc/freeswitch/tls/` exclusion),
  O01 (Prom metrics), O04 (CI workflow), O05 (KMS keys + IAM roles +
  KEK rotation runbook), C04 (no-overlap window).

End of PLAN.md.
