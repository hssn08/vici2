#!/usr/bin/env bash
# vici2 dev helper — boots just the freeswitch service (and its deps) via
# docker compose and tails logs. Intended for fast iteration on FS-only changes.
set -euo pipefail
cd "$(dirname "$0")/../.."
docker compose -f docker-compose.dev.yml up -d freeswitch
exec docker compose -f docker-compose.dev.yml logs -f freeswitch
