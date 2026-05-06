#!/usr/bin/env bash
# Hard reset: stop stack, drop volumes, remove generated artifacts.
# Equivalent to `make clean`. Useful when MySQL data gets wedged.

set -euo pipefail

cd "$(dirname "$0")/.."

docker compose -f docker-compose.dev.yml down -v || true
rm -rf node_modules dialer/bin dialer/tmp api/dist workers/dist web/.next || true

echo "[reset] stack stopped, volumes removed, artifacts cleaned."
