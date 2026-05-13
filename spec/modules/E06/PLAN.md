# E06 — Channel + Conference Janitor — PLAN

**Module:** E06
**Branch:** `feat/E06-implement`
**Date:** 2026-05-13
**Status:** PLAN_COMPLETE
**Effort estimate:** 2–3 days
**LOC estimate:** ~900 production + ~400 test

---

## 0. TL;DR

E06 is a 60-second periodic sweep running in the dialer process. A Valkey
`SETNX` leader lock (`t:<tid>:janitor:lock`, TTL=90s) ensures only one
dialer pod sweeps at a time. Three sweep types run in sequence each tick:

1. **Stuck channels** — `call_log` rows open > 4h cross-referenced with FS
   live channels; stale DB rows are closed (`call_ended=NOW()`,
   `status='JANITOR'`), and the FS channel is hung up via ESL.
2. **Stale conferences** — FS conferences empty for > 5 min that are NOT
   an agent home conference (`agent_t<tid>_u<uid>*`) are destroyed via
   `conference <name> kick all`.
3. **Orphaned hopper locks** — delegates to the pre-existing
   `picker.Janitor.SweepOrphans()` and `originate.Service.SweepOrphans()`.

Every kill action is recorded via `audit.Writer.AppendAuditLog()` with
`actor_kind="system"`. Four Prometheus metrics gate O03 alerting when kill
counts exceed thresholds (anomaly indicator).

---

## 1. File Map

```
dialer/internal/janitor/
├── janitor.go           # Janitor struct, Run() loop, leader election
├── stuck_channels.go    # DB query + ESL kill + audit for stuck channels
├── stale_confs.go       # ESL all-conf list + empty detection + kick + audit
├── orphan_locks.go      # Delegates to picker.Janitor + originate.Service
├── metrics.go           # Prometheus metric registration
└── janitor_test.go      # Unit + integration tests
```

---

## 2. Janitor Struct and Run Loop

### 2.1 `janitor.go`

```go
package janitor

// Config holds constructor dependencies for the Janitor.
type Config struct {
    TenantID      int64
    PodID         string              // hostname + PID, used as lock value
    DB            *sql.DB
    Rdb           *redis.Client
    ESL           *esl.Client
    FSHost        string              // primary FS host (Phase 1: single host)
    Keys          valkey.Keys
    AuditWriter   *audit.Writer
    PickerJanitor *picker.Janitor     // SweepOrphans delegation
    OriginateJan  *originate.Service  // SweepOrphans delegation
    Metrics       *Metrics
    Log           *slog.Logger

    // Thresholds (configurable; defaults below apply if zero)
    StuckChannelAge  time.Duration // default: 4h
    StaleConfAge     time.Duration // default: 5min
    MaxKillsPerTick  int           // default: 100 (safety cap)
}

// Janitor runs the periodic E06 sweeps.
type Janitor struct {
    cfg Config
    log *slog.Logger
}

func New(cfg Config) *Janitor { ... }

// Run blocks until ctx is cancelled. Returns ctx.Err().
// Tick interval: 60s.
func (j *Janitor) Run(ctx context.Context) error {
    ticker := time.NewTicker(60 * time.Second)
    defer ticker.Stop()

    // Run one sweep immediately on startup (catches crashes that left state).
    j.sweep(ctx)

    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            j.sweep(ctx)
        }
    }
}

// sweep acquires the leader lock and runs all three sweepers.
func (j *Janitor) sweep(ctx context.Context) {
    start := time.Now()
    defer func() {
        j.cfg.Metrics.TickDuration.Observe(time.Since(start).Seconds())
    }()

    // Leader election: SETNX with 90s TTL.
    lockKey := j.cfg.Keys.JanitorLock()
    acquired, err := j.cfg.Rdb.SetNX(ctx, lockKey, j.cfg.PodID, 90*time.Second).Result()
    if err != nil {
        j.log.Error("janitor: leader lock SETNX", "err", err)
        return
    }
    if !acquired {
        j.log.Debug("janitor: not leader, skipping sweep")
        return
    }
    defer j.cfg.Rdb.Del(ctx, lockKey)

    j.log.Info("janitor: sweep start", "pod", j.cfg.PodID)

    n1, err := j.sweepStuckChannels(ctx)
    if err != nil {
        j.log.Error("janitor: stuck channels sweep", "err", err)
    }

    n2, err := j.sweepStaleConferences(ctx)
    if err != nil {
        j.log.Error("janitor: stale conferences sweep", "err", err)
    }

    n3, err := j.sweepOrphanLocks(ctx)
    if err != nil {
        j.log.Error("janitor: orphan locks sweep", "err", err)
    }

    j.log.Info("janitor: sweep complete",
        "stuck_killed", n1,
        "stale_confs_killed", n2,
        "orphan_locks_cleared", n3,
        "duration_ms", time.Since(start).Milliseconds(),
    )
}
```

