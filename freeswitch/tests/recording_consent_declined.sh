#!/usr/bin/env bash
# recording_consent_declined.sh — R01 integration test: consent declined → no recording.
# R01 PLAN §12.2.
set -euo pipefail

RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/freeswitch/recordings}"
TENANT_ID="${TENANT_ID:-1}"
CAMPAIGN_ID="${CAMPAIGN_ID:-SOLAR_Q2}"
LEAD_ID="${LEAD_ID:-8888}"
FS_HOST="${FS_HOST:-127.0.0.1}"
FS_ESL_PORT="${FS_ESL_PORT:-8021}"

if ! command -v fs_cli &>/dev/null; then
    echo "[R01-consent] fs_cli not found; skipping"
    exit 0
fi

CALL_UUID=$(uuidgen)
TODAY=$(date -u '+%Y/%m/%d')
UNEXPECTED_PATH="${RECORDINGS_DIR}/${TENANT_ID}/${TODAY}/${CAMPAIGN_ID}_${LEAD_ID}_${CALL_UUID}.wav"

echo "[R01-consent] Placing 10s call with consent_record_enabled=false..."
fs_cli -H "${FS_HOST}" -P "${FS_ESL_PORT}" -x \
    "bgapi originate {origination_uuid=${CALL_UUID},vici2_tenant_id=${TENANT_ID},vici2_campaign_id=${CAMPAIGN_ID},vici2_lead_id=${LEAD_ID},vici2_consent_mode=REQUIRE_ACTIVE,consent_record_enabled=false,vici2_consent_status=prompted_declined}sip:conf_${TENANT_ID}_1@${FS_HOST}:5060 &sleep(10)" \
    &>/dev/null &

sleep 15

if [[ -f "${UNEXPECTED_PATH}" ]]; then
    echo "[R01-consent] FAIL: recording file should NOT exist when consent declined"
    exit 1
fi

echo "[R01-consent] PASS: no recording created when consent_record_enabled=false"
