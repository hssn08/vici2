# Restore Runbook — vici2 O02

**Owner:** Operations (O02)
**Status:** Active — Phase 1
**RPO:** 24 hours (nightly backups at 02:00–02:20 UTC)
**RTO targets:** MySQL < 30 min (Phase 1, ~5 GB DB); Valkey < 5 min; FreeSWITCH config < 2 min

Contact: file an incident issue in the vici2 repo; escalate to the operator on-call per your team's runbook.

---

## 1. Overview

This runbook covers restoring vici2 services from the nightly backups stored in S3
(`s3://vici2-backups-prod`). Backups are encrypted at rest with SSE-KMS using a dedicated
KMS key (`alias/vici2-backup-kek-prod`) that is separate from the application KEK
(`alias/vici2-app-kek-prod`).

Services covered:
- **MySQL** — full logical dump via `mysqldump`, compressed with `zstd`.
- **Valkey** — RDB snapshot (`BGSAVE`), compressed with `zstd`.
- **FreeSWITCH config** — `/etc/freeswitch` tar.gz (excluding `tls/`).

Recordings (`s3://vici2-recordings`) are owned by R02. Do NOT restore them with these scripts.

---

## 2. Pre-flight checklist

Before starting any restore:

```bash
# 1. Confirm AWS CLI v2 is installed
aws --version        # expect: aws-cli/2.x

# 2. Confirm you can assume the backup-read IAM role
aws sts get-caller-identity --query Arn

# 3. Confirm KMS key is accessible
aws kms describe-key --key-id alias/vici2-backup-kek-prod \
  --query 'KeyMetadata.{Enabled:Enabled,KeyState:KeyState}'
# expect: {"Enabled": true, "KeyState": "Enabled"}

# 4. Confirm destination DB/Valkey/FS is reachable
mysqladmin ping -h <dest-host>
valkey-cli -h <valkey-host> PING

# 5. Check disk space: need 3× compressed artifact size in /tmp
df -h /tmp

# 6. Run the host preflight check (first time on a new host)
scripts/backup/preflight-host.sh
```

---

## 3. MySQL restore

### 3.1 Find available backups

```bash
# List backups for a specific date
DATE="2026-05-12"
YYYY="${DATE%%-*}"; MM=$(echo "$DATE" | cut -d- -f2); DD=$(echo "$DATE" | cut -d- -f3)
aws s3 ls "s3://vici2-backups-prod/prod/mysql/${YYYY}/${MM}/${DD}/"
```

### 3.2 Restore to staging (safe default)

```bash
scripts/restore/from-s3.sh \
  --service mysql \
  --date 2026-05-12 \
  --target staging \
  --env prod \
  --bucket vici2-backups-prod
```

The script will:
1. List artifacts for the given date.
2. Download the newest `.sql.zst` artifact + `.sha256` sidecar.
3. Verify SHA256 integrity (refuses to restore on mismatch).
4. Decompress and pipe into the staging MySQL instance.
5. Log row counts for `leads`, `call_log`, `audit_log`, `users`, `campaigns`.
6. Emit `vici2_restore_test_rto_seconds` metric.

### 3.3 Emergency prod restore

Use ONLY for genuine data-loss emergencies. This overwrites the production database.

```bash
# Step 1: Take a fresh backup of current prod state FIRST
scripts/backup/mysql.sh --env prod --archive-class daily

# Step 2: Confirm the backup landed
aws s3 ls "s3://vici2-backups-prod/prod/mysql/$(date -u +%Y/%m/%d)/"

# Step 3: Run the restore with --confirm-destroy
scripts/restore/from-s3.sh \
  --service mysql \
  --date 2026-05-12 \
  --target prod-emergency \
  --env prod \
  --bucket vici2-backups-prod \
  --confirm-destroy
```

The script prints a 5-second countdown banner showing:
- Destination DB host
- Source artifact S3 path
- Current row counts in `call_log`, `leads`, `audit_log`

### 3.4 RTO measurement

Time the restore manually:

```bash
START=$(date +%s)
scripts/restore/from-s3.sh --service mysql --date <YYYY-MM-DD> --target staging --env prod
END=$(date +%s)
echo "RTO: $((END - START)) seconds"
```

The `vici2_restore_test_rto_seconds` metric is also emitted automatically.

RTO alert fires if the weekly restore-test exceeds 3600 seconds. If it does:
1. Check if DB has grown beyond 10 GB.
2. Evaluate migrating to Percona XtraBackup (Phase 2 upgrade path).

