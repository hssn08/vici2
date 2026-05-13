#!/usr/bin/env bash
# scripts/backup/valkey.sh — O02 Phase 1 Valkey (Redis-compatible) backup
# Usage: scripts/backup/valkey.sh --env prod|staging|dev --archive-class daily|monthly|yearly [options]
# See spec/modules/O02/PLAN.md §3 for full contract.
set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────────────
ENV="${VICI2_ENV:-dev}"
ARCHIVE_CLASS="daily"
VALKEY_HOST="${VICI2_VALKEY_HOST:-localhost}"
VALKEY_PORT="${VICI2_VALKEY_PORT:-6379}"
VALKEY_PASSWORD="${VALKEY_PASSWORD:-}"
DATA_DIR="${VICI2_VALKEY_DATA_DIR:-/var/lib/docker/volumes/vici2_valkey_data/_data}"
BUCKET="${VICI2_BACKUP_BUCKET:-vici2-backups}"
KEK_ALIAS="${VICI2_BACKUP_KEK_ALIAS:-alias/vici2-backup-kek}"
DRY_RUN=false
ENDPOINT_URL=""
USE_DOCKER_CP=false  # set true if running in Docker dev environment

# ── arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)             ENV="$2";             shift 2 ;;
    --archive-class)   ARCHIVE_CLASS="$2";   shift 2 ;;
    --valkey-host)     VALKEY_HOST="$2";     shift 2 ;;
    --valkey-port)     VALKEY_PORT="$2";     shift 2 ;;
    --valkey-password) VALKEY_PASSWORD="$2"; shift 2 ;;
    --data-dir)        DATA_DIR="$2";        shift 2 ;;
    --bucket)          BUCKET="$2";          shift 2 ;;
    --kek-alias)       KEK_ALIAS="$2";       shift 2 ;;
    --endpoint-url)    ENDPOINT_URL="$2";    shift 2 ;;
    --docker-cp)       USE_DOCKER_CP=true;   shift ;;
    --dry-run)         DRY_RUN=true;         shift ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

# ── validate ─────────────────────────────────────────────────────────────────
case "$ARCHIVE_CLASS" in daily|monthly|yearly) ;; *) echo "ERROR: --archive-class must be daily|monthly|yearly" >&2; exit 1 ;; esac
case "$ENV" in prod|staging|dev) ;; *) echo "ERROR: --env must be prod|staging|dev" >&2; exit 1 ;; esac

[[ "$ARCHIVE_CLASS" == "daily" ]] && ZSTD_LEVEL=3 || ZSTD_LEVEL=19

TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
YYYY=$(date -u +%Y)
MM=$(date -u +%m)
DD=$(date -u +%d)

S3_URI="s3://${BUCKET}/${ENV}/valkey/${YYYY}/${MM}/${DD}/dump-${TS}.rdb.zst"
SHA_URI="s3://${BUCKET}/${ENV}/valkey/${YYYY}/${MM}/${DD}/dump-${TS}.rdb.sha256"

TEXTFILE_DIR="${VICI2_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
PROM_FILE="${TEXTFILE_DIR}/vici2_backup_valkey.prom"
START_TS=$(date -u +%s)
TMP_RDB=/tmp/dump_valkey_$$.rdb
TMP_SHA=/tmp/dump_valkey_$$.rdb.sha256

# ── helpers ───────────────────────────────────────────────────────────────────
log_json() {
  local level="$1" msg="$2" extra="${3:-}"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","level":"%s","service":"vici2-backup","module":"O02","backup_service":"valkey","env":"%s","archive_class":"%s"%s,"msg":"%s"}\n' \
    "$now" "$level" "$ENV" "$ARCHIVE_CLASS" "${extra:+,$extra}" "$msg"
}

aws_cmd() {
  if [[ -n "$ENDPOINT_URL" ]]; then
    aws --endpoint-url "$ENDPOINT_URL" "$@"
  else
    aws "$@"
  fi
}

valkey_cli_cmd() {
  if [[ -n "$VALKEY_PASSWORD" ]]; then
    valkey-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" -a "$VALKEY_PASSWORD" "$@"
  else
    valkey-cli -h "$VALKEY_HOST" -p "$VALKEY_PORT" "$@"
  fi
}

emit_prom() {
  local success="$1" size_bytes="$2" duration_sec="$3" failures="$4"
  if [[ -d "$TEXTFILE_DIR" ]]; then
    {
      echo "# HELP vici2_backup_last_success_timestamp Unix timestamp of last successful backup."
      echo "# TYPE vici2_backup_last_success_timestamp gauge"
      [[ "$success" == "1" ]] && echo "vici2_backup_last_success_timestamp{service=\"valkey\",env=\"${ENV}\"} $(date -u +%s)"
      echo "# HELP vici2_backup_size_bytes Size of compressed backup artifact in bytes."
      echo "# TYPE vici2_backup_size_bytes gauge"
      echo "vici2_backup_size_bytes{service=\"valkey\",env=\"${ENV}\"} ${size_bytes}"
      echo "# HELP vici2_backup_duration_seconds Total backup duration in seconds."
      echo "# TYPE vici2_backup_duration_seconds gauge"
      echo "vici2_backup_duration_seconds{service=\"valkey\",env=\"${ENV}\"} ${duration_sec}"
      echo "# HELP vici2_backup_failures_total Total backup failures."
      echo "# TYPE vici2_backup_failures_total counter"
      echo "vici2_backup_failures_total{service=\"valkey\",env=\"${ENV}\"} ${failures}"
    } > "${PROM_FILE}.tmp" && mv "${PROM_FILE}.tmp" "${PROM_FILE}"
  fi
}

