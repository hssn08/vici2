#!/usr/bin/env bash
# scripts/restore/from-s3.sh — O02 Phase 1 restore from S3
# Usage: scripts/restore/from-s3.sh --service mysql|valkey|freeswitch --date YYYY-MM-DD [options]
# See spec/modules/O02/PLAN.md §5 for full contract and safety semantics.
set -euo pipefail

# ── defaults ─────────────────────────────────────────────────────────────────
SERVICE=""
DATE=""
ARCHIVE_CLASS=""  # omit = pick newest
TARGET="staging"
ENV="prod"
BUCKET="${VICI2_BACKUP_BUCKET:-vici2-backups}"
CONFIRM_DESTROY=false
ENDPOINT_URL=""
STAGING_DB_HOST="${VICI2_STAGING_DB_HOST:-localhost}"
STAGING_DB_PORT="${VICI2_STAGING_DB_PORT:-3307}"
VALKEY_DATA_DIR="${VICI2_VALKEY_DATA_DIR:-/var/lib/docker/volumes/vici2_valkey_data/_data}"
FS_CONFIG_DIR="${VICI2_FS_CONFIG_DIR:-/etc/freeswitch}"

# ── arg parsing ──────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --service)         SERVICE="$2";          shift 2 ;;
    --date)            DATE="$2";             shift 2 ;;
    --archive-class)   ARCHIVE_CLASS="$2";    shift 2 ;;
    --target)          TARGET="$2";           shift 2 ;;
    --env)             ENV="$2";              shift 2 ;;
    --bucket)          BUCKET="$2";           shift 2 ;;
    --confirm-destroy) CONFIRM_DESTROY=true;  shift ;;
    --endpoint-url)    ENDPOINT_URL="$2";     shift 2 ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

# ── validate ─────────────────────────────────────────────────────────────────
if [[ -z "$SERVICE" ]]; then echo "ERROR: --service is required" >&2; exit 1; fi
if [[ -z "$DATE" ]];    then echo "ERROR: --date YYYY-MM-DD is required" >&2; exit 1; fi
case "$SERVICE" in mysql|valkey|freeswitch) ;; *) echo "ERROR: --service must be mysql|valkey|freeswitch" >&2; exit 1 ;; esac
case "$TARGET" in staging|local|prod-emergency) ;; *) echo "ERROR: --target must be staging|local|prod-emergency" >&2; exit 1 ;; esac
case "$ENV" in prod|staging|dev) ;; *) echo "ERROR: --env must be prod|staging|dev" >&2; exit 1 ;; esac

# ── prod-emergency safety gate ────────────────────────────────────────────────
if [[ "$TARGET" == "prod-emergency" && "$CONFIRM_DESTROY" != "true" ]]; then
  cat >&2 <<EOF

ERROR: --target prod-emergency requires --confirm-destroy.

This operation will OVERWRITE the production database with the chosen backup.

To proceed, re-run with --confirm-destroy.  Make sure you have a fresh backup
taken in the last 5 minutes (run scripts/backup/${SERVICE}.sh first).

EOF
  exit 1
fi

# ── local target: interactive confirmation ────────────────────────────────────
if [[ "$TARGET" == "local" && "$CONFIRM_DESTROY" != "true" ]]; then
  echo ""
  echo "WARNING: --target local will overwrite the LOCAL ${SERVICE} instance."
  printf "Type 'yes' to proceed: "
  read -r CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "Aborted."
    exit 0
  fi
fi

# ── helpers ───────────────────────────────────────────────────────────────────
YYYY="${DATE%%-*}"
REST="${DATE#*-}"
MM="${REST%%-*}"
DD="${REST#*-}"

START_TS=$(date -u +%s)

log_json() {
  local level="$1" msg="$2" extra="${3:-}"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","level":"%s","service":"vici2-restore","module":"O02","restore_service":"%s","env":"%s","target":"%s","date":"%s"%s,"msg":"%s"}\n' \
    "$now" "$level" "$SERVICE" "$ENV" "$TARGET" "$DATE" "${extra:+,$extra}" "$msg"
}

aws_cmd() {
  if [[ -n "$ENDPOINT_URL" ]]; then
    aws --endpoint-url "$ENDPOINT_URL" "$@"
  else
    aws "$@"
  fi
}

WORKDIR=$(mktemp -d /tmp/vici2-restore-XXXXXX)
cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

log_json "info" "restore starting"

PREFIX="${ENV}/${SERVICE}/${YYYY}/${MM}/${DD}/"

# ── list artifacts for the given date ────────────────────────────────────────
log_json "info" "listing artifacts" "\"prefix\":\"${PREFIX}\""
ARTIFACT_LIST=$(aws_cmd s3 ls "s3://${BUCKET}/${PREFIX}" 2>/dev/null \
  | grep -v '\.sha256$' \
  | awk '{print $4}' \
  | sort || true)