### 2.2 Zero-Value Threshold Defaults

Applied in `New()`:
```go
if cfg.StuckChannelAge == 0 {
    cfg.StuckChannelAge = 4 * time.Hour
}
if cfg.StaleConfAge == 0 {
    cfg.StaleConfAge = 5 * time.Minute
}
if cfg.MaxKillsPerTick == 0 {
    cfg.MaxKillsPerTick = 100
}
```

---

## 3. Stuck Channels Sweeper

### 3.1 `stuck_channels.go`

```go
// sweepStuckChannels finds call_log rows open > StuckChannelAge, cross-
// references with live FS channels, closes DB rows not found in FS, and
// hangs up channels still in FS.
func (j *Janitor) sweepStuckChannels(ctx context.Context) (int, error)
```

### 3.2 Algorithm (Step by Step)

**Step 1: Query DB for candidate stuck rows**

```sql
SELECT id, uuid, call_started, user_id, campaign_id
FROM call_log
WHERE tenant_id    = ?
  AND call_ended   IS NULL
  AND call_started < NOW() - INTERVAL ? SECOND
  AND call_started >= NOW() - INTERVAL 35 DAY
ORDER BY call_started ASC
LIMIT ?;
```

Parameters: `tenantID`, `StuckChannelAge.Seconds()`, `MaxKillsPerTick`.

The index `idx_call_log_t_status_started` is on `(tenant_id, status,
call_started)`. Since `call_ended IS NULL` is not indexed, E06 may add a
targeted index in the migration (see §9). For Phase 1 with low call volume
the existing index is sufficient.

**Step 2: Get live FS channels**

```go
liveUUIDs, err := j.getLiveChannelUUIDs(ctx)
```

Where `getLiveChannelUUIDs` calls `api show channels as json` on each host
in `j.cfg.ESL.HealthyHosts()` and unions the UUID sets. This reuses the
`parseShowChannelsJSON` function from `dialer/internal/esl/reconcile.go`
(unexported; E06 calls via a new exported wrapper or duplicates the 10-line
parse function).

**Step 3: Cross-reference and kill**

```go
for _, row := range candidates {
    if liveUUIDs[row.UUID] {
        // Channel still exists in FS — send hangup.
        err := j.cfg.ESL.UUIDKill(ctx, j.cfg.FSHost, row.UUID)
        // Log but don't fail the sweep on ESL error.
    }
    // Whether FS kill succeeded or not: close the DB row.
    // The channel may have already hung up naturally.
    err := j.closeCallLogRow(ctx, row.ID, row.CallStarted)
    if err != nil {
        j.log.Error("janitor: closeCallLogRow", "uuid", row.UUID, "err", err)
        continue
    }
    j.auditChannelKill(ctx, row)
    j.cfg.Metrics.StuckChannelsKilled.Inc()
    killed++
}
```

**Step 4: Close DB row**

```go
func (j *Janitor) closeCallLogRow(ctx context.Context, id int64, callStarted time.Time) error {
    const q = `
        UPDATE call_log
           SET call_ended  = NOW(6),
               status      = 'JANITOR',
               hangup_cause = 'JANITOR_SWEEP',
               updated_at  = NOW(6)
         WHERE id           = ?
           AND call_started = ?    -- partition key for pruning
           AND call_ended   IS NULL`
    _, err := j.cfg.DB.ExecContext(ctx, q, id, callStarted)
    return err
}
```

The `AND call_ended IS NULL` guard prevents double-close in a concurrent tick.
The `call_started` filter ensures the UPDATE hits the correct partition.

