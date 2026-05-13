#!/usr/bin/env bash
# scripts/ci/check-pr-body.sh
#
# Verifies the PR description follows the template in
# .github/PULL_REQUEST_TEMPLATE.md, specifically that:
#   1. A "## Module" header exists.
#   2. The next non-empty, non-comment line starts with a module ID matching
#      ^[A-Z][0-9]{2}\b and that ID corresponds to a real spec file in
#      spec/modules/.
#   3. The body contains the "## Test plan" and "## Compliance impact" headers.
#
# Reads PR body from $PR_BODY (set by the workflow step).
# Exits 0 on success, non-zero on failure with a clear message.

set -euo pipefail

PR_BODY="${PR_BODY:-}"

if [ -z "${PR_BODY}" ]; then
  echo "::error::PR_BODY env var is empty — cannot verify PR description."
  exit 1
fi

# Write body to a temp file so we can grep with line numbers.
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
printf '%s\n' "$PR_BODY" > "$tmp"

fail() {
  echo "::error::$*"
  echo ""
  echo "Open .github/PULL_REQUEST_TEMPLATE.md, fill it in, and re-push."
  exit 1
}

# 1. ## Module header present
if ! grep -qE '^## Module([[:space:]]*$|[[:space:]])' "$tmp"; then
  fail "PR body missing required '## Module' header."
fi

# 2. Module ID after the header
#    Find the line after "## Module" that isn't blank, isn't an HTML comment.
module_line=$(awk '
  /^## Module/ { found=1; next }
  found {
    # skip blank
    if ($0 ~ /^[[:space:]]*$/) next
    # skip HTML comments
    if ($0 ~ /^[[:space:]]*<!--/) next
    print
    exit
  }
' "$tmp")

if [ -z "$module_line" ]; then
  fail "PR body has '## Module' header but no module ID on the next non-empty line."
fi

# Extract module ID (allow leading whitespace, allow dash/em-dash + name after)
module_id=$(printf '%s' "$module_line" | sed -nE 's/^[[:space:]]*([A-Z][0-9]{2})\b.*$/\1/p')

if [ -z "$module_id" ]; then
  fail "PR body 'Module' line must start with a module ID like 'F01', 'O04', 'T02'. Got: '$module_line'"
fi

# Verify the spec file exists. Either spec/modules/<id>.md OR spec/modules/<id>/
# (some modules use directories with PLAN/RESEARCH/etc inside).
if [ ! -f "spec/modules/${module_id}.md" ] && [ ! -d "spec/modules/${module_id}" ]; then
  fail "Module ID '${module_id}' has no matching spec file (looked for spec/modules/${module_id}.md and spec/modules/${module_id}/)"
fi

# 3. Required headers
for hdr in "## Test plan" "## Compliance impact"; do
  if ! grep -qE "^${hdr}([[:space:]]*$|[[:space:]])" "$tmp"; then
    fail "PR body missing required '${hdr}' header."
  fi
done

echo "PR body OK — module=${module_id}"
