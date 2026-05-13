#!/bin/bash
# infra/kamailio/scripts/healthcheck.sh
# X02: Kamailio health probe for Docker HEALTHCHECK and keepalived check_kamailio.
#
# Strategy (in order of preference):
#   1. sipsak: sends SIP OPTIONS to 127.0.0.1:SIP_PORT; checks for 200 response.
#   2. kamcmd core.info: verifies Kamailio's UNIX control socket is responsive.
#
# Exit 0 = healthy, non-zero = unhealthy.
#
# Environment variables:
#   KAMAILIO_SIP_PORT     SIP UDP port to probe (default: 5060)
#   HEALTHCHECK_TIMEOUT   seconds to wait for SIP response (default: 3)
set -euo pipefail

SIP_PORT="${KAMAILIO_SIP_PORT:-5060}"
TIMEOUT="${HEALTHCHECK_TIMEOUT:-3}"

if command -v sipsak &>/dev/null; then
    # sipsak -s: target URI; -o: timeout; -q: quiet (exit code only)
    sipsak -s "sip:healthcheck@127.0.0.1:${SIP_PORT}" -o "${TIMEOUT}" -q \
        >/dev/null 2>&1
    exit $?
fi

# Fallback: check kamcmd responds (verifies process is alive and ctl socket works)
if command -v kamcmd &>/dev/null; then
    kamcmd core.info >/dev/null 2>&1
    exit $?
fi

echo "[kamailio healthcheck] Neither sipsak nor kamcmd available" >&2
exit 1
