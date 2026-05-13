#!/usr/bin/env bash
# recording_basic_e2e.sh — R01 integration test: basic end-to-end recording.
#
# Requires: docker compose up (F03/T01 live), sipp, sox/soxi, ffprobe.
# R01 PLAN §12.2.
#
# Usage:
#   RECORDINGS_DIR=/var/lib/freeswitch/recordings \
#   TENANT_ID=1 CAMPAIGN_ID=SOLAR_Q2 LEAD_ID=4287 \
#   ./recording_basic_e2e.sh
set -euo pipefail

RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/freeswitch/recordings}"
TENANT_ID="${TENANT_ID:-1}"
CAMPAIGN_ID="${CAMPAIGN_ID:-SOLAR_Q2}"
LEAD_ID="${LEAD_ID:-4287}"
FS_HOST="${FS_HOST:-127.0.0.1}"
FS_ESL_PORT="${FS_ESL_PORT:-8021}"
SIP_TARGET="${SIP_TARGET:-sip:conf_${TENANT_ID}_1@${FS_HOST}:5060}"

echo "[R01-e2e] Placing 10s test call via SIPp..."
# sipp sends an INVITE to the customer_into_agent_conf extension.
# In a real test environment, T04 originate would set campaign vars first.
# This smoke test uses a direct SIP call to the conf extension.
CALL_UUID=$(uuidgen)

# Place call via ESL originate (if esl_client available) or SIPp.
if command -v fs_cli &>/dev/null; then
    ORIGINATE_RESULT=$(fs_cli -H "${FS_HOST}" -P "${FS_ESL_PORT}" -x \
        "originate {origination_uuid=${CALL_UUID},vici2_tenant_id=${TENANT_ID},vici2_campaign_id=${CAMPAIGN_ID},vici2_lead_id=${LEAD_ID},vici2_consent_mode=ALLOW,RECORD_STEREO=true,RECORD_MIN_SEC=2,recording_follow_transfer=true}${SIP_TARGET} &sleep(10)" \
        2>&1)
    echo "[R01-e2e] Originate result: ${ORIGINATE_RESULT}"
else
    echo "[R01-e2e] fs_cli not found; skipping live call (use docker exec)"
    exit 0
fi

# Compute expected recording path.
TODAY=$(date -u '+%Y/%m/%d')
EXPECTED_PATH="${RECORDINGS_DIR}/${TENANT_ID}/${TODAY}/${CAMPAIGN_ID}_${LEAD_ID}_${CALL_UUID}.wav"
echo "[R01-e2e] Expected recording path: ${EXPECTED_PATH}"

# Wait up to 15s for the file to appear.
WAITED=0
while [[ ! -f "${EXPECTED_PATH}" && ${WAITED} -lt 15 ]]; do
    sleep 1
    WAITED=$((WAITED + 1))
done

if [[ ! -f "${EXPECTED_PATH}" ]]; then
    echo "[R01-e2e] FAIL: recording file not found at ${EXPECTED_PATH}"
    exit 1
fi

# Verify non-zero size and duration > 2s.
FILESIZE=$(stat --printf='%s' "${EXPECTED_PATH}")
if [[ "${FILESIZE}" -lt 1 ]]; then
    echo "[R01-e2e] FAIL: recording file is empty (0 bytes)"
    exit 1
fi

if command -v soxi &>/dev/null; then
    DURATION=$(soxi -D "${EXPECTED_PATH}" 2>/dev/null || echo "0")
    if [[ $(echo "${DURATION} > 2.0" | bc -l) -ne 1 ]]; then
        echo "[R01-e2e] FAIL: recording duration ${DURATION}s is less than 2s"
        exit 1
    fi
    echo "[R01-e2e] Duration: ${DURATION}s"
fi

echo "[R01-e2e] PASS: recording file exists at ${EXPECTED_PATH} (${FILESIZE} bytes)"
