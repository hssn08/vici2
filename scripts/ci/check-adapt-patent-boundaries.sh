#!/usr/bin/env bash
# check-adapt-patent-boundaries.sh — E03 PLAN §7.2, §15.5 (FROZEN CI enforcement)
#
# Patent-defense static-analysis assertions for dialer/internal/adapt/.
# Runs in the same CI stage as go vet. Failure blocks merge.
#
# US8681955B1 (Noble Systems) mitigations — permanently prohibited in adapt/:
# 1. No speech analytics feedback.
# 2. No dynamic setpoint adjustment (we adjust actuator, not target).
# 3. Prior-art citation in every source file.
# 4. No ML library imports.
#
# E03 is a clean-room Go port of Vicidial AST_VDadapt.pl (public GPL source,
# in source control since at least 2008 per inktel/Vicidial git history).

set -euo pipefail

ADAPT_DIR="${1:-dialer/internal/adapt}"
FAIL=0

red()   { printf '\033[0;31m%s\033[0m\n' "$*"; }
green() { printf '\033[0;32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[0;33mWARN: %s\033[0m\n' "$*"; }

echo "=== E03 patent-defense boundary check ==="
echo "  Directory: $ADAPT_DIR"

# ------------------------------------------------------------------
# Rule 1: No speech/sentiment/NLP files.
# ------------------------------------------------------------------
SPEECH_FILES=$(find "$ADAPT_DIR" -name '*.go' \
  \( -name '*speech*' -o -name '*sentiment*' -o -name '*nlp*' \) 2>/dev/null || true)
if [[ -n "$SPEECH_FILES" ]]; then
  red "FAIL: Speech/sentiment/NLP files found (US8681955B1 prohibition):"
  echo "$SPEECH_FILES"
  FAIL=1
else
  green "OK: No speech/sentiment/NLP files."
fi

# ------------------------------------------------------------------
# Rule 2: No setpoint-adjustment exported symbols.
# ------------------------------------------------------------------
SETPOINT_SYMS=$(grep -rn --include='*.go' \
  -E '(TargetAdjust|SetpointUpdate|UpdateTarget|AdjustSetpoint)' \
  "$ADAPT_DIR" 2>/dev/null || true)
if [[ -n "$SETPOINT_SYMS" ]]; then
  red "FAIL: Setpoint-adjustment symbol detected (US8681955B1 prohibition):"
  echo "$SETPOINT_SYMS"
  FAIL=1
else
  green "OK: No setpoint-adjustment symbols."
fi

# ------------------------------------------------------------------
# Rule 3: Every .go file must contain the prior-art header comment.
# ------------------------------------------------------------------
REQUIRED_COMMENT="E03 is a clean-room Go port of Vicidial AST_VDadapt.pl"
MISSING_HEADER=""
while IFS= read -r -d '' f; do
  if ! grep -qF "$REQUIRED_COMMENT" "$f"; then
    MISSING_HEADER="$MISSING_HEADER $f"
  fi
done < <(find "$ADAPT_DIR" -name '*.go' -not -name '*_test.go' -print0)

if [[ -n "$MISSING_HEADER" ]]; then
  red "FAIL: Missing prior-art header in production files (US8681955B1 defense):"
  for f in $MISSING_HEADER; do echo "  $f"; done
  FAIL=1
else
  green "OK: Prior-art header present in all production files."
fi

# ------------------------------------------------------------------
# Rule 4: No ML library imports.
# ------------------------------------------------------------------
ML_BLACKLIST=(tensorflow onnx gorgonia golearn "ml.go" "golang-mlpack")
ML_FOUND=""
for lib in "${ML_BLACKLIST[@]}"; do
  hits=$(grep -rn --include='*.go' "\".*${lib}.*\"" "$ADAPT_DIR" 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    ML_FOUND="$ML_FOUND\n  $lib:\n$hits"
  fi
done
if [[ -n "$ML_FOUND" ]]; then
  red "FAIL: ML library import detected (US8681955B1 prohibition):"
  printf "%b\n" "$ML_FOUND"
  FAIL=1
else
  green "OK: No ML library imports."
fi

# ------------------------------------------------------------------
# Rule 5: No Phase 4 differential target usage (reserved column warning).
# ------------------------------------------------------------------
DIFF_TARGET=$(grep -rn --include='*.go' \
  -E 'DlDiffTarget|dl_diff_target|AdaptiveDlDiff' \
  "$ADAPT_DIR" 2>/dev/null | grep -v 'ignores\|reserved\|Phase 3\|Phase 4' || true)
if [[ -n "$DIFF_TARGET" ]]; then
  warn "adaptive_dl_diff_target referenced in production adapt/ code (Phase 3 only):"
  echo "$DIFF_TARGET"
  # Not a hard failure — just a warning to review.
fi

# ------------------------------------------------------------------
# Summary
# ------------------------------------------------------------------
echo ""
if [[ $FAIL -eq 0 ]]; then
  green "=== ALL PATENT BOUNDARY CHECKS PASSED ==="
  exit 0
else
  red "=== PATENT BOUNDARY CHECK FAILED (${FAIL} violation(s)) ==="
  echo "See E03 PLAN §7.2 for mitigations. Legal review required before go-live."
  exit 1
fi
