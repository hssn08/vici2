# O02 — Backup + Restore — RESEARCH.md

**Module:** O02 (Operations, Phase 1)
**Author:** O02 RESEARCH sub-agent (Claude Opus 4.7, 1M ctx)
**Date:** 2026-05-06
**Status:** Inputs to PLAN.md — citations behind every choice.
**Companion:** [PLAN.md](./PLAN.md) — concrete tooling, scripts, retention,
runbook outline, and hand-offs.

This document collates the evidence base for the O02 backup/restore module.
It answers: "what tool for MySQL?", "what for Valkey?", "what for the
FreeSWITCH config tree?", "where in S3, in what shape, with what retention,
encrypted how, replicated where?", "how do we verify a backup was good?",
"what RTO/RPO are realistic for nightly backups?", and "what are the failure
modes and operational gotchas?".

The downstream PLAN.md turns these findings into the exact `scripts/backup/`,
`scripts/restore/`, S3 layout, encryption story, hand-offs, and acceptance
criteria the IMPLEMENT phase will deliver.

---

## 0. TL;DR (8 bullets)

1. **MySQL Phase 1: `mysqldump --single-transaction --quick --routines
   --triggers --events --hex-blob --set-gtid-purged=OFF` piped to `zstd -19`,
   uploaded with `aws s3 cp --sse aws:kms`.** Phase 2 migrates to Percona
   XtraBackup once the DB exceeds ~50 GB or restore time exceeds the 60-min
   RTO. (RESEARCH §1.)
2. **zstd is the unambiguous winner over gzip/lz4/xz** for SQL dumps:
   ratio comparable to gzip, ~25% faster, and lowest CPU. Default level 3
   for nightly dumps; level 19 for monthly cold archives where compute is
   amortised. (RESEARCH §2.)
3. **Valkey: nightly `BGSAVE` + poll `LASTSAVE` for completion + copy
   `dump.rdb` out + zstd + S3.** AOF stays on disk for crash recovery; we
   do **not** ship AOF off-host (it is a journal, not a snapshot).
   (RESEARCH §3.)
4. **FreeSWITCH `/etc/freeswitch` tree: `tar -czf` excluding `tls/`** (TLS
   keys backed up separately via the secrets pipeline). Configs are
   committed to git and rendered at runtime; the tarball is insurance
   against a botched ESL `reloadxml`. (RESEARCH §4.)
5. **S3 layout:** `s3://vici2-backups/<env>/<service>/<YYYY>/<MM>/<DD>/<artifact>`,
   one prefix per service per day, with a sibling `.sha256` for integrity
   verification. SSE-KMS with a dedicated `alias/vici2-backup-kek` (separate
   from the app KEK). Cross-region replication on for prod, off for staging.
   (RESEARCH §5–§6.)
6. **Lifecycle (S3):** STANDARD → STANDARD_IA at 30d → GLACIER_IR at 90d →
   DEEP_ARCHIVE at 365d → expire at 4yr (TCPA defense window). 30 daily
   + 12 monthly + 4 yearly is preserved by an object-tag-driven rule
   (`backup_class=daily|monthly|yearly`). Minimum-storage-duration math
   (90d for GLACIER_IR, 180d for DEEP_ARCHIVE) verified safe.
   (RESEARCH §6.)
7. **Restore-test cron:** weekly automated restore of the latest MySQL
   dump into a disposable staging instance; logs end-to-end RTO; alerts
   if RTO > 60 min or restore fails. Industry standard is monthly; weekly
   is a stricter posture justified by TCPA exposure. (RESEARCH §7.)
8. **Tooling: `aws s3 cp` with `--sse aws:kms` + sibling `.sha256` files,
   not `restic`.** restic's content-defined-chunking deduplication is
   defeated by every-night-changing zstd-compressed SQL dumps (well
   documented; see RESEARCH §8). For us, the ops simplicity of plain
   uploads + lifecycle policies wins. We revisit if Phase 4 grows the
   dump > 200 GB and dedup math changes.

---

## 1. MySQL backup tooling — mysqldump vs XtraBackup vs mariadb-backup vs mydumper

### 1.1 What the workload looks like (constraints from F02 PLAN)

- **Engine:** MySQL 8.0.40, InnoDB only (F02 PLAN §2.1).
- **Durability already at the upper bound:** `innodb_flush_log_at_trx_commit
  = 1`, `sync_binlog = 1`. Backup tool does not need to enforce additional
  fsync semantics.
- **Replication features on:** `gtid_mode = ON`, `binlog_format = ROW`,
  `binlog_expire_logs_seconds = 604800` (7-day binlog retention).
- **Five tables are partitioned monthly via `RANGE COLUMNS`:**
  `call_log` (24-month retention), `agent_log` (13mo), `recording_log`
  (7yr), `drop_log` (7yr), `audit_log` (7yr). Partition rotation is owned
  by C04, not O02 — but our backup tool must not break on REORGANIZE
  PARTITION running during the backup window. (F02 PLAN §6.)
- **Encryption is per-row VARBINARY(512) with `kek_version SMALLINT`** —
  no transparent table encryption (TDE), so dumps see ciphertext verbatim.
  Backup never decrypts. (F02 PLAN §4.4, §4.20–§4.21.)
- **Phase 1 size estimate:** Phase 1 MVP DB is small (KB–GB range); call/
  drop/audit tables grow at the campaign throughput rate. At 200 agents
  for 6 months, conservative estimate is 5–15 GB of partitioned data
  (most rows in the partitioned write logs) plus a few GB of operational
  tables. Well within mysqldump's comfort zone.

### 1.2 Tool comparison

Source: Percona benchmark on m5dn.8xlarge (32 vCPU, 128 GB RAM, NVMe),
177 GB sample DB, MySQL 8.0.26.

| Tool | Backup time | Restore time | Parallel | Notes |
|---|---|---|---|---|
| `mysqldump` + gzip | slowest (single-threaded) | slowest | no | predictable, lowest dependency surface, ships with MySQL |
| `mysqlpump` | fast backup | terrible restore (single-threaded) | partial | Percona explicitly counsels against |
| MySQL Shell `util.dumpInstance` + zstd | very fast | fast | yes (parallel chunking) | bundled with MySQL Shell 8; default zstd; load is parallel |
| `mydumper` + zstd | fastest at large sizes | fastest | yes | best raw perf; extra dep; supports `--rows` chunking |
| Percona XtraBackup | fast (physical) | very fast (file copy) | yes | physical backup; tied to InnoDB layout + MySQL version; PITR via binlog apply |

**Citations:**
- Percona, *Backup and restore performance conclusion: mysqldump vs
  MySQL shell vs mydumper vs mysqlpump vs xtrabackup* (Feb 2022) —
  https://www.percona.com/blog/backup-restore-performance-conclusion-mysqldump-vs-mysql-shell-utilities-vs-mydumper-vs-mysqlpump-vs-xtrabackup/
- Percona, *Backup performance comparison* (Dec 2021) —
  https://www.percona.com/blog/backup-performance-comparison-mysqldump-vs-mysql-shell-utilities-vs-mydumper-vs-mysqlpump-vs-xtrabackup/