---

## 4. Valkey restore

### 4.1 Find available backups

```bash
DATE="2026-05-12"
YYYY="${DATE%%-*}"; MM=$(echo "$DATE" | cut -d- -f2); DD=$(echo "$DATE" | cut -d- -f3)
aws s3 ls "s3://vici2-backups-prod/prod/valkey/${YYYY}/${MM}/${DD}/"
```

### 4.2 Restore

```bash
scripts/restore/from-s3.sh \
  --service valkey \
  --date 2026-05-12 \
  --target staging \
  --env prod \
  --bucket vici2-backups-prod
```

The script will:
1. Download `dump.rdb.zst` + `.sha256`.
2. Decompress the RDB.
3. Verify SHA256 of the uncompressed RDB (sidecar covers uncompressed bytes).
4. Stop Valkey (`docker compose stop valkey`).
5. Replace `dump.rdb` in the data dir.
6. Start Valkey and verify `rdb_last_load_keys_loaded > 0`.

### 4.3 Manual Valkey restore (bare-metal)

```bash
# 1. Download and decompress
aws s3 cp "s3://vici2-backups-prod/prod/valkey/2026/05/12/dump-<TS>.rdb.zst" /tmp/
aws s3 cp "s3://vici2-backups-prod/prod/valkey/2026/05/12/dump-<TS>.rdb.sha256" /tmp/
zstd -d /tmp/dump-<TS>.rdb.zst -o /tmp/dump.rdb

# 2. Verify
ACTUAL=$(sha256sum /tmp/dump.rdb | awk '{print $1}')
EXPECTED=$(cat /tmp/dump-<TS>.rdb.sha256)
[ "$ACTUAL" = "$EXPECTED" ] && echo "OK" || { echo "SHA256 MISMATCH"; exit 1; }

# 3. Replace
systemctl stop valkey
cp /tmp/dump.rdb /var/lib/valkey/dump.rdb
chown valkey:valkey /var/lib/valkey/dump.rdb
chmod 0640 /var/lib/valkey/dump.rdb
systemctl start valkey

# 4. Verify
valkey-cli INFO persistence | grep rdb_last_load_keys_loaded
valkey-cli DBSIZE
```

---

## 5. FreeSWITCH config restore

### 5.1 Find available backups

```bash
DATE="2026-05-12"
YYYY="${DATE%%-*}"; MM=$(echo "$DATE" | cut -d- -f2); DD=$(echo "$DATE" | cut -d- -f3)
aws s3 ls "s3://vici2-backups-prod/prod/freeswitch/${YYYY}/${MM}/${DD}/"
```

### 5.2 Restore

```bash
scripts/restore/from-s3.sh \
  --service freeswitch \
  --date 2026-05-12 \
  --target staging \
  --env prod \
  --bucket vici2-backups-prod
```

The script will:
1. Download `etc-freeswitch-<TS>.tar.gz` + `.sha256`.
2. Verify SHA256 integrity.
3. Backup current `/etc/freeswitch` to `/etc/freeswitch.pre-restore-<TS>`.
4. Extract the tarball to `/etc/freeswitch/` (note: `tls/` was never in the tarball).
5. Run `fs_cli -x reloadxml` + `sofia profile external rescan`.

### 5.3 Rollback

If the restored config is broken:

```bash
# Revert to the pre-restore snapshot
TS="2026-05-13T02-10-00Z"   # the timestamp printed by the restore script
cp -a /etc/freeswitch.pre-restore-${TS}/* /etc/freeswitch/
fs_cli -x reloadxml
```

---

## 6. Cross-region failover (prod-dr)

When the primary region (us-east-1) is unavailable:

```bash
# 1. Switch to the DR bucket in us-west-2
export AWS_DEFAULT_REGION=us-west-2
BUCKET_DR="vici2-backups-prod-dr"

# 2. Verify DR bucket has recent artifacts
DATE="2026-05-12"
YYYY="${DATE%%-*}"; MM=$(echo "$DATE" | cut -d- -f2); DD=$(echo "$DATE" | cut -d- -f3)
aws s3 ls "s3://${BUCKET_DR}/prod/mysql/${YYYY}/${MM}/${DD}/"

# 3. Run restore pointing at DR bucket
scripts/restore/from-s3.sh \
  --service mysql \
  --date "${DATE}" \
  --target prod-emergency \
  --env prod \
  --bucket "${BUCKET_DR}" \
  --confirm-destroy
```

