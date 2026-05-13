#!/usr/bin/env bash
# scripts/backup/mysql.sh — O02 Phase 1 MySQL backup
# Usage: scripts/backup/mysql.sh --env prod|staging|dev --archive-class daily|monthly|yearly [options]
# See spec/modules/O02/PLAN.md §2 for full contract.
set -euo pipefail

# ── defaults (can be overridden by env vars or flags) ──────────────────────
ENV="${VICI2_ENV:-dev}"
ARCHIVE_CLASS="daily"
DB_HOST="${VICI2_DB_HOST:-localhost}"
DB_PORT="${VICI2_DB_PORT:-3306}"
DB_NAME="${VICI2_DB_NAME:-vici2}"
BUCKET="${VICI2_BACKUP_BUCKET:-vici2-backups}"
KEK_ALIAS="${VICI2_BACKUP_KEK_ALIAS:-alias/vici2-backup-kek}"
MYSQL_CNF="${MYSQL_CNF:-/etc/vici2/mysql-backup.cnf}"
DRY_RUN=false
ENDPOINT_URL=""

# ── arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)            ENV="$2";            shift 2 ;;
    --archive-class)  ARCHIVE_CLASS="$2";  shift 2 ;;
    --db-host)        DB_HOST="$2";        shift 2 ;;
    --db-port)        DB_PORT="$2";        shift 2 ;;
    --db-name)        DB_NAME="$2";        shift 2 ;;
    --bucket)         BUCKET="$2";         shift 2 ;;
    --kek-alias)      KEK_ALIAS="$2";      shift 2 ;;
    --mysql-cnf)      MYSQL_CNF="$2";      shift 2 ;;
    --endpoint-url)   ENDPOINT_URL="$2";   shift 2 ;;
    --dry-run)        DRY_RUN=true;        shift ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

# ── validate ─────────────────────────────────────────────────────────────────
case "$ARCHIVE_CLASS" in daily|monthly|yearly) ;; *) echo "ERROR: --archive-class must be daily|monthly|yearly" >&2; exit 1 ;; esac
case "$ENV" in prod|staging|dev) ;; *) echo "ERROR: --env must be prod|staging|dev" >&2; exit 1 ;; esac

# ── zstd level: fast for daily, max for monthly/yearly cold archives ─────────
if [[ "$ARCHIVE_CLASS" == "daily" ]]; then
  ZSTD_LEVEL=3
else
  ZSTD_LEVEL=19
fi

# ── timestamps ───────────────────────────────────────────────────────────────
TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
YYYY=$(date -u +%Y)
MM=$(date -u +%m)
DD=$(date -u +%d)

S3_URI="s3://${BUCKET}/${ENV}/mysql/${YYYY}/${MM}/${DD}/dump-${TS}.sql.zst"
SHA_URI="${S3_URI}.sha256"
TEXTFILE_DIR="${VICI2_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
PROM_FILE="${TEXTFILE_DIR}/vici2_backup_mysql.prom"
START_TS=$(date -u +%s)

# ── structured log helper ─────────────────────────────────────────────────────
log_json() {
  local level="$1" msg="$2" extra="${3:-}"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","level":"%s","service":"vici2-backup","module":"O02","backup_service":"mysql","env":"%s","archive_class":"%s"%s,"msg":"%s"}\n' \
    "$now" "$level" "$ENV" "$ARCHIVE_CLASS" "${extra:+,$extra}" "$msg"
}

# ── AWS CLI helper (supports --endpoint-url for LocalStack/MinIO) ─────────────
aws_cmd() {
  if [[ -n "$ENDPOINT_URL" ]]; then
    aws --endpoint-url "$ENDPOINT_URL" "$@"
  else
    aws "$@"
  fi
}

# ── mysqldump version for metadata ────────────────────────────────────────────
MYSQLDUMP_VERSION=$(mysqldump --version 2>&1 | awk '{print $3}' || echo "unknown")

emit_prom() {
  local success="$1" size_bytes="$2" duration_sec="$3" failures="$4"
  if [[ -d "$TEXTFILE_DIR" ]]; then
    {
      echo "# HELP vici2_backup_last_success_timestamp Unix timestamp of last successful backup."
      echo "# TYPE vici2_backup_last_success_timestamp gauge"
      if [[ "$success" == "1" ]]; then
        echo "vici2_backup_last_success_timestamp{service=\"mysql\",env=\"${ENV}\"} $(date -u +%s)"
      fi
      echo "# HELP vici2_backup_size_bytes Size of the compressed backup artifact in bytes."
      echo "# TYPE vici2_backup_size_bytes gauge"
      echo "vici2_backup_size_bytes{service=\"mysql\",env=\"${ENV}\"} ${size_bytes}"
      echo "# HELP vici2_backup_duration_seconds Total backup duration in seconds."
      echo "# TYPE vici2_backup_duration_seconds gauge"
      echo "vici2_backup_duration_seconds{service=\"mysql\",env=\"${ENV}\"} ${duration_sec}"
      echo "# HELP vici2_backup_failures_total Total backup failures."
      echo "# TYPE vici2_backup_failures_total counter"
      echo "vici2_backup_failures_total{service=\"mysql\",env=\"${ENV}\"} ${failures}"
    } > "${PROM_FILE}.tmp" && mv "${PROM_FILE}.tmp" "${PROM_FILE}"
  fi
}

