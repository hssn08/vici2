#!/usr/bin/env bash
# D04 — CI: validate system-statuses.json seed file.
#
# Asserts:
#   1. Exactly 35 rows in db/seeds/system-statuses.json
#   2. Every row has a non-null systemOwner
#   3. category='system-compliance' rows have systemOwner IN (T04,T01,E05,E01)
#   4. category='agent-outcome' rows have systemOwner = '__AGT__'
#   5. All status codes match regex ^[A-Z][A-Z0-9_-]{0,7}$  (except GATEWAY_LIMIT_TRY_LATER which is 24 chars — regex updated)
#   6. Hotkey values are unique per-campaign across rows with non-null hotkey
#
# Note: GATEWAY_LIMIT_TRY_LATER is 24 chars (widened from VARCHAR(8) per D04 amendment).
# The status code regex below allows up to 24 chars.

set -euo pipefail

SEED_FILE="$(git rev-parse --show-toplevel)/db/seeds/system-statuses.json"

if [[ ! -f "$SEED_FILE" ]]; then
  echo "ERROR: $SEED_FILE not found" >&2
  exit 1
fi

echo "[check-status-seed] checking $SEED_FILE"

# ── Assertion 1: exactly 35 rows ───────────────────────────────────────────────
ROW_COUNT=$(python3 -c "import json,sys; data=json.load(open('$SEED_FILE')); print(len(data))")
if [[ "$ROW_COUNT" -ne 35 ]]; then
  echo "ERROR: expected 35 rows in system-statuses.json, got $ROW_COUNT" >&2
  exit 1
fi
echo "[check-status-seed] ✓ row count = $ROW_COUNT"

# ── Assertion 2: every row has non-null systemOwner ───────────────────────────
NULL_OWNER=$(python3 -c "
import json, sys
data = json.load(open('$SEED_FILE'))
missing = [r['status'] for r in data if not r.get('systemOwner')]
if missing:
    print(' '.join(missing))
")
if [[ -n "$NULL_OWNER" ]]; then
  echo "ERROR: rows with null/missing systemOwner: $NULL_OWNER" >&2
  exit 1
fi
echo "[check-status-seed] ✓ all rows have systemOwner"

# ── Assertion 3: system-compliance rows have valid systemOwner ─────────────────
COMPLIANCE_BAD=$(python3 -c "
import json
data = json.load(open('$SEED_FILE'))
valid = {'T04', 'T01', 'E05', 'E01'}
bad = [r['status'] for r in data
       if r.get('category') == 'system-compliance'
       and r.get('systemOwner') not in valid]
if bad:
    print(' '.join(bad))
")
if [[ -n "$COMPLIANCE_BAD" ]]; then
  echo "ERROR: system-compliance rows with invalid systemOwner: $COMPLIANCE_BAD" >&2
  echo "       Allowed: T04, T01, E05, E01" >&2
  exit 1
fi
echo "[check-status-seed] ✓ system-compliance systemOwner values valid"

# ── Assertion 4: agent-outcome rows have systemOwner = '__AGT__' ───────────────
AGENT_BAD=$(python3 -c "
import json
data = json.load(open('$SEED_FILE'))
bad = [r['status'] for r in data
       if r.get('category') == 'agent-outcome'
       and r.get('systemOwner') != '__AGT__']
if bad:
    print(' '.join(bad))
")
if [[ -n "$AGENT_BAD" ]]; then
  echo "ERROR: agent-outcome rows with systemOwner != '__AGT__': $AGENT_BAD" >&2
  exit 1
fi
echo "[check-status-seed] ✓ agent-outcome systemOwner = '__AGT__'"

# ── Assertion 5: status code format ───────────────────────────────────────────
# Regex: starts with uppercase letter, followed by 0-23 uppercase letters/digits/-/_
CODE_BAD=$(python3 -c "
import json, re
data = json.load(open('$SEED_FILE'))
# D04 widened status to VARCHAR(24); regex allows codes up to 24 chars
pattern = re.compile(r'^[A-Z][A-Z0-9_-]{0,23}\$')
bad = [r['status'] for r in data if not pattern.match(r['status'])]
if bad:
    print(' '.join(bad))
")
if [[ -n "$CODE_BAD" ]]; then
  echo "ERROR: status codes with invalid format: $CODE_BAD" >&2
  exit 1
fi
echo "[check-status-seed] ✓ all status codes match format"

# ── Assertion 6: hotkey uniqueness ────────────────────────────────────────────
HOTKEY_DUP=$(python3 -c "
import json
from collections import Counter
data = json.load(open('$SEED_FILE'))
hotkeys = [r['hotkey'] for r in data if r.get('hotkey') is not None]
counts = Counter(hotkeys)
dups = [k for k, v in counts.items() if v > 1]
if dups:
    print(' '.join(dups))
")
if [[ -n "$HOTKEY_DUP" ]]; then
  echo "ERROR: duplicate hotkeys in system-statuses.json: $HOTKEY_DUP" >&2
  exit 1
fi
echo "[check-status-seed] ✓ hotkeys are unique"

echo "[check-status-seed] all assertions passed"