**Step 5: ESL UUID hangup**

The ESL client does not yet expose `uuid_kill`. E06 adds to
`dialer/internal/esl/`:

```go
// UUIDKill sends a uuid_kill ESL command to hang up a channel.
func (c *Client) UUIDKill(ctx context.Context, fsHost, uuid string) error {
    _, err := c.command(ctx, fsHost, fmt.Sprintf("api uuid_kill %s", uuid))
    return err
}
```

This calls the existing `command()` (used by `ConferenceCommand` etc.) and is
consistent with the T01 transport surface.

**Step 6: Audit**

```go
func (j *Janitor) auditChannelKill(ctx context.Context, row stuckRow) {
    j.cfg.AuditWriter.AppendAuditLog(ctx, audit.AuditLogRow{
        TenantID:   j.cfg.TenantID,
        ActorKind:  "system",
        Action:     "channel_killed",
        EntityType: "call_log",
        EntityID:   row.UUID,
        AfterJSON: map[string]interface{}{
            "status":      "JANITOR",
            "hangup_cause": "JANITOR_SWEEP",
            "swept_at":    time.Now().UTC().Format(time.RFC3339Nano),
        },
        RequestID: j.sweepTickID,
        UserAgent: "vici2-janitor/1.0",
        Ts:        time.Now().UTC(),
    })
}
```

---

## 4. Stale Conference Sweeper

### 4.1 `stale_confs.go`

```go
// sweepStaleConferences lists all FS conferences, records empty-since
// timestamps in Valkey, and kills those empty for > StaleConfAge that
// are not agent home conferences.
func (j *Janitor) sweepStaleConferences(ctx context.Context) (int, error)
```

### 4.2 Agent Home Conference Safety Guard

```go
// agentConfRE matches both home and hold conferences — NEVER kill.
var agentConfRE = regexp.MustCompile(`^agent_t\d+_u\d+(_hold)?$`)

func isAgentHomeConf(name string) bool {
    return agentConfRE.MatchString(name)
}
```

This regexp is derived from `conference.ConferenceName()` and
`conference.HoldConferenceName()` in
`/root/vici2/dialer/internal/conference/name.go`.

### 4.3 Empty-Since Tracking

The empty-since state is stored in a Valkey HASH so it survives pod restarts:

```
Key: t:<tid>:janitor:empty_confs
Field: <conference_name>
Value: <unix_timestamp_ms_when_first_seen_empty>
```

This key is NOT in `keys.go` yet. E06 adds:

```go
// JanitorEmptyConfs is the HASH tracking when each non-agent conference
// first became empty. Field = conference_name, Value = empty_since_unix_ms.
func (k Keys) JanitorEmptyConfs() string {
    return fmt.Sprintf("t:%d:janitor:empty_confs", k.tid)
}
```

### 4.4 Algorithm

**Step 1: List all conferences from FS**

E06 adds to `dialer/internal/esl/conference.go`:

```go
// ConferenceSummary is returned by ListAllConferences.
type ConferenceSummary struct {
    Name        string
    MemberCount int
}

// ListAllConferences returns a summary of all active conferences on one FS host.
// Uses `api conference json_list` (no conference name = list all).
func (c *Client) ListAllConferences(ctx context.Context, fsHost string) ([]ConferenceSummary, error) {
    reply, err := c.command(ctx, fsHost, "api conference json_list")
    if err != nil {
        return nil, fmt.Errorf("esl ListAllConferences: %w", err)
    }
    return parseAllConferences(reply)
}
```

**Step 2: Update empty-since HASH**

```go
now := time.Now()
emptySinceKey := j.cfg.Keys.JanitorEmptyConfs()

for _, conf := range conferences {
    if isAgentHomeConf(conf.Name) {
        // Agent home conf: remove from empty-since tracking if present.
        j.cfg.Rdb.HDel(ctx, emptySinceKey, conf.Name)
        continue
    }
    if conf.MemberCount > 0 {
        // Not empty: remove from tracking.
        j.cfg.Rdb.HDel(ctx, emptySinceKey, conf.Name)
        continue
    }
    // Empty, non-agent conf: record first-empty time if not already recorded.
    j.cfg.Rdb.HSetNX(ctx, emptySinceKey, conf.Name,
        strconv.FormatInt(now.UnixMilli(), 10))
}
```

