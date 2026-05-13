#!/usr/bin/env bash
# recording_stereo_verify.sh — R01 integration test: stereo channel verification.
#
# Requires: ffmpeg, a completed recording at $RECORDING_PATH.
# R01 PLAN §12.2 + §12.3.
#
# Usage:
#   RECORDING_PATH=/var/lib/freeswitch/recordings/1/2026/05/06/SOLAR_Q2_4287_<uuid>.wav \
#   ./recording_stereo_verify.sh
set -euo pipefail

RECORDING_PATH="${RECORDING_PATH:-}"
TMPDIR_OUT=$(mktemp -d)
trap 'rm -rf "${TMPDIR_OUT}"' EXIT

if [[ -z "${RECORDING_PATH}" ]]; then
    echo "[R01-stereo] RECORDING_PATH not set; finding most recent .wav..."
    RECORDINGS_DIR="${RECORDINGS_DIR:-/var/lib/freeswitch/recordings}"
    RECORDING_PATH=$(find "${RECORDINGS_DIR}" -name '*.wav' -newer /tmp -type f | head -1)
fi
if [[ -z "${RECORDING_PATH}" || ! -f "${RECORDING_PATH}" ]]; then
    echo "[R01-stereo] FAIL: no recording found"
    exit 1
fi

echo "[R01-stereo] Testing: ${RECORDING_PATH}"

# 1. Verify stereo via ffprobe.
AUDIO_INFO=$(ffprobe -v error -select_streams a:0 -show_entries stream=channels,sample_rate,codec_name \
    -of default=noprint_wrappers=1 "${RECORDING_PATH}" 2>&1)

echo "[R01-stereo] Audio info: ${AUDIO_INFO}"
if ! echo "${AUDIO_INFO}" | grep -q "channels=2"; then
    echo "[R01-stereo] FAIL: expected stereo (channels=2), got: ${AUDIO_INFO}"
    exit 1
fi

# 2. Demux left (customer) and right (agent) channels.
LEFT="${TMPDIR_OUT}/left.wav"
RIGHT="${TMPDIR_OUT}/right.wav"

ffmpeg -y -i "${RECORDING_PATH}" \
    -filter_complex "[0:a]pan=mono|c0=c0[left];[0:a]pan=mono|c0=c1[right]" \
    -map "[left]" "${LEFT}" \
    -map "[right]" "${RIGHT}" \
    -v error 2>&1

LEFT_SIZE=$(stat --printf='%s' "${LEFT}")
RIGHT_SIZE=$(stat --printf='%s' "${RIGHT}")

if [[ "${LEFT_SIZE}" -lt 100 || "${RIGHT_SIZE}" -lt 100 ]]; then
    echo "[R01-stereo] FAIL: left or right channel too small (left=${LEFT_SIZE}, right=${RIGHT_SIZE})"
    exit 1
fi

echo "[R01-stereo] PASS: stereo verified (channels=2, left=${LEFT_SIZE}B, right=${RIGHT_SIZE}B)"