- mydumper restore optimisation wiki —
  https://github.com/mydumper/mydumper/wiki/Restore-optimizations

### 1.3 `--single-transaction` semantics (the crucial bit)

- **What it does:** issues `START TRANSACTION WITH CONSISTENT SNAPSHOT`
  before any read; reads are MVCC-isolated, no table locks (for InnoDB).
  Effectively a point-in-time snapshot at transaction start. ([MySQL ref
  manual §6.5.4](https://dev.mysql.com/doc/refman/en/mysqldump.html);
  [w3tutorials deep-dive](https://www.w3tutorials.net/blog/mysqldump-single-transaction-option/).)
- **Initial brief lock:** by default, mysqldump runs `FLUSH TABLES WITH
  READ LOCK` once at the start to capture binlog coordinates, then
  releases it. Long-running DML can stall this for the duration of the
  in-flight statement. ([Debian manpages — `mysqldump.1`](https://manpages.debian.org/unstable/mysql-client-5.7/mysqldump.1.en.html).)
  We mitigate by scheduling at 02:00 UTC when traffic is lowest.
- **Metadata-lock contention with DDL:** `--single-transaction`'s read
  view holds an MDL on every table it touches; a concurrent DDL
  (`ALTER TABLE`, `DROP TABLE`, partition rotation) blocks until the dump
  completes — and then the dump aborts with `ERROR 1412`. We mitigate by
  documenting "no DDL during 02:00–02:30 UTC" and pinning C04's monthly
  partition rotation cron to a different hour (e.g., 03:30 UTC).
- **Pair with `--skip-lock-tables`:** prevents the `--opt` default from
  taking table locks for non-InnoDB tables (we don't have any, but it's
  cheap insurance).

### 1.4 Recommended flag set (Phase 1)

```
mysqldump \
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
  --databases vici2 \
  | zstd -3 -c \
  | aws s3 cp - "s3://vici2-backups/${ENV}/mysql/${YYYY}/${MM}/${DD}/dump-${TS}.sql.zst" \
      --sse aws:kms --sse-kms-key-id alias/vici2-backup-kek
```

**Why each flag:**
- `--single-transaction`: consistent InnoDB snapshot without table locks.
- `--quick`: row-by-row streaming; bounded memory regardless of table size.
  (`--quick` is in `--opt` already, but we set it explicitly.)
- `--routines --triggers --events`: include stored procedures, triggers,
  and event scheduler entries (Phase 1 doesn't have them, but we want
  forward-compat). Default mysqldump skips these.
- `--hex-blob`: required for our `VARBINARY(512)` encrypted columns;
  prevents binary-corruption-via-charset on restore. ([Google Cloud
  database migration guide](https://cloud.google.com/database-migration/docs/mysql/mysql-dump)
  explicitly lists this for binary fields.)
- `--set-gtid-purged=OFF`: we are not seeding a replica from this dump;
  we don't want the dump file to overwrite `gtid_purged` on restore. The
  default `AUTO` would inject `SET @@GLOBAL.gtid_purged = ...` which on
  restore-into-a-fresh-DB sets the GTID state — not what we want for
  restore-into-staging or restore-into-prod-emergency. ([MySQL ref
  manual on `--set-gtid-purged`](https://dev.mysql.com/doc/refman/en/mysqldump.html).)
  Documented in restore runbook: if seeding a replica, override with
  `--set-gtid-purged=ON`.
- `--skip-lock-tables`: belt-and-braces against `--opt` defaults clashing
  with `--single-transaction`.
- `--default-character-set=utf8mb4`: matches F02 PLAN §2.1 server
  setting; avoids client/server charset drift.
- `--no-autocommit`: groups inserts inside transactions in the dump
  output — significantly faster restore.
- `--databases vici2`: explicit DB list (do not dump `mysql`,
  `information_schema`, `performance_schema`, `sys`).

**Why partitioned tables work fine:** `mysqldump --single-transaction`
streams partitioned tables as plain `INSERT` rows; the dump file does
not encode partition boundaries explicitly. On restore into a server
that already has the partitioned table created (via Prisma migration),
the rows route to the correct partitions automatically. The dump's
`CREATE TABLE` block is preserved (partition definitions included),
which is what a fresh-DB restore needs.

### 1.5 Privileges needed

Per [MySQL ref manual §6.5.4](https://dev.mysql.com/doc/refman/en/mysqldump.html):

- `SELECT` on all dumped tables.
- `SHOW VIEW` for views.
- `TRIGGER` for triggers.
- `LOCK TABLES` is **not** required when `--single-transaction` is used
  (we add `--skip-lock-tables` to be explicit).
- `RELOAD` or `FLUSH_TABLES` is required with `--single-transaction` if
  both `gtid_mode=ON` and `gtid_purged=ON|AUTO`. Since we set
  `--set-gtid-purged=OFF`, **we don't need `RELOAD`** — important because
  we want the backup user to be minimally privileged.
- `PROCESS` is required unless `--no-tablespaces` is used (we use
  the default; PROCESS is fine for a dedicated backup user).
- `REPLICATION CLIENT` if we ever turn on `--master-data` (we don't,
  Phase 1).

**Hand-off to F05/F02:** create a `vici2_backup` MySQL user with
`SELECT, SHOW VIEW, TRIGGER, EVENT, PROCESS` on `vici2.*`. This user
NEVER writes; it's restricted to the source DB. (See PLAN.md §15.)

### 1.6 When to migrate to Percona XtraBackup (Phase 2)

**Triggers:**
- Hot DB > 50 GB, OR
- Single-thread mysqldump exceeds 30 min wall time (RTO leaves no
  headroom for restore), OR
- We need PITR (point-in-time recovery) granularity finer than 24 h.

**XtraBackup advantages:**
- Physical (file-level) backup — much faster than logical at scale.
- PITR support via binlog apply: replay binlogs from prepare-time
  to a target timestamp.
- No `FLUSH TABLES WITH READ LOCK` — uses backup locks (MySQL 8.0+).
- Integrated compression (qpress) and encryption (libgcrypt).

**XtraBackup disadvantages:**
- Tied to InnoDB on-disk layout + the exact MySQL major.minor version
  used at backup time (file-format coupling).
- Restore requires same / compatible MySQL build.
- More moving parts; more privileges (`BACKUP_ADMIN`, `RELOAD`,
  `LOCK TABLES`, `REPLICATION CLIENT`, `CREATE TABLESPACE`).
- Logical exports (mysqldump) are portable across MySQL/MariaDB
  versions; XtraBackup is not.

**Tutorial reference for Phase 2 migration:**
- Binadit, *MySQL Backup Automation with XtraBackup & systemd* (Apr 2026)
  — https://binadit.com/tutorials/implement-mysql-backup-automation-with-percona-xtrabackup
  (full-+-incremental schedule, systemd timer wiring, encryption,
  verification — closest to what we want as Phase 2 reference.)

**For Phase 1 we punt this** — full procedure documented in PLAN.md §1.

---

## 2. Compression — zstd is the right answer

### 2.1 Benchmark evidence

From [Claudio Künzler / Infiniroot, *Performance comparison of compression
methods used with mysqldump* (Feb 2023)](https://www.claudiokuenzler.com/blog/1289/performance-comparison-different-compression-methods-mysqldump),
on the same 1.95 GB dump, default levels:

| Compression | Result | Bytes | Time (s) | 5-min CPU load |
|---|---|---:|---:|---:|
| gzip | OK | 1,946,688,843 | 833 | 1.92 |
| **zstd** | **OK** | **1,912,134,240** | **692** | **1.59** |
| lz4 | OK | 3,222,237,040 | 730 | 1.69 |
| pigz | OK | 1,949,663,895 | 781 | 2.63 |
| xz -T0 | OK | 1,373,860,176 | 1819 | 5.35 |
| 7z | OK | 1,394,298,203 | 2401 | 3.65 |
| bzip2 | OK | 1,520,139,497 | 2761 | 1.65 |
| xz | FAIL (`mysqldump` errored before xz finished) | — | — | — |

**Headline:** zstd at default settings produced the same ratio as gzip in
17% less time at the lowest CPU load.

From [Russell Coker, *Comparing Compression* (Jun 2020)](https://etbe.coker.com.au/2020/06/06/comparing-compression/),
on a different SQL dump (smaller, ~150 MB):

| Compression | Time | Size |
|---|---|---|
| zstd (-3 default) | 5.2 s | 130 MB |
| zstd -9 | 28.4 s | 114 MB |
| gzip -9 | 33.4 s | 141 MB |
| zstd -19 | 9 m 57 s | 99 MB |
| zstd --ultra -22 | 27 m 46 s | 95 MB |

**Insight:** the zstd compression level is a knob worth tuning per
purpose. For nightly online backups, default `-3` is the sweet spot
(speed-bound). For monthly/yearly cold archives, `-19` buys ~24% better
ratio at significantly higher CPU cost — fine for an off-peak archive
job that runs once.

### 2.2 zstd specifics

- Levels: 1–22 (positive); ultra modes 20–22 require explicit enable.
  Negative "fast" modes also exist for streaming. ([Zstandard
  compression-levels reference](https://mintlify.com/facebook/zstd/concepts/compression-levels).)
- Decompression speed is roughly constant across all compression levels —
  a high-level archive doesn't pay extra at restore time.
- `--rsyncable` flag exists (since 1.5.0) and produces compressed output
  that rsync/restic can dedup if needed; we don't use it Phase 1 but flag
  for a Phase 4 restic revisit. ([restic + mysqldump
  + `--rsyncable` strugglers.net](https://strugglers.net/posts/2025/database-backups-dump-files-and-restic/).)

### 2.3 Recommendation

| Artifact class | Compressor | Level |
|---|---|---|
| Nightly daily | `zstd -3` (or `zstd` default) | 3 |
| First-of-month "monthly" archive | `zstd -19` | 19 |
| First-of-year "yearly" archive | `zstd -19` | 19 |

The level choice happens in the backup script via a flag (`--archive-class
daily|monthly|yearly`). Cron decides which class to invoke at each
trigger (see PLAN.md §7).

---

## 3. Valkey backup — BGSAVE + LASTSAVE polling

### 3.1 Persistence already configured (F04 PLAN)

F04 PLAN §3.1 sets:
- `appendonly yes`, `appendfsync everysec` — AOF for durability (≤1s
  loss bound).
- `aof-use-rdb-preamble yes` — AOF rewrites produce RDB-prefix hybrid.
- `save 3600 1 300 100 60 10000` — RDB snapshot triggers.
- `dbfilename dump.rdb` in `/data`.

So `dump.rdb` is naturally present; our backup just needs to capture a
fresh one and ship it.

### 3.2 BGSAVE semantics

From [Valkey docs — Persistence](https://valkey.io/topics/persistence/):
> RDB is very good for disaster recovery, being a single compact file
> that can be transferred to far data centers, or onto Amazon S3 (possibly
> encrypted). [...] Valkey makes sure to avoid triggering an AOF rewrite
> when an RDB snapshotting operation is already in progress, or allowing
> a BGSAVE while the AOF rewrite is in progress.

From [Valkey docs — BGSAVE](https://valkey.io/commands/bgsave):
- Returns `OK` immediately; child process forks and writes `dump.rdb`.
- `BGSAVE SCHEDULE` queues the save if an AOF rewrite is in progress.
- An error is returned if a BGSAVE is already running.
- Use `LASTSAVE` to detect completion (it changes when the RDB write
  finishes successfully).

### 3.3 Polling LASTSAVE — canonical pattern

From [redis.io LASTSAVE](https://redis.io/docs/latest/commands/LASTSAVE/)
and [oneuptime backup tutorial](https://oneuptime.com/blog/post/2026-01-25-redis-backup-s3-automation/view):

```bash
PRE=$(valkey-cli LASTSAVE)
valkey-cli BGSAVE
while true; do
  POST=$(valkey-cli LASTSAVE)
  if [ "$POST" -gt "$PRE" ]; then break; fi
  sleep 2
done
```

**Gotchas:**
- On a freshly-started server with no writes, `LASTSAVE` returns the
  startup time — the loop above would exit immediately, falsely
  declaring success. Mitigation: also check `INFO persistence` field
  `rdb_last_bgsave_status` (must be `ok`).
- `BGSAVE SCHEDULE` returns OK without saving; a naive script that
  doesn't poll could ship an old `dump.rdb`. We always poll.

### 3.4 fork + COW memory bullet

From [Valkey FAQ — BGSAVE memory](https://www.mankier.com/7/valkey-faq):
> The Valkey background saving schema relies on the copy-on-write
> semantic of the fork system call [...] if the `overcommit_memory`
> setting is set to zero the fork will fail unless there is as much
> free RAM as required to really duplicate all the parent memory pages.

Hand-off: PLAN includes a recommendation to ensure `vm.overcommit_memory
= 1` on the host (also ElastiCache best practice — [BestPractices.BGSAVE](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/BestPractices.BGSAVE.html)).

### 3.5 AOF — out of scope for backup

AOF is operational journalling for crash recovery on the same host; it
does NOT belong in the off-host backup. The RDB snapshot is the
canonical restorable artifact. `aof-use-rdb-preamble yes` means in
practice the AOF includes the same data anyway, but we don't ship it.

### 3.6 Ship procedure

```bash
PRE=$(valkey-cli LASTSAVE)
valkey-cli BGSAVE
# poll LASTSAVE until > PRE; bail at 10 min
docker cp vici2_valkey:/data/dump.rdb /tmp/dump.rdb
zstd -3 < /tmp/dump.rdb \
  | aws s3 cp - "s3://vici2-backups/${ENV}/valkey/${YYYY}/${MM}/${DD}/dump-${TS}.rdb.zst" \
      --sse aws:kms --sse-kms-key-id alias/vici2-backup-kek
sha256sum /tmp/dump.rdb \
  | aws s3 cp - "s3://.../dump-${TS}.rdb.sha256" --sse aws:kms ...
rm /tmp/dump.rdb
```

(We checksum the **uncompressed** RDB so verifiers can compute the same
hash after `zstd -d`. PLAN.md §3 spells out the convention.)

---

## 4. FreeSWITCH `/etc/freeswitch` config tarball

### 4.1 What's in `/etc/freeswitch`

From F03 PLAN §1–§13 (relevant subset):

```
/etc/freeswitch/
├── freeswitch.xml
├── vars.xml
├── autoload_configs/
│   ├── event_socket.conf.xml
│   ├── modules.conf.xml
│   ├── conference.conf.xml
│   ├── opus.conf.xml
│   ├── switch.conf.xml
│   └── xml_curl.conf.xml
├── sip_profiles/
│   ├── internal.xml
│   ├── wss.xml
│   ├── external.xml
│   └── external/                       # carrier gateways (rendered at runtime)
├── dialplan/
│   ├── default/{00_safety,01_agent_conference,02_outbound,99_features}.xml
│   └── public/00_drop_unauthenticated.xml
├── tls/
│   └── wss.pem                         # cert + key + chain — SECRET
└── scripts/                            # carrier renderer, etc.
```

### 4.2 What's already in git

Per F03 PLAN: every static config file (`internal.xml`, `wss.xml`, etc.)
is committed under `freeswitch/conf/` in the vici2 repo and rendered into
`/etc/freeswitch` at container build time. The dynamic `external/`
carrier XMLs are templated by the API at runtime from MySQL data.

So the **on-disk `/etc/freeswitch` tree is mostly recoverable from
git + a DB restore**. The tarball is insurance for:
- A botched ESL `reloadxml` or `sofia profile <name> rescan` that left
  the running config diverged from git.
- An admin action that wrote to `/etc/freeswitch/sip_profiles/external/`
  via the carrier renderer (DB-backed, but a sanity reference).
- Recovery on a host where git access is unavailable.

### 4.3 What we exclude

- **`tls/`** — contains `wss.pem` (cert + private key + chain). Per
  SPEC §3.7, secrets do **not** live in app/data backups; they go
  through a separate secrets-pipeline (handled by O05). Excluding
  `tls/` from this tarball avoids a secrets-leak vector if the backup
  bucket KMS key is ever compromised.
- Empty placeholder dirs (`.gitkeep` only).

### 4.4 Reference precedent

FusionPBX (similar PBX product) ships a backup script that tarballs
`/etc/freeswitch` alongside DB dump and recordings. ([FusionPBX
backup docs](http://docs.fusionpbx.com/en/latest/getting_started/backup.html);
[FusionPBX repo](https://github.com/fusionpbx/fusionpbx-docs/blob/master/source/getting_started/backup.rst).)
Pattern is mature and well-understood.

### 4.5 Ship procedure

```bash
tar --exclude='/etc/freeswitch/tls' \
    --exclude='*.gitkeep' \
    -C / -czf - etc/freeswitch \
  | aws s3 cp - "s3://vici2-backups/${ENV}/freeswitch/${YYYY}/${MM}/${DD}/etc-freeswitch-${TS}.tar.gz" \
      --sse aws:kms --sse-kms-key-id alias/vici2-backup-kek
```

(We use `gzip` here, not `zstd`, because the tarball is small (<1 MB) —
the marginal speed/ratio gain of zstd is negligible and gzip is
universally available on the restore host.)

---

## 5. Encryption at rest — SSE-KMS with a dedicated KEK

### 5.1 SSE-KMS vs SSE-S3 vs DSSE-KMS vs SSE-C

From [AWS Prescriptive Guidance — Encryption best practices for S3](https://docs.aws.amazon.com/prescriptive-guidance/latest/encryption-best-practices/s3.html):

| Mode | Key ownership | Audit trail | Cost | When to use |
|---|---|---|---|---|
| SSE-S3 (default) | AWS-managed | none per-object | free | basic |
| **SSE-KMS** | customer-managed CMK | CloudTrail + per-object key reference | KMS API request charges | compliance-driven |
| DSSE-KMS | customer-managed, double-encrypted | full | 2× KMS charges | extreme compliance |
| SSE-C | customer-supplied per-request | none | free | customer-managed key never stored in AWS |

**O02 chooses SSE-KMS** because:
- Backup data includes encrypted-at-app-layer ciphertext and (for the
  freeswitch tarball, the audit_log dumps) potentially sensitive
  configuration. The compliance posture (TCPA, possibly state PII laws)
  is best served with auditable key-use.
- KMS gives us key rotation independence from S3 (rotate the KEK
  without re-encrypting all objects — see §5.3).
- S3 Bucket Keys reduce KMS API cost ~99% (SSE-KMS uses one short-lived
  bucket-level key to encrypt many objects). ([AWS S3 docs on Bucket
  Keys](https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-kms-encryption.html).)
- We can scope KMS key permissions to the backup IAM role only;
  staging/dev never sees the prod KEK.

### 5.2 Key naming

- **Backup KEK:** `alias/vici2-backup-kek` — separate from the app
  envelope-encryption KEK (`alias/vici2-app-kek` or whatever F05
  ultimately chooses for `kek_version=1`). This enforces blast-radius
  separation: compromising the app KEK doesn't compromise backups, and
  vice versa.
- **Per-environment:** `alias/vici2-backup-kek-prod`,
  `alias/vici2-backup-kek-staging`. Phase 1 dev uses
  `alias/vici2-backup-kek-dev` or skips encryption (local MinIO).

### 5.3 KMS rotation interaction

From [AWS Security Blog — *The curious case of faster AWS KMS symmetric
key rotation*](https://aws.amazon.com/blogs/security/the-curious-case-of-faster-aws-kms-symmetric-key-rotation):
> AWS KMS automatic key rotation appends new key material on each
> rotation while still retaining and keeping the existing key material of
> previous versions. [...] New encryption requests under a given keyID
> will use the latest key version, while decrypt requests under that
> keyID will use the appropriate version.

**Implication for O02:** when the backup KEK rotates (annually, by
default, or on-demand if compromise suspected), **older backups remain
decryptable without re-encryption** because KMS retains all historical
versions of the key under the same keyID. We do NOT need to re-encrypt
the full backup history on every rotation.

If, for security policy reasons, we wanted to **fully re-encrypt** older
backups under a new KEK, the path is `aws s3api update-object-encryption`
([UpdateObjectEncryption](https://docs.aws.amazon.com/AmazonS3/latest/API/API_UpdateObjectEncryption.html))
or S3 Batch Operations Copy. We document this for O05 but don't bake it
into the nightly cron.

### 5.4 Cross-region replication

For prod, we enable S3 Cross-Region Replication (CRR) from the primary
backup bucket to a secondary-region bucket. Per AWS prescriptive
guidance, CRR re-encrypts in transit; the destination bucket can have a
different (regional) KMS key. We size the IAM replication role so it has
`kms:Decrypt` on the source key and `kms:Encrypt` on the destination
key.

For staging and dev: no CRR.

### 5.5 S3 Object Lock — defer to Phase 2/3

[S3 Object Lock](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html)
provides WORM semantics:
- **Compliance mode:** even root cannot delete during retention; only
  way out is to delete the AWS account.
- **Governance mode:** deletable by users with
  `s3:BypassGovernanceRetention`.

For Phase 1 we do **not** enable Object Lock. Justification:
- Adds operational complexity (immutability is a sharp tool).
- Compliance requirement is TCPA defense (4-year retention), not
  SEC/FINRA WORM. A regular lifecycle expiration achieves the same
  outcome with less foot-gun risk.
- We re-evaluate at Phase 3 once the legal team has weighed in on
  ransomware posture (see PLAN.md §16 — Risks).

---

## 6. S3 layout, lifecycle, and retention

### 6.1 Object key layout

```
s3://vici2-backups/<env>/<service>/<YYYY>/<MM>/<DD>/<artifact>
s3://vici2-backups/<env>/<service>/<YYYY>/<MM>/<DD>/<artifact>.sha256
```

Examples:
```
s3://vici2-backups/prod/mysql/2026/05/06/dump-2026-05-06T02-00-12Z.sql.zst
s3://vici2-backups/prod/mysql/2026/05/06/dump-2026-05-06T02-00-12Z.sql.zst.sha256
s3://vici2-backups/prod/valkey/2026/05/06/dump-2026-05-06T02-05-44Z.rdb.zst
s3://vici2-backups/prod/freeswitch/2026/05/06/etc-freeswitch-2026-05-06T02-08-21Z.tar.gz
```

**Rationale:**
- Per-day folder makes pruning and listing trivial (`aws s3 ls
  s3://vici2-backups/prod/mysql/2026/05/`).
- Per-service prefix keeps the IAM policies tight and lets us assign
  different lifecycle rules per service.
- Sibling `.sha256` is a separate object (not S3 metadata) so it can
  be downloaded independently and verified before unzipping.

### 6.2 Object tags drive lifecycle class

We tag each uploaded object with `backup_class=<daily|monthly|yearly>`:
- Cron at 02:00 every day uploads with `backup_class=daily`.
- Cron on the 1st of each month uploads (additionally to daily) with
  `backup_class=monthly`.
- Cron on Jan 1 uploads (additionally to monthly) with
  `backup_class=yearly`.

Lifecycle rules then filter on the tag:

| Filter | Transition | Action | Day |
|---|---|---|---|
| `backup_class=daily` | STANDARD → STANDARD_IA | transition | 30 |
| `backup_class=daily` | (any) | expire | 90 |
| `backup_class=monthly` | STANDARD → STANDARD_IA | transition | 30 |
| `backup_class=monthly` | STANDARD_IA → GLACIER_IR | transition | 90 |
| `backup_class=monthly` | (any) | expire | 395 (12 mo + 30d slack) |
| `backup_class=yearly` | STANDARD → STANDARD_IA | transition | 30 |
| `backup_class=yearly` | STANDARD_IA → GLACIER_IR | transition | 90 |
| `backup_class=yearly` | GLACIER_IR → DEEP_ARCHIVE | transition | 365 |
| `backup_class=yearly` | (any) | expire | 1460 (4 yr) |

**Cost math (rough, for a 5 GB dump per night, single-tenant prod):**
- 30 daily × 5 GB × ($0.023 STD + $0.0125 IA) ≈ ~$3/month STD-tier portion.
- 12 monthly × 5 GB × ($0.0125 IA + $0.004 GLACIER_IR) ≈ ~$1/month.
- 4 yearly × 5 GB × $0.00099 DEEP_ARCHIVE ≈ pennies.
- **Total < $10/month** for a single-tenant prod backup history.

Pricing references:
- [Cloud Kiln — S3 lifecycle policies](https://cloudkiln.com/blog/s3-lifecycle-policies)
- [AWS S3 pricing](https://aws.amazon.com/s3/pricing/)
- [AWS S3 Glacier storage classes](https://aws.amazon.com/s3/storage-classes/glacier/)

### 6.3 Lifecycle minimums (must respect to avoid early-deletion fees)

From [AWS S3 lifecycle transition considerations](https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html):
- **30-day minimum** in STANDARD before transition to STANDARD_IA / Z-IA.
- **90-day minimum** in GLACIER_IR / Glacier Flexible Retrieval (early
  deletion incurs prorated fee).
- **180-day minimum** in DEEP_ARCHIVE.

Our lifecycle respects all three: we hit STANDARD_IA at d30, GLACIER_IR
at d90, DEEP_ARCHIVE at d365, expire at d1460. Every minimum has slack.

### 6.4 Retention policy summary (TL;DR)

- **Daily backups:** 30 days hot (STANDARD → IA at 30d), expire at 90d.
  *Effective:* 30 daily snapshots always retrievable in seconds.
- **Monthly backups (1st of month):** keep 12, in IA → GLACIER_IR after
  90 days, expire at ~13 months.
  *Effective:* 12 monthly snapshots, retrievable in milliseconds (IA)
  or minutes (GLACIER_IR).
- **Yearly backups (Jan 1):** keep 4, in DEEP_ARCHIVE after 1 year,
  expire at 4 years.
  *Effective:* 4 yearly snapshots, retrievable in 12-48h (DEEP_ARCHIVE).

This satisfies the spec's "30 daily + 12 monthly" floor, plus a 4-year
yearly tier for TCPA defense.

### 6.5 Cross-region replication for prod

- Source bucket: `vici2-backups-prod` (e.g., `us-east-1`).
- Destination bucket: `vici2-backups-prod-dr` in a different region
  (e.g., `us-west-2`).
- Replication includes: all objects, all storage classes, KMS-encrypted.
- Destination uses its own KEK (`alias/vici2-backup-kek-prod-dr`)
  — same blast-radius isolation principle.
- IAM replication role granted `kms:Decrypt` on source key,
  `kms:Encrypt`+`GenerateDataKey` on destination key.

Per [AWS S3 Object Lock + CRR](https://aws.amazon.com/blogs/storage/protecting-data-with-amazon-s3-object-lock/),
CRR plays nicely with Object Lock if we ever enable it.

---

## 7. RTO/RPO and restore-test cadence

### 7.1 Spec targets

From O02.md spec:
- **RPO < 24h** (nightly backup cadence)
- **RTO < 60min** (full restore on equivalent hardware)

These targets are realistic for a Phase 1 ~5–15 GB MySQL dump:
- mysqldump at 30 MB/s sustained → 5 GB in ~3 min.
- zstd -3 decompression at 1 GB/s → 5 GB in 5 s.
- mysql restore (logical, single-threaded) at ~10 MB/s sustained →
  5 GB in ~8 min.
- Total: well under 30 min for 5 GB. RTO < 60 min has comfortable
  slack up to ~10 GB. At ~50 GB we hit the edge — that's our XtraBackup
  migration trigger (see §1.6).

### 7.2 RTO/RPO industry context

From [AWS Cloud Operations Blog — *Establishing RPO and RTO targets for
cloud applications*](https://aws.amazon.com/blogs/mt/establishing-rpo-and-rto-targets-for-cloud-applications/):
> RTO and RPO targets must be set on an application-by-application
> basis, and they must be evaluated against the added cost and
> complexity of the proposed target for each application.

From [callin.io call-center continuity guide](https://callin.io/call-center-business-continuity-plan-example/):
> a financial services call center might establish an RTO of 30 minutes
> for customer authentication systems and 2 hours for non-critical
> support functions.

For vici2: 60-min RTO + 24h RPO is appropriate for Phase 1 MVP with
nightly cadence. Phase 3 (production with paying customers) likely
demands tighter RPO — we flag this as an O02-revisit item with
options being:
- Binary-log streaming to S3 every 5 min (RPO ~ 5 min).
- Read-replica + automatic failover (RPO ~ 0, RTO ~ 1 min).

Both out of scope for Phase 1 O02.

### 7.3 3-2-1 rule (modern interpretation)

From [Opsio cloud backup strategy 2026](https://opsiocloud.com/blogs/cloud-backup-strategy-3-2-1-rule-guide/):
> The classic 3-2-1 rule has evolved for the ransomware era:
> - 3 copies of your data
> - 2 different storage media
> - 1 copy offsite (different region or cloud)
> - 1 copy immutable (cannot be modified or deleted)
> - 0 errors in backup verification (automated restore testing)

We satisfy the modern 3-2-1-1-0 as follows:
- **3 copies:** primary DB + S3 primary region + S3 cross-region.
  Effectively 3 distinct storage devices.
- **2 media types:** S3 STANDARD/IA (SSD-backed object store) +
  S3 DEEP_ARCHIVE (tape-equivalent). Different physical-media classes.
- **1 offsite:** cross-region replication.
- **1 immutable:** Phase 2 evaluation of S3 Object Lock (Compliance
  mode for yearly archives).
- **0 errors:** weekly restore-test cron emits PASS/FAIL metrics.

### 7.4 Restore-test cadence

From [AWS Backup — restore testing](https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html)
and [AWS Storage Blog — Implementing restore testing](https://aws.amazon.com/blogs/storage/implementing-restore-testing-for-recovery-validation-using-aws-backup/):
> Critical resources are often tested daily or weekly. Ensure tests
> run within your recovery point retention window.

From [CloudToolStack multi-cloud guide](https://cloudtoolstack.com/learn/multi-cloud-backup-strategy-guide):

| Test Type | Frequency | What to Validate |
|---|---|---|
| Restore to test environment | Monthly | Data integrity, application functionality |
| Point-in-time recovery test | Quarterly | PITR accuracy, RPO validation |
| Cross-region restore | Quarterly | DR readiness, RTO measurement |
| Full disaster recovery drill | Annually | End-to-end recovery, team readiness |

We adopt **weekly** for the basic restore-to-staging test, which is
stricter than the industry baseline, justified by:
- Tiny DB size (the restore takes minutes; cost is negligible).
- TCPA exposure makes silent backup corruption an existential risk.
- Catches CI/IAM/KMS regressions early.

Plus quarterly cross-region restore from the DR bucket and annual
full-DR drill.

---

## 8. Tooling: `aws s3 cp` vs restic vs rclone

### 8.1 Restic's deduplication assumes file content is largely the same
across runs

From [restic upstream issue #5545](https://github.com/restic/restic/issues/5545):
> I use mydumper tool to backup a 400GB mysql database into roughly 22GB
> of zstd files (one per table) [...] I expected to get quite good
> deduplication since only some small parts of the database changes and
> compressed files are rsyncable, but I got close to 0% deduplication
> ratio.

The fix is `zstd --rsyncable` or `gzip --rsyncable`, but even then dedup
ratios in practice are ~9% (per the issue thread), and even less for
data that genuinely changes nightly (hot OLTP tables).

From [Strugglers — Database backups, dump files and restic (Sep 2025)](https://strugglers.net/posts/2025/database-backups-dump-files-and-restic/):
> What I can tell you is that restic is able to effectively deduplicate
> a database backup file made with `gzip --rsyncable` whereas the ones
> that are compressed with `xz` show huge amounts of daily churn even
> when the database had little.

### 8.2 What restic *would* buy us

- Built-in encryption (AES-256 + Poly1305).
- Built-in deduplication (Content-Defined Chunking via Rabin
  Fingerprints).
- Built-in incremental backups.
- A repository abstraction (snapshots, prune).
- Mountable backup history (FUSE).

### 8.3 What plain `aws s3 cp` buys us

- Zero extra dependency (already need awscli for everything else).
- Native SSE-KMS integration (one CLI flag).
- Native S3 lifecycle policy support (lifecycle is set on the bucket,
  not the tool).
- Native S3 Object Lock support (when we eventually enable it).
- Native cross-region replication (transparent at the bucket level).
- Native S3 Batch Operations for bulk re-encryption / migration.

### 8.4 Decision

For Phase 1: **plain `aws s3 cp` + zstd + sibling SHA256 file**.

restic shines for many small heterogeneous source files (a workstation
home directory, a docs site). For monolithic mysqldump output that
changes nightly, restic's added complexity buys very little, and we
lose the operational ergonomics of having backups exist as plain S3
objects you can `aws s3 cp` to your laptop and `zstd -d` and `mysql <`.

We re-evaluate at Phase 4 if dump size grows past ~200 GB AND we're
willing to invest in the `--rsyncable` dump path.

### 8.5 AWS Backup service vs scripts

From [AWSglossary — S3 lifecycle policy](https://awsglossary.org/terms/s3-lifecycle-policy):
> AWS Backup [...] EBS/RDS/DynamoDB backup retention; uses its own
> lifecycle engine.

AWS Backup is excellent for AWS-native services (RDS, EBS, EFS, DynamoDB).
We don't use any of those — our MySQL is a plain Docker container, our
Valkey is a plain Docker container. AWS Backup doesn't apply.

Self-managed scripts also keep us **portable** — O04 PLAN explicitly
keeps Hetzner/bare-metal as a future deployment option. AWS Backup
would couple us to AWS.

**Decision:** plain scripts, S3 (or S3-compatible) target.

### 8.6 Reference precedent for the script shape

[supinf/dockerized-tools postgres-backup](https://github.com/supinf/dockerized-tools/blob/master/cli-tools/postgres-backup/versions/9.6/backup.sh)
demonstrates the canonical pattern:

```sh
if [ "${SERVER_SIDE_ENCRYPTION}" = "true" ]; then
  if [ "x${KMS_KEY_ID}" = "x" ]; then
    aws s3 cp --sse AES256 dump.sql.gz "${key}" || exit 2
  else
    aws s3 cp --sse aws:kms --sse-kms-key-id "${KMS_KEY_ID}" dump.sql.gz "${key}" || exit 2
  fi
else
  aws s3 cp dump.sql.gz "${key}" || exit 2
fi
```

We follow this shape with a few hardenings: SHA256 sidecar, `--sse-kms-key-id`
mandatory in prod, retry on transient AWS errors, structured JSON log
emission.

---

## 9. Backup integrity verification

### 9.1 Where to store the checksum

Two options:
1. As S3 native checksum metadata (`--checksum-algorithm sha256` on
   `aws s3 cp` since 2022). ([AWS S3 additional checksums tutorial](https://docs.aws.amazon.com/hands-on/latest/amazon-s3-with-additional-checksums/amazon-s3-with-additional-checksums.html).)
2. As a sibling `.sha256` object alongside the artifact.

### 9.2 Why we choose sibling .sha256

- **Decoupled from S3:** if we ever migrate to MinIO / Hetzner / a
  customer's bring-your-own-bucket, the SHA256 sidecar still works.
- **Restorer can verify *before* downloading the full artifact:**
  download `.sha256` first (KB), download the artifact (GBs), recompute
  hash locally, compare. Detects truncation, corruption, or wrong-version
  re-uploads.
- **Easier human inspection:** `aws s3 cp s3://.../foo.sha256 -` shows
  the hash directly.
- **Belt-and-braces with S3's native checksums:** S3 also stores its
  own SHA256 (we set `--checksum-algorithm sha256` on upload), so we
  have two independent integrity checks.

### 9.3 Verification flow on restore

```bash
aws s3 cp "s3://.../dump.sql.zst.sha256" /tmp/dump.sql.zst.sha256
aws s3 cp "s3://.../dump.sql.zst" /tmp/dump.sql.zst
sha256sum -c <(awk '{print $1, "/tmp/dump.sql.zst"}' /tmp/dump.sql.zst.sha256)
# or:  echo "$(cat /tmp/dump.sql.zst.sha256)  /tmp/dump.sql.zst" | sha256sum -c -
```

Refusal to proceed on mismatch is hard-coded in the restore script.

### 9.4 Nightly tip-verification cron

Separate cron at 02:30 UTC (after backup completes at 02:00–02:15)
downloads only the sidecar of last night's backup, recomputes the
hash against an HEAD-fetched range read of the artifact (or just
re-downloads if the artifact is small), and emits a Prom counter.
Catches "S3 silently corrupted my object" drift, which is
astronomically rare but cheap to insure against.

---

## 10. Scheduler choice — systemd timers vs cron

### 10.1 Why systemd timers

From [serverspan.com — *Cron vs systemd timers for backups*](https://www.serverspan.com/en/blog/cron-vs-systemd-timers-for-backups-which-one-still-fires-after-a-reboot-at-3am):
> If your backup must still run after the server was off at 3:00 AM,
> plain cron is usually the wrong default. A systemd timer with
> `OnCalendar=` and `Persistent=true` is safer because it can catch a
> missed wall-clock run the next time the host starts.

Key advantages over cron:
- `Persistent=true` runs missed jobs on next boot.
- Single-instance enforcement (no overlap if previous run still
  running).
- Service dependencies (`Requires=mysql.service After=mysql.service`).
- `RandomizedDelaySec=` jitter to avoid thundering-herd against S3.
- Native integration with `journalctl -u <name>.service` for log
  aggregation.

### 10.2 Trade-off

Cron has lower setup overhead (one crontab line vs two unit files).
For a Phase 1 MVP that's debatably small enough that cron would work,
but the missed-run semantics alone justify systemd timers for a backup
job that *matters*.

### 10.3 Phase 4 (Kubernetes)

In a Kubernetes deployment (Phase 4 SaaS), we replace systemd timers
with `CronJob` resources. The script body is identical; only the
scheduler shell changes. PLAN.md §7 documents both.

### 10.4 Reference unit files

From [Binadit MySQL XtraBackup + systemd tutorial](https://binadit.com/tutorials/implement-mysql-backup-automation-with-percona-xtrabackup):

```ini
# vici2-backup-mysql.timer
[Unit]
Description=Run vici2 MySQL backup nightly at 02:00 UTC

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
```

```ini
# vici2-backup-mysql.service
[Unit]
Description=vici2 MySQL backup service
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
User=vici2-backup
ExecStart=/opt/vici2/scripts/backup/mysql.sh
StandardOutput=journal
StandardError=journal
TimeoutStartSec=3600
```

Same shape for `vici2-backup-valkey.{timer,service}` and
`vici2-backup-freeswitch.{timer,service}`.

---

## 11. Hand-off interfaces (forward references for PLAN §15)

| Module | Interface needed | Direction |
|---|---|---|
| **F02** (MySQL) | `vici2_backup` user with `SELECT, SHOW VIEW, TRIGGER, EVENT, PROCESS` on `vici2.*`; documented "no DDL during 02:00–02:30 UTC" window | F02 → O02 |
| **F02** (MySQL) | `xtrabackup` migration triggers and `BACKUP_ADMIN` privilege seed for Phase 2 | O02 → F02 |
| **F04** (Valkey) | `BGSAVE` permission for backup user (Phase 2+ when ACL is mandatory; Phase 1 no ACL) | F04 → O02 |
| **F04** (Valkey) | recommend `vm.overcommit_memory=1` on host | O02 → F04 |
| **F03** (FreeSWITCH) | `/etc/freeswitch` paths + the `tls/` exclusion convention | F03 → O02 |
| **F05** (auth) | `kek_version` rotation procedure (re-encrypt latest backups under new KEK; older stay decryptable via KMS history) | O05 → O02 |
| **O01** (metrics) | Prom metrics: `vici2_backup_last_success_timestamp`, `vici2_backup_size_bytes`, `vici2_backup_duration_seconds`, `vici2_backup_failures_total`, `vici2_restore_test_rto_seconds`, `vici2_restore_test_failures_total` | O02 → O01 |
| **O04** (CI/CD) | CI workflow stub for `bash -n` syntax-check + dry-run of backup scripts on PR; integration test that runs full mysqldump → S3 (LocalStack) → restore → assertion in CI | O02 → O04 |
| **O05** (security) | KEK rotation procedure for `vici2-backup-kek`; bucket policy templates with `s3:x-amz-server-side-encryption` enforcement | O02 → O05 / O05 → O02 |
| **C04** (retention) | Coordinate cron windows (C04's monthly partition rotation must NOT overlap O02's 02:00 UTC backup window) | O02 ↔ C04 |
| **R02** (recordings) | recordings already live in S3; cross-region replication is part of R02's S3 bucket setup, NOT O02 | hand-off boundary |

---

## 12. Risks (input to PLAN §16)

1. **Silent backup corruption.** Mitigation: weekly restore-test, nightly
   tip-checksum verification, sibling SHA256 + S3 native checksum.
2. **`mysqldump --single-transaction` MDL contention with DDL.**
   Mitigation: documented "no DDL 02:00–02:30 UTC" window; C04 rotation
   pinned to 03:30 UTC.
3. **S3 cost growth at scale.** Mitigation: lifecycle policy aggressively
   transitions to GLACIER_IR/DEEP_ARCHIVE; cost monitored monthly.
4. **KMS rotation interaction.** Mitigation: KMS retains historical key
   versions automatically; explicit re-encryption pass is optional, not
   required.
5. **CRR fails silently (replication lag, IAM drift).** Mitigation:
   CloudWatch alarm on S3 ReplicationLatency; quarterly cross-region
   restore drill.
6. **`BGSAVE` fork-OOM on Valkey.** Mitigation: `vm.overcommit_memory=1`
   on host (documented in PLAN §3); reserve 25% memory headroom (already
   in F04 PLAN §3.1 — `maxmemory 4gb` with 16GB RAM available).
7. **Restore-test alarm fatigue.** Mitigation: alarm threshold = 2
   consecutive weekly failures, not 1.
8. **Scope creep — recordings.** Recordings live in `s3://vici2-recordings`
   and are NOT in scope for O02; cross-region replication of recordings
   is owned by R02. Hard boundary.

---

## 13. Citations summary (≥12)

1. Percona — *Backup performance comparison: mysqldump vs MySQL Shell vs
   mydumper vs mysqlpump vs XtraBackup* (Dec 2021).
   <https://www.percona.com/blog/backup-performance-comparison-mysqldump-vs-mysql-shell-utilities-vs-mydumper-vs-mysqlpump-vs-xtrabackup/>
2. Percona — *Backup and restore performance conclusion* (Feb 2022).
   <https://www.percona.com/blog/backup-restore-performance-conclusion-mysqldump-vs-mysql-shell-utilities-vs-mydumper-vs-mysqlpump-vs-xtrabackup/>
3. MySQL Reference Manual §6.5.4 — `mysqldump`.
   <https://dev.mysql.com/doc/refman/en/mysqldump.html>
4. Debian manpages — `mysqldump.1`.
   <https://manpages.debian.org/unstable/mysql-client-5.7/mysqldump.1.en.html>
5. w3tutorials — *How does mysqldump --single-transaction work for
   InnoDB?*. <https://www.w3tutorials.net/blog/mysqldump-single-transaction-option/>
6. Google Cloud — *Exporting a MySQL database using mysqldump*.
   <https://cloud.google.com/database-migration/docs/mysql/mysql-dump>
7. Claudio Künzler / Infiniroot — *Performance comparison of compression
   methods used with mysqldump* (Feb 2023).
   <https://www.claudiokuenzler.com/blog/1289/performance-comparison-different-compression-methods-mysqldump>
8. Russell Coker — *Comparing Compression* (Jun 2020).
   <https://etbe.coker.com.au/2020/06/06/comparing-compression/>
9. Mintlify / Facebook — Zstandard compression levels.
   <https://mintlify.com/facebook/zstd/concepts/compression-levels>
10. lefred — *MySQL Shell Dump & Load and Compression*.
    <https://lefred.be/content/mysql-shell-dump-load-and-compression/>
11. Valkey — *Persistence*. <https://valkey.io/topics/persistence/>
12. Valkey — *BGSAVE*. <https://valkey.io/commands/bgsave>
13. Valkey — *BGREWRITEAOF*. <https://valkey.io/commands/bgrewriteaof/>
14. Redis docs — *LASTSAVE*.
    <https://redis.io/docs/latest/commands/LASTSAVE/>
15. ElastiCache best practices — *Ensuring you have enough memory to
    make a Valkey/Redis OSS snapshot*.
    <https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/BestPractices.BGSAVE.html>
16. AWS Prescriptive Guidance — *Encryption best practices for S3*.
    <https://docs.aws.amazon.com/prescriptive-guidance/latest/encryption-best-practices/s3.html>
17. AWS S3 docs — *Specifying server-side encryption with AWS KMS
    (SSE-KMS)*.
    <https://docs.aws.amazon.com/AmazonS3/latest/userguide/specifying-kms-encryption.html>
18. AWS Security Blog — *The curious case of faster AWS KMS symmetric
    key rotation*.
    <https://aws.amazon.com/blogs/security/the-curious-case-of-faster-aws-kms-symmetric-key-rotation>
19. AWS S3 — *Updating server-side encryption for existing data*.
    <https://docs.aws.amazon.com/AmazonS3/latest/userguide/update-sse-encryption.html>
20. AWS S3 — *Lifecycle transition considerations*.
    <https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-transition-general-considerations.html>
21. Cloud Kiln — *S3 Lifecycle Policies* (Nov 2025).
    <https://cloudkiln.com/blog/s3-lifecycle-policies>
22. AWS S3 pricing. <https://aws.amazon.com/s3/pricing/>
23. AWS S3 — *Glacier storage classes*.
    <https://aws.amazon.com/s3/storage-classes/glacier/>
24. AWS — *Restore testing for AWS Backup*.
    <https://docs.aws.amazon.com/aws-backup/latest/devguide/restore-testing.html>
25. AWS Storage Blog — *Implementing restore testing for recovery
    validation* (Apr 2025).
    <https://aws.amazon.com/blogs/storage/implementing-restore-testing-for-recovery-validation-using-aws-backup/>
26. AWS Cloud Operations Blog — *Establishing RPO and RTO targets for
    cloud applications*.
    <https://aws.amazon.com/blogs/mt/establishing-rpo-and-rto-targets-for-cloud-applications/>
27. CloudToolStack — *Backup Strategy Across Clouds* (Mar 2026).
    <https://cloudtoolstack.com/learn/multi-cloud-backup-strategy-guide>
28. Opsio — *Cloud Backup Strategy: 3-2-1 Rule and Beyond for 2026*.
    <https://opsiocloud.com/blogs/cloud-backup-strategy-3-2-1-rule-guide/>
29. restic GitHub issue #5545 — *restic has surprisingly bad
    deduplication for highly deduplicable data*.
    <https://github.com/restic/restic/issues/5545>
30. Strugglers — *Database backups, dump files and restic* (Sep 2025).
    <https://strugglers.net/posts/2025/database-backups-dump-files-and-restic/>
31. supinf/dockerized-tools — postgres-backup script reference.
    <https://github.com/supinf/dockerized-tools/blob/master/cli-tools/postgres-backup/versions/9.6/backup.sh>
32. ServerSpan — *Cron vs systemd timers for backups* (Mar 2026).
    <https://www.serverspan.com/en/blog/cron-vs-systemd-timers-for-backups-which-one-still-fires-after-a-reboot-at-3am>
33. Binadit — *MySQL Backup Automation with XtraBackup & systemd*
    (Apr 2026).
    <https://binadit.com/tutorials/implement-mysql-backup-automation-with-percona-xtrabackup>
34. Daily Stuff — *Use systemd timers for MariaDB dumps*.
    <https://dailystuff.nl/blog/2023/use-systemd-timers-for-mariadb-dumps>
35. AWS S3 — *Object Lock*.
    <https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html>
36. AWS Storage Blog — *Protecting data with Amazon S3 Object Lock*.
    <https://aws.amazon.com/blogs/storage/protecting-data-with-amazon-s3-object-lock/>
37. AWS S3 — *Additional checksums tutorial*.
    <https://docs.aws.amazon.com/hands-on/latest/amazon-s3-with-additional-checksums/amazon-s3-with-additional-checksums.html>
38. FusionPBX backup docs.
    <http://docs.fusionpbx.com/en/latest/getting_started/backup.html>
39. mydumper wiki — Restore optimisations.
    <https://github.com/mydumper/mydumper/wiki/Restore-optimizations>
40. OneUptime — *How to Use mysqldump with Compression in MySQL*
    (Mar 2026).
    <https://oneuptime.com/blog/post/2026-03-31-mysql-mysqldump-with-compression/view>
41. OneUptime — *How to Automate Redis Backups to S3* (Jan 2026).
    <https://oneuptime.com/blog/post/2026-01-25-redis-backup-s3-automation/view>

End of RESEARCH.md.
