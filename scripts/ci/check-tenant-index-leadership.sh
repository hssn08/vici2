#!/usr/bin/env bash
# =============================================================================
# F02 — tenant_id index-leadership check.
#
# Per F02 PLAN §9 (Multi-tenant rule, PR-blocking):
#   Every multi-column index whose table has a `tenant_id` column MUST list
#   `tenant_id` first. Single-column indexes on `id` PK or natural keys are
#   fine. `phone_codes`, `phone_codes_overrides`, `zip_codes`,
#   `auth_config`, and `_prisma_migrations` are exempt (global reference /
#   single-row / system).
#
# Two layers:
#   1. Static grep against api/prisma/schema.prisma — runs in every CI job
#      (no DB needed).
#   2. INFORMATION_SCHEMA query when DATABASE_URL is set + reachable.
#
# Exit 0 = clean, 1 = violation found.
# =============================================================================
set -euo pipefail

SCHEMA="${SCHEMA:-api/prisma/schema.prisma}"
# Models exempt from tenant_id leadership entirely (no tenant_id column,
# global reference / single-row / system).
#   PhoneCode, PhoneCodeOverride, ZipCode  — global NANP / ZIP reference
#   AuthConfig                             — single-row F05 hook
#   StateHoliday                           — global C01 admin lookup
#   DncSyncConfig, DncSyncLog              — D05 sync state (system-scoped)
EXEMPT_MODELS_REGEX='^(PhoneCode|PhoneCodeOverride|ZipCode|AuthConfig|StateHoliday|DncSyncConfig|DncSyncLog)$'
# Per-(model, index-map-name) exemptions for indexes that legitimately do
# NOT lead with tenant_id. Listed here so any future addition is reviewed.
#   Dnc.idx_dnc_phone_only      — federal-scrub fast path (PLAN §4.14)
#   CallLog.uk_call_log_uuid    — uuid + partition col uniqueness (PLAN §4.24)
#   RecordingLog.uk_recording_log_uuid — same (PLAN §4.26)
#   OriginateAudit.uq_originate_audit_attempt — attempt_uuid global idempotency (T04 §7)
#   OriginateAudit.idx_originate_audit_call_uuid — joins call_log via uuid (T04 §7)
EXEMPT_INDEXES_REGEX='^(idx_dnc_phone_only|uk_call_log_uuid|uk_recording_log_uuid|uq_originate_audit_attempt|idx_originate_audit_call_uuid)$'

if [[ ! -f "$SCHEMA" ]]; then
  echo "[check] schema not found at $SCHEMA — run from repo root" >&2
  exit 1
fi

violations=0

# Walk the schema. Track current model. For every @@index([…]) whose table
# is NOT in EXEMPT_MODELS_REGEX, fail if the first field isn't tenantId.
awk -v exempt="$EXEMPT_MODELS_REGEX" -v exempt_idx="$EXEMPT_INDEXES_REGEX" '
  function flush_model() { in_exempt = 0; current = "" }

  function index_name(line,    n) {
    # Extract `map: "..."` if present, else fall back to "(unnamed)".
    if (match(line, /map:[ \t]*"([^"]+)"/, mm)) return mm[1]
    return "(unnamed)"
  }

  /^model[ \t]+/ {
    n = split($0, parts, /[ \t{]+/)
    current = parts[2]
    in_exempt = (current ~ exempt)
    next
  }
  /^}/ { flush_model(); next }

  in_exempt { next }

  /@@index\(/ {
    if (match($0, /@@index\(\[([^]]+)\]/, m)) {
      cols = m[1]
      n = split(cols, c, /[ ,]+/)
      first = c[1]
      if (first != "tenantId") {
        idx = index_name($0)
        if (idx ~ exempt_idx) next
        printf "[FAIL] %s line %d (model %s, index %s): @@index does not lead with tenantId — first field is %s\n", FILENAME, NR, current, idx, first
        bad++
      }
    }
  }
  /@@unique\(\[/ {
    if (match($0, /@@unique\(\[([^]]+)\]/, m)) {
      cols = m[1]
      n = split(cols, c, /[ ,]+/)
      first = c[1]
      if (n > 1 && first != "tenantId") {
        idx = index_name($0)
        if (idx ~ exempt_idx) next
        printf "[FAIL] %s line %d (model %s, index %s): @@unique does not lead with tenantId — first field is %s\n", FILENAME, NR, current, idx, first
        bad++
      }
    }
  }
  END { exit (bad ? 1 : 0) }
' "$SCHEMA" || violations=$?

if [[ $violations -eq 0 ]]; then
  echo "[check] schema-level: OK"
else
  echo "[check] schema-level: FAILED ($violations violation(s))"
  exit 1
fi

# Optional DB-level cross-check
if [[ -n "${DATABASE_URL:-}" ]] && command -v mysql >/dev/null 2>&1; then
  proto="${DATABASE_URL%%://*}"
  if [[ "$proto" == "mysql" ]]; then
    rest="${DATABASE_URL#mysql://}"
    user="${rest%%:*}"
    rest="${rest#*:}"
    password="${rest%%@*}"
    rest="${rest#*@}"
    host_port="${rest%%/*}"
    host="${host_port%:*}"
    port="${host_port##*:}"
    db_part="${rest#*/}"
    db="${db_part%%\?*}"
    if [[ "$port" == "$host" ]]; then port=3306; fi

    bad_rows=$(MYSQL_PWD="$password" mysql -h"$host" -P"$port" -u"$user" -D"$db" -N -B -e "
      SELECT CONCAT(TABLE_NAME, '.', INDEX_NAME)
      FROM (
        SELECT TABLE_NAME, INDEX_NAME,
               GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols
        FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND INDEX_NAME != 'PRIMARY'
        GROUP BY TABLE_NAME, INDEX_NAME
      ) idx
      WHERE EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS c
        WHERE c.TABLE_SCHEMA = DATABASE()
          AND c.TABLE_NAME = idx.TABLE_NAME
          AND c.COLUMN_NAME = 'tenant_id'
      )
        AND idx.cols NOT LIKE 'tenant_id%'
        AND idx.TABLE_NAME NOT IN ('phone_codes','phone_codes_overrides','zip_codes','auth_config','_prisma_migrations','state_holidays','dnc_sync_config','dnc_sync_log')
        AND CONCAT(idx.TABLE_NAME, '.', idx.INDEX_NAME) NOT IN (
          'dnc.idx_dnc_phone_only',
          'call_log.uk_call_log_uuid',
          'recording_log.uk_recording_log_uuid',
          'originate_audit.uq_originate_audit_attempt',
          'originate_audit.idx_originate_audit_call_uuid'
        )
        AND (LOCATE(',', idx.cols) > 0);
    " 2>/dev/null || echo "")

    if [[ -n "$bad_rows" ]]; then
      echo "[check] DB-level: FAILED — composite indexes not leading with tenant_id:"
      echo "$bad_rows" | sed 's/^/  /'
      exit 1
    fi
    echo "[check] DB-level: OK"
  fi
fi

echo "[check] tenant-id index leadership: PASS"
