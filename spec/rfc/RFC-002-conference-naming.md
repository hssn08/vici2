# RFC-002 — Conference Naming Convention

| Field | Value |
|---|---|
| Status | ACCEPTED |
| Date | 2026-05-06 |
| Decided by | orchestrator |
| Affects | SPEC.md §4.4, T03, F03, T01, A02, E04, S02 |

## Decision

Conference name format: `agent_t<tenant_id>_u<user_id>@default`

Example: `agent_t1_u1042@default`

## Why

T03 RESEARCH §10 surfaced a BLOCKING conflict between three sources:

1. **SPEC.md §4.4** + **T03.md spec**: `conference_<user_id>@default`
2. **F03 PLAN §5** (already shipped, frozen): `agent_*@default` glob in conference profile
3. **T03 RESEARCH §10 recommendation**: `agent_t<tid>_u<uid>@default` for multi-tenant forward-compat

Constraints:
- F03 PLAN cannot regress to `conference_*` without breaking the conference profile already designed
- The `agent_<uid>` form (no tenant prefix) creates collision risk in Phase 4 multi-tenant when user_id is no longer globally unique
- Adding `_t<tid>_u<uid>` is a Phase-1 no-op (always `t1_`) with zero migration cost when multi-tenant arrives

T03's recommendation reconciles all three.

## How to apply

- **Single source of truth helper:**
  - Go: `func ConferenceName(tenantID, userID int64) string` in `dialer/internal/conference/name.go`
  - TS: `confName(tenantID: number, userID: number): string` in `shared/types/src/conference.ts`
- **Lint guards** (CI-blocking):
  - `golangci-lint` custom check forbids `"agent_"` string literal in conference contexts
  - ESLint custom rule equivalent for TS code
- **F03 dialplan stub** uses `${vici2_tenant_id}` channel var + capture group from extension pattern to derive name on the FS side
- **SPEC.md §4.4** to be updated in a follow-up commit to reflect the new format

## Affected modules

| Module | Change |
|---|---|
| T03 (agent conference) | Implements helper + uses it for all conference operations |
| F03 (FS config) | Dialplan extracts (tid, uid) from extension; profile glob `agent_*` already covers it |
| T01 (ESL bridge) | `ConferenceCommand` accepts conference name from helper |
| A02 (SIP.js) | Outbound INVITE target uses helper-derived name (T03 PLAN finalizes) |
| E04 (picker) | References conference name when transferring customer in |
| S02 (eavesdrop) | Supervisor whisper joins agent's conf using helper |

## Phase-1 single-tenant behavior

`tenant_id` is always `1`, so all conferences are named `agent_t1_u<uid>@default` in Phase 1. No code path branches on tenant count.