Cross-region replication lag is monitored via CloudWatch alarm
`vici2-backup-replication-lag` (alert if > 15 min). Quarterly drill: restore from DR
bucket to staging and verify row counts match primary-region restore.

---

## 7. RPO measurement

How to compute the current RPO gap:

```bash
# Check the last successful backup timestamp from Prom metrics
# (from node_exporter textfile collector)
cat /var/lib/node_exporter/textfile_collector/vici2_backup_mysql.prom \
  | grep vici2_backup_last_success_timestamp

# Compute age in seconds
LAST_SUCCESS=<unix timestamp from above>
NOW=$(date -u +%s)
echo "RPO gap: $((NOW - LAST_SUCCESS)) seconds"
```

RPO alert fires if `now - vici2_backup_last_success_timestamp > 30 hours`.

---

## 8. KEK rotation interaction

The backup KEK (`alias/vici2-backup-kek-prod`) uses AWS KMS automatic annual rotation.
KMS retains all previous key material; older backups remain decryptable without any
re-encryption pass. Operators do not need to take action when rotation occurs.

Exception: if O05 declares a key compromise, a full re-encryption pass is needed:

```bash
# List all objects to re-encrypt (S3 Batch Operations Copy)
aws s3api list-objects-v2 \
  --bucket vici2-backups-prod \
  --query 'Contents[].Key' \
  | jq -r '.[]' > /tmp/keys-to-reencrypt.txt

# O05 runs the re-encryption batch job with the vici2-backup-rotate IAM role.
# See infra/aws/iam-backup-rotate-role.json for the required permissions.
```

The `kek_version` metadata field on every S3 object allows filtering which objects
were encrypted under which key version (used by O05 to target the re-encryption scope).

---

## 9. Rollback procedure (botched restore)

### MySQL

The `--target staging` target only touches the staging instance; no rollback needed.

For `--target prod-emergency`:
1. The restore script does NOT take a pre-restore snapshot automatically for prod-emergency.
2. You must take a fresh backup BEFORE running the emergency restore (see §3.3 Step 1).
3. To rollback: run `scripts/backup/mysql.sh` on prod (to snapshot current state), then
   restore the pre-emergency backup with another `--confirm-destroy` run.

### Valkey

A pre-restore snapshot is not taken for Valkey. The last Valkey RDB backup is the rollback target:
```bash
scripts/restore/from-s3.sh --service valkey --date <yesterday> --target staging --env prod
```

### FreeSWITCH

The restore script creates `/etc/freeswitch.pre-restore-<TS>` automatically. See §5.3.

---

## 10. Common errors

### SHA256 mismatch

```
ERROR: SHA256 mismatch — refusing to restore.
```

Cause: object corrupted in transit or at rest, or wrong `.sha256` sidecar downloaded.

Resolution:
1. Re-download the artifact: `aws s3 cp` again.
2. If mismatch persists: restore from the previous day's backup.
3. File an incident — `tip-verify.sh` should have caught this nightly.
4. Check `vici2_backup_integrity_failure_total` metric in Prometheus.

### KMS access denied

```
An error occurred (AccessDeniedException) when calling the Decrypt operation
```

Cause: IAM role does not have `kms:Decrypt` on the backup KEK, or the role is not assumed correctly.

Resolution:
1. Confirm you are running as or have assumed the `vici2-backup-read` IAM role.
2. Check the KMS key policy: `aws kms get-key-policy --key-id alias/vici2-backup-kek-prod --policy-name default`.
3. Contact O05 to verify IAM policy has not drifted.

### mysqldump partial restore (foreign key / partition mismatch)

Symptom: `ERROR 1215 (HY000): Cannot add foreign key constraint` during restore.

Resolution:
```bash
# The dump includes SET FOREIGN_KEY_CHECKS=0; but if your MySQL version
# has stricter parsing, add it manually:
echo "SET FOREIGN_KEY_CHECKS=0;" | cat - dump.sql | mysql -h <host>
```

### Valkey BGSAVE stuck / timeout

Symptom: `valkey.sh` exits with "BGSAVE timeout after 600s".

Cause: `vm.overcommit_memory=0` on the host, or another BGSAVE in progress.

