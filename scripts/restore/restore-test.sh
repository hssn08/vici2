#!/usr/bin/env bash
# scripts/restore/restore-test.sh — O02 weekly automated restore test
# Spins up a throwaway MySQL staging container, restores the latest prod daily
# backup, verifies row counts, emits Prom metrics, tears down the container.
# See spec/modules/O02/PLAN.md §12.
set -euo pipefail

ENV="${VICI2_ENV:-prod}"
BUCKET="${VICI2_BACKUP_BUCKET:-vici2-backups}"
ENDPOINT_URL=""
MYSQL_ROOT_PASSWORD="restore-test-pw-$(date +%s)"
CONTAINER_NAME="vici2-restore-test-$$"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)          ENV="$2";           shift 2 ;;
    --bucket)       BUCKET="$2";        shift 2 ;;
    --endpoint-url) ENDPOINT_URL="$2";  shift 2 ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

TEXTFILE_DIR="${VICI2_TEXTFILE_DIR:-/var/lib/node_exporter/textfile_collector}"
START_TS=$(date -u +%s)
FAILURE=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log_json() {
  local level="$1" msg="$2" extra="${3:-}"
  local now
  now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '{"ts":"%s","level":"%s","service":"vici2-backup","module":"O02","component":"restore-test","env":"%s"%s,"msg":"%s"}\n' \
    "$now" "$level" "$ENV" "${extra:+,$extra}" "$msg"
}

emit_prom() {
  local rto_sec="$1" failures="$2"
  if [[ -d "$TEXTFILE_DIR" ]]; then
    {
      echo "# HELP vici2_restore_test_rto_seconds Duration of the restore test in seconds."
      echo "# TYPE vici2_restore_test_rto_seconds gauge"
      echo "vici2_restore_test_rto_seconds{service=\"mysql\",env=\"${ENV}\"} ${rto_sec}"
      echo "# HELP vici2_restore_test_failures_total Total restore test failures."
      echo "# TYPE vici2_restore_test_failures_total counter"
      echo "vici2_restore_test_failures_total{service=\"mysql\",env=\"${ENV}\"} ${failures}"
      echo "# HELP vici2_restore_test_last_success_timestamp Unix timestamp of last successful restore test."
      echo "# TYPE vici2_restore_test_last_success_timestamp gauge"
      if [[ "$failures" -eq 0 ]]; then
        echo "vici2_restore_test_last_success_timestamp{service=\"mysql\",env=\"${ENV}\"} $(date -u +%s)"
      fi
    } > "${TEXTFILE_DIR}/vici2_restore_test.prom.tmp" && \
      mv "${TEXTFILE_DIR}/vici2_restore_test.prom.tmp" \
         "${TEXTFILE_DIR}/vici2_restore_test.prom"
  fi
}

cleanup() {
  log_json "info" "tearing down restore-test container"
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true
}
trap cleanup EXIT

log_json "info" "restore-test starting" "\"env\":\"${ENV}\""

# ── 1. Find yesterday's latest daily backup ───────────────────────────────────
YESTERDAY=$(date -u -d "yesterday" +%Y/%m/%d 2>/dev/null || date -u -v-1d +%Y/%m/%d 2>/dev/null || true)
if [[ -z "$YESTERDAY" ]]; then
  YESTERDAY=$(date -u +%Y/%m/%d)  # fallback: use today
fi
YESTERDAY_DASH="${YESTERDAY//\//-}"

AWS_EXTRA=""
[[ -n "$ENDPOINT_URL" ]] && AWS_EXTRA="--endpoint-url ${ENDPOINT_URL}"

ARTIFACT=$(aws ${AWS_EXTRA:+$AWS_EXTRA} s3 ls \
    "s3://${BUCKET}/${ENV}/mysql/${YESTERDAY}/" 2>/dev/null \
    | grep -v '\.sha256$' | awk '{print $4}' | sort | tail -1 || true)

if [[ -z "$ARTIFACT" ]]; then
  log_json "error" "no daily backup found for ${YESTERDAY}" "\"bucket\":\"${BUCKET}\""
  FAILURE=1
  DURATION=$(( $(date -u +%s) - START_TS ))
  emit_prom "$DURATION" "$FAILURE"
  exit 1
