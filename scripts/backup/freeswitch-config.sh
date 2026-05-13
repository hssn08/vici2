#!/usr/bin/env bash
# scripts/backup/freeswitch-config.sh — O02 Phase 1 FreeSWITCH config backup
# Usage: scripts/backup/freeswitch-config.sh --env prod|staging|dev --archive-class daily|monthly|yearly [options]
# See spec/modules/O02/PLAN.md §4 for full contract.
# Note: uses gzip (not zstd) because configs are small (<1 MB) and gzip is
# universally present without extra deps at restore time.
set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────────────
ENV="${VICI2_ENV:-dev}"
ARCHIVE_CLASS="daily"
SOURCE="${VICI2_FS_CONFIG_DIR:-/etc/freeswitch}"
BUCKET="${VICI2_BACKUP_BUCKET:-vici2-backups}"
KEK_ALIAS="${VICI2_BACKUP_KEK_ALIAS:-alias/vici2-backup-kek}"
DRY_RUN=false
ENDPOINT_URL=""

# ── arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)           ENV="$2";           shift 2 ;;
    --archive-class) ARCHIVE_CLASS="$2"; shift 2 ;;
    --source)        SOURCE="$2";        shift 2 ;;
    --bucket)        BUCKET="$2";        shift 2 ;;
    --kek-alias)     KEK_ALIAS="$2";     shift 2 ;;
    --endpoint-url)  ENDPOINT_URL="$2";  shift 2 ;;
    --dry-run)       DRY_RUN=true;       shift ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

# ── validate ─────────────────────────────────────────────────────────────────
case "$ARCHIVE_CLASS" in daily|monthly|yearly) ;; *) echo "ERROR: --archive-class must be daily|monthly|yearly" >&2; exit 1 ;; esac
case "$ENV" in prod|staging|dev) ;; *) echo "ERROR: --env must be prod|staging|dev" >&2; exit 1 ;; esac

TS=$(date -u +%Y-%m-%dT%H-%M-%SZ)
YYYY=$(date -u +%Y)
MM=$(date -u +%m)
DD=$(date -u +%d)

ARTIFACT="etc-freeswitch-${TS}.tar.gz"
S3_URI="s3://${BUCKET}/${ENV}/freeswitch/${YYYY}/${MM}/${DD}/${ARTIFACT}"
SHA_URI="${S3_URI}.sha256"

TEXTFILE_DIR="${VICI2_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
PROM_FILE="${TEXTFILE_DIR}/vici2_backup_freeswitch.prom"
START_TS=$(date -u +%s)
TMP_SHA=/tmp/etc-fs-$$.sha256

# ── helpers ───────────────────────────────────────────────────────────────────
log_json() {
  local level="$1" msg="$2" extra="${3:-}"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","level":"%s","service":"vici2-backup","module":"O02","backup_service":"freeswitch","env":"%s","archive_class":"%s"%s,"msg":"%s"}\n' \
    "$now" "$level" "$ENV" "$ARCHIVE_CLASS" "${extra:+,$extra}" "$msg"
}

aws_cmd() {
  if [[ -n "$ENDPOINT_URL" ]]; then
    aws --endpoint-url "$ENDPOINT_URL" "$@"
  else
    aws "$@"
  fi
}

emit_prom() {
  local success="$1" size_bytes="$2" duration_sec="$3" failures="$4"
  if [[ -d "$TEXTFILE_DIR" ]]; then
    {
      echo "# HELP vici2_backup_last_success_timestamp Unix timestamp of last successful backup."
      echo "# TYPE vici2_backup_last_success_timestamp gauge"
      [[ "$success" == "1" ]] && echo "vici2_backup_last_success_timestamp{service=\"freeswitch\",env=\"${ENV}\"} $(date -u +%s)"
      echo "# HELP vici2_backup_size_bytes Size of compressed backup artifact in bytes."
      echo "# TYPE vici2_backup_size_bytes gauge"
      echo "vici2_backup_size_bytes{service=\"freeswitch\",env=\"${ENV}\"} ${size_bytes}"
      echo "# HELP vici2_backup_duration_seconds Total backup duration in seconds."
      echo "# TYPE vici2_backup_duration_seconds gauge"
      echo "vici2_backup_duration_seconds{service=\"freeswitch\",env=\"${ENV}\"} ${duration_sec}"
      echo "# HELP vici2_backup_failures_total Total backup failures."
      echo "# TYPE vici2_backup_failures_total counter"
      echo "vici2_backup_failures_total{service=\"freeswitch\",env=\"${ENV}\"} ${failures}"
    } > "${PROM_FILE}.tmp" && mv "${PROM_FILE}.tmp" "${PROM_FILE}"
  fi
}

