#!/usr/bin/env bash
# vici2 dev WSS cert generator — F03 PLAN §9.2.
# Produces a combined-PEM at freeswitch/tls/wss.pem (cert + key + rootCA chain).
# Requires mkcert (https://github.com/FiloSottile/mkcert) installed on the
# HOST and `mkcert -install` already run so the local CA is trusted by your
# browser. This is the #1 dev-onboarding pitfall — see README.
set -euo pipefail

TLS_DIR="$(cd "$(dirname "$0")/.." && pwd)/tls"

command -v mkcert >/dev/null 2>&1 || {
  echo "ERROR: mkcert not found on PATH."
  echo "       Install mkcert and run 'mkcert -install' once on this host."
  echo "       macOS: brew install mkcert nss"
  echo "       Linux: see https://github.com/FiloSottile/mkcert#installation"
  exit 2
}

mkdir -p "$TLS_DIR"
cd "$TLS_DIR"

mkcert -cert-file _cert.pem -key-file _key.pem \
  localhost 127.0.0.1 ::1 host.docker.internal "*.local" "$(hostname)"

cat _cert.pem _key.pem "$(mkcert -CAROOT)/rootCA.pem" > wss.pem
rm -f _cert.pem _key.pem
chmod 600 wss.pem

echo "wss.pem written to ${TLS_DIR}/wss.pem"
echo "Restart FreeSWITCH to pick up new cert:"
echo "  docker compose restart freeswitch"
