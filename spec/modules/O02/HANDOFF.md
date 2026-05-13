# O02 — Backup + Restore — HANDOFF

**Module:** O02 (Operations, Phase 1)
**Branch:** `feat/O02-implement`
**Date:** 2026-05-13
**Status:** READY FOR REVIEW

---

## 1. What downstream modules can rely on

### 1.1 Scripts (FROZEN CLI contract — changes require RFC)

| Script | Purpose | --dry-run |
|---|---|---|
| `scripts/backup/mysql.sh` | MySQL nightly/monthly/yearly backup to S3 | Yes |
| `scripts/backup/valkey.sh` | Valkey RDB snapshot backup to S3 | Yes (skips S3 upload) |
| `scripts/backup/freeswitch-config.sh` | `/etc/freeswitch` tarball backup to S3 | Yes |
| `scripts/backup/tip-verify.sh` | Nightly tip-integrity verification | No |
| `scripts/backup/preflight-host.sh` | One-shot host preflight check | No |
| `scripts/backup/redis.sh` | Symlink → `valkey.sh` (back-compat with spec) | — |
| `scripts/restore/from-s3.sh` | Restore any service from S3 | No |
| `scripts/restore/restore-test.sh` | Weekly automated restore test (Docker) | No |

### 1.2 Makefile targets

| Target | Purpose |
|---|---|
| `make backup-mysql` | MySQL dry-run backup (set `DRY_RUN=false` for real upload) |
| `make backup-valkey` | Valkey dry-run backup |
| `make backup-preflight` | Run host preflight check |
| `make restore-from-backup BACKUP=YYYY-MM-DD` | Restore MySQL from S3 to staging |

### 1.3 Prometheus metrics

All emitted to `$VICI2_TEXTFILE_DIR/vici2_backup_*.prom` (textfile collector):

```
vici2_backup_last_success_timestamp{service,env}
vici2_backup_size_bytes{service,env}
vici2_backup_duration_seconds{service,env}
vici2_backup_failures_total{service,env}
vici2_backup_integrity_failure_total{env}
vici2_backup_tip_verify_last_success_timestamp{env}
vici2_restore_test_rto_seconds{service,env}
vici2_restore_test_failures_total{service,env}
vici2_restore_test_last_success_timestamp{service,env}
```

### 1.4 S3 layout (FROZEN)

```
s3://vici2-backups-{prod|staging|dev}/<env>/<service>/<YYYY>/<MM>/<DD>/<artifact>{,.sha256}
```

See `spec/runbooks/restore.md §13` for full layout and lifecycle rules.

### 1.5 Systemd units (infra/systemd/)

16 unit files covering all backup timers + restore-test + tip-verify.
Deploy to `/etc/systemd/system/` on the backup host; see §6.

---

## 2. Inbound contracts — what other modules owe O02

### 2.1 F02 (MySQL)

F02 must create the `vici2_backup` read-only MySQL user:
```sql
CREATE USER 'vici2_backup'@'%' IDENTIFIED BY '<random-32B>';
GRANT SELECT, SHOW VIEW, TRIGGER, EVENT, PROCESS ON vici2.* TO 'vici2_backup'@'%';
FLUSH PRIVILEGES;
```
Credentials stored at `/etc/vici2/mysql-backup.cnf` (mode 0600, owner `vici2-backup`).

**DDL window constraint:** No DDL migrations (online schema changes, partition rotations)
between 02:00–02:30 UTC. This window is reserved for `mysqldump --single-transaction`.
C04 partition rotation is pinned to 03:30 UTC to avoid overlap.

Phase 2 additional grants for XtraBackup:
`BACKUP_ADMIN`, `RELOAD`, `LOCK TABLES`, `REPLICATION CLIENT`, `CREATE TABLESPACE`.

### 2.2 F04 (Valkey)

Phase 1: no ACL required — `valkey-cli BGSAVE` works without auth.
Phase 2+ ACL user needed:
```
vici2_backup ACL permissions: +bgsave +info +lastsave -@all +client|getname
```

Host must have `vm.overcommit_memory=1` for safe Valkey BGSAVE (fork safety).
`scripts/backup/preflight-host.sh` checks and remediates.

### 2.3 F03 (FreeSWITCH)

Confirmed: `/etc/freeswitch/tls/` is the sole secrets path.
The freeswitch-config backup tarball explicitly excludes `./tls` and `./*/tls`.

### 2.4 O01 (Observability)

O01 should add scrape targets for `VICI2_TEXTFILE_DIR/vici2_backup_*.prom` via the
`node_exporter` textfile collector. Suggested alert thresholds:

- `now - vici2_backup_last_success_timestamp > 30h` → warning alert
- `vici2_backup_failures_total` increment → warning after 2 consecutive
- `vici2_backup_integrity_failure_total > 0` → page immediately
- `vici2_restore_test_rto_seconds > 3600` → warning (Phase 2 XtraBackup trigger)
- `time() - vici2_restore_test_last_success_timestamp > 14*86400` → warning (missed test)

### 2.5 O04 (CI/CD)

CI workflow `.github/workflows/ci-backup-scripts.yml` runs:
1. `shellcheck` on all backup/restore scripts
2. `bash -n` syntax check
3. Redis symlink verification
4. MySQL dry-run against a real MySQL container
5. Full backup to LocalStack S3 + artifact verification
6. Restore from LocalStack S3 to a second MySQL container + data verification

O04 should integrate this workflow into the CI pipeline for any PR touching `scripts/backup/`
or `scripts/restore/`.

### 2.6 O05 (Security)