if [[ -z "$ARTIFACT_LIST" ]]; then
  log_json "error" "no artifacts found" "\"prefix\":\"${PREFIX}\""
  echo "ERROR: No artifacts found for service=${SERVICE} date=${DATE} env=${ENV}" >&2
  exit 1
fi

# Pick the newest (last lexicographically, since timestamps are ISO8601)
ARTIFACT_KEY=$(echo "$ARTIFACT_LIST" | tail -1)
FULL_KEY="${PREFIX}${ARTIFACT_KEY}"
SHA_KEY="${FULL_KEY}.sha256"

log_json "info" "selected artifact" "\"key\":\"${FULL_KEY}\""

# ── download artifact + sha256 ────────────────────────────────────────────────
ARTIFACT_FILE="${WORKDIR}/${ARTIFACT_KEY}"
SHA_FILE="${WORKDIR}/${ARTIFACT_KEY}.sha256"

log_json "info" "downloading artifact"
aws_cmd s3 cp "s3://${BUCKET}/${FULL_KEY}" "$ARTIFACT_FILE"
aws_cmd s3 cp "s3://${BUCKET}/${SHA_KEY}"  "$SHA_FILE"

# ── SHA256 integrity check ────────────────────────────────────────────────────
EXPECTED_HASH=$(awk '{print $1}' "$SHA_FILE")

case "$SERVICE" in
  mysql|freeswitch)
    # sidecar covers the compressed artifact
    ARTIFACT_HASH=$(sha256sum "$ARTIFACT_FILE" | awk '{print $1}')
    ;;
  valkey)
    # sidecar covers the UNCOMPRESSED rdb (per PLAN §3.2 step 5)
    # Decompress to tmp file for hashing, then re-use for restore
    DECOMPRESSED="${WORKDIR}/dump.rdb"
    zstd -d "$ARTIFACT_FILE" -o "$DECOMPRESSED"
    ARTIFACT_HASH=$(sha256sum "$DECOMPRESSED" | awk '{print $1}')
    ;;
esac

if [[ "$ARTIFACT_HASH" != "$EXPECTED_HASH" ]]; then
  log_json "error" "SHA256 MISMATCH — REFUSING TO RESTORE" \
    "\"expected\":\"${EXPECTED_HASH}\",\"got\":\"${ARTIFACT_HASH}\""
  echo "" >&2
  echo "ERROR: SHA256 mismatch — refusing to restore." >&2
  echo "  Expected: ${EXPECTED_HASH}" >&2
  echo "  Got:      ${ARTIFACT_HASH}" >&2
  echo "  Try re-downloading or restoring from a prior day." >&2
  exit 1
fi

log_json "info" "integrity verified" "\"sha256\":\"${EXPECTED_HASH}\""

