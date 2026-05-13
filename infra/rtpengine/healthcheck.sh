#!/bin/bash
# infra/rtpengine/healthcheck.sh
# X01: rtpengine health probe via ng-protocol statistics command.
#
# ng-protocol uses bencode over UDP. We send a statistics request and verify
# that rtpengine echoes back our cookie in the response.
# Uses nc (netcat-openbsd) in UDP mode with a 2-second timeout.
#
# If rtpengine is healthy, response comes in < 50ms.
# If no response within 2s, the container is considered unhealthy.
set -euo pipefail

NG_HOST="${RTPENGINE_NG_HOST:-127.0.0.1}"
NG_PORT="${RTPENGINE_NG_PORT:-22222}"

# Bencode for: <cookie> d7:command10:statisticse
# cookie is a unique token; rtpengine echoes it back in the response.
COOKIE="hc_$(date +%s)_$$"
REQUEST="${COOKIE} d7:command10:statisticse"

RESPONSE=$(printf '%s' "${REQUEST}" | nc -u -w 2 "${NG_HOST}" "${NG_PORT}" 2>/dev/null || true)

if echo "${RESPONSE}" | grep -qF "${COOKIE}"; then
    exit 0
else
    echo "[rtpengine healthcheck] No valid response from ${NG_HOST}:${NG_PORT}" >&2
    echo "[rtpengine healthcheck] Request: ${REQUEST}" >&2
    echo "[rtpengine healthcheck] Response: ${RESPONSE}" >&2
    exit 1
fi