FAIL_REASON=""
cleanup() {
  local exit_code=$?
  rm -f /tmp/dump.sha256
  if [[ $exit_code -ne 0 ]]; then
    local duration=$(( $(date -u +%s) - START_TS ))
    log_json "error" "backup failed" "\"fail_reason\":\"${FAIL_REASON}\",\"duration_sec\":${duration}"
    emit_prom 0 0 "$duration" 1
  fi
}
trap cleanup EXIT

log_json "info" "backup starting" "\"dry_run\":${DRY_RUN}"

# ── check MySQL cnf exists (only if not a dummy path in CI) ──────────────────
if [[ ! -f "$MYSQL_CNF" ]]; then
  # Fall back to ~/.my.cnf if the dedicated cnf is absent (dev/CI convenience)
  if [[ -f "${HOME}/.my.cnf" ]]; then
    MYSQL_CNF="${HOME}/.my.cnf"
    log_json "warn" "mysql-backup.cnf not found; falling back to ~/.my.cnf"
  else
    log_json "warn" "no MySQL cnf found; will attempt unauthenticated or env-based connection"
    MYSQL_CNF=""
  fi
fi

CNF_ARG=""
[[ -n "$MYSQL_CNF" ]] && CNF_ARG="--defaults-extra-file=${MYSQL_CNF}"

# ── build the mysqldump pipeline ──────────────────────────────────────────────
DUMP_CMD=(
  mysqldump
  ${CNF_ARG:+$CNF_ARG}
  --host="${DB_HOST}"
  --port="${DB_PORT}"
  --single-transaction
  --quick
  --routines
  --triggers
  --events
  --hex-blob
  --set-gtid-purged=OFF
  --skip-lock-tables
  --default-character-set=utf8mb4
  --no-autocommit
  --databases "${DB_NAME}"
)

METADATA="service=mysql,env=${ENV},archive_class=${ARCHIVE_CLASS},kek_version=1,backup_tool=mysqldump,backup_tool_version=${MYSQLDUMP_VERSION}"
TAGGING="backup_class=${ARCHIVE_CLASS}&service=mysql&env=${ENV}"

if [[ "$DRY_RUN" == "true" ]]; then
  log_json "info" "dry-run: verifying mysqldump connectivity and pipeline"
  FAIL_REASON="mysqldump"
  SIZE_BYTES=$( "${DUMP_CMD[@]}" | zstd "-${ZSTD_LEVEL}" -c | wc -c )
  FAIL_REASON=""
  log_json "info" "dry-run complete" "\"compressed_bytes\":${SIZE_BYTES}"
  emit_prom 1 "$SIZE_BYTES" "$(( $(date -u +%s) - START_TS ))" 0
  exit 0
fi

# ── real backup: stream mysqldump | zstd | tee sha256 | s3 cp ────────────────
FAIL_REASON="mysqldump"

# We use a subshell + process substitution for the SHA256 side-channel.
# The sha256sum reads from tee's copy in a background fd.
TMP_SHA=/tmp/dump.sha256

S3_UPLOAD_CMD=(
  aws_cmd s3 cp -
  "${S3_URI}"
  --sse aws:kms
  --sse-kms-key-id "${KEK_ALIAS}"
  --checksum-algorithm sha256
  --metadata "${METADATA}"
  --tagging "${TAGGING}"
)

# tee to fd3 for sha256, pipe to s3 from main stdout
exec 3> >(sha256sum > "$TMP_SHA")

FAIL_REASON="zstd"
"${DUMP_CMD[@]}" \
  | zstd "-${ZSTD_LEVEL}" -c \
  | tee /dev/fd/3 \
  | aws_cmd s3 cp - "${S3_URI}" \
      --sse aws:kms \
      --sse-kms-key-id "${KEK_ALIAS}" \
      --checksum-algorithm sha256 \
      --metadata "${METADATA}" \
      --tagging "${TAGGING}"

FAIL_REASON="s3_sha256"
# Wait for sha256 to finish writing
exec 3>&-

# ── upload sibling SHA256 ────────────────────────────────────────────────────
aws_cmd s3 cp "$TMP_SHA" "${SHA_URI}" \
  --sse aws:kms \
  --sse-kms-key-id "${KEK_ALIAS}" \
  --tagging "${TAGGING}"

FAIL_REASON=""

# ── compute metrics ───────────────────────────────────────────────────────────
DURATION=$(( $(date -u +%s) - START_TS ))
SHA256_VALUE=$(awk '{print $1}' "$TMP_SHA")
SIZE_BYTES=$(aws_cmd s3api head-object --bucket "${BUCKET}" --key "${ENV}/mysql/${YYYY}/${MM}/${DD}/dump-${TS}.sql.zst" --query ContentLength --output text 2>/dev/null || echo 0)

emit_prom 1 "${SIZE_BYTES}" "${DURATION}" 0

log_json "info" "backup completed" \
  "\"s3_uri\":\"${S3_URI}\",\"size_bytes\":${SIZE_BYTES},\"duration_sec\":${DURATION},\"sha256\":\"${SHA256_VALUE}\""

rm -f "$TMP_SHA"
