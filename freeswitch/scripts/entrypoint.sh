#!/usr/bin/env bash
# vici2 FreeSWITCH container entrypoint — F03 PLAN §12.
# Responsibilities:
#   1. Apply ulimits (stack 240 KB mitigates Artoo R2D2 thread wall, RESEARCH §9.1).
#   2. Env-substitute *.tmpl files inside /etc/freeswitch.
#   3. exec the freeswitch binary with whatever CMD was passed.
set -euo pipefail

# --- 1. ulimits ---------------------------------------------------------------
# Some Docker setups don't honor compose `ulimits:`; set them here too. The
# stack ulimit is the single biggest contributor to total thread headroom on
# FreeSWITCH's Artoo (~1796-thread) wall.
ulimit -s 240         2>/dev/null || true
ulimit -n 1048576     2>/dev/null || true
ulimit -u 65535       2>/dev/null || true

# --- 2. envsubst *.tmpl -------------------------------------------------------
# Only files explicitly suffixed .tmpl get rendered. The output overwrites the
# .tmpl-stripped name (so vars.xml.tmpl -> vars.xml). FS-internal $${var} is
# left alone by envsubst because envsubst only touches ${VAR} forms.
shopt -s globstar nullglob
for tmpl in /etc/freeswitch/**/*.tmpl; do
  out="${tmpl%.tmpl}"
  envsubst < "$tmpl" > "$out"
done
shopt -u globstar nullglob

# --- 3. exec ------------------------------------------------------------------
exec "$@"
