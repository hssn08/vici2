#!/usr/bin/env bash
# =============================================================================
# infra/certbot/render-fs-tls.sh
# =============================================================================
# certbot --deploy-hook script: distribute the renewed LE cert into the
# FreeSWITCH TLS directory and trigger per-profile sofia restart.
#
# Called by certbot automatically when a cert is successfully renewed.
# $RENEWED_LINEAGE is set by certbot to the cert's live directory.
#
# FreeSWITCH expects files in /etc/freeswitch/tls/:
#   wss.pem       — WebRTC WSS (fullchain + privkey concatenated)
#   agent.pem     — server cert (symlink → wss.pem)
#   tls.pem       — TLS client/server (symlink → wss.pem)
#   dtls-srtp.pem — DTLS-SRTP fingerprint (symlink → wss.pem)
#
# See: https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Security/Certificates_3966216/
# See: https://github.com/signalwire/freeswitch/issues/2287 (TLS hot-reload not supported)
# =============================================================================
set -euo pipefail

FS_TLS_DIR="${FS_TLS_DIR:-/etc/freeswitch/tls}"
FS_ESL_HOST="${FS_ESL_HOST:-127.0.0.1}"
FS_ESL_PORT="${FS_ESL_PORT:-8021}"
FS_EVENT_SOCKET_PASSWORD="${FS_EVENT_SOCKET_PASSWORD:-ClueCon}"

# certbot sets this env var to the directory that was renewed.
LINEAGE="${RENEWED_LINEAGE:-}"

if [[ -z "${LINEAGE}" ]]; then
    echo "[render-fs-tls] ERROR: RENEWED_LINEAGE not set. Run via certbot --deploy-hook." >&2
    exit 1
fi

FULLCHAIN="${LINEAGE}/fullchain.pem"
PRIVKEY="${LINEAGE}/privkey.pem"

for f in "${FULLCHAIN}" "${PRIVKEY}"; do
    [[ -f "${f}" ]] || { echo "[render-fs-tls] ERROR: ${f} not found" >&2; exit 1; }
done

mkdir -p "${FS_TLS_DIR}"
chmod 750 "${FS_TLS_DIR}"

# ---------------------------------------------------------------------------
# Step 1–2: atomic write of wss.pem (fullchain + privkey concatenated).
# Atomic: write to .new then mv -f so FS never reads a partial file.
# ---------------------------------------------------------------------------
echo "[render-fs-tls] Writing ${FS_TLS_DIR}/wss.pem ..."
cat "${FULLCHAIN}" "${PRIVKEY}" > "${FS_TLS_DIR}/wss.pem.new"
chmod 640 "${FS_TLS_DIR}/wss.pem.new"
mv -f "${FS_TLS_DIR}/wss.pem.new" "${FS_TLS_DIR}/wss.pem"

# ---------------------------------------------------------------------------
# Steps 3–5: symlink agent.pem, tls.pem, dtls-srtp.pem → wss.pem
# ---------------------------------------------------------------------------
for name in agent tls dtls-srtp; do
    ln -sf wss.pem "${FS_TLS_DIR}/${name}.pem"
done

echo "[render-fs-tls] Cert files written to ${FS_TLS_DIR}/"
ls -la "${FS_TLS_DIR}/"

# ---------------------------------------------------------------------------
# Steps 6–8: restart each sofia profile to reload TLS material.
# FS cannot hot-reload TLS (issue #2287). Per-profile restart isolates
# blast radius (F03 PLAN §1.2 — 3-profile design).
# ---------------------------------------------------------------------------
FS_CLI_ARGS=(-H "${FS_ESL_HOST}" -P "${FS_ESL_PORT}" -p "${FS_EVENT_SOCKET_PASSWORD}")

for profile in wss internal external; do
    echo "[render-fs-tls] Restarting sofia profile '${profile}'..."
    if fs_cli "${FS_CLI_ARGS[@]}" -x "sofia profile ${profile} restart reloadxml" 2>/dev/null; then
        echo "[render-fs-tls] Profile '${profile}' restarted OK"
    else
        echo "[render-fs-tls] WARN: sofia profile '${profile}' restart failed (profile may not exist)" >&2
    fi
done

echo "[render-fs-tls] Done. FS TLS cert renewed and profiles reloaded."
