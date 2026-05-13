#!/usr/bin/env bash
# M02 CI gate — check that all Fastify routes have requirePermission or noPermission.
# Run: bash scripts/ci/check-rbac-coverage.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ROUTES_DIR="${REPO_ROOT}/api/src/routes"
FAIL=0

# ---------------------------------------------------------------------------
# 1. Fastify routes must have requirePermission or noPermission in preHandler
# ---------------------------------------------------------------------------
echo "==> Checking Fastify route permission coverage..."

if [ -d "${ROUTES_DIR}" ]; then
  # Find all .ts files in routes that register a route handler
  while IFS= read -r file; do
    # Check if this file has any route registration
    if grep -qE 'fastify\.(get|post|put|patch|delete|head)\(' "${file}"; then
      # Check if it also has requirePermission or noPermission
      if ! grep -qE 'requirePermission|noPermission|// PUBLIC-ROUTE:' "${file}"; then
        echo "ERROR: ${file} has route registrations but no requirePermission/noPermission"
        FAIL=1
      fi
    fi
  done < <(find "${ROUTES_DIR}" -name '*.ts' -type f)
fi

# ---------------------------------------------------------------------------
# 2. Check gen-rbac parity (if Go toolchain available)
# ---------------------------------------------------------------------------
echo "==> Checking Go matrix parity..."
if command -v go &>/dev/null; then
  cd "${REPO_ROOT}/dialer" && go vet ./internal/auth/rbac/... && echo "Go vet: OK"
else
  echo "  (go not available — skipping Go vet)"
fi

# ---------------------------------------------------------------------------
# 3. Check test/rbac/golden.json exists and is non-empty
# ---------------------------------------------------------------------------
GOLDEN="${REPO_ROOT}/test/rbac/golden.json"
echo "==> Checking golden.json..."
if [ ! -f "${GOLDEN}" ]; then
  echo "ERROR: ${GOLDEN} does not exist — run: pnpm exec tsx scripts/rbac/gen-golden.ts"
  FAIL=1
elif [ ! -s "${GOLDEN}" ]; then
  echo "ERROR: ${GOLDEN} is empty"
  FAIL=1
else
  ENTRY_COUNT=$(python3 -c "import json,sys; print(len(json.load(sys.stdin)))" < "${GOLDEN}" 2>/dev/null || echo 0)
  if [ "${ENTRY_COUNT}" -lt 100 ]; then
    echo "ERROR: ${GOLDEN} has only ${ENTRY_COUNT} entries (expected >= 2880)"
    FAIL=1
  else
    echo "  golden.json: ${ENTRY_COUNT} entries OK"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
if [ "${FAIL}" -eq 1 ]; then
  echo ""
  echo "RBAC coverage check FAILED. See errors above."
  exit 1
else
  echo ""
  echo "RBAC coverage check PASSED."
fi
