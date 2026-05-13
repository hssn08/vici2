#!/usr/bin/env bash
# =============================================================================
# infra/fail2ban/install.sh — install fail2ban and enable vici2 jails on host
# =============================================================================
# Usage (run as root or via sudo):
#   sudo bash infra/fail2ban/install.sh
#
# What this does:
#   1. Installs fail2ban via apt
#   2. Installs fail2ban-prometheus-exporter (for Fail2banBannedSurge alert)
#   3. Copies filter.d/*.conf to /etc/fail2ban/filter.d/
#   4. Copies action.d/*.local to /etc/fail2ban/action.d/
#   5. Copies jails/*.local to /etc/fail2ban/jail.d/
#   6. Enables and starts fail2ban.service
# =============================================================================
set -euo pipefail

FAIL2BAN_CONF_DIR="/etc/fail2ban"
F2B_EXPORTER_VERSION="0.10.0"  # fail2ban-prometheus-exporter release

info() { echo "[O05/fail2ban] $*"; }
die()  { echo "[O05/fail2ban] ERROR: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Must run as root (use sudo)"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------------------------------------------------------------------------
# Install fail2ban
# ---------------------------------------------------------------------------
if ! command -v fail2ban-server &>/dev/null; then
    info "Installing fail2ban..."
    apt-get update -qq
    apt-get install -y fail2ban iptables
fi

FAIL2BAN_VERSION=$(fail2ban-server --version 2>&1 | head -1)
info "fail2ban version: ${FAIL2BAN_VERSION}"

# ---------------------------------------------------------------------------
# Install fail2ban-prometheus-exporter (for Fail2banBannedSurge alert in O01)
# ---------------------------------------------------------------------------
if ! command -v fail2ban-exporter &>/dev/null; then
    info "Installing fail2ban-prometheus-exporter ${F2B_EXPORTER_VERSION}..."
    ARCH=$(dpkg --print-architecture)
    EXPORTER_URL="https://github.com/jangrewe/prometheus-fail2ban-exporter/releases/download/v${F2B_EXPORTER_VERSION}/fail2ban-exporter_${F2B_EXPORTER_VERSION}_linux_${ARCH}.tar.gz"
    TMPDIR=$(mktemp -d)
    trap 'rm -rf "${TMPDIR}"' EXIT
    curl -fsSL "${EXPORTER_URL}" -o "${TMPDIR}/exporter.tar.gz" || {
        info "WARN: Could not download fail2ban exporter. Install manually from:"
        info "  https://github.com/jangrewe/prometheus-fail2ban-exporter/releases"
    }
    if [[ -f "${TMPDIR}/exporter.tar.gz" ]]; then
        tar -xzf "${TMPDIR}/exporter.tar.gz" -C "${TMPDIR}"
        install -m 0755 "${TMPDIR}/fail2ban-exporter" /usr/local/bin/fail2ban-exporter
        info "fail2ban-prometheus-exporter installed"
        # Install systemd unit for the exporter
        cat > /etc/systemd/system/fail2ban-exporter.service <<'EOF'
[Unit]
Description=fail2ban Prometheus exporter
After=fail2ban.service

[Service]
Type=simple
ExecStart=/usr/local/bin/fail2ban-exporter --socket /run/fail2ban/fail2ban.sock --port 9191
Restart=on-failure
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
        systemctl daemon-reload
        systemctl enable --now fail2ban-exporter.service
        info "fail2ban-exporter.service enabled on :9191"
    fi
fi

# ---------------------------------------------------------------------------
# Copy filter.d configs
# ---------------------------------------------------------------------------
info "Installing fail2ban filter configs..."
for f in "${SCRIPT_DIR}/filter.d/"*.conf; do
    name=$(basename "${f}")
    if [[ -f "${FAIL2BAN_CONF_DIR}/filter.d/${name}" ]]; then
        info "  Backing up existing ${name} → ${name}.bak"
        cp "${FAIL2BAN_CONF_DIR}/filter.d/${name}" "${FAIL2BAN_CONF_DIR}/filter.d/${name}.bak"
    fi
    install -m 0644 "${f}" "${FAIL2BAN_CONF_DIR}/filter.d/${name}"
    info "  Installed filter.d/${name}"
done

# ---------------------------------------------------------------------------
# Copy action.d configs
# ---------------------------------------------------------------------------
info "Installing fail2ban action configs..."
for f in "${SCRIPT_DIR}/action.d/"*.local; do
    name=$(basename "${f}")
    install -m 0644 "${f}" "${FAIL2BAN_CONF_DIR}/action.d/${name}"
    info "  Installed action.d/${name}"
done

# ---------------------------------------------------------------------------
# Copy jail configs (skip ignoreip.local if already customized)
# ---------------------------------------------------------------------------
info "Installing fail2ban jail configs..."
for f in "${SCRIPT_DIR}/jails/"*.local; do
    name=$(basename "${f}")
    dest="${FAIL2BAN_CONF_DIR}/jail.d/${name}"
    if [[ "${name}" == "ignoreip.local" ]] && [[ -f "${dest}" ]]; then
        info "  Skipping ignoreip.local (already configured — review manually)"
        continue
    fi
    install -m 0640 "${f}" "${dest}"
    info "  Installed jail.d/${name}"
done

# ---------------------------------------------------------------------------
# Validate fail2ban config before restart
# ---------------------------------------------------------------------------
info "Validating fail2ban configuration..."
fail2ban-client -t -c "${FAIL2BAN_CONF_DIR}" || {
    die "fail2ban config validation failed. Check /etc/fail2ban/jail.d/ configs."
}

# ---------------------------------------------------------------------------
# Enable and start fail2ban
# ---------------------------------------------------------------------------
systemctl enable fail2ban
systemctl restart fail2ban
info "fail2ban.service started"

# ---------------------------------------------------------------------------
# Verify jails
# ---------------------------------------------------------------------------
sleep 2
info "Enabled jails:"
fail2ban-client status | grep -A20 "Jail list"

info ""
info "Installation complete. Next steps:"
info "  1. Edit /etc/fail2ban/jail.d/ignoreip.local with your ops jump-host IPs"
info "  2. Set VICI2_API_SERVICE_TOKEN in /etc/fail2ban/fail2ban.env for audit action"
info "  3. Verify FreeSWITCH log-auth-failures params are set in all sofia profiles"
info "  4. Test: fail2ban-client status freeswitch"