**Step 3: Find conferences empty long enough**

```go
allEmpty, _ := j.cfg.Rdb.HGetAll(ctx, emptySinceKey).Result()

for confName, emptyMsStr := range allEmpty {
    emptyMs, _ := strconv.ParseInt(emptyMsStr, 10, 64)
    emptyDuration := now.Sub(time.UnixMilli(emptyMs))

    if emptyDuration < j.cfg.StaleConfAge {
        continue // not yet stale
    }

    // Verify it's still in FS and still empty (re-check to avoid race).
    members, err := j.cfg.ESL.ConferenceList(ctx, j.cfg.FSHost, confName)
    if err != nil || len(members) > 0 {
        j.cfg.Rdb.HDel(ctx, emptySinceKey, confName)
        continue
    }

    // Kill it.
    err = j.cfg.ESL.ConferenceKick(ctx, j.cfg.FSHost, confName, "all")
    if err != nil {
        j.log.Error("janitor: conf kick all", "conf", confName, "err", err)
        continue
    }
    j.cfg.Rdb.HDel(ctx, emptySinceKey, confName)
    j.auditConfKill(ctx, confName, emptyDuration)
    j.cfg.Metrics.StaleConfsKilled.Inc()
    killed++
}
```

**Step 4: Audit**

```go
func (j *Janitor) auditConfKill(ctx context.Context, confName string, emptyFor time.Duration) {
    j.cfg.AuditWriter.AppendAuditLog(ctx, audit.AuditLogRow{
        TenantID:   j.cfg.TenantID,
        ActorKind:  "system",
        Action:     "conference_killed",
        EntityType: "conference",
        EntityID:   confName,
        AfterJSON: map[string]interface{}{
            "empty_for_seconds": int(emptyFor.Seconds()),
            "swept_at":          time.Now().UTC().Format(time.RFC3339Nano),
        },
        RequestID: j.sweepTickID,
        UserAgent: "vici2-janitor/1.0",
        Ts:        time.Now().UTC(),
    })
}
```

---

## 5. Orphan Lock Sweeper

### 5.1 `orphan_locks.go`

```go
// sweepOrphanLocks delegates to picker.Janitor and originate.Service
// to clean up orphaned in_flight HASH entries and originate_audit rows.
func (j *Janitor) sweepOrphanLocks(ctx context.Context) (int, error) {
    n1, err1 := j.cfg.PickerJanitor.SweepOrphans(ctx)
    if err1 != nil {
        j.log.Error("janitor: picker orphans sweep", "err", err1)
    }

    n2, err2 := j.cfg.OriginateJan.SweepOrphans(ctx)
    if err2 != nil {
        j.log.Error("janitor: originate orphans sweep", "err", err2)
    }

    total := n1 + n2
    j.cfg.Metrics.OrphanLocksCleared.Add(float64(total))
    return total, joinErrs(err1, err2)
}
```

`picker.Janitor.SweepOrphans()` is at
`/root/vici2/dialer/internal/picker/janitor.go:49`. It sweeps
`t:<tid>:campaign:{<cid>}:in_flight` HASH entries older than 5 minutes.

`originate.Service.SweepOrphans()` is at
`/root/vici2/dialer/internal/originate/janitor.go:17`. It sweeps
`originate_audit` rows with `outcome='OTHER'` older than 5 minutes.

E06 does NOT add new lock-sweeping logic — it orchestrates existing sweepers
and aggregates their counts into a unified metric.

---

## 6. Metrics

### 6.1 `metrics.go`

