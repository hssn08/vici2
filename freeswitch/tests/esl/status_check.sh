#!/usr/bin/env bash
# vici2 ESL smoke test — connects to mod_event_socket and asserts FS is UP
# with the 3 frozen profiles RUNNING.
# Usage:  FS_EVENT_SOCKET_PASSWORD=ClueCon ./status_check.sh [host[:port]]
set -euo pipefail

HOST_PORT="${1:-127.0.0.1:8021}"
HOST="${HOST_PORT%%:*}"
PORT="${HOST_PORT##*:}"
PASS="${FS_EVENT_SOCKET_PASSWORD:-ClueCon}"

# Prefer fs_cli when available, otherwise minimal /dev/tcp probe.
if command -v fs_cli >/dev/null 2>&1; then
  status="$(fs_cli -H "$HOST" -P "$PORT" -p "$PASS" -x 'status' 2>/dev/null || true)"
  echo "$status" | grep -qE '^UP ' || {
    echo "FAIL: status not UP" >&2
    echo "$status" >&2
    exit 1
  }
  sofia="$(fs_cli -H "$HOST" -P "$PORT" -p "$PASS" -x 'sofia status' 2>/dev/null || true)"
  count="$(echo "$sofia" | grep -c RUNNING || true)"
  if [ "$count" -lt 3 ]; then
    echo "FAIL: sofia RUNNING count=$count (expected >=3)" >&2
    echo "$sofia" >&2
    exit 1
  fi
  echo "PASS: FS up, $count sofia entries RUNNING"
  exit 0
fi

# Fallback: raw TCP probe; tests only that ESL accepts a connection.
exec 3<>"/dev/tcp/$HOST/$PORT" || { echo "FAIL: cannot connect to $HOST:$PORT" >&2; exit 1; }
read -r -t 2 banner <&3 || true
echo "$banner" | grep -q 'auth/request' || {
  echo "FAIL: no auth/request banner; got: $banner" >&2
  exit 1
}
printf 'auth %s\r\n\r\n' "$PASS" >&3
read -r -t 2 reply <&3 || true
exec 3<&-
echo "$reply" | grep -q '+OK' && {
  echo "PASS: ESL TCP probe authenticated"
  exit 0
}
echo "FAIL: ESL auth rejected; reply=$reply" >&2
exit 1
