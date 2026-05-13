#!/usr/bin/env bash
# recording_mode_NEVER.sh — R01 integration test: recording_mode=NEVER means no file.
# R01 PLAN §12.2.
set -euo pipefail

RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/freeswitch/recordings}"
TENANT_ID="${TENANT_ID:-1}"
CAMPAIGN_ID="${CAMPAIGN_ID:-SOLAR_Q2}"
LEAD_ID="${LEAD_ID:-9999}"
FS_HOST="${FS_HOST:-127.0.0.1}"
FS_ESL_PORT="${FS_ESL_PORT:-8021}"

if ! command -v fs_cli &>/dev/null; then
    echo "[R01-never] fs_cli not found; skipping"
    exit 0
fi

CALL_UUID=$(uuidgen)
TODAY=$(date -u '+%Y/%m/%d')
UNEXPECTED_PATH="${RECORDINGS_DIR}/${TENANT_ID}/${TODAY}/${CAMPAIGN_ID}_${LEAD_ID}_${CALL_UUID}.wav"

echo "[R01-never] Placing 10s call with recording_mode_skip=true..."
fs_cli -H "${FS_HOST}" -P "${FS_ESL_PORT}" -x \
    "bgapi originate {origination_uuid=${CALL_UUID},vici2_tenant_id=${TENANT_ID},vici2_campaign_id=${CAMPAIGN_ID},vici2_lead_id=${LEAD_ID},vici2_consent_mode=ALLOW,recording_mode_skip=true}sip:conf_${TENANT_ID}_1@${FS_HOST}:5060 &sleep(10)" \
    &>/dev/null &

sleep 15

if [[ -f "${UNEXPECTED_PATH}" ]]; then
    echo "[R01-never] FAIL: recording file SHOULD NOT exist for mode=NEVER, but found ${UNEXPECTED_PATH}"
    exit 1
fi

echo "[R01-never] PASS: no recording file created for mode=NEVER (recording_mode_skip=true)"
