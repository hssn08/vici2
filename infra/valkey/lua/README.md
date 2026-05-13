# `infra/valkey/lua/`

Lua scripts ship from `shared/lua/` (single source of truth — see F04
PLAN §6 and §7.5). Both `dialer/internal/valkey` (Go) and
`api/src/lib/valkey` (TS) embed scripts directly from `shared/lua/`
via package-relative paths; no Docker image is shipped with scripts
because they are loaded by application code at boot via `SCRIPT LOAD`
(see F04 PLAN §6.7).

Index of scripts (all under `shared/lua/`):

| File | Owner module | Purpose |
|---|---|---|
| `claim_lead_from_hopper.v1.lua` | F04 | Atomic hopper claim + lead_lock + in_flight HSET |
| `release_hopper_lock.v1.lua`    | F04 | Idempotent hopper release with optional reinsert |
| `record_call_outcome.v1.lua`    | F04 | Atomic drop_window + events stream write + state clear |
| `pick_agent_for_call.v1.lua`    | F04 | Atomic longest-waiting READY agent picker → RESERVED |
| `agent_state_transition.v1.lua` | F04 | CAS agent state with index invariants |
| `originate_acquire.v1.lua`      | F04 (T04) | Gateway-cap + in_flight HSET on originate |
| `originate_release.v1.lua`      | F04 (T04) | Gateway counter decrement + in_flight DEL on hangup |
| `dnc_bloom_check.v1.lua`        | F04 (D05) | Multi-source Bloom prefilter (BF.EXISTS) |
| `refresh_consume.v1.lua`        | F04 (F05) | Atomic refresh-token GETDEL + family reuse-revoke |

Versioning policy (FROZEN by PLAN §6): any change is a new file
(`*.v2.lua`); never edit a deployed version.
