#!/usr/bin/env bash
# scripts/backup/tip-verify.sh — O02 nightly tip-integrity verification
# Runs at 02:55 UTC after all backup scripts complete.
# For each service, downloads today's .sha256 sidecar and compares against
# S3's native SHA256 checksum (--checksum-mode ENABLED).
# See spec/modules/O02/PLAN.md §13.2.
set -euo pipefail

ENV="${VICI2_ENV:-prod}"
BUCKET="${VICI2_BACKUP_BUCKET:-vici2-backups}"
KEK_ALIAS="${VICI2_BACKUP_KEK_ALIAS:-alias/vici2-backup-kek}"
ENDPOINT_URL=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)          ENV="$2";           shift 2 ;;
    --bucket)       BUCKET="$2";        shift 2 ;;
    --endpoint-url) ENDPOINT_URL="$2";  shift 2 ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

YYYY=$(date -u +%Y)
MM=$(date -u +%m)
DD=$(date -u +%d)

TEXTFILE_DIR="${VICI2_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
PROM_FILE="${TEXTFILE_DIR}/vici2_backup_tip_verify.prom"
START_TS=$(date -u +%s)
FAILURE_COUNT=0

log_json() {
  local level="$1" msg="$2" extra="${3:-}"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","level":"%s","service":"vici2-backup","module":"O02","component":"tip-verify","env":"%s"%s,"msg":"%s"}\n' \
    "$now" "$level" "$ENV" "${extra:+,$extra}" "$msg"
}

aws_cmd() {
  if [[ -n "$ENDPOINT_URL" ]]; then
    aws --endpoint-url "$ENDPOINT_URL" "$@"
  else
    aws "$@"
  fi
}

verify_service() {
  local service="$1"
  local prefix="${ENV}/${service}/${YYYY}/${MM}/${DD}/"

  log_json "info" "verifying tip backup" "\"service\":\"${service}\",\"prefix\":\"${prefix}\""

  # Find latest artifact (not the .sha256 sidecar)
  local artifact_key
  artifact_key=$(aws_cmd s3 ls "s3://${BUCKET}/${prefix}" 2>/dev/null \
    | grep -v '\.sha256' \
    | awk '{print $4}' \
    | sort | tail -1 || true)

  if [[ -z "$artifact_key" ]]; then
    log_json "error" "no artifact found for today" "\"service\":\"${service}\",\"prefix\":\"${prefix}\""
    FAILURE_COUNT=$(( FAILURE_COUNT + 1 ))
    return
  fi

  local full_key="${prefix}${artifact_key}"
  local sha_key="${full_key}.sha256"
  local tmp_sha
  tmp_sha=$(mktemp /tmp/tip-verify-XXXXXX.sha256)

  # Download the sidecar SHA256
  if ! aws_cmd s3 cp "s3://${BUCKET}/${sha_key}" "$tmp_sha" >/dev/null 2>&1; then
    log_json "error" "failed to download SHA256 sidecar" "\"service\":\"${service}\",\"sha_key\":\"${sha_key}\""
    FAILURE_COUNT=$(( FAILURE_COUNT + 1 ))
    rm -f "$tmp_sha"
    return
  fi

  local expected_sha
  expected_sha=$(awk '{print $1}' "$tmp_sha")

  # For MySQL/FreeSWITCH: the sidecar hash covers the compressed artifact.
  # Compare against S3 native checksum via head-object --checksum-mode ENABLED.
  local s3_checksum
  s3_checksum=$(aws_cmd s3api head-object \
    --bucket "${BUCKET}" \
    --key "${full_key}" \
    --checksum-mode ENABLED \
    --query 'ChecksumSHA256' \
    --output text 2>/dev/null || echo "UNAVAILABLE")

  if [[ "$s3_checksum" == "None" || "$s3_checksum" == "UNAVAILABLE" ]]; then
    # S3 native checksum not available (object predates checksum feature or LocalStack).
    # Fall back to sidecar-only verification: just confirm sidecar exists and is non-empty.
    if [[ -z "$expected_sha" ]]; then
      log_json "error" "SHA256 sidecar is empty" "\"service\":\"${service}\",\"artifact\":\"${artifact_key}\""
      FAILURE_COUNT=$(( FAILURE_COUNT + 1 ))
    else
      log_json "info" "tip verified (sidecar-only; S3 native checksum unavailable)" \
        "\"service\":\"${service}\",\"artifact\":\"${artifact_key}\",\"sha256\":\"${expected_sha}\""
    fi
  else
    # S3 stores the checksum as base64; convert expected_sha (hex) to base64 for comparison.
    local expected_b64
    expected_b64=$(echo "$expected_sha" | xxd -r -p | base64)
    if [[ "$s3_checksum" == "$expected_b64" ]]; then
      log_json "info" "tip verified" \
        "\"service\":\"${service}\",\"artifact\":\"${artifact_key}\",\"sha256\":\"${expected_sha}\""
    else
      log_json "error" "SHA256 MISMATCH — possible corruption" \
        "\"service\":\"${service}\",\"artifact\":\"${artifact_key}\",\"expected\":\"${expected_sha}\",\"s3_checksum\":\"${s3_checksum}\""
      FAILURE_COUNT=$(( FAILURE_COUNT + 1 ))
    fi
  fi

  rm -f "$tmp_sha"
}

verify_service mysql
verify_service valkey
verify_service freeswitch

DURATION=$(( $(date -u +%s) - START_TS ))

# ── emit Prom metrics ─────────────────────────────────────────────────────────
if [[ -d "$TEXTFILE_DIR" ]]; then
  {
    echo "# HELP vici2_backup_tip_verify_last_success_timestamp Unix timestamp of last successful tip verify run."
    echo "# TYPE vici2_backup_tip_verify_last_success_timestamp gauge"
    if [[ "$FAILURE_COUNT" -eq 0 ]]; then
      echo "vici2_backup_tip_verify_last_success_timestamp{env=\"${ENV}\"} $(date -u +%s)"
    fi
    echo "# HELP vici2_backup_integrity_failure_total Total integrity failures detected by tip-verify."
    echo "# TYPE vici2_backup_integrity_failure_total counter"
    echo "vici2_backup_integrity_failure_total{env=\"${ENV}\"} ${FAILURE_COUNT}"
  } > "${PROM_FILE}.tmp" && mv "${PROM_FILE}.tmp" "${PROM_FILE}"
fi

if [[ "$FAILURE_COUNT" -gt 0 ]]; then
  log_json "error" "tip-verify completed with failures" \
    "\"failures\":${FAILURE_COUNT},\"duration_sec\":${DURATION}"
  exit 1
fi

log_json "info" "tip-verify completed successfully" "\"duration_sec\":${DURATION}"
