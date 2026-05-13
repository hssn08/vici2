#!/usr/bin/env bash
# vici2 FreeSWITCH healthcheck — F03 PLAN §12 + §16.
# Pass criteria:
#   1. `status` returns a line starting with "UP "
#   2. `sofia status` reports at least 3 profiles RUNNING (internal, wss, external)
# Returns 0 healthy / 1 unhealthy.
set -euo pipefail

PASS="${FS_EVENT_SOCKET_PASSWORD:-ClueCon}"

status_out="$(fs_cli -p "$PASS" -x 'status' 2>/dev/null || true)"
echo "$status_out" | grep -qE '^UP ' || {
  echo "healthcheck: status not UP" >&2
  exit 1
}

sofia_out="$(fs_cli -p "$PASS" -x 'sofia status' 2>/dev/null || true)"
running_count="$(echo "$sofia_out" | grep -c 'RUNNING' || true)"
# We expect AT LEAST 3 (internal, wss, external). Allow more (gateway lines also count).
if [ "${running_count:-0}" -lt 3 ]; then
  echo "healthcheck: sofia RUNNING count=$running_count (<3)" >&2
  exit 1
fi

exit 0