```go
package janitor

import "github.com/prometheus/client_golang/prometheus"

// Metrics holds E06 Prometheus collectors.
type Metrics struct {
    StuckChannelsKilled  prometheus.Counter
    StaleConfsKilled     prometheus.Counter
    OrphanLocksCleared   prometheus.Counter
    TickDuration         prometheus.Histogram
}

func NewMetrics(reg prometheus.Registerer) *Metrics {
    if reg == nil {
        reg = prometheus.DefaultRegisterer
    }
    m := &Metrics{
        StuckChannelsKilled: prometheus.NewCounter(prometheus.CounterOpts{
            Name: "vici2_janitor_stuck_channels_killed_total",
            Help: "Total call_log rows closed by the janitor sweeper.",
        }),
        StaleConfsKilled: prometheus.NewCounter(prometheus.CounterOpts{
            Name: "vici2_janitor_stale_confs_killed_total",
            Help: "Total FreeSWITCH conferences destroyed by the janitor sweeper.",
        }),
        OrphanLocksCleared: prometheus.NewCounter(prometheus.CounterOpts{
            Name: "vici2_janitor_orphan_locks_cleared_total",
            Help: "Total orphaned in_flight HASH entries and originate_audit rows reaped.",
        }),
        TickDuration: prometheus.NewHistogram(prometheus.HistogramOpts{
            Name:    "vici2_janitor_tick_duration_seconds",
            Help:    "Duration of each janitor sweep tick (leader pod only).",
            Buckets: []float64{0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0},
        }),
    }
    reg.MustRegister(
        m.StuckChannelsKilled,
        m.StaleConfsKilled,
        m.OrphanLocksCleared,
        m.TickDuration,
    )
    return m
}
```

### 6.2 Prometheus Alert Rules

`prometheus/rules/janitor.yml`:

```yaml
groups:
  - name: janitor
    rules:
      - alert: JanitorHighStuckChannelRate
        expr: rate(vici2_janitor_stuck_channels_killed_total[5m]) > 3
        for: 2m
        labels:
          severity: warn
        annotations:
          summary: "Janitor killing >3 stuck channels/min — possible upstream bug in T04/ESL"
          runbook: "https://wiki.vici2.io/runbooks/janitor-stuck-channels"

      - alert: JanitorHighStaleConfRate
        expr: rate(vici2_janitor_stale_confs_killed_total[5m]) > 1
        for: 5m
        labels:
          severity: warn
        annotations:
          summary: "Janitor killing >1 stale conference/min — conference lifecycle bug"
          runbook: "https://wiki.vici2.io/runbooks/janitor-stale-confs"

      - alert: JanitorHighOrphanLockRate
        expr: rate(vici2_janitor_orphan_locks_cleared_total[5m]) > 5
        for: 5m
        labels:
          severity: warn
        annotations:
          summary: "Janitor clearing >5 orphan locks/min — picker pod crash pattern?"
          runbook: "https://wiki.vici2.io/runbooks/janitor-orphan-locks"

      - alert: JanitorTickSlow
        expr: histogram_quantile(0.95, rate(vici2_janitor_tick_duration_seconds_bucket[10m])) > 5
        for: 10m
        labels:
          severity: info
        annotations:
          summary: "Janitor sweep p95 > 5s — ESL or DB latency spike"
```

---

## 7. Valkey Key Addition

### 7.1 New Key in `dialer/internal/valkey/keys.go`

Append after the existing `JanitorLock()` definition (line 132):

```go
// JanitorEmptyConfs is the HASH tracking when each non-agent conference
// first became empty (for stale conference detection).
// Field = conference_name, Value = empty_since_unix_ms (decimal string).
// No TTL — fields are deleted when the conference is killed or recovers.
// E06 PLAN §4.3.
func (k Keys) JanitorEmptyConfs() string {
    return fmt.Sprintf("t:%d:janitor:empty_confs", k.tid)
}
```

---

## 8. ESL Additions

### 8.1 `UUIDKill` in `dialer/internal/esl/`

Add to `dialer/internal/esl/originate.go` (or a new `uuid_commands.go`):

```go
// UUIDKill sends uuid_kill to hang up a channel by UUID.
// Returns nil if the channel does not exist (idempotent).
// T01 PLAN §8 (general ESL surface).
func (c *Client) UUIDKill(ctx context.Context, fsHost, uuid string) error {
    if c.isShuttingDown() {
        return ErrShuttingDown
    }
    reply, err := c.command(ctx, fsHost, fmt.Sprintf("api uuid_kill %s", uuid))
    if err != nil {
        return fmt.Errorf("esl UUIDKill %s: %w", uuid, err)
    }
    // FS returns "+OK" on success or "-ERR no such channel" if already gone.
    if strings.HasPrefix(reply, "-ERR") && !strings.Contains(reply, "no such channel") {
        return fmt.Errorf("esl UUIDKill %s: %s", uuid, reply)
    }
    return nil
}
```