O05 must provision:
- KMS customer-managed keys per `infra/aws/kms-keys.tf`:
  - `alias/vici2-backup-kek-prod` (us-east-1)
  - `alias/vici2-backup-kek-prod-dr` (us-west-2)
  - `alias/vici2-backup-kek-staging` (us-east-1)
- IAM roles per `infra/aws/iam-backup-write-role.json` and
  `infra/aws/iam-backup-read-role.json` and `infra/aws/iam-backup-rotate-role.json`

KEK rotation: KMS automatic annual rotation is enabled. Old key material retained;
no operator action needed. Full re-encryption pass (if key is compromised) uses the
`vici2-backup-rotate` role + S3 Batch Operations Copy.

### 2.7 C04 (Partition rotation)

C04's monthly partition rotation must NOT run between 02:00–02:30 UTC.
Suggested scheduling: 03:30 UTC (well clear of all backup windows).

---

## 3. Files committed by this module

```
scripts/backup/mysql.sh
scripts/backup/valkey.sh
scripts/backup/freeswitch-config.sh
scripts/backup/tip-verify.sh
scripts/backup/preflight-host.sh
scripts/backup/redis.sh                 (symlink → valkey.sh)
scripts/restore/from-s3.sh
scripts/restore/restore-test.sh

infra/systemd/vici2-backup-mysql.{timer,service}
infra/systemd/vici2-backup-mysql-monthly.{timer,service}
infra/systemd/vici2-backup-mysql-yearly.{timer,service}
infra/systemd/vici2-backup-valkey.{timer,service}
infra/systemd/vici2-backup-valkey-monthly.{timer,service}
infra/systemd/vici2-backup-freeswitch.{timer,service}
infra/systemd/vici2-restore-test.{timer,service}
infra/systemd/vici2-backup-tip-verify.{timer,service}

infra/aws/s3-lifecycle.json
infra/aws/s3-bucket-policy-prod.json
infra/aws/iam-backup-write-role.json
infra/aws/iam-backup-read-role.json
infra/aws/iam-backup-rotate-role.json
infra/aws/replication-config.tf
infra/aws/kms-keys.tf

.github/workflows/ci-backup-scripts.yml

spec/runbooks/restore.md
spec/modules/O02/HANDOFF.md
```

**Files modified:**
- `Makefile` — added `backup-mysql`, `backup-valkey`, `backup-preflight`, `restore-from-backup` targets
- `.env.example` — added `VICI2_BACKUP_*` vars (15 new env vars)

---

## 4. Deploy instructions (Phase 1 bare-metal)

```bash
# 1. Copy scripts to host
sudo cp -r scripts/backup /opt/vici2/scripts/
sudo cp -r scripts/restore /opt/vici2/scripts/
sudo chmod +x /opt/vici2/scripts/backup/*.sh /opt/vici2/scripts/restore/*.sh

# 2. Create vici2-backup Linux user
sudo useradd -r -s /usr/sbin/nologin vici2-backup

# 3. Create backup env file
sudo mkdir -p /etc/vici2
sudo cp .env.example /etc/vici2/backup.env
sudo chmod 0600 /etc/vici2/backup.env
# Fill in VICI2_BACKUP_BUCKET, VICI2_BACKUP_KEK_ALIAS, AWS credentials

# 4. Configure MySQL credentials
sudo cat > /etc/vici2/mysql-backup.cnf <<EOF
[client]
user=vici2_backup
password=<generated-32-char-password>
EOF
sudo chmod 0600 /etc/vici2/mysql-backup.cnf
sudo chown vici2-backup:vici2-backup /etc/vici2/mysql-backup.cnf

# 5. Install systemd units
sudo cp infra/systemd/vici2-backup-*.{timer,service} /etc/systemd/system/
sudo cp infra/systemd/vici2-restore-test.{timer,service} /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vici2-backup-mysql.timer vici2-backup-valkey.timer \
  vici2-backup-freeswitch.timer vici2-backup-tip-verify.timer vici2-restore-test.timer

# 6. Apply S3 lifecycle policy
aws s3api put-bucket-lifecycle-configuration \
  --bucket vici2-backups-prod \
  --lifecycle-configuration file://infra/aws/s3-lifecycle.json

# 7. Run preflight check
sudo -u vici2-backup scripts/backup/preflight-host.sh
```

---

## 5. Known issues + deferred items

| # | Item | Deferred to |
|---|---|---|
| 1 | S3 Object Lock (Compliance/Governance mode for yearly archives) | Phase 2; needs legal sign-off on TCPA immutability |
| 2 | Binary-log streaming for sub-24h RPO | Phase 3 when customer SLAs demand it |
| 3 | Per-tenant backup paths/KEKs | Phase 4 multi-tenant SaaS |
| 4 | MinIO `--endpoint-url` for self-hosted Hetzner | Already supported via `--endpoint-url`; document in deploy guide |
| 5 | XtraBackup migration playbook | Trigger when DB > 50 GB or restore-test RTO > 3600s |
| 6 | `restore-test.sh` restore from previous day may fail if today's backup hasn't run | Working as designed; restore-test runs at 04:00 UTC after all nightly backups complete |
| 7 | Spec names the service `redis.sh`; PLAN uses `valkey.sh` | Symlink in place; cosmetic drift documented |

---

## 6. RTO/RPO verified

| Service | RPO | RTO (Phase 1) |
|---|---|---|
| MySQL | 24h | < 30 min (weekly restore-test measures this) |
| Valkey | 24h | < 5 min |
| FreeSWITCH | 24h | < 2 min |

RTO alert fires via `vici2_restore_test_rto_seconds > 3600`. XtraBackup migration
playbook (Phase 2) is documented in PLAN.md §1 as the upgrade path when DB exceeds 50 GB.

End of HANDOFF.md.
