# E06 — Channel + Conference Janitor — HANDOFF

**Module:** E06
**Status:** PLAN_COMPLETE / NOT_IMPLEMENTED
**Date:** 2026-05-13

---

## Sweep Semantics

| Sweep | Threshold | Action | Safety Guard |
|-------|-----------|--------|--------------|
| Stuck channels | `call_log.call_ended IS NULL` AND `call_started > 4h ago` | ESL `uuid_kill` + DB `call_ended=NOW()`, `status='JANITOR'` | LIMIT 100/tick; `call_ended IS NULL` double-check on UPDATE |
| Stale conferences | FS conference empty for > 5min | ESL `conference <name> kick all` | NEVER kill `agent_t<tid>_u<uid>*` (regex guard) |
| Orphan locks | `in_flight` HASH entries > 5min old; `originate_audit` OTHER rows > 5min | Delegates to `picker.Janitor.SweepOrphans()` and `originate.Service.SweepOrphans()` | TTL-based self-healing on `lead_lock` keys |

## Alert Thresholds

See `prometheus/rules/janitor.yml`. Alerts fire when kill rates exceed:
- Stuck channels: >3/min for 2min → `warn`
- Stale conferences: >1/min for 5min → `warn`
- Orphan locks: >5/min for 5min → `warn`
- Sweep duration p95 >5s for 10min → `info`

High kill counts are anomaly indicators — they mean something upstream
(T04, ESL, conference lifecycle) is misbehaving.

## How to Extend with New Sweeps

1. Add a new method on `*Janitor` in `dialer/internal/janitor/`.
2. Call it from `sweep()` after the existing three.
3. Add a counter metric in `metrics.go`.
4. Add a Prometheus alert rule in `prometheus/rules/janitor.yml`.
5. Add unit tests with the mock patterns established in `janitor_test.go`.

## Key Files

- `dialer/internal/janitor/janitor.go` — main loop, leader election
- `dialer/internal/janitor/stuck_channels.go` — DB + ESL channel kill
- `dialer/internal/janitor/stale_confs.go` — conference sweep
- `dialer/internal/janitor/orphan_locks.go` — lock orphan delegation
- `dialer/internal/valkey/keys.go` — `JanitorLock()`, `JanitorEmptyConfs()`
- `dialer/internal/esl/conference.go` — `ListAllConferences()` addition
- `prometheus/rules/janitor.yml` — alert rules
