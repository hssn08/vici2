#!/bin/bash
# infra/rtpengine/entrypoint.sh
# X01: rtpengine startup with optional kernel module detection.
#
# Env vars (all have defaults; override in docker-compose or .env):
#   RTPENGINE_KERNEL_MODE   0|1   Enable kernel forwarding (requires xt_RTPENGINE on host)
#   RTPENGINE_INTERFACE     IP    RTP interface (0.0.0.0 for all interfaces)
#   RTPENGINE_NG_PORT       int   ng-control UDP port (default 22222)
#   RTPENGINE_PORT_MIN      int   RTP port range start (default 30000)
#   RTPENGINE_PORT_MAX      int   RTP port range end (default 40000)
#   RTPENGINE_TOS           int   IP TOS/DSCP for RTP packets (184 = DSCP EF)
#   RTPENGINE_LOG_LEVEL     int   5=INFO, 7=DEBUG
#   RTPENGINE_RECORDING_DIR path  PCAP diagnostic recording directory
#   RTPENGINE_TABLE         int   Kernel module forwarding table id (default 0)
#   RTPENGINE_PROMETHEUS_PORT int Prometheus metrics HTTP port (default 9109)
set -euo pipefail

RTPENGINE_KERNEL_MODE="${RTPENGINE_KERNEL_MODE:-0}"
RTPENGINE_INTERFACE="${RTPENGINE_INTERFACE:-0.0.0.0}"
RTPENGINE_NG_PORT="${RTPENGINE_NG_PORT:-22222}"
RTPENGINE_PORT_MIN="${RTPENGINE_PORT_MIN:-30000}"
RTPENGINE_PORT_MAX="${RTPENGINE_PORT_MAX:-40000}"
RTPENGINE_TOS="${RTPENGINE_TOS:-184}"       # DSCP EF = 0xB8 = 184 decimal
RTPENGINE_LOG_LEVEL="${RTPENGINE_LOG_LEVEL:-5}"  # 5=INFO, 7=DEBUG
RTPENGINE_RECORDING_DIR="${RTPENGINE_RECORDING_DIR:-/var/lib/rtpengine/recordings}"
RTPENGINE_TABLE="${RTPENGINE_TABLE:-0}"     # kernel module table id
RTPENGINE_PROMETHEUS_PORT="${RTPENGINE_PROMETHEUS_PORT:-9109}"

mkdir -p "${RTPENGINE_RECORDING_DIR}"

KERNEL_ARGS=""
if [ "${RTPENGINE_KERNEL_MODE}" = "1" ]; then
    if [ -e /proc/rtpengine/control ]; then
        echo "[rtpengine] Kernel module detected; enabling kernel forwarding (table=${RTPENGINE_TABLE})"
        KERNEL_ARGS="--table=${RTPENGINE_TABLE}"
    else
        echo "[rtpengine] WARNING: RTPENGINE_KERNEL_MODE=1 but /proc/rtpengine/control not found." >&2
        echo "[rtpengine] Run 'modprobe xt_RTPENGINE' on the host to enable kernel mode." >&2
        echo "[rtpengine] Falling back to userspace mode." >&2
        KERNEL_ARGS="--no-kernel-forwarding"
    fi
else
    echo "[rtpengine] Running in userspace mode (RTPENGINE_KERNEL_MODE=${RTPENGINE_KERNEL_MODE})"
    KERNEL_ARGS="--no-kernel-forwarding"
fi

echo "[rtpengine] Starting: interface=${RTPENGINE_INTERFACE} ng=127.0.0.1:${RTPENGINE_NG_PORT} ports=${RTPENGINE_PORT_MIN}-${RTPENGINE_PORT_MAX}"

exec /usr/sbin/rtpengine \
    --interface="${RTPENGINE_INTERFACE}" \
    --listen-ng="127.0.0.1:${RTPENGINE_NG_PORT}" \
    --port-min="${RTPENGINE_PORT_MIN}" \
    --port-max="${RTPENGINE_PORT_MAX}" \
    --tos="${RTPENGINE_TOS}" \
    --log-level="${RTPENGINE_LOG_LEVEL}" \
    --log-stderr \
    --recording-dir="${RTPENGINE_RECORDING_DIR}" \
    --recording-method=pcap \
    --prometheus-listen="0.0.0.0:${RTPENGINE_PROMETHEUS_PORT}" \
    --prometheus-prefix=rtpengine_ \
    --foreground \
    ${KERNEL_ARGS} \
    "$@"