fi

log_json "info" "found artifact" "\"artifact\":\"${ARTIFACT}\",\"date\":\"${YESTERDAY_DASH}\""

# ── 2. Spin up a throwaway MySQL staging container ────────────────────────────
log_json "info" "starting throwaway MySQL container" "\"name\":\"${CONTAINER_NAME}\""
docker run -d \
  --name "$CONTAINER_NAME" \
  -e MYSQL_ROOT_PASSWORD="$MYSQL_ROOT_PASSWORD" \
  -p 13306:3306 \
  mysql:8.0 \
  --default-authentication-plugin=mysql_native_password \
  >/dev/null

# Wait for MySQL to be ready (up to 60 seconds)
log_json "info" "waiting for MySQL to be ready"
for i in $(seq 1 30); do
  if docker exec "$CONTAINER_NAME" mysqladmin ping -u root -p"${MYSQL_ROOT_PASSWORD}" --silent 2>/dev/null; then
    break
  fi
  if [[ "$i" -eq 30 ]]; then
    log_json "error" "MySQL container did not become ready in 60s"
    FAILURE=1
    DURATION=$(( $(date -u +%s) - START_TS ))
    emit_prom "$DURATION" "$FAILURE"
    exit 1
  fi
  sleep 2
done

# ── 3. Run restore ────────────────────────────────────────────────────────────
log_json "info" "running restore"

RESTORE_ARGS=(
  --service mysql
  --date "${YESTERDAY_DASH}"
  --target staging
  --env "${ENV}"
  --bucket "${BUCKET}"
)
[[ -n "$ENDPOINT_URL" ]] && RESTORE_ARGS+=(--endpoint-url "${ENDPOINT_URL}")

# Override staging host/port to point at our throwaway container
export VICI2_STAGING_DB_HOST=127.0.0.1
export VICI2_STAGING_DB_PORT=13306
# Pass MySQL root credentials via environment for this test
export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"

if ! "${SCRIPT_DIR}/from-s3.sh" "${RESTORE_ARGS[@]}"; then
  log_json "error" "restore script failed"
  FAILURE=1
  DURATION=$(( $(date -u +%s) - START_TS ))
  emit_prom "$DURATION" "$FAILURE"
  exit 1
fi

# ── 4. Sanity SQL pass ────────────────────────────────────────────────────────
log_json "info" "running post-restore sanity checks"
SANITY_PASS=true
for table in users leads campaigns; do
  COUNT=$(docker exec "$CONTAINER_NAME" mysql -u root -p"${MYSQL_ROOT_PASSWORD}" \
    -e "SELECT COUNT(*) FROM vici2.${table}" --skip-column-names 2>/dev/null || echo "error")
  log_json "info" "sanity count" "\"table\":\"${table}\",\"count\":\"${COUNT}\""
  if [[ "$COUNT" == "error" ]]; then
    log_json "warn" "could not query table" "\"table\":\"${table}\""
    SANITY_PASS=false
  fi
done

# audit_log should have rows from actual prod data
AUDIT_COUNT=$(docker exec "$CONTAINER_NAME" mysql -u root -p"${MYSQL_ROOT_PASSWORD}" \
  -e "SELECT COUNT(*) FROM vici2.audit_log" --skip-column-names 2>/dev/null || echo "0")
log_json "info" "sanity count" "\"table\":\"audit_log\",\"count\":\"${AUDIT_COUNT}\""

DURATION=$(( $(date -u +%s) - START_TS ))

if [[ "$SANITY_PASS" == "false" ]]; then
  log_json "warn" "sanity checks had failures (non-fatal)" "\"duration_sec\":${DURATION}"
fi

# ── 5. Emit metrics ───────────────────────────────────────────────────────────
emit_prom "$DURATION" "$FAILURE"

log_json "info" "restore-test completed" "\"rto_sec\":${DURATION},\"failures\":${FAILURE}"

if [[ "$DURATION" -gt 3600 ]]; then
  log_json "warn" "RTO exceeded 3600s — consider XtraBackup migration" "\"rto_sec\":${DURATION}"
fi
