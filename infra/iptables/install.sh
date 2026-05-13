#!/usr/bin/env bash
# =============================================================================
# infra/iptables/install.sh — persist SIP prefilter rules across reboots
# =============================================================================
# Usage (run as root or via sudo):
#   sudo bash infra/iptables/install.sh
#
# What this does:
#   1. Runs sip-prefilter.sh to install iptables rules into the running kernel
#   2. Saves the rules to /etc/iptables/rules.v4 (iptables-persistent)
#   3. Installs a systemd drop-in to ensure rules load before docker.service
#
# NOTE: Docker modifies iptables heavily. This script saves rules AFTER
# docker has started so we capture docker's own chains too. The systemd
# drop-in ensures our rules re-apply after docker-managed chain flush.
# =============================================================================
set -euo pipefail

info() { echo "[O05/iptables] $*"; }
die()  { echo "[O05/iptables] ERROR: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Must run as root (use sudo)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Install iptables-persistent
# ---------------------------------------------------------------------------
if ! dpkg -l iptables-persistent &>/dev/null; then
    info "Installing iptables-persistent..."
    DEBIAN_FRONTEND=noninteractive apt-get install -y iptables-persistent
fi

# ---------------------------------------------------------------------------
# Apply the SIP prefilter rules now
# ---------------------------------------------------------------------------
info "Applying SIP prefilter rules..."
bash "${SCRIPT_DIR}/sip-prefilter.sh"

# ---------------------------------------------------------------------------
# Save rules for persistence
# ---------------------------------------------------------------------------
info "Saving iptables rules to /etc/iptables/rules.v4..."
mkdir -p /etc/iptables
iptables-save > /etc/iptables/rules.v4
ip6tables-save > /etc/iptables/rules.v6
info "Rules saved"

# ---------------------------------------------------------------------------
# Systemd drop-in to re-apply SIP rules after docker restarts
# (Docker flushes the INPUT chain on docker.service restart)
# ---------------------------------------------------------------------------
DROPIN_DIR="/etc/systemd/system/docker.service.d"
mkdir -p "${DROPIN_DIR}"
cat > "${DROPIN_DIR}/50-sip-prefilter.conf" <<'EOF'
[Service]
# Re-apply SIP prefilter rules after docker.service starts
# (Docker modifies iptables; our rules must come after docker's setup)
ExecStartPost=/bin/bash /usr/local/bin/vici2-sip-prefilter.sh
EOF

# Install the prefilter script to a stable path
install -m 0750 "${SCRIPT_DIR}/sip-prefilter.sh" /usr/local/bin/vici2-sip-prefilter.sh

systemctl daemon-reload
info "Systemd drop-in installed: ${DROPIN_DIR}/50-sip-prefilter.conf"
info ""
info "iptables SIP prefilter rules will automatically re-apply on:"
info "  - System boot (via iptables-persistent)"
info "  - docker.service restart (via systemd drop-in)"
info ""
info "To test: sudo iptables -L INPUT -n | grep -E '(5060|scanner)'"
