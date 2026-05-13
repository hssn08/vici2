# E06 — Channel + Conference Janitor — HANDOFF

**Module:** E06
**Status:** IMPLEMENTED
**Date:** 2026-05-13
**Commit:** feat(E06): implement channel + conference janitor

---

## Sweep Semantics

| Sweep | Threshold | Action | Safety Guard |
|-------|-----------|--------|--------------|
| Stuck channels | `call_log.call_ended IS NULL` AND `call_started > 4h ago` | ESL `uuid_kill` (cause=NORMAL_CLEARING) + DB `call_ended=NOW()`, `status='JANITOR'` | LIMIT 100/tick; `call_ended IS NULL` double-check on UPDATE |
| Stale conferences | FS conference empty for > 5min | ESL `conference <name> kick all` | NEVER kill `agent_t<tid>_u<uid>*` (regex guard `^agent_t\d+_u\d+(_hold)?$`) |
| Orphan locks | `in_flight` HASH entries > 5min old; `originate_audit` OTHER rows > 5min | Delegates to `picker.Janitor.SweepOrphans()` and `originate.Service.SweepOrphans()` | TTL-based self-healing on `lead_lock` keys |

## Alert Thresholds

See `prometheus/rules/janitor.yml`. Alerts fire when kill rates exceed:
- Stuck channels: >3/min for 2min → `warn`
- Stale conferences: >1/min for 5min → `warn`
- Orphan locks: >5/min for 5min → `warn`
- Sweep duration p95 >5s for 10min → `info`

High kill counts are anomaly indicators — they mean something upstream
(T04, ESL, conference lifecycle) is misbehaving.

## Implementation Notes

- Leader election: `SETNX t:<tid>:janitor:lock <podID> 90s` — only one pod sweeps
- TickDuration histogram only recorded on the leader pod (per PLAN spec)
- Empty-since tracking: `t:<tid>:janitor:empty_confs` HASH (JanitorEmptyConfs key)
- Agent home conf safety: `isAgentHomeConf()` checked at two points in sweep —
  during initial conference list processing AND when iterating the empty-since HASH
- UUIDKill uses existing `esl.Client.UUIDKill(ctx, fsHost, uuid, "NORMAL_CLEARING")`
- ListAllConferences uses `conference json_list` ESL command (no conf name = all)

## Key Files

- `dialer/internal/janitor/janitor.go` — main loop, leader election, Config/New
- `dialer/internal/janitor/stuck_channels.go` — DB + ESL channel kill
- `dialer/internal/janitor/stale_confs.go` — conference sweep with agent-home guard
- `dialer/internal/janitor/orphan_locks.go` — lock orphan delegation
- `dialer/internal/janitor/metrics.go` — Prometheus metric registration
- `dialer/internal/janitor/janitor_test.go` — 8 unit tests (all passing)
- `dialer/internal/esl/uuid_commands.go` — ShowChannelUUIDs() addition
- `dialer/internal/esl/conference.go` — ListAllConferences(), parseAllConferences(),
  ConferenceSummary additions
- `dialer/internal/valkey/keys.go` — JanitorEmptyConfs() key added
- `prometheus/rules/janitor.yml` — 4 Prometheus alert rules

## How to Wire into Dialer main.go

```go
jCfg := janitor.Config{
    TenantID:      tenantID,
    PodID:         podID,
    DB:            db,
    Rdb:           rdb,
    ESL:           eslClient,
    FSHost:        cfg.FSHost,
    Keys:          valkey.NewKeys(tenantID),
    AuditWriter:   auditWriter,
    PickerJanitor: pickerJanitor,
    OriginateJan:  originateSvc,
    Metrics:       janitor.NewMetrics(prometheus.DefaultRegisterer),
    Log:           slog.Default().With("component", "janitor"),
}
g.Go(func() error {
    return janitor.New(jCfg).Run(gCtx)
})
```

Note: dialer/cmd/dialer/main.go is still a Phase 1 stub without DB/ESL/audit
wiring. The janitor can be added when those dependencies are wired in.

## How to Extend with New Sweeps

1. Add a new method on `*Janitor` in `dialer/internal/janitor/`.
2. Call it from `sweep()` after the existing three.
3. Add a counter metric in `metrics.go`.
4. Add a Prometheus alert rule in `prometheus/rules/janitor.yml`.
5. Add unit tests with the mock patterns established in `janitor_test.go`.

## Pre-existing Test Failure (Not E06)

`dialer/internal/valkey/keys_test.go` has a pre-existing failure:
`k.AdaptLock(42)` test expects `"t:1:adapt:lock:42"` but keys.go
generates `"t:1:adapt:lock:{42}"`. This was failing before E06 and is
not related to E06's changes.
