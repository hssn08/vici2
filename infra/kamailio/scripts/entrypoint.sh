#!/bin/bash
# infra/kamailio/scripts/entrypoint.sh
# X02: Kamailio container startup.
#
# Responsibilities:
#   1. Substitute environment variables into kamailio.cfg
#      (DBURL, RTPENGINE_SOCK, TOPOH_SECRET, KAMAILIO_PUBLIC_IP)
#   2. Generate a self-signed TLS certificate if none is present (dev mode)
#   3. Exec the Kamailio process (passed as CMD arguments)
#
# Required environment variables:
#   KAMAILIO_DB_URL     MySQL URL e.g. mysql://kamailio:pass@mysql:3306/kamailio
#   RTPENGINE_HOST      rtpengine IP/hostname (default: 127.0.0.1)
#   RTPENGINE_NG_PORT   rtpengine ng-control port (default: 22222)
#   TOPOH_SECRET        topology-hiding mask key (any random string)
#   KAMAILIO_PUBLIC_IP  public IP for topoh masking (default: 127.0.0.1)
#
# Optional:
#   KAMAILIO_DOMAIN     SIP domain for self-signed cert CN (default: kamailio.local)
set -euo pipefail

CFG_SRC="/etc/kamailio/kamailio.cfg"
CFG_TMP="/tmp/kamailio.cfg.rendered"
TLS_DIR="/etc/kamailio/tls"

# ---------------------------------------------------------------------------
# 1. Build env defaults
# ---------------------------------------------------------------------------
KAMAILIO_DB_URL="${KAMAILIO_DB_URL:-mysql://kamailio:kamailio@127.0.0.1:3306/kamailio}"
RTPENGINE_HOST="${RTPENGINE_HOST:-127.0.0.1}"
RTPENGINE_NG_PORT="${RTPENGINE_NG_PORT:-22222}"
RTPENGINE_SOCK="udp:${RTPENGINE_HOST}:${RTPENGINE_NG_PORT}"
TOPOH_SECRET="${TOPOH_SECRET:-vici2-topoh-default-secret}"
KAMAILIO_PUBLIC_IP="${KAMAILIO_PUBLIC_IP:-127.0.0.1}"
KAMAILIO_DOMAIN="${KAMAILIO_DOMAIN:-kamailio.local}"

echo "[kamailio] DB URL: ${KAMAILIO_DB_URL%%@*}@*** (credentials hidden)"
echo "[kamailio] rtpengine socket: ${RTPENGINE_SOCK}"
echo "[kamailio] public IP (topoh): ${KAMAILIO_PUBLIC_IP}"

# ---------------------------------------------------------------------------
# 2. Render kamailio.cfg — substitute placeholder tokens
# ---------------------------------------------------------------------------
sed \
    -e "s|DBURL|${KAMAILIO_DB_URL}|g" \
    -e "s|RTPENGINE_SOCK|${RTPENGINE_SOCK}|g" \
    -e "s|TOPOH_SECRET|${TOPOH_SECRET}|g" \
    -e "s|KAMAILIO_PUBLIC_IP|${KAMAILIO_PUBLIC_IP}|g" \
    "${CFG_SRC}" > "${CFG_TMP}"

# Replace original config with rendered version
cp "${CFG_TMP}" "${CFG_SRC}"
echo "[kamailio] Configuration rendered to ${CFG_SRC}"

# ---------------------------------------------------------------------------
# 3. Generate self-signed TLS certificate if not present (dev/test mode)
# ---------------------------------------------------------------------------
mkdir -p "${TLS_DIR}"
if [ ! -f "${TLS_DIR}/server.crt" ] || [ ! -f "${TLS_DIR}/server.key" ]; then
    echo "[kamailio] No TLS certificate found — generating self-signed cert for dev"
    openssl req -x509 -newkey rsa:2048 -keyout "${TLS_DIR}/server.key" \
        -out "${TLS_DIR}/server.crt" -days 3650 -nodes \
        -subj "/CN=${KAMAILIO_DOMAIN}/O=vici2/C=US" \
        2>/dev/null
    # Create an empty CA bundle (no verification in dev)
    touch "${TLS_DIR}/ca-bundle.crt"
    echo "[kamailio] Self-signed cert written to ${TLS_DIR}/"
else
    echo "[kamailio] TLS certificate found at ${TLS_DIR}/server.crt"
fi

# ---------------------------------------------------------------------------
# 4. Exec Kamailio (replace shell process so signals are delivered correctly)
# ---------------------------------------------------------------------------
echo "[kamailio] Starting: $*"
exec "$@"
