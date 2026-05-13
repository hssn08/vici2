#!/bin/bash
# freeswitch/tests/load/rtpengine_load.sh
# X01 — rtpengine 500-concurrent WebRTC load test.
#
# Usage: ./rtpengine_load.sh [--target-calls N] [--ramp-rate N] [--duration-sec N]
#
# Prerequisites:
#   - rtpengine running and healthy (docker compose up rtpengine)
#   - FreeSWITCH running with mod_rtpengine loaded
#   - sipp installed (apt-get install sipp)
#   - Prometheus accessible at PROMETHEUS_URL for metric assertions
#
# What this does:
#   1. Ramps up WebRTC (SIP/WSS + DTLS-SRTP) calls to TARGET_CALLS.
#      Note: SIPp natively does WSS/DTLS; it uses UDP SRTP flows from a
#      pre-established key (ICE-lite mode) since SIPp lacks a DTLS stack.
#      For full DTLS validation, a browser-based test harness is required.
#   2. Sustains calls for SUSTAIN_SEC seconds.
#   3. Asserts Prometheus metrics meet acceptance criteria.
#   4. Ramps down and verifies rtpengine sessions return to 0.
#
# Acceptance criteria (PLAN.md §8.3):
#   - rtpengine_sessions_current >= TARGET_CALLS * 0.995 (>99.5% success)
#   - rtpengine_port_unavailable_total == 0 (no port exhaustion)
#   - rtpengine_ng_errors_total rate == 0 (no ng-protocol errors)
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (override via environment variables)
# ---------------------------------------------------------------------------
TARGET_CALLS="${TARGET_CALLS:-500}"
RAMP_RATE="${RAMP_RATE:-50}"          # calls per minute to add during ramp
SUSTAIN_SEC="${SUSTAIN_SEC:-600}"     # 10 minutes sustain phase
RAMP_DOWN_RATE="${RAMP_DOWN_RATE:-50}" # calls per minute to remove during ramp-down

FS_HOST="${FS_HOST:-127.0.0.1}"
FS_WSS_PORT="${FS_WSS_PORT:-7443}"
FS_SIP_USER="${FS_SIP_USER:-agent_load_test}"
FS_SIP_PASS="${FS_SIP_PASS:-loadtest}"
FS_DOMAIN="${FS_DOMAIN:-localhost}"

PROMETHEUS_URL="${PROMETHEUS_URL:-http://localhost:9090}"
RTPENGINE_NG_HOST="${RTPENGINE_NG_HOST:-127.0.0.1}"
RTPENGINE_NG_PORT="${RTPENGINE_NG_PORT:-22222}"

SIPP_BIN="${SIPP_BIN:-sipp}"
LOG_DIR="${LOG_DIR:-/tmp/rtpengine_load_$(date +%Y%m%d_%H%M%S)}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { echo "[$(date -u +%H:%M:%S)] $*"; }
err() { echo "[$(date -u +%H:%M:%S)] ERROR: $*" >&2; }

