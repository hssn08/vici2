#!/usr/bin/env bash
# =============================================================================
# infra/certbot/install.sh — install certbot (Snap) + issue LE wildcard cert
# =============================================================================
# Usage (run as root or via sudo):
#   sudo VICI2_DOMAIN=vici2.example.com VICI2_ACME_EMAIL=admin@example.com \
#        bash infra/certbot/install.sh
#
# What this does:
#   1. Installs certbot via Snap (EFF-recommended on Debian 12)
#   2. Installs certbot-dns-route53 plugin
#   3. Issues/renews the wildcard cert via DNS-01 challenge against Route53
#   4. Installs render-fs-tls.sh deploy hook
#
# Prerequisites:
#   - AWS credentials for Route53 zone: AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
#     (or IAM instance role — Route53 plugin auto-detects)
#   - Route53 hosted zone for VICI2_DOMAIN already exists
# =============================================================================
set -euo pipefail

DOMAIN="${VICI2_DOMAIN:?Set VICI2_DOMAIN to your apex domain, e.g. vici2.example.com}"
EMAIL="${VICI2_ACME_EMAIL:?Set VICI2_ACME_EMAIL to your LE account email}"
STAGING="${VICI2_ACME_STAGING:-false}"

info() { echo "[O05/certbot] $*"; }
die()  { echo "[O05/certbot] ERROR: $*" >&2; exit 1; }

[[ "$(id -u)" -eq 0 ]] || die "Must run as root (use sudo)"

# ---------------------------------------------------------------------------
# Install snapd and certbot
# ---------------------------------------------------------------------------
if ! command -v snap &>/dev/null; then
    info "Installing snapd..."
    apt-get update -qq && apt-get install -y snapd
fi

if ! snap list certbot &>/dev/null; then
    info "Installing certbot via snap..."
    snap install --classic certbot
    ln -sf /snap/bin/certbot /usr/local/bin/certbot
fi

# Route53 DNS plugin
if ! snap list certbot-dns-route53 &>/dev/null; then
    info "Installing certbot-dns-route53 plugin..."
    snap install certbot-dns-route53
    snap set certbot trust-plugin-with-root=ok
    snap connect certbot:plugin certbot-dns-route53
fi

# ---------------------------------------------------------------------------
# Install deploy hook
# ---------------------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 0750 "${SCRIPT_DIR}/render-fs-tls.sh" /usr/local/bin/render-fs-tls.sh
info "Installed deploy hook at /usr/local/bin/render-fs-tls.sh"

# ---------------------------------------------------------------------------
# Issue / renew the wildcard cert
# ---------------------------------------------------------------------------
STAGING_FLAG=""
if [[ "${STAGING}" == "true" ]]; then
    STAGING_FLAG="--staging"
    info "Using Let's Encrypt STAGING endpoint"
fi

info "Requesting LE wildcard cert for ${DOMAIN} and *.${DOMAIN} ..."
certbot certonly \
    ${STAGING_FLAG} \
    --dns-route53 \
    --agree-tos \
    --non-interactive \
    --email "${EMAIL}" \
    --dns-route53-propagation-seconds 30 \
    --deploy-hook /usr/local/bin/render-fs-tls.sh \
    -d "${DOMAIN}" \
    -d "*.${DOMAIN}"

info "Cert issued at /etc/letsencrypt/live/${DOMAIN}/"
info ""
info "Certbot's Snap-managed systemd timer will auto-renew before 30d expiry."
info "Renewal fires render-fs-tls.sh automatically."
info ""
info "To verify the timer:"
info "  systemctl list-timers | grep certbot"
info ""
info "To force-test renewal (dry run):"
info "  sudo certbot renew --dry-run"
