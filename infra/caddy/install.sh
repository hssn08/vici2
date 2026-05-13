#!/usr/bin/env bash
# =============================================================================
# infra/caddy/install.sh — install Caddy 2.9 with Route53 DNS plugin on host
# =============================================================================
# Usage (run as root or via sudo):
#   sudo bash infra/caddy/install.sh
#
# What this does:
#   1. Installs Go (for xcaddy) if not already present
#   2. Installs xcaddy
#   3. Builds caddy with caddy-dns/route53 plugin
#   4. Installs the binary to /usr/local/bin/caddy
#   5. Creates /etc/caddy/ directory + copies Caddyfile.example
#   6. Creates /var/log/caddy/
#   7. Installs systemd unit file
#   8. Enables + starts caddy.service
#
# Prerequisites:
#   - Debian 12 (Bookworm) or Ubuntu 22.04+
#   - certbot already installed (infra/certbot/install.sh) and cert present at
#     /etc/letsencrypt/live/vici2.example.com/ before caddy.service starts
#   - /etc/caddy/caddy.env populated from .env.example O05 additions
# =============================================================================
set -euo pipefail

CADDY_VERSION="v2.9.1"
XCADDY_VERSION="v0.4.4"
ROUTE53_PLUGIN="github.com/caddy-dns/route53"

CADDY_BIN="/usr/local/bin/caddy"
CADDY_CONFIG_DIR="/etc/caddy"
CADDY_LOG_DIR="/var/log/caddy"
CADDY_USER="caddy"
CADDY_GROUP="caddy"

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
info() { echo "[O05/caddy] $*"; }
die()  { echo "[O05/caddy] ERROR: $*" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Verify running as root
# ---------------------------------------------------------------------------
[[ "$(id -u)" -eq 0 ]] || die "Must run as root (use sudo)"

# ---------------------------------------------------------------------------
# Install Go if not present (xcaddy requires it)
# ---------------------------------------------------------------------------
if ! command -v go &>/dev/null; then
    info "Go not found — installing via apt..."
    apt-get update -qq
    apt-get install -y golang-go
fi

GO_VERSION=$(go version | awk '{print $3}' | sed 's/go//')
info "Go version: ${GO_VERSION}"

# ---------------------------------------------------------------------------
# Install xcaddy
# ---------------------------------------------------------------------------
if ! command -v xcaddy &>/dev/null; then
    info "Installing xcaddy ${XCADDY_VERSION}..."
    GOBIN=/usr/local/bin go install "github.com/caddyserver/xcaddy/cmd/xcaddy@${XCADDY_VERSION}"
fi

# ---------------------------------------------------------------------------
# Build Caddy with Route53 DNS plugin
# ---------------------------------------------------------------------------
info "Building Caddy ${CADDY_VERSION} with ${ROUTE53_PLUGIN}..."
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "${BUILD_DIR}"' EXIT

xcaddy build "${CADDY_VERSION}" \
    --with "${ROUTE53_PLUGIN}" \
    --output "${BUILD_DIR}/caddy"

install -m 0755 "${BUILD_DIR}/caddy" "${CADDY_BIN}"
info "Caddy installed at ${CADDY_BIN}"
caddy version

# ---------------------------------------------------------------------------
# Create caddy user/group
# ---------------------------------------------------------------------------
if ! id -u "${CADDY_USER}" &>/dev/null; then
    info "Creating system user '${CADDY_USER}'..."
    useradd --system --home-dir /var/lib/caddy --shell /bin/false \
        --comment "Caddy web server" "${CADDY_USER}"
fi

# ---------------------------------------------------------------------------
# Create directories
# ---------------------------------------------------------------------------
install -d -o "${CADDY_USER}" -g "${CADDY_GROUP}" -m 0750 "${CADDY_CONFIG_DIR}"
install -d -o "${CADDY_USER}" -g "${CADDY_GROUP}" -m 0750 "${CADDY_LOG_DIR}"
install -d -o "${CADDY_USER}" -g "${CADDY_GROUP}" -m 0750 /var/lib/caddy

# ---------------------------------------------------------------------------
# Copy Caddyfile.example (do NOT overwrite existing config)
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "${CADDY_CONFIG_DIR}/Caddyfile" ]]; then
    cp "${SCRIPT_DIR}/Caddyfile.example" "${CADDY_CONFIG_DIR}/Caddyfile"
    info "Copied Caddyfile.example to ${CADDY_CONFIG_DIR}/Caddyfile"
    info "IMPORTANT: Edit ${CADDY_CONFIG_DIR}/Caddyfile before starting caddy.service"
else
    info "Existing ${CADDY_CONFIG_DIR}/Caddyfile preserved — skipping copy"
fi

# ---------------------------------------------------------------------------
# Create environment file template (do NOT overwrite)
# ---------------------------------------------------------------------------
if [[ ! -f "${CADDY_CONFIG_DIR}/caddy.env" ]]; then
    cat > "${CADDY_CONFIG_DIR}/caddy.env" <<'EOF'
# Caddy environment — sourced by caddy.service EnvironmentFile=
# See .env.example O05 section for full reference.

VICI2_ACME_EMAIL=admin@example.com
# Use Let's Encrypt staging in dev/test:
#   VICI2_ACME_DIRECTORY=https://acme-staging-v02.api.letsencrypt.org/directory
# Use production in prod:
#   VICI2_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory
VICI2_ACME_DIRECTORY=https://acme-v02.api.letsencrypt.org/directory

CADDY_HOSTNAMES=vici2.example.com,*.vici2.example.com

# Route53 credentials (dev/laptop only — use IAM instance role in prod)
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=us-east-1

# Upstream addresses (Phase 1: loopback since services run on same host)
API_UPSTREAM=http://127.0.0.1:3000
WEB_UPSTREAM=http://127.0.0.1:4000
FS_WSS_UPSTREAM=http://127.0.0.1:5066
FS_WSS_PORT=7443
EOF
    chown "${CADDY_USER}:${CADDY_GROUP}" "${CADDY_CONFIG_DIR}/caddy.env"
    chmod 0640 "${CADDY_CONFIG_DIR}/caddy.env"
    info "Created ${CADDY_CONFIG_DIR}/caddy.env — fill in your values"
fi

# ---------------------------------------------------------------------------
# Install systemd unit
# ---------------------------------------------------------------------------
cat > /etc/systemd/system/caddy.service <<'EOF'
[Unit]
Description=Caddy Web Server (vici2 edge)
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
Type=notify
User=caddy
Group=caddy
EnvironmentFile=/etc/caddy/caddy.env
ExecStartPre=/usr/local/bin/caddy validate --config /etc/caddy/Caddyfile
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
ExecStop=/usr/local/bin/caddy stop
TimeoutStopSec=5s
LimitNOFILE=1048576
LimitNPROC=512
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable caddy.service
info "caddy.service enabled"
info ""
info "Next steps:"
info "  1. Edit ${CADDY_CONFIG_DIR}/Caddyfile (set real hostnames + upstream ports)"
info "  2. Edit ${CADDY_CONFIG_DIR}/caddy.env (set VICI2_ACME_EMAIL + AWS creds)"
info "  3. Ensure certbot has issued the cert at /etc/letsencrypt/live/vici2.example.com/"
info "     (run: sudo bash infra/certbot/install.sh)"
info "  4. sudo systemctl start caddy"
info "  5. sudo systemctl status caddy"
