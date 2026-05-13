#!/usr/bin/env bash
# scripts/ci/check-migrations.sh
#
# Per SPEC §3.8 + O04 PLAN §10.1.6: every Prisma migration must ship a sibling
# down.sql so we can reverse a bad change in dev/staging without resorting to
# prisma migrate reset.
#
# Production rollback is forward-fix only (see runbooks/migration-incident.md
# once it exists), but a hand-written down.sql is still required as the dev
# escape hatch and as a documentation artifact.
#
# Walks api/prisma/migrations/*/migration.sql and fails if any sibling
# down.sql is missing.

set -euo pipefail

migrations_dir="api/prisma/migrations"

if [ ! -d "$migrations_dir" ]; then
  echo "::notice::No migrations directory at ${migrations_dir} — skipping."
  exit 0
fi

allowlist_file="${migrations_dir}/.no-down-sql-allowlist"

# Legacy migrations created before this rule was enforced may be grandfathered
# via .no-down-sql-allowlist (one migration-directory basename per line, '#'
# comments allowed). New migrations MUST ship a down.sql.
is_allowlisted() {
  local name="$1"
  [ -f "$allowlist_file" ] || return 1
  grep -qE "^${name}([[:space:]]|#|$)" "$allowlist_file"
}

missing=()
checked=0

while IFS= read -r -d '' upfile; do
  checked=$((checked + 1))
  dir=$(dirname "$upfile")
  base=$(basename "$dir")
  if [ ! -f "${dir}/down.sql" ]; then
    if is_allowlisted "$base"; then
      continue
    fi
    missing+=("$dir")
  fi
done < <(find "$migrations_dir" -name 'migration.sql' -print0)

if [ ${#missing[@]} -gt 0 ]; then
  echo "::error::The following migrations are missing a sibling down.sql:"
  for d in "${missing[@]}"; do
    echo "  - ${d}/down.sql"
  done
  echo ""
  echo "Add a hand-written down.sql to each. See SPEC §3.8 + O04 PLAN §10.1.6."
  exit 1
fi

echo "All ${checked} migrations have a down.sql."
