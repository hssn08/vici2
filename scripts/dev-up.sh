#!/usr/bin/env bash
# Convenience wrapper around `make dev`. Used by some scripts / docs.

set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "[dev-up] .env not found — copying from .env.example. Set SIGNALWIRE_TOKEN!"
  cp .env.example .env
fi

if [ -z "${SIGNALWIRE_TOKEN:-}" ] && ! grep -q "^SIGNALWIRE_TOKEN=.\+" .env; then
  echo "[dev-up] WARNING: SIGNALWIRE_TOKEN is empty. FreeSWITCH image build will fail." >&2
fi

exec make dev