FAIL_REASON=""
cleanup() {
  local exit_code=$?
  rm -f "$TMP_SHA"
  if [[ $exit_code -ne 0 ]]; then
    local duration=$(( $(date -u +%s) - START_TS ))
    log_json "error" "backup failed" "\"fail_reason\":\"${FAIL_REASON}\",\"duration_sec\":${duration}"
    emit_prom 0 0 "$duration" 1
  fi
}
trap cleanup EXIT

log_json "info" "backup starting" "\"source\":\"${SOURCE}\",\"dry_run\":${DRY_RUN}"

# ── verify source exists and is readable ─────────────────────────────────────
FAIL_REASON="source_unreadable"
if [[ ! -d "$SOURCE" ]]; then
  log_json "error" "FreeSWITCH config dir not found" "\"source\":\"${SOURCE}\""
  exit 1
fi
if [[ ! -r "$SOURCE" ]]; then
  log_json "error" "FreeSWITCH config dir not readable" "\"source\":\"${SOURCE}\""
  exit 1
fi
FAIL_REASON=""

METADATA="service=freeswitch,env=${ENV},archive_class=${ARCHIVE_CLASS},kek_version=1"
TAGGING="backup_class=${ARCHIVE_CLASS}&service=freeswitch&env=${ENV}"

if [[ "$DRY_RUN" == "true" ]]; then
  log_json "info" "dry-run: measuring tarball size"
  SIZE_BYTES=$(tar \
    --exclude='./tls' \
    --exclude='./*/tls' \
    --exclude='*.gitkeep' \
    --exclude='*.bak' \
    --exclude='*~' \
    -C "${SOURCE}" \
    -czf - . 2>/dev/null | wc -c)
  log_json "info" "dry-run complete" "\"compressed_bytes\":${SIZE_BYTES}"
  emit_prom 1 "$SIZE_BYTES" "$(( $(date -u +%s) - START_TS ))" 0
  exit 0
fi

# ── real backup: tar | tee sha256 | s3 cp ────────────────────────────────────
FAIL_REASON="tar"
exec 3> >(sha256sum > "$TMP_SHA")

tar \
  --exclude='./tls' \
  --exclude='./*/tls' \
  --exclude='*.gitkeep' \
  --exclude='*.bak' \
  --exclude='*~' \
  -C "${SOURCE}" \
  -czf - . \
  | tee /dev/fd/3 \
  | aws_cmd s3 cp - "${S3_URI}" \
      --sse aws:kms \
      --sse-kms-key-id "${KEK_ALIAS}" \
      --metadata "${METADATA}" \
      --tagging "${TAGGING}"

exec 3>&-
FAIL_REASON="s3_sha256"

aws_cmd s3 cp "$TMP_SHA" "${SHA_URI}" \
  --sse aws:kms \
  --sse-kms-key-id "${KEK_ALIAS}" \
  --tagging "${TAGGING}"

FAIL_REASON=""

DURATION=$(( $(date -u +%s) - START_TS ))
SHA256_VALUE=$(awk '{print $1}' "$TMP_SHA")
SIZE_BYTES=$(aws_cmd s3api head-object --bucket "${BUCKET}" --key "${ENV}/freeswitch/${YYYY}/${MM}/${DD}/${ARTIFACT}" --query ContentLength --output text 2>/dev/null || echo 0)

emit_prom 1 "${SIZE_BYTES}" "${DURATION}" 0

log_json "info" "backup completed" \
  "\"s3_uri\":\"${S3_URI}\",\"size_bytes\":${SIZE_BYTES},\"duration_sec\":${DURATION},\"sha256\":\"${SHA256_VALUE}\""

rm -f "$TMP_SHA"
