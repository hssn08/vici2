#!/usr/bin/env bash
# O03 — Alertmanager maintenance window helper.
#
# Wraps `amtool silence add/expire/query` to set a bounded silence on
# all vici2 alerts during scheduled maintenance. Default cap: 120 minutes
# (O01 PLAN §9.2 — never-silent protection).
#
# Usage:
#   scripts/maintenance-window.sh start [duration_minutes] [extra_matchers...]
#   scripts/maintenance-window.sh stop  [silence_id]
#   scripts/maintenance-window.sh list
#
# Environment:
#   ALERTMANAGER_URL      Alertmanager URL (default: http://localhost:9093)
#   MAINTENANCE_MAX_MIN   Maximum allowed duration in minutes (default: 120)
#
# Examples:
#   scripts/maintenance-window.sh start 60
#   scripts/maintenance-window.sh start 30 'env="staging"'
#   scripts/maintenance-window.sh stop   a1b2c3d4-...
#   scripts/maintenance-window.sh list

set -euo pipefail

ALERTMANAGER_URL="${ALERTMANAGER_URL:-http://localhost:9093}"
MAINTENANCE_MAX_MIN="${MAINTENANCE_MAX_MIN:-120}"
SILENCE_ID_FILE="${SILENCE_ID_FILE:-.alertmanager-silence-id}"

# ─── helpers ──────────────────────────────────────────────────────────────────

usage() {
  grep '^#' "$0" | sed 's/^# \{0,1\}//' | tail -n +2
  exit 1
}

require_amtool() {
  if ! command -v amtool &>/dev/null; then
    echo "ERROR: amtool not found. Install with: go install github.com/prometheus/alertmanager/cmd/amtool@latest" >&2
    exit 1
  fi
}

# ─── subcommands ──────────────────────────────────────────────────────────────

cmd_start() {
  local duration_min="${1:-60}"
  shift || true
  local extra_matchers=("$@")

  if (( duration_min > MAINTENANCE_MAX_MIN )); then
    echo "ERROR: Requested duration ${duration_min}m exceeds cap of ${MAINTENANCE_MAX_MIN}m." >&2
    echo "       Set MAINTENANCE_MAX_MIN env to override (operator approval required)." >&2
    exit 1
  fi

  require_amtool

  local ends_at
  ends_at=$(date -u -d "+${duration_min} minutes" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null \
    || date -u -v "+${duration_min}M" '+%Y-%m-%dT%H:%M:%SZ')  # macOS fallback

  local creator="${USER:-operator}"
  local comment="Scheduled maintenance window: ${duration_min}m — started $(date -u +%Y-%m-%dT%H:%M:%SZ) by ${creator}"

  local silence_id
  silence_id=$(amtool silence add \
    --alertmanager.url="${ALERTMANAGER_URL}" \
    --duration="${duration_min}m" \
    --comment="${comment}" \
    --author="${creator}" \
    'alertname=~"Vici2.*"' \
    "${extra_matchers[@]}" 2>&1)

  echo "Silence created: ${silence_id}"
  echo "Duration: ${duration_min} minutes (expires ${ends_at})"
  echo "${silence_id}" > "${SILENCE_ID_FILE}"
  echo "Silence ID saved to ${SILENCE_ID_FILE}"
}

cmd_stop() {
  local silence_id="${1:-}"

  if [[ -z "${silence_id}" ]]; then
    if [[ -f "${SILENCE_ID_FILE}" ]]; then
      silence_id=$(cat "${SILENCE_ID_FILE}")
      echo "Using silence ID from ${SILENCE_ID_FILE}: ${silence_id}"
    else
      echo "ERROR: No silence_id provided and ${SILENCE_ID_FILE} not found." >&2
      echo "       Run: scripts/maintenance-window.sh stop <silence_id>" >&2
      exit 1
    fi
  fi

  require_amtool
  amtool silence expire \
    --alertmanager.url="${ALERTMANAGER_URL}" \
    "${silence_id}"

  echo "Silence ${silence_id} expired."
  rm -f "${SILENCE_ID_FILE}"
}

cmd_list() {
  require_amtool
  amtool silence query \
    --alertmanager.url="${ALERTMANAGER_URL}" \
    'alertname=~"Vici2.*"'
}

# ─── dispatch ─────────────────────────────────────────────────────────────────

if [[ $# -lt 1 ]]; then
  usage
fi

CMD="${1}"
shift

case "${CMD}" in
  start) cmd_start "$@" ;;
  stop)  cmd_stop  "$@" ;;
  list)  cmd_list        ;;
  *)
    echo "ERROR: Unknown command '${CMD}'" >&2
    usage
    ;;
esac