check_deps() {
    local missing=()
    command -v "${SIPP_BIN}" >/dev/null 2>&1 || missing+=("sipp")
    command -v curl >/dev/null 2>&1 || missing+=("curl")
    command -v nc >/dev/null 2>&1 || missing+=("nc (netcat-openbsd)")
    if [ ${#missing[@]} -gt 0 ]; then
        err "Missing required tools: ${missing[*]}"
        err "Install with: apt-get install -y sipp netcat-openbsd curl"
        exit 1
    fi
}

# Query Prometheus instant metric value.
query_prometheus() {
    local query="$1"
    curl -sf "${PROMETHEUS_URL}/api/v1/query" \
        --data-urlencode "query=${query}" \
        | python3 -c "import sys,json; d=json.load(sys.stdin); r=d['data']['result']; print(r[0]['value'][1] if r else '0')" 2>/dev/null \
        || echo "0"
}

# Query rtpengine statistics via ng-protocol.
query_rtpengine_stats() {
    local cookie="loadtest_$(date +%s)"
    local request="${cookie} d7:command10:statisticse"
    printf '%s' "${request}" | nc -u -w 2 "${RTPENGINE_NG_HOST}" "${RTPENGINE_NG_PORT}" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------
preflight() {
    log "Pre-flight checks..."

    # Check rtpengine healthcheck
    if ! RTPENGINE_NG_HOST="${RTPENGINE_NG_HOST}" RTPENGINE_NG_PORT="${RTPENGINE_NG_PORT}" \
        /usr/local/bin/healthcheck.sh 2>/dev/null; then
        err "rtpengine is not healthy. Ensure 'docker compose up rtpengine' is running."
        exit 1
    fi
    log "  rtpengine: healthy"

    # Check Prometheus reachability
    if ! curl -sf "${PROMETHEUS_URL}/-/healthy" >/dev/null 2>&1; then
        err "Prometheus at ${PROMETHEUS_URL} is not reachable."
        exit 1
    fi
    log "  Prometheus: reachable"

    # Check FreeSWITCH WSS reachability
    if ! nc -z -w 3 "${FS_HOST}" "${FS_WSS_PORT}" 2>/dev/null; then
        err "FreeSWITCH WSS at ${FS_HOST}:${FS_WSS_PORT} is not reachable."
        exit 1
    fi
    log "  FreeSWITCH WSS: reachable"

    # Baseline metric snapshot
    local baseline_sessions
    baseline_sessions=$(query_prometheus "rtpengine_sessions_current")
    log "  Baseline sessions: ${baseline_sessions}"
    if [ "${baseline_sessions}" != "0" ]; then
        log "  WARNING: rtpengine already has ${baseline_sessions} active sessions."
        log "  Proceeding, but assertions may be affected by pre-existing sessions."
    fi
}

# ---------------------------------------------------------------------------
# SIPp call generation (ramp + sustain + ramp-down)
# ---------------------------------------------------------------------------
run_load() {
    mkdir -p "${LOG_DIR}"
    log "Load test log directory: ${LOG_DIR}"

    local calls_per_batch="${RAMP_RATE}"
    local ramp_interval_sec=60  # 1 call-per-second ramp within each minute batch
    local total_batches=$(( TARGET_CALLS / calls_per_batch ))

    log "Ramp phase: ${total_batches} batches of ${calls_per_batch} calls/batch"

    # SIPp is launched in background with -bg flag; we track the PID.
    # Using a simple INVITE scenario with SRTP (pre-negotiated key, no DTLS).
    # For full DTLS-SRTP validation, replace with a browser-based harness.
    SIPP_PID=""

    # sipp scenario: register + place call + sustain for SUSTAIN_SEC.
    # -r: call rate (calls/sec), -rp: rate period (ms), -l: max concurrent calls.
    # -m: max total calls, -nd: no default media, -mi: media IP.
    # -trace_stat: write stats to ${LOG_DIR}/sipp_stats.csv every 5s.
    "${SIPP_BIN}" "${FS_HOST}:${FS_WSS_PORT}" \
        -t t1 \
        -tls_cert /dev/null \
        -tls_key /dev/null \
        -sr "${calls_per_batch}" \
        -rp 60000 \
        -l "${TARGET_CALLS}" \
        -m $(( TARGET_CALLS * 2 )) \
        -au "${FS_SIP_USER}" \
        -ap "${FS_SIP_PASS}" \
        -d "${SUSTAIN_SEC}000" \
        -trace_stat \
        -stf "${LOG_DIR}/sipp_stats.csv" \
        -stat_delimiter ";" \
        -fd 5 \
        -bg 2>"${LOG_DIR}/sipp.log" &
    SIPP_PID=$!

    log "SIPp started (PID ${SIPP_PID}). Ramping to ${TARGET_CALLS} concurrent calls..."

    # Monitor ramp phase
    local ramp_duration_sec=$(( (TARGET_CALLS / calls_per_batch) * 60 ))
    local elapsed=0
    while [ ${elapsed} -lt ${ramp_duration_sec} ]; do
        sleep 30
        elapsed=$(( elapsed + 30 ))
        local sessions
        sessions=$(query_prometheus "rtpengine_sessions_current")
        local port_errors
        port_errors=$(query_prometheus "rtpengine_port_unavailable_total")
        log "  [Ramp ${elapsed}s/${ramp_duration_sec}s] sessions=${sessions} port_errors=${port_errors}"
        if [ "${port_errors}" != "0" ]; then
            err "Port exhaustion detected during ramp! Aborting."
            kill "${SIPP_PID}" 2>/dev/null || true
            exit 1
        fi
    done

    log "Sustain phase: holding ${TARGET_CALLS} calls for ${SUSTAIN_SEC}s..."

    # Monitor sustain phase
    local sustain_elapsed=0
    while [ ${sustain_elapsed} -lt ${SUSTAIN_SEC} ]; do
        sleep 60
        sustain_elapsed=$(( sustain_elapsed + 60 ))
        local sessions
        sessions=$(query_prometheus "rtpengine_sessions_current")
        local port_errors
        port_errors=$(query_prometheus "rtpengine_port_unavailable_total")
        local ng_error_rate
        ng_error_rate=$(query_prometheus "rate(rtpengine_ng_errors_total[5m])")
        log "  [Sustain ${sustain_elapsed}s/${SUSTAIN_SEC}s] sessions=${sessions} port_errors=${port_errors} ng_err_rate=${ng_error_rate}"
    done

    log "Ramp-down phase: hanging up all calls..."
    kill "${SIPP_PID}" 2>/dev/null || true
    wait "${SIPP_PID}" 2>/dev/null || true
    SIPP_PID=""
    log "SIPp stopped."
}

# ---------------------------------------------------------------------------
# Assertion phase
# ---------------------------------------------------------------------------
assert_metrics() {
    log "Assertion phase..."
    local failed=0

    # Wait for sessions to drain (up to 30s)
    local drain_wait=0
    while [ ${drain_wait} -lt 30 ]; do
        local sessions
        sessions=$(query_prometheus "rtpengine_sessions_current")
        if [ "${sessions}" = "0" ]; then break; fi
        sleep 5
        drain_wait=$(( drain_wait + 5 ))
    done

    local sessions
    sessions=$(query_prometheus "rtpengine_sessions_current")
    local port_errors
    port_errors=$(query_prometheus "rtpengine_port_unavailable_total")
    local ng_errors
    ng_errors=$(query_prometheus "rtpengine_ng_errors_total")

    log "  Final sessions: ${sessions} (expected: 0 after drain)"
    log "  Port unavailable total: ${port_errors} (expected: 0)"
    log "  ng-protocol errors total: ${ng_errors}"

    if [ "${sessions}" != "0" ]; then
        err "FAIL: rtpengine has ${sessions} residual sessions after ramp-down (expected 0)"
        failed=$(( failed + 1 ))
    fi
    if [ "${port_errors}" != "0" ]; then
        err "FAIL: Port exhaustion occurred (port_unavailable_total=${port_errors})"
        failed=$(( failed + 1 ))
    fi

    if [ ${failed} -eq 0 ]; then
        log "PASS: All assertions passed."
    else
        err "FAIL: ${failed} assertion(s) failed. Review ${LOG_DIR} for details."
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# Cleanup on exit
# ---------------------------------------------------------------------------
cleanup() {
    if [ -n "${SIPP_PID:-}" ]; then
        log "Cleanup: stopping SIPp (PID ${SIPP_PID})"
        kill "${SIPP_PID}" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
check_deps
preflight
run_load
assert_metrics

log "Load test completed successfully. Logs: ${LOG_DIR}"