FAIL_REASON=""
cleanup() {
  local exit_code=$?
  rm -f "$TMP_RDB" "$TMP_SHA"
  if [[ $exit_code -ne 0 ]]; then
    local duration=$(( $(date -u +%s) - START_TS ))
    log_json "error" "backup failed" "\"fail_reason\":\"${FAIL_REASON}\",\"duration_sec\":${duration}"
    emit_prom 0 0 "$duration" 1
  fi
}
trap cleanup EXIT

log_json "info" "backup starting" "\"dry_run\":${DRY_RUN}"

# ── fork-OOM mitigation check ─────────────────────────────────────────────────
BGSAVE_REPLY=$(valkey_cli_cmd BGSAVE 2>&1 || true)
if echo "$BGSAVE_REPLY" | grep -q "Background save already in progress"; then
  log_json "error" "BGSAVE already in progress — another backup or auto-save is running; wait and retry"
  FAIL_REASON="bgsave_in_progress"
  exit 1
fi

# ── record pre-save LASTSAVE timestamp ───────────────────────────────────────
PRE=$(valkey_cli_cmd LASTSAVE)
log_json "info" "BGSAVE triggered" "\"pre_lastsave\":${PRE}"

# ── poll until BGSAVE completes (10-minute timeout, 300 × 2s) ────────────────
FAIL_REASON="bgsave_timeout"
for i in $(seq 1 300); do
  POST=$(valkey_cli_cmd LASTSAVE)
  STATUS=$(valkey_cli_cmd INFO persistence 2>/dev/null | awk -F: '/^rdb_last_bgsave_status:/{print $2}' | tr -d '\r\n ')
  if [[ "$POST" -gt "$PRE" && "$STATUS" == "ok" ]]; then
    break
  fi
  if [[ "$i" -eq 300 ]]; then
    log_json "error" "BGSAVE timed out after 600s"
    exit 1
  fi
  sleep 2
done
FAIL_REASON=""

log_json "info" "BGSAVE completed" "\"post_lastsave\":${POST}"

# ── locate dump.rdb ──────────────────────────────────────────────────────────
FAIL_REASON="rdb_copy"
if [[ "$DRY_RUN" == "true" ]]; then
  log_json "info" "dry-run: BGSAVE poll succeeded; skipping S3 upload"
  emit_prom 1 0 "$(( $(date -u +%s) - START_TS ))" 0
  exit 0
fi

if [[ "$USE_DOCKER_CP" == "true" ]]; then
  docker cp vici2_valkey:/data/dump.rdb "$TMP_RDB"
elif [[ -f "${DATA_DIR}/dump.rdb" ]]; then
  cp "${DATA_DIR}/dump.rdb" "$TMP_RDB"
else
  log_json "error" "dump.rdb not found at ${DATA_DIR}; try --docker-cp for Docker dev"
  exit 1
fi

# ── SHA256 of the uncompressed RDB (verifier can re-hash after zstd -d) ──────
sha256sum "$TMP_RDB" | awk '{print $1}' > "$TMP_SHA"
SHA256_VALUE=$(cat "$TMP_SHA")

FAIL_REASON="s3_upload"
METADATA="service=valkey,env=${ENV},archive_class=${ARCHIVE_CLASS},kek_version=1"
TAGGING="backup_class=${ARCHIVE_CLASS}&service=valkey&env=${ENV}"

zstd "-${ZSTD_LEVEL}" -c < "$TMP_RDB" \
  | aws_cmd s3 cp - "${S3_URI}" \
      --sse aws:kms \
      --sse-kms-key-id "${KEK_ALIAS}" \
      --metadata "${METADATA}" \
      --tagging "${TAGGING}"

FAIL_REASON="s3_sha256"
aws_cmd s3 cp "$TMP_SHA" "${SHA_URI}" \
  --sse aws:kms \
  --sse-kms-key-id "${KEK_ALIAS}" \
  --tagging "${TAGGING}"

FAIL_REASON=""

DURATION=$(( $(date -u +%s) - START_TS ))
SIZE_BYTES=$(aws_cmd s3api head-object --bucket "${BUCKET}" --key "${ENV}/valkey/${YYYY}/${MM}/${DD}/dump-${TS}.rdb.zst" --query ContentLength --output text 2>/dev/null || echo 0)

emit_prom 1 "${SIZE_BYTES}" "${DURATION}" 0

log_json "info" "backup completed" \
  "\"s3_uri\":\"${S3_URI}\",\"size_bytes\":${SIZE_BYTES},\"duration_sec\":${DURATION},\"sha256\":\"${SHA256_VALUE}\""

rm -f "$TMP_RDB" "$TMP_SHA"
