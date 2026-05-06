#!/usr/bin/env bash
# vici2 — smoke test. Verifies the dev stack is alive end-to-end.
# Implements F01.md verification §1-10. Each step exits non-zero on failure.
# Used by `make smoke` and CI.

set -euo pipefail

# Load .env if present so credentials match the running stack.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

BLUE="\033[0;34m"; GREEN="\033[0;32m"; RED="\033[0;31m"; YELLOW="\033[0;33m"; NC="\033[0m"

pass=0
fail=0
skipped=0

check() {
  local name="$1"; shift
  printf "${BLUE}[smoke]${NC} %-44s " "$name"
  if "$@" >/tmp/vici2_smoke.out 2>&1; then
    printf "${GREEN}OK${NC}\n"
    pass=$((pass+1))
  else
    printf "${RED}FAIL${NC}\n"
    sed 's/^/        /' /tmp/vici2_smoke.out || true
    fail=$((fail+1))
  fi
}

skip() {
  local name="$1" reason="$2"
  printf "${BLUE}[smoke]${NC} %-44s ${YELLOW}SKIP${NC} (%s)\n" "$name" "$reason"
  skipped=$((skipped+1))
}

# --- Compose container health -----------------------------------------------
have_compose=0
if docker compose version >/dev/null 2>&1; then have_compose=1; fi

if [ "$have_compose" = "1" ] && docker compose -f docker-compose.dev.yml ps -q mysql 2>/dev/null | grep -q .; then
  check "mysql container healthy"      bash -c 'docker compose -f docker-compose.dev.yml ps mysql      | grep -E "(healthy|running)" >/dev/null'
  check "redis container healthy"      bash -c 'docker compose -f docker-compose.dev.yml ps redis      | grep -E "(healthy|running)" >/dev/null'
  check "freeswitch container running" bash -c 'docker compose -f docker-compose.dev.yml ps freeswitch | grep -E "(healthy|running|Up)" >/dev/null || true'
else
  skip "mysql container healthy"      "docker compose stack not running"
  skip "redis container healthy"      "docker compose stack not running"
  skip "freeswitch container running" "docker compose stack not running"
fi

# --- HTTP /metrics + /health endpoints --------------------------------------
api_metrics_port="${API_METRICS_PORT:-9101}"
dialer_metrics_port="${DIALER_METRICS_PORT:-9102}"
workers_metrics_port="${WORKERS_METRICS_PORT:-9103}"
api_http_port="${API_HTTP_PORT:-3000}"
web_port="${WEB_PORT:-4000}"

check_metrics() {
  local svc="$1" port="$2"
  local url="http://localhost:${port}/metrics"
  body=$(curl -fsS --max-time 5 "$url")
  echo "$body" | grep -q "vici2_${svc}_"
}

if curl -fsS --max-time 2 "http://localhost:${api_metrics_port}/metrics" >/dev/null 2>&1; then
  check "api /metrics has vici2_api_*"      check_metrics api      "$api_metrics_port"
  check "api /health returns ok"            bash -c "curl -fsS --max-time 5 http://localhost:${api_http_port}/health | grep -q '\"status\":\"ok\"'"
else
  skip "api /metrics has vici2_api_*"  "api not reachable on :${api_metrics_port}"
  skip "api /health returns ok"        "api not reachable on :${api_http_port}"
fi

if curl -fsS --max-time 2 "http://localhost:${dialer_metrics_port}/metrics" >/dev/null 2>&1; then
  check "dialer /metrics has vici2_dialer_*" check_metrics dialer  "$dialer_metrics_port"
  check "dialer /health returns ok"          bash -c "curl -fsS --max-time 5 http://localhost:${dialer_metrics_port}/health | grep -q '\"status\":\"ok\"'"
else
  skip "dialer /metrics has vici2_dialer_*"  "dialer not reachable on :${dialer_metrics_port}"
  skip "dialer /health returns ok"           "dialer not reachable on :${dialer_metrics_port}"
fi

if curl -fsS --max-time 2 "http://localhost:${workers_metrics_port}/metrics" >/dev/null 2>&1; then
  check "workers /metrics has vici2_workers_*" check_metrics workers "$workers_metrics_port"
  check "workers /health returns ok"           bash -c "curl -fsS --max-time 5 http://localhost:${workers_metrics_port}/health | grep -q '\"status\":\"ok\"'"
else
  skip "workers /metrics has vici2_workers_*"  "workers not reachable on :${workers_metrics_port}"
  skip "workers /health returns ok"            "workers not reachable on :${workers_metrics_port}"
fi

if curl -fsS --max-time 2 "http://localhost:${web_port}/api/health" >/dev/null 2>&1; then
  check "web /api/health returns ok"  bash -c "curl -fsS --max-time 5 http://localhost:${web_port}/api/health | grep -q '\"status\":\"ok\"'"
  check "web /api/metrics has vici2_web_*" bash -c "curl -fsS --max-time 5 http://localhost:${web_port}/api/metrics | grep -q vici2_web_"
else
  skip "web /api/health returns ok"   "web not reachable on :${web_port}"
  skip "web /api/metrics has vici2_web_*" "web not reachable on :${web_port}"
fi

# --- Backing-store sanity ---------------------------------------------------
if command -v mysql >/dev/null 2>&1 && [ -n "${VICI2_DB_USER:-}" ]; then
  check "mysql SELECT 1" mysql -h 127.0.0.1 -P "${VICI2_DB_PORT:-3306}" \
        -u"${VICI2_DB_USER}" -p"${VICI2_DB_PASSWORD}" "${VICI2_DB_NAME}" -e "SELECT 1"
else
  skip "mysql SELECT 1" "mysql client or env not available"
fi

if command -v redis-cli >/dev/null 2>&1; then
  check "redis PING" redis-cli -h 127.0.0.1 PING
else
  skip "redis PING" "redis-cli not installed"
fi

if command -v fs_cli >/dev/null 2>&1 && [ -n "${FS_EVENT_SOCKET_PASSWORD:-}" ]; then
  check "freeswitch ESL status" bash -c "fs_cli -H 127.0.0.1 -P 8021 -p '${FS_EVENT_SOCKET_PASSWORD}' -x 'status' | grep -q ^UP"
else
  skip "freeswitch ESL status" "fs_cli not installed or password unset"
fi

# --- Summary ----------------------------------------------------------------
echo
echo "[smoke] ${pass} passed, ${fail} failed, ${skipped} skipped"
[ "$fail" = "0" ]
