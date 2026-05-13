#!/usr/bin/env bash
# scripts/ci/cardinality-lint.sh
# Source: spec/modules/O01/PLAN.md §5.3.
#
# Greps Go/TS sources for prometheus client registrations and fails the
# build if any metric uses a label from the FORBIDDEN_LABELS list.
# This is the front-line defense against cardinality runaway.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

# Forbidden label names. Per-call-uuid / per-agent-id / etc would blow up
# Prometheus active-series count and slow PromQL to a crawl.
FORBIDDEN=(
  call_uuid
  b_leg_uuid
  session_uuid
  session_id
  agent_id
  user_id
  lead_id
  phone_number
  caller_id
  dnis
  request_id
  trace_id
  email
  ip_address
)

# Files that could register metrics (Go client_golang, Node prom-client).
mapfile -t TARGETS < <(
  find api dialer workers shared web \
    \( -name '*.go' -o -name '*.ts' -o -name '*.tsx' \) \
    -not -path '*/node_modules/*' \
    -not -path '*/dist/*' \
    -not -path '*/.next/*' \
    2>/dev/null || true
)

if [ "${#TARGETS[@]}" -eq 0 ]; then
  echo "cardinality-lint: no source files to scan"
  exit 0
fi

FAIL=0
for label in "${FORBIDDEN[@]}"; do
  # We look for the label inside a metric registration. The pattern is
  # intentionally permissive: any line that quotes the label *and* sits
  # within a metric definition would trigger. False positives are flagged
  # for human review.
  hits=$(grep -nE "\"$label\"|'$label'" "${TARGETS[@]}" 2>/dev/null | \
         grep -iE 'prometheus\.New|new (Counter|Gauge|Histogram|Summary)|labelnames|register' || true)
  if [ -n "$hits" ]; then
    echo "FAIL: forbidden cardinality label '$label' appears in:"
    echo "$hits" | sed 's/^/  /'
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo ""
  echo "cardinality-lint: forbidden label(s) found. See spec/modules/O01/PLAN.md §5."
  echo "If you genuinely need a new label, file an RFC against PLAN §5.2."
  exit 1
fi

echo "cardinality-lint: OK (${#TARGETS[@]} files scanned, 0 forbidden labels)"