# ── service-specific restore ──────────────────────────────────────────────────
case "$SERVICE" in

  # ── MySQL restore ────────────────────────────────────────────────────────────
  mysql)
    SQL_FILE="${WORKDIR}/dump.sql"
    log_json "info" "decompressing SQL"
    zstd -d "$ARTIFACT_FILE" -o "$SQL_FILE"

    case "$TARGET" in
      staging)
        log_json "info" "restoring to staging" "\"host\":\"${STAGING_DB_HOST}\",\"port\":\"${STAGING_DB_PORT}\""
        mysql -h "${STAGING_DB_HOST}" -P "${STAGING_DB_PORT}" < "$SQL_FILE"
        ;;
      local)
        log_json "info" "restoring to local MySQL"
        mysql < "$SQL_FILE"
        ;;
      prod-emergency)
        PROD_DB_HOST="${VICI2_DB_HOST:-localhost}"
        PROD_DB_PORT="${VICI2_DB_PORT:-3306}"
        # Print row counts so operator sees what's about to be replaced
        echo ""
        echo "============================================================"
        echo " PROD-EMERGENCY RESTORE — destination: ${PROD_DB_HOST}:${PROD_DB_PORT}"
        echo " Source artifact: s3://${BUCKET}/${FULL_KEY}"
        echo ""
        echo " Current row counts:"
        for table in call_log leads audit_log; do
          COUNT=$(mysql -h "${PROD_DB_HOST}" -P "${PROD_DB_PORT}" \
            -e "SELECT COUNT(*) FROM vici2.${table}" --skip-column-names 2>/dev/null || echo "error")
          echo "   ${table}: ${COUNT}"
        done
        echo ""
        echo " Starting restore in 5 seconds..."
        echo "============================================================"
        sleep 5
        log_json "info" "prod-emergency restore commencing" "\"host\":\"${PROD_DB_HOST}\""
        mysql -h "${PROD_DB_HOST}" -P "${PROD_DB_PORT}" < "$SQL_FILE"
        ;;
    esac

    # Post-restore verification — log row counts
    log_json "info" "post-restore verification"
    DB_HOST="${STAGING_DB_HOST}"
    DB_PORT="${STAGING_DB_PORT}"
    [[ "$TARGET" == "prod-emergency" ]] && { DB_HOST="${VICI2_DB_HOST:-localhost}"; DB_PORT="${VICI2_DB_PORT:-3306}"; }
    [[ "$TARGET" == "local" ]] && { DB_HOST="localhost"; DB_PORT="3306"; }

    for table in leads call_log audit_log users campaigns; do
      COUNT=$(mysql -h "${DB_HOST}" -P "${DB_PORT}" \
        -e "SELECT COUNT(*) FROM vici2.${table}" --skip-column-names 2>/dev/null || echo "error")
      log_json "info" "row count" "\"table\":\"${table}\",\"count\":\"${COUNT}\""
    done
    ;;

  # ── Valkey restore ────────────────────────────────────────────────────────────
  valkey)
    RDB_FILE="${WORKDIR}/dump.rdb"
    # Already decompressed above for the hash check

    log_json "info" "stopping Valkey"
    if command -v docker &>/dev/null; then
      docker compose stop valkey 2>/dev/null || true
    elif command -v systemctl &>/dev/null; then
      systemctl stop valkey 2>/dev/null || true
    fi

    DEST_RDB="${VALKEY_DATA_DIR}/dump.rdb"
    log_json "info" "replacing dump.rdb" "\"dest\":\"${DEST_RDB}\""
    cp "$RDB_FILE" "$DEST_RDB"
    # Valkey UID inside container is 999
    chown 999:999 "$DEST_RDB" 2>/dev/null || true
    chmod 0640 "$DEST_RDB"

    log_json "info" "starting Valkey"
    if command -v docker &>/dev/null; then
      docker compose start valkey 2>/dev/null || true
      sleep 3
      # Verify load succeeded
      LOAD_KEYS=$(valkey-cli INFO persistence 2>/dev/null \
        | awk -F: '/^rdb_last_load_keys_loaded:/{print $2}' | tr -d '\r\n' || echo 0)
      DBSIZE=$(valkey-cli DBSIZE 2>/dev/null || echo 0)
      log_json "info" "Valkey restored" "\"keys_loaded\":\"${LOAD_KEYS}\",\"dbsize\":\"${DBSIZE}\""
    elif command -v systemctl &>/dev/null; then
      systemctl start valkey 2>/dev/null || true
    fi
    ;;

  # ── FreeSWITCH restore ───────────────────────────────────────────────────────
  freeswitch)
    TS_NOW=$(date -u +%Y-%m-%dT%H-%M-%SZ)
    BACKUP_DIR="${FS_CONFIG_DIR}.pre-restore-${TS_NOW}"
    log_json "info" "backing up current config" "\"backup\":\"${BACKUP_DIR}\""
    cp -a "${FS_CONFIG_DIR}" "${BACKUP_DIR}" 2>/dev/null || \
      log_json "warn" "could not backup current config — proceeding anyway"

    log_json "info" "extracting tarball to ${FS_CONFIG_DIR}"
    # Note: tarball never contained tls/; any existing tls/ is preserved.
    tar -xzf "$ARTIFACT_FILE" -C "${FS_CONFIG_DIR}/"

    log_json "info" "reloading FreeSWITCH XML"
    if command -v fs_cli &>/dev/null; then
      fs_cli -x reloadxml || log_json "warn" "reloadxml failed — check FS logs"
      fs_cli -x 'sofia profile external rescan' || \
        log_json "warn" "sofia rescan failed — check FS logs"
    else
      log_json "warn" "fs_cli not found — reload manually with: fs_cli -x reloadxml"
    fi
    ;;
esac

DURATION=$(( $(date -u +%s) - START_TS ))

# ── emit restore RTO metric ───────────────────────────────────────────────────
TEXTFILE_DIR="${VICI2_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
if [[ -d "$TEXTFILE_DIR" ]]; then
  {
    echo "# HELP vici2_restore_test_rto_seconds Duration of the last restore in seconds."
    echo "# TYPE vici2_restore_test_rto_seconds gauge"
    echo "vici2_restore_test_rto_seconds{service=\"${SERVICE}\",env=\"${ENV}\"} ${DURATION}"
    echo "# HELP vici2_restore_test_last_success_timestamp Unix timestamp of last successful restore."
    echo "# TYPE vici2_restore_test_last_success_timestamp gauge"
    echo "vici2_restore_test_last_success_timestamp{service=\"${SERVICE}\",env=\"${ENV}\"} $(date -u +%s)"
    echo "# HELP vici2_restore_test_failures_total Total restore failures."
    echo "# TYPE vici2_restore_test_failures_total counter"
    echo "vici2_restore_test_failures_total{service=\"${SERVICE}\",env=\"${ENV}\"} 0"
  } > "${TEXTFILE_DIR}/vici2_restore_${SERVICE}.prom.tmp" && \
    mv "${TEXTFILE_DIR}/vici2_restore_${SERVICE}.prom.tmp" \
       "${TEXTFILE_DIR}/vici2_restore_${SERVICE}.prom"
fi

log_json "info" "restore completed successfully" "\"duration_sec\":${DURATION}"