### 8.2 `ListAllConferences` in `dialer/internal/esl/conference.go`

```go
// ConferenceSummary represents one conference in the all-conferences list.
type ConferenceSummary struct {
    Name        string
    MemberCount int
}

// ListAllConferences returns all active conferences on an FS host.
// Uses `api conference json_list` (no conference name = list all).
// T01 PLAN §8.1.
func (c *Client) ListAllConferences(ctx context.Context, fsHost string) ([]ConferenceSummary, error) {
    if c.isShuttingDown() {
        return nil, ErrShuttingDown
    }
    reply, err := c.command(ctx, fsHost, "api conference json_list")
    if err != nil {
        return nil, fmt.Errorf("esl ListAllConferences: %w", err)
    }
    return parseAllConferences(reply)
}

// parseAllConferences parses the JSON array returned by `conference json_list`.
func parseAllConferences(reply string) ([]ConferenceSummary, error) {
    reply = strings.TrimSpace(reply)
    if reply == "" || reply == "+OK" || !strings.HasPrefix(reply, "[") {
        return nil, nil
    }
    var raw []struct {
        Name    string `json:"conference_name"`
        Members []struct{} `json:"members"`
    }
    if err := json.Unmarshal([]byte(reply), &raw); err != nil {
        return nil, fmt.Errorf("parseAllConferences: %w", err)
    }
    out := make([]ConferenceSummary, 0, len(raw))
    for _, r := range raw {
        out = append(out, ConferenceSummary{
            Name:        r.Name,
            MemberCount: len(r.Members),
        })
    }
    return out, nil
}
```

---

## 9. Database Index (Optional)

The stuck-channel query filters on `(tenant_id, call_ended IS NULL,
call_started)`. The existing index `idx_call_log_t_status_started` covers
`(tenant_id, status, call_started)`. Since `status` is not filtered (it's
`NULL` for open rows), a targeted index would help:

```sql
-- Optional: add in E06 migration if query plan shows full scan.
ALTER TABLE call_log
    ADD INDEX idx_call_log_open_started (tenant_id, call_ended, call_started)
    COMMENT 'E06 stuck-channel sweeper';
```

This is OPTIONAL for Phase 1 (low volume). The migration file is
`api/prisma/migrations/<date>_e06_janitor_index/migration.sql`.

---

## 10. Wiring into the Dialer Process

E06's `Janitor` is wired into the dialer's main `run()` function as a
background goroutine, following the same pattern as other loops
(e.g., `queue.Janitor.Run(ctx)` in `dialer/internal/queue/janitor.go`).

