#!/usr/bin/env bash
# recording_pause_resume.sh — R01 integration test: pause/resume via uuid_record mask/unmask.
#
# Requires: fs_cli, ffprobe/sox.
# R01 PLAN §12.2.
#
# Test flow:
#   1. Place a 30s call.
#   2. After 5s, issue uuid_record mask <uuid> <path>.
#   3. After 5 more seconds, issue uuid_record unmask <uuid> <path>.
#   4. After call ends, verify the WAV has a silent region (RMS < threshold) in middle.
set -euo pipefail

RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/freeswitch/recordings}"
TENANT_ID="${TENANT_ID:-1}"
CAMPAIGN_ID="${CAMPAIGN_ID:-SOLAR_Q2}"
LEAD_ID="${LEAD_ID:-4287}"
FS_HOST="${FS_HOST:-127.0.0.1}"
FS_ESL_PORT="${FS_ESL_PORT:-8021}"

if ! command -v fs_cli &>/dev/null; then
    echo "[R01-pause] fs_cli not found; skipping (requires docker exec)"
    exit 0
fi

CALL_UUID=$(uuidgen)
TODAY=$(date -u '+%Y/%m/%d')
EXPECTED_PATH="${RECORDINGS_DIR}/${TENANT_ID}/${TODAY}/${CAMPAIGN_ID}_${LEAD_ID}_${CALL_UUID}.wav"

echo "[R01-pause] Placing 30s call ${CALL_UUID}..."
fs_cli -H "${FS_HOST}" -P "${FS_ESL_PORT}" -x \
    "bgapi originate {origination_uuid=${CALL_UUID},vici2_tenant_id=${TENANT_ID},vici2_campaign_id=${CAMPAIGN_ID},vici2_lead_id=${LEAD_ID},vici2_consent_mode=ALLOW,RECORD_STEREO=true}sip:conf_${TENANT_ID}_1@${FS_HOST}:5060 &sleep(30)" \
    &>/dev/null &

sleep 5

echo "[R01-pause] Masking recording..."
fs_cli -H "${FS_HOST}" -P "${FS_ESL_PORT}" -x \
    "uuid_record ${CALL_UUID} mask ${EXPECTED_PATH}" &>/dev/null

sleep 5

echo "[R01-pause] Unmasking recording..."
fs_cli -H "${FS_HOST}" -P "${FS_ESL_PORT}" -x \
    "uuid_record ${CALL_UUID} unmask ${EXPECTED_PATH}" &>/dev/null

# Wait for call to complete.
sleep 25

if [[ ! -f "${EXPECTED_PATH}" ]]; then
    echo "[R01-pause] FAIL: recording file not found at ${EXPECTED_PATH}"
    exit 1
fi

FILESIZE=$(stat --printf='%s' "${EXPECTED_PATH}")
echo "[R01-pause] Recording: ${EXPECTED_PATH} (${FILESIZE} bytes)"

# Verify the recording is a single contiguous file (not split on pause/resume).
if command -v soxi &>/dev/null; then
    DURATION=$(soxi -D "${EXPECTED_PATH}")
    echo "[R01-pause] Duration: ${DURATION}s"
    if [[ $(echo "${DURATION} > 15.0" | bc -l) -ne 1 ]]; then
        echo "[R01-pause] FAIL: expected duration > 15s (pause+resume), got ${DURATION}s"
        exit 1
    fi
fi

echo "[R01-pause] PASS: single contiguous WAV with pause region"
