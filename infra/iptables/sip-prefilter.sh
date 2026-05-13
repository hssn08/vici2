#!/usr/bin/env bash
# =============================================================================
# infra/iptables/sip-prefilter.sh — host iptables pre-fail2ban SIP guards
# =============================================================================
# Cheaper than fail2ban regex: drop known scanners by string match and
# rate-limit REGISTER floods at the packet level BEFORE fail2ban sees the log.
#
# Applied at host iptables INPUT chain via systemd-managed restore.
# Rules survive reboot via infra/iptables/install.sh.
#
# Ports match F03's 3-profile design:
#   5060 — UDP SIP (internal + external profiles)
#   5061 — SIP-TLS (TLS profile, carriers)
#   5080 — alternate SIP / outbound profile
#
# Reference: https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Security/
# Reference: O05 PLAN §2.5
# =============================================================================
set -euo pipefail

info() { echo "[O05/iptables] $*"; }

# ---------------------------------------------------------------------------
# String-match drops for known SIP scanner user agents.
# Boyer-Moore string search is inexpensive at line-rate.
# Run these at the INPUT chain head so packets are dropped immediately.
# ---------------------------------------------------------------------------
info "Installing SIP scanner string-match rules..."

# Friendly-scanner (SIPVicious suite)
iptables -I INPUT -p udp --dport 5060 -m string --string "friendly-scanner" --algo bm -j DROP
iptables -I INPUT -p udp --dport 5061 -m string --string "friendly-scanner" --algo bm -j DROP
iptables -I INPUT -p udp --dport 5080 -m string --string "friendly-scanner" --algo bm -j DROP
iptables -I INPUT -p tcp --dport 5060 -m string --string "friendly-scanner" --algo bm -j DROP
iptables -I INPUT -p tcp --dport 5061 -m string --string "friendly-scanner" --algo bm -j DROP

# sipcli (automated SIP stress/scan tool)
iptables -I INPUT -p udp --dport 5060 -m string --string "sipcli" --algo bm -j DROP
iptables -I INPUT -p tcp --dport 5060 -m string --string "sipcli" --algo bm -j DROP

# VaxSIPUserAgent (commercial SIP scanner)
iptables -I INPUT -p udp --dport 5060 -m string --string "VaxSIPUserAgent" --algo bm -j DROP
iptables -I INPUT -p tcp --dport 5060 -m string --string "VaxSIPUserAgent" --algo bm -j DROP

info "SIP scanner string-match rules installed"

# ---------------------------------------------------------------------------
# Per-source REGISTER rate limit with hashlimit.
# Allows 5 REGISTER packets/sec burst-to-8 per source IP.
# Legitimate SIP phones register every 30–600 seconds, so this limit
# (5/s burst-8) only triggers scanner tools.
# Packets that pass the limit fall through to further processing.
# ---------------------------------------------------------------------------
info "Installing SIP REGISTER hashlimit rule..."

iptables -A INPUT -p udp --dport 5060 \
    -m string --string "REGISTER" --algo bm \
    -m hashlimit \
        --hashlimit-name SIP_REG \
        --hashlimit-mode srcip \
        --hashlimit 5/sec \
        --hashlimit-burst 8 \
    -j ACCEPT

# Packets that fail the rate limit are not explicitly DROPped here —
# they fall through to fail2ban's iptables chains if triggered.

info "SIP REGISTER hashlimit rule installed"

# ---------------------------------------------------------------------------
# INVITE flood rate limit (optional, more aggressive — disabled by default)
# Uncomment if you see INVITE floods in freeswitch.log.
# ---------------------------------------------------------------------------
# iptables -A INPUT -p udp --dport 5060 \
#     -m string --string "INVITE" --algo bm \
#     -m hashlimit \
#         --hashlimit-name SIP_INVITE \
#         --hashlimit-mode srcip \
#         --hashlimit 2/sec \
#         --hashlimit-burst 4 \
#     -j ACCEPT

info "Done. Current SIP-related INPUT rules:"
iptables -L INPUT -n --line-numbers | grep -E "(5060|5061|5080|scanner|sipcli|VaxSIP|SIP_)" || true