Resolution:
```bash
# Check if BGSAVE is in progress
valkey-cli INFO persistence | grep rdb_bgsave_in_progress

# Check overcommit setting
cat /proc/sys/vm/overcommit_memory
# Fix: sudo sysctl -w vm.overcommit_memory=1

# Run preflight check
scripts/backup/preflight-host.sh
```

### No artifacts found for date

Symptom: `ERROR: No artifacts found for service=mysql date=YYYY-MM-DD env=prod`

Cause: backup for that date failed; check `vici2_backup_failures_total` metric.

Resolution:
1. Check `vici2_backup_last_success_timestamp` — find the last successful date.
2. Restore from that date instead.
3. Check systemd journal for the backup service: `journalctl -u vici2-backup-mysql.service`.

---

## 11. Schedule reference

| Timer | Schedule | Purpose |
|---|---|---|
| `vici2-backup-mysql.timer` | 02:00 UTC nightly | MySQL daily backup |
| `vici2-backup-mysql-monthly.timer` | 02:30 UTC on 1st of month | MySQL monthly backup |
| `vici2-backup-mysql-yearly.timer` | 03:00 UTC on Jan 1 | MySQL yearly backup |
| `vici2-backup-valkey.timer` | 02:15 UTC nightly | Valkey daily backup |
| `vici2-backup-valkey-monthly.timer` | 02:45 UTC on 1st of month | Valkey monthly backup |
| `vici2-backup-freeswitch.timer` | 02:20 UTC nightly | FreeSWITCH config backup |
| `vici2-backup-tip-verify.timer` | 02:55 UTC nightly | Integrity tip verification |
| `vici2-restore-test.timer` | 04:00 UTC Monday | Weekly automated restore test |

**IMPORTANT:** Do NOT run DDL migrations (schema changes, partition rotations) between
02:00–02:30 UTC. This window is reserved for `mysqldump --single-transaction` to avoid
MDL contention. C04 partition rotation is pinned to 03:30 UTC to avoid overlap.

---

## 12. Prometheus metrics

All metrics are emitted to `/var/lib/node_exporter/textfile_collector/vici2_backup_*.prom`
and scraped by `node_exporter` via the textfile collector. Dashboards and alerts are
provisioned in O01.

| Metric | Description |
|---|---|
| `vici2_backup_last_success_timestamp{service,env}` | Unix timestamp of last successful backup |
| `vici2_backup_size_bytes{service,env}` | Compressed artifact size |
| `vici2_backup_duration_seconds{service,env}` | Total backup duration |
| `vici2_backup_failures_total{service,env}` | Backup failure count |
| `vici2_backup_integrity_failure_total{env}` | Integrity failures from tip-verify |
| `vici2_backup_tip_verify_last_success_timestamp{env}` | Last successful tip-verify |
| `vici2_restore_test_rto_seconds{service,env}` | Last restore-test duration |
| `vici2_restore_test_failures_total{service,env}` | Restore-test failure count |
| `vici2_restore_test_last_success_timestamp{service,env}` | Last successful restore test |

---

## 13. S3 layout (FROZEN interface)

```
s3://vici2-backups-{prod|staging|dev}/
└── <env>/
    ├── mysql/
    │   └── <YYYY>/<MM>/<DD>/
    │       ├── dump-<TS>.sql.zst              (tag: backup_class=daily|monthly|yearly)
    │       └── dump-<TS>.sql.zst.sha256       (SHA256 of compressed artifact)
    ├── valkey/
    │   └── <YYYY>/<MM>/<DD>/
    │       ├── dump-<TS>.rdb.zst
    │       └── dump-<TS>.rdb.sha256            (SHA256 of UNCOMPRESSED rdb)
    └── freeswitch/
        └── <YYYY>/<MM>/<DD>/
            ├── etc-freeswitch-<TS>.tar.gz
            └── etc-freeswitch-<TS>.tar.gz.sha256
```

Object tags drive S3 lifecycle transitions:
- `backup_class=daily` → STANDARD → STANDARD_IA (30d) → expire (90d)
- `backup_class=monthly` → STANDARD → STANDARD_IA (30d) → GLACIER_IR (90d) → expire (395d)
- `backup_class=yearly` → STANDARD → STANDARD_IA (30d) → GLACIER_IR (90d) → DEEP_ARCHIVE (365d) → expire (1460d)

Lifecycle rules: `infra/aws/s3-lifecycle.json`. Apply with:
```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket vici2-backups-prod \
  --lifecycle-configuration file://infra/aws/s3-lifecycle.json
```

---

End of restore runbook.
