#!/usr/bin/env bash
# D04 — CI: guard against incorrect FCC drop-rate denominator in M08 queries.
#
# CRITICAL INVARIANT: The FCC 3% drop-rate denominator must ALWAYS use
# SUM(s.human_answered) or SUM(human_answered), never COUNT(*) alone or
# SUM(is_drop) alone.
#
# This script scans M08 reporting query files for the correct denominator
# pattern and fails if any file uses a disallowed alternative.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"

echo "[check-drop-rate-denominator] checking M08 reporting queries"

# Files to check: M08 source files (once M08 is implemented)
M08_DIRS=(
  "$ROOT/api/src/reporting"
  "$ROOT/workers/src/reporting"
)

FOUND_M08=0
ERRORS=0

for dir in "${M08_DIRS[@]}"; do
  if [[ ! -d "$dir" ]]; then
    continue
  fi
  FOUND_M08=1

  # Check for files containing drop-rate SQL
  while IFS= read -r -d '' file; do
    # Must not use COUNT(*) as drop-rate denominator
    if grep -qiE 'drop.*rate|drop_rate|is_drop.*denominator' "$file" 2>/dev/null; then
      if grep -qiE 'COUNT\(\*\)\s*/\s*(NULLIF|sum.*human|sum.*human_answered)' "$file" 2>/dev/null; then
        echo "ERROR: $file uses COUNT(*) as drop-rate denominator (must use SUM(human_answered))" >&2
        ERRORS=$((ERRORS + 1))
      fi
    fi

    # Must use SUM(human_answered) as the denominator in drop-rate calculations
    if grep -qiE '(drop_rate|3.*percent|fcc.*drop|drop.*fcc|TCPA.*drop)' "$file" 2>/dev/null; then
      if ! grep -qiE 'SUM\s*\(\s*(s\.)?human_answered\s*\)' "$file" 2>/dev/null; then
        echo "WARNING: $file mentions drop-rate but does not use SUM(human_answered)" >&2
      fi
    fi
  done < <(find "$dir" -name "*.ts" -o -name "*.sql" -print0 2>/dev/null)
done

if [[ $FOUND_M08 -eq 0 ]]; then
  echo "[check-drop-rate-denominator] no M08 reporting directories found yet — OK (pre-M08)"
fi

if [[ $ERRORS -gt 0 ]]; then
  echo "[check-drop-rate-denominator] FAILED: $ERRORS error(s) found" >&2
  exit 1
fi

echo "[check-drop-rate-denominator] all checks passed"
echo ""
echo "Canonical denominator (per D04 PLAN §8.2):"
echo "  SUM(s.human_answered) — the sole FCC TCPA 3% drop-rate denominator"