```go
// In dialer cmd/dialer/main.go or equivalent:
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

The `g` is an `errgroup.Group` with the main context. On SIGTERM, the context
is cancelled and `Run()` returns `ctx.Err()`.

---

## 11. Test Plan

### 11.1 `janitor_test.go` — Unit Tests

**Test 1: `TestLeaderElection`**
- Two Janitor instances sharing a fake Redis (miniredis).
- Both call `sweep()` concurrently.
- Assert that exactly one processes the sweep (mock sweepStuckChannels
  increments a counter).
- Assert counter == 1 after both goroutines finish.

**Test 2: `TestStuckChannelSweepPredicates`**
- Mock DB with 5 rows: 2 open > 4h, 1 open < 4h, 1 with call_ended set,
  1 outside 35-day floor.
- Mock ESL `show channels as json` returning an empty channel list.
- Assert exactly 2 DB rows are closed.
- Assert `StuckChannelsKilled` counter == 2.
- Assert audit log called twice.

**Test 3: `TestStuckChannelStillInFS`**
- Same as Test 2 but mock ESL returns the UUID of one stuck channel as live.
- Assert `UUIDKill` is called for that UUID.
- Assert DB row is closed regardless.

**Test 4: `TestAgentHomeConfNeverKilled`** (CRITICAL — acceptance criterion)
- Mock FS returning conferences:
  - `agent_t1_u1042` (0 members, matches agent home pattern)
  - `agent_t1_u1099_hold` (0 members, hold conference)
  - `my_custom_conf` (0 members, non-agent)
- Pre-populate Valkey `janitor:empty_confs` with all three conferences
  at a timestamp 10 minutes ago (well past 5-min threshold).
- Run one sweep.
- Assert `conference kick all` is called ONLY for `my_custom_conf`.
- Assert `agent_t1_u1042` and `agent_t1_u1099_hold` are NEVER killed.
- Assert `StaleConfsKilled` counter == 1.

**Test 5: `TestStaleConfEmptySinceTracking`**
- First sweep: `my_custom_conf` seen empty, `empty_since` written to Valkey.
- Assert `my_custom_conf` is NOT killed (not yet 5 min).
- Advance time mock by 6 minutes.
- Second sweep: assert `my_custom_conf` IS killed.

**Test 6: `TestOrphanLockDelegation`**
- Mock `picker.Janitor.SweepOrphans()` to return (3, nil).
- Mock `originate.Service.SweepOrphans()` to return (2, nil).
- Assert `OrphanLocksCleared` counter increases by 5.

**Test 7: `TestTickDurationMetric`**
- Run `sweep()` with no work to do.
- Assert `TickDuration` histogram has at least 1 observation.

**Test 8: `TestThresholdDefaults`**
- Create Janitor with zero Config thresholds.
- Assert `cfg.StuckChannelAge == 4 * time.Hour`.
- Assert `cfg.StaleConfAge == 5 * time.Minute`.
- Assert `cfg.MaxKillsPerTick == 100`.

### 11.2 Integration Test (Real FS + Real DB)

Integration tests require:
- A live FreeSWITCH instance (or `esl/testutil.FakeFS` with extended responses)
- A MySQL test database with `call_log` table

**Integration Test 1: `TestIntegrationStuckChannel`**

1. INSERT into `call_log` with `call_started = NOW() - INTERVAL 5 HOUR`,
   `call_ended = NULL`.
2. Configure FakeFS to return an empty `show channels as json` response.
3. Run one janitor tick.
4. SELECT the row back and assert `call_ended IS NOT NULL`.
5. Assert `status = 'JANITOR'`.
6. Assert `hangup_cause = 'JANITOR_SWEEP'`.
7. Assert audit_log row exists with `action = 'channel_killed'`.

**Integration Test 2: `TestIntegrationAgentConfProtected`**

1. Configure FakeFS `conference json_list` to return:
   ```json
   [{"conference_name":"agent_t1_u42","members":[]}]
   ```
2. Pre-set `t:1:janitor:empty_confs` HSET `agent_t1_u42` = 10 minutes ago.
3. Run one janitor tick.
4. Assert FakeFS received NO `conference agent_t1_u42 kick all` command.

**Integration Test 3: `TestIntegrationLockPreventsDoubleSweep`**

1. Manually `SETNX t:1:janitor:lock "other-pod" 90`.
2. Run janitor sweep.
3. Assert no DB queries were executed (the sweeper detected non-leader and returned early).

### 11.3 Acceptance Criteria Checklist

- [ ] All three sweep types implemented and tested.
- [ ] `TestAgentHomeConfNeverKilled` PASSES — agent home conferences are
      unconditionally excluded from the stale conf sweeper.
- [ ] Single-instance via Valkey SETNX leader lock — `TestLeaderElection` PASSES.
- [ ] Metrics registered and observable via Prometheus scrape endpoint.
- [ ] Alert rules file committed at `prometheus/rules/janitor.yml`.
- [ ] Audit log entries written for every kill action.
- [ ] `TestIntegrationStuckChannel` PASSES against real MySQL schema.
- [ ] Tick interval is 60s (test mocks tick via channel injection).
- [ ] `MaxKillsPerTick` cap prevents runaway kills on misconfiguration.
- [ ] `StuckChannelAge` default is 4h; `StaleConfAge` default is 5min.
- [ ] `UUIDKill` is idempotent — channels already gone return nil error.
- [ ] `conference kick all` failure is logged but does not abort the sweep.
- [ ] `call_log` UPDATE includes partition-key `call_started` filter.
- [ ] `JanitorEmptyConfs()` key added to `valkey/keys.go`.

---

## 12. Phase Plan

### Phase 1 (Day 1, ~4h) — Core Infrastructure

- [ ] Create `dialer/internal/janitor/` package.
- [ ] Implement `janitor.go`: `Config`, `Janitor`, `Run()`, `sweep()`,
      leader election.
- [ ] Implement `metrics.go`.
- [ ] Add `JanitorEmptyConfs()` to `dialer/internal/valkey/keys.go`.
- [ ] Write `TestLeaderElection`, `TestThresholdDefaults`, `TestTickDurationMetric`.

### Phase 2 (Day 1–2, ~4h) — Stuck Channel Sweeper

- [ ] Implement `stuck_channels.go`.
- [ ] Add `UUIDKill()` to `dialer/internal/esl/originate.go` or new file.
- [ ] Write `TestStuckChannelSweepPredicates`, `TestStuckChannelStillInFS`.
- [ ] Write `TestIntegrationStuckChannel`.

### Phase 3 (Day 2, ~4h) — Stale Conference Sweeper

- [ ] Implement `stale_confs.go`.
- [ ] Add `ConferenceSummary`, `ListAllConferences()`, `parseAllConferences()`
      to `dialer/internal/esl/conference.go`.
- [ ] Write `TestAgentHomeConfNeverKilled`, `TestStaleConfEmptySinceTracking`.
- [ ] Write `TestIntegrationAgentConfProtected`.

### Phase 4 (Day 3, ~3h) — Orphan Locks + Wiring + Alerts

- [ ] Implement `orphan_locks.go`.
- [ ] Write `TestOrphanLockDelegation`.
- [ ] Wire `Janitor` into dialer main process.
- [ ] Commit `prometheus/rules/janitor.yml`.
- [ ] Write `TestIntegrationLockPreventsDoubleSweep`.
- [ ] Optional: migration file for `idx_call_log_open_started`.

### Phase 5 (Day 3, ~1h) — Review + Cleanup

- [ ] `make lint` passes with new files.
- [ ] `make test ./dialer/internal/janitor/...` passes.
- [ ] All acceptance criteria checked.
- [ ] HANDOFF.md written.

---

## 13. LOC Estimate

| File | Estimated LOC |
|------|--------------|
| `janitor/janitor.go` | ~180 |
| `janitor/stuck_channels.go` | ~150 |
| `janitor/stale_confs.go` | ~180 |
| `janitor/orphan_locks.go` | ~60 |
| `janitor/metrics.go` | ~60 |
| `janitor/janitor_test.go` | ~380 |
| `esl/conference.go` additions | ~70 |
| `esl/uuid_commands.go` (new) | ~50 |
| `valkey/keys.go` addition | ~10 |
| `prometheus/rules/janitor.yml` | ~40 |
| **Total** | **~1,180** |

---

## 14. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `conference json_list` not supported on older FS version | Low | Medium | Add FS version check at startup; fall back to text `conference list` parse |
| Clock skew between DB server and dialer pod causing premature kills | Low | High | Add 60-second grace period to StuckChannelAge threshold in prod; use FS `created_epoch` where possible |
| High-volume environments (>10k open call_log rows) making query slow | Medium | Low | `LIMIT 100` cap + optional index migration |
| Janitor kills a channel that was bridged but not yet DB-committed | Low | High | `AND call_ended IS NULL` double-check prevents double-close; `uuid_kill` is sent regardless but results in a short-duration ghost channel |
| `picker.Janitor.SweepOrphans` and E06 running in same pod causing double-sweep | None | N/A | E06 calls picker.Janitor directly (synchronous delegation, not a separate goroutine) |

---

## 15. Dependencies and Non-Blocking Status

E06 is classified as "defensive" — it does not block any other module. However:

- **T01** must be merged (already merged) for ESL methods.
- **F02** must be merged (already merged) for `call_log` schema.
- **I01** must be merged (already merged) for `keys.go` with `JanitorLock()`.
- **C03** audit writer must be available (already merged per git log).
- **O03** alert router is a soft dependency — the Prometheus rules file is
  committed as a stub and activates when O03 wires Alertmanager.

The `picker.Janitor` and `originate.Service.SweepOrphans` are pre-built hooks
explicitly designed for E06 (see comments in both files referencing "E06 every
60s"). E06 is the final piece that orchestrates these into a unified sweeper.
