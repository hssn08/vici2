# E06 — Channel + Conference Janitor — RESEARCH

**Module:** E06
**Date:** 2026-05-13
**Status:** RESEARCH_COMPLETE
**Depends on:** T01, F02, I01, W01, C03

---

## 1. How Vicidial Does It

### 1.1 Background

Vicidial's codebase (ViciDial open-source, GPL, available at
`https://github.com/vicidial/vicidial`) shows three related maintenance
mechanisms that together perform the same function E06 takes on for vici2.
The specific scripts are:

- **`AST_VDauto_dial.pl`** — The main dialer loop; it tracks hopper state and
  calls the hopper garbage logic inline.
- **`AST_VDadapt.pl`** — The adaptive pacing controller (open-source GPL,
  referenced in E03's code comments at
  `/root/vici2/dialer/internal/adapt/fastcut.go`). Contains the
  `vicidial_hopper_garbage` clause that expires stale hopper entries.
- **`kill_vicidial_hopper_process`** — A bash shell function, periodically
  invoked from cron or from within the main process, that does an Asterisk
  `originate` channel kill when a hopper call is detected as stuck.

### 1.2 Vicidial's `vicidial_hopper_garbage` Logic

In Vicidial's MySQL-backed architecture, the hopper table
(`vicidial_hopper`) has a column `status` (values: `N`=new, `D`=dialing,
`X`=done). The garbage logic is a SQL UPDATE that resets any row with
`status='D'` but no corresponding live Asterisk channel back to `status='N'`
for re-dialing:

```sql
UPDATE vicidial_hopper SET status='N'
WHERE status='D'
  AND called_since_last_reset='N'
  AND last_update_time < NOW() - INTERVAL 5 MINUTE;
```

This runs inside `AST_VDadapt.pl`'s main loop at approximately a 15-second
interval. In very high-volume Vicidial installs this query runs hot because
the table is scanned repeatedly; engineers working with Vicidial regularly
report needing to add indexes on `(status, called_since_last_reset,
last_update_time)` for installations with 100k+ hopper rows.

### 1.3 Vicidial's `kill_vicidial_hopper_process`

This is a shell function (called from the admin web UI and from
`AST_VDauto_dial.pl`) that executes Asterisk Manager Interface (AMI) commands
to hang up channels stuck in a dialing state:

```bash
# Pseudo-code of the core logic:
asterisk -rx "channel request hangup SIP/gateway-UUID-of-stuck-call"
# Then updates the DB row:
mysql -e "UPDATE vicidial_log SET status='XFER' WHERE uniqueid='$uuid' AND call_date < NOW() - INTERVAL 4 HOUR;"
```

The 4-hour threshold is hardcoded in the Vicidial admin panel (`vicidial_web_display`)
and is a well-known operational constant in the Vicidial community (discussed
extensively on ViciDial forums and the `VICIdial` mailing list). The reasoning
is that no legitimate outbound call should ever exceed 4 hours.

### 1.4 Vicidial's Conference Garbage

Vicidial (Asterisk-based) does not have a direct equivalent to stale
FreeSWITCH conference janitor because Asterisk manages its conference rooms
(`MeetMe`, `ConfBridge`) differently — they auto-destroy when empty. However,
Vicidial's `AST_VDsupervision.pl` runs `core show conferences` via AMI and
forcibly kicks lingering members to reset state. The typical threshold for an
"abandoned conference" check is 5 minutes (matching E06's design).

### 1.5 Key Lessons from Vicidial Experience

1. **Never trust ESL-only state** — Vicidial learned that AMI/ESL state can
   lie. Always cross-reference DB records.
2. **Clock skew kills calls** — Asterisk channel start times (reported via AMI)
   can differ from DB timestamps by 1-2 seconds in busy installations. Vicidial
   uses a 10-second grace period on top of the threshold. E06 uses FS-reported
   timestamps where possible and adds a 60-second grace.
3. **Leader election is essential** — Vicidial's `AST_VDauto_dial.pl` used a
   MySQL `GET_LOCK()` advisory lock to prevent double-sweep on multi-server
   installations. E06 replicates this using Valkey SETNX (per
   `dialer/internal/valkey/keys.go` `JanitorLock()` key).
4. **Audit every kill** — Vicidial's `vicidial_log` table has a `status='XFER'`
   sentinel that marks janitor-killed calls, and DB queries are logged to the
   admin history. E06 uses the C03 audit hash chain.

---

## 2. FreeSWITCH ESL API: `conference list` Output Format

### 2.1 The `json_list` Command

The existing ESL client at `/root/vici2/dialer/internal/esl/conference.go`
uses `conference <name> json_list` (not the legacy text format). The JSON
structure parsed by `parseConferenceList()` is:

```json
{
  "conference_name": "agent_t1_u1042",
  "conference_uuid": "b3d4e5f6-...",
  "members": [
    {
      "id": "1",
      "uuid": "a1b2c3d4-1234-5678-abcd-ef0123456789",
      "caller_num": "+15551234567",
      "caller_name": "Customer",
      "flags": "mute|deaf",
      "talking": false,
      "floor": false,
      "video": false,
      "hear": true,
      "speak": false,
      "recording": false,
      "energy": "300",
      "volume_in": "0",
      "volume_out": "0"
    }
  ]
}
```

When the conference does not exist, FS returns the string
`-ERR Conference not found` (handled by `parseConferenceList` returning
`nil, nil`).

When the conference exists but has no members (empty/zombie conference),
the `members` array is `[]` (empty array) — this is the signal the stale
conference sweeper uses.

### 2.2 Listing All Active Conferences

To sweep all conferences without knowing their names in advance, E06 uses
the ESL API command `conference list` (note: no conference name argument
means "list all"). The ESL client sends:

```
api conference list
```

FS responds with a newline-separated text format:
```
Conference agent_t1_u1042 (2 members rate: 8000 flags: running)
Conference agent_t1_u1099 (0 members rate: 8000 flags: running,zombie)
Conference agent_t2_u200 (1 member rate: 8000 flags: running)
```

Or JSON via `conference json_list` (all conferences):
```
api conference json_list
```

This returns a JSON array of conference objects, each with a `conference_name`
and `members` array. For the stale conference sweeper, E06 calls
`conference json_list` and iterates over conferences where
`len(members) == 0` and name does NOT match the agent home pattern.

### 2.3 The `conference <name> kick all` Command

To destroy a stale conference, E06 uses the ESL `conference <name> kick all`
command, which removes all members (if any) and causes FS to destroy the
conference room. This corresponds to the existing
`ConferenceKick(ctx, fsHost, conferenceName, "all")` in
`/root/vici2/dialer/internal/esl/conference.go`.

---

## 3. FreeSWITCH ESL API: `show channels as json` Output Format

The reconciler at `/root/vici2/dialer/internal/esl/reconcile.go` already uses
this command. The response structure is:

```json
{
  "rowCount": 3,
  "rows": [
    {
      "uuid": "a1b2c3d4-...",
      "direction": "outbound",
      "created": "2026-05-13 14:00:00",
      "created_epoch": "1747137600",
      "name": "sofia/gateway/gw1/+15551234567",
      "state": "CS_EXECUTE",
      "cid_name": "ViciDial",
      "cid_num": "+15005550001",
      "ip_addr": "203.0.113.1",
      "dest": "agent_t1_u1042",
      "presence_id": "",
      "presence_data": "",
      "accountcode": "",
      "callstate": "ACTIVE",
      "callee_name": "",
      "callee_num": "",
      "callee_direction": "SEND",
      "call_uuid": "a1b2c3d4-...",
      "sent_callee_name": "",
      "sent_callee_num": ""
    }
  ]
}
```

Key fields for the stuck-channel sweeper:
- `uuid` — the channel UUID (matches `call_log.uuid`)
- `created_epoch` — Unix timestamp of channel creation (reliable, from FS)
- `state` — `CS_EXECUTE`, `CS_ROUTING`, `CS_PARK`, etc.
- `callstate` — `ACTIVE`, `RINGING`, `EARLY`, `HELD`

The `created_epoch` field is crucial for E06: the sweeper computes
`now - created_epoch` as the channel age. If age > 4h AND
`call_log.call_ended IS NULL`, the channel is stuck.

---

## 4. Valkey Keys to Inspect

From `/root/vici2/dialer/internal/valkey/keys.go` (frozen namespace per F04
PLAN §4), the keys relevant to E06's orphan-lock sweep are:

### 4.1 Per-Lead Hopper Locks

```
t:<tid>:lead_lock:{<cid>}:<lead_id>
```
Builder: `Keys.LeadLock(cid, leadID)`. These are per-lead mutex keys set by
the Lua script `claim_lead_from_hopper.v1.lua`. They have a TTL of
`lead_lock_ttl_sec` (default 30s, configurable). Orphans occur when the
dialer pod crashes after popping from the hopper but before calling T04.
The picker janitor at `/root/vici2/dialer/internal/picker/janitor.go` already
sweeps `in_flight` entries older than 5 minutes. E06's orphan-lock sweep
specifically targets lead_lock keys whose TTL has already expired but whose
companion `in_flight` HASH entry is also gone (double-orphan: lock expired
but in_flight not cleaned up, or vice versa).

### 4.2 In-Flight HASH

```
t:<tid>:campaign:{<cid>}:in_flight
```
Builder: `Keys.CampaignInFlight(cid)`. HASH keyed by `lead_id` (string).
Values are `instance_id:claim_ts_ms`. The picker janitor at
`/root/vici2/dialer/internal/picker/janitor.go` sweeps these already; E06
calls `picker.Janitor.SweepOrphans()` as a sub-sweep.

### 4.3 Hopper ZSET

```
t:<tid>:campaign:{<cid>}:hopper
```
Builder: `Keys.CampaignHopper(cid)`. Sorted set of lead_ids by score.
E06 does NOT directly modify the hopper ZSET; the picker janitor handles
hopper-related cleanup.

### 4.4 Janitor Leader Lock

```
t:<tid>:janitor:lock
```
Builder: `Keys.JanitorLock()`. The single key used for leader election.
`SETNX` with TTL=90s. Only one dialer pod may hold this at a time. The
pattern mirrors the dispatch lock in
`/root/vici2/dialer/internal/queue/dispatcher.go` (lines 122-129):

```go
acquired, err := rdb.SetNX(ctx, lockKey, podID, 90*time.Second).Result()
if !acquired { return nil }
defer rdb.Del(ctx, lockKey)
```

### 4.5 Call Active SSET

```
t:<tid>:call:active
```
Builder: `Keys.CallActive()`. SSET of active call UUIDs maintained by the
ESL fanout. E06 does NOT clean this directly; the reconciler at
`/root/vici2/dialer/internal/esl/reconcile.go` handles divergence.

### 4.6 Other Lock Keys Not Swept by E06

The following coordination keys have their own TTL management and are NOT
touched by E06:
- `Keys.AdaptLock(cid)` — E03 pacing lock
- `Keys.AdaptFastcutLock(cid)` — E03 fast-cut lock (5s TTL)
- `Keys.DialerTick(cid)` — E02 tick heartbeat
- `Keys.CampaignDropGated(cid)` — E05 drop gate (no TTL, persistent)

### 4.7 Monitor Session Keys

```
t:<tid>:monitor:<sup_call_uuid>
```
Builder: `Keys.MonitorSession(...)`. S02 supervisor session HASHes.
E06 does NOT sweep monitor sessions; S02 handles its own TTL.

---

## 5. Leader-Election Valkey Lock Pattern

Reading `/root/vici2/dialer/internal/queue/dispatcher.go` (lines 117-129),
the dispatch lock pattern is:

```go
acquired, err := d.cfg.Rdb.SetNX(ctx, lockKey, d.cfg.PodID, DispatchLockTTLSec*time.Second).Result()
if err != nil {
    return fmt.Errorf("dispatch: SETNX lock: %w", err)
}
if !acquired {
    return nil // another pod holds the lock
}
defer d.cfg.Rdb.Del(ctx, lockKey)
```

The `DispatchLockTTLSec` constant in `dispatcher.go` is the safeguard: if the
pod crashes while holding the lock, it expires automatically.

For E06, the Janitor lock TTL must exceed the maximum sweep duration.
Reasoning:
- `show channels as json` over ESL: ~20-50ms for up to 10k channels
- DB query for stuck call_log rows: ~100ms with index on `(tenant_id, call_ended, call_started)`
- `conference json_list` (all conferences): ~50ms
- Per-conference kick: ~10ms each, usually <10 stale conferences
- Per-orphan-lock Valkey scan: ~5ms SCAN + HDEL per tenant

Total sweep budget: 2-5 seconds worst case. E06 sets JanitorLock TTL=90s,
giving 18x headroom and matching the key already defined in `keys.go`.

The lock value stored is the pod ID (hostname + PID), enabling diagnostic
queries like `GET t:1:janitor:lock` to identify the sweep-leader pod.

---

## 6. `call_log` Schema Fields

From `/root/vici2/api/prisma/schema.prisma` (lines 1281-1318), the
`call_log` table fields relevant to E06:

| Field | Type | E06 Relevance |
|-------|------|---------------|
| `id` | `BigInt` (PK, composite with `call_started`) | Filter target |
| `tenant_id` | `BigInt` | Tenant scoping |
| `uuid` | `VARCHAR(40)` | Cross-reference with FS channel UUID |
| `call_started` | `DATETIME(6)` | Partition key + age calculation |
| `call_answered` | `DATETIME(6)` nullable | NULL = never answered |
| `call_ended` | `DATETIME(6)` nullable | **NULL = stuck/open** |
| `status` | `VARCHAR(8)` nullable | Set to `'JANITOR'` on close |
| `hangup_cause` | `VARCHAR(32)` nullable | Set to `'JANITOR_SWEEP'` |
| `user_id` | `BigInt` nullable | Agent association |
| `campaign_id` | `VARCHAR(32)` nullable | Campaign association |

The stuck-channel query is:
```sql
SELECT id, uuid, call_started, tenant_id
FROM call_log
WHERE tenant_id = ?
  AND call_ended IS NULL
  AND call_started < NOW() - INTERVAL 4 HOUR
  AND call_started >= NOW() - INTERVAL 35 DAY  -- bounded to active partition
ORDER BY call_started ASC
LIMIT 100;
```

The composite `@@id([id, callStarted])` and the index
`idx_call_log_t_status_started` means the query should be efficient. The
LIMIT 100 cap prevents a single sweep from generating excessive ESL
kill traffic.

---

## 7. Conference Naming Convention RFC-002

From `/root/vici2/dialer/internal/conference/name.go`:

```go
// RFC-002 ACCEPTED — format: agent_t<tenantID>_u<userID>@<profile>.

func ConferenceName(tenantID, userID int64) string {
    return fmt.Sprintf("agent_t%d_u%d", tenantID, userID)
}

func ConferenceFQN(tenantID, userID int64, profile string) string {
    return ConferenceName(tenantID, userID) + "@" + profile
}

func HoldConferenceName(tenantID, userID int64) string {
    return fmt.Sprintf("agent_t%d_u%d_hold", tenantID, userID)
}
```

**Critical safety rule (RFC-002):** The stale conference sweeper MUST NEVER
kill a conference whose name matches the pattern `^agent_t\d+_u\d+$` or
`^agent_t\d+_u\d+_hold$`. These are agent home conferences. Even if they
report 0 members, they may be in the "waiting for next call" state —
destroying them would require the agent to re-login.

The regex check in `stale_confs.go` must be:
```go
var agentConfRE = regexp.MustCompile(`^agent_t\d+_u\d+(_hold)?$`)

func isAgentHomeConf(name string) bool {
    return agentConfRE.MatchString(name)
}
```

The `name_test.go` at `/root/vici2/dialer/internal/conference/name_test.go`
demonstrates the expected test patterns and can be referenced for test fixture
values.

Also: only conferences with names NOT matching the agent pattern AND having
0 members for more than 5 minutes are eligible. The "5 minutes empty" check
requires tracking when the conference first became empty. E06 uses a Valkey
HASH `t:<tid>:janitor:empty_confs` to record the `empty_since` timestamp per
conference name (see PLAN §7.3).

---

## 8. Adjacent Module Interfaces

### 8.1 T01 ESL Transport (`dialer/internal/esl/`)

Key methods available to E06:

| Method | File | Purpose |
|--------|------|---------|
| `Client.ConferenceCommand(ctx, host, name, cmd, args)` | `conference.go:26` | Run any `conference <name> <cmd>` |
| `Client.ConferenceList(ctx, host, name)` | `conference.go:54` | `json_list` one conference |
| `Client.ConferenceKick(ctx, host, name, memberID)` | `conference.go:64` | Kick a member |
| `command.API{Command:"show", Arguments:"channels as json"}` | `reconcile.go:30` | Get all channels |
| `parseShowChannelsJSON(body)` | `reconcile.go:76` | Parse channel JSON |

E06 needs an additional ESL method (not yet in `conference.go`):
```go
// ListAllConferences returns all active conferences from FS.
func (c *Client) ListAllConferences(ctx context.Context, fsHost string) ([]ConferenceSummary, error)
```
This wraps `api conference json_list` (all conferences, no name argument).
E06's implementation file `stale_confs.go` will add this.

### 8.2 F02 Database (`api/prisma/schema.prisma`)

`call_log` table queried via raw `database/sql`. The stuck-channel sweep does:
1. SELECT to find open rows older than 4h
2. Cross-reference with FS live channels via ESL
3. UPDATE to close rows not found in FS

### 8.3 I01 Hopper Keys (`dialer/internal/valkey/`)

`keys.go` provides all key builders. E06 does not add new key patterns.
The `JanitorLock()` key is already defined (line 132 of `keys.go`).

### 8.4 W01 Worker Infra (Workers TS)

The ShutdownManager pattern (`workers/src/lib/shutdown.ts`) is TypeScript and
applies to the TS worker pool. The Go dialer side uses the context-cancellation
pattern seen in `queue/janitor.go` (`Run(ctx context.Context) error` with a
ticker loop and `<-ctx.Done()` return). E06 follows the same Go pattern.

### 8.5 C03 Audit Hash Chain (`dialer/internal/audit/`)

`audit.Writer.AppendAuditLog()` inserts into `audit_log` with
SHA-256 chained `row_hash`. The `AuditLogRow` struct fields (from
`canonicalize_test.go`):

```go
type AuditLogRow struct {
    TenantID    int64
    ActorUserID *uint64    // nil for system actors
    ActorKind   string     // "system" for janitor
    Action      string     // "channel_killed" | "conf_killed" | "orphan_lock_cleared"
    EntityType  string     // "call_log" | "conference" | "valkey_lock"
    EntityID    string     // uuid or conference name or key name
    BeforeJSON  interface{}
    AfterJSON   interface{}
    RequestID   string     // "janitor-sweep-<tick_id>"
    IPAddress   string     // ""
    UserAgent   string     // "vici2-janitor/1.0"
    Ts          time.Time
    PrevHash    string     // set by trigger; leave empty on insert
}
```

### 8.6 O03 Alert Router

O03 (`spec/modules/O03/PLAN.md`) routes Alertmanager firings to Slack/
PagerDuty/webhook receivers. E06 fires Prometheus metrics that Alertmanager
rules can pick up. The alert rule for high kill counts:

```yaml
# prometheus/rules/janitor.yml
- alert: JanitorHighKillRate
  expr: rate(vici2_janitor_stuck_channels_killed_total[5m]) > 3
  for: 2m
  labels:
    severity: warn
  annotations:
    summary: "Janitor killing >3 stuck channels/min — possible upstream bug"
```

A separate rule covers stale conferences:
```yaml
- alert: JanitorHighStaleConfs
  expr: rate(vici2_janitor_stale_confs_killed_total[5m]) > 1
  for: 5m
  labels:
    severity: warn
  annotations:
    summary: "Janitor killing >1 stale conf/min — conference lifecycle bug"
```

---

## 9. FreeSWITCH Conference JSON Format — Additional Details

### 9.1 `conference json_list` (All Conferences)

The ESL command `api conference json_list` returns a JSON array (not an
object). Each element has the structure:

```json
[
  {
    "conference_name": "agent_t1_u1042",
    "conference_uuid": "uuid-of-conference",
    "conference_id": 1,
    "members": [...]
  },
  {
    "conference_name": "my_custom_conf",
    "conference_uuid": "uuid-2",
    "conference_id": 2,
    "members": []
  }
]
```

Empty `members: []` = stale candidate (if not an agent home conf).

### 9.2 Conference Zombie Detection

FreeSWITCH has an internal "zombie" conference state — conferences that have
been empty but not yet garbage collected. The `conference list` text output
includes `flags: running,zombie` for these. E06 COULD use the zombie flag,
but it is simpler and more reliable to track empty-since timestamps in Valkey
(as above) rather than depend on FS-internal zombie semantics.

### 9.3 ESL `show channels` XML vs JSON

FreeSWITCH supports both:
- `show channels as json` — JSON format (used by reconciler, E06 prefers this)
- `show channels as xml` — XML format (legacy, not used by vici2)

The JSON format as implemented in `reconcile.go` is authoritative.

---

## 10. Orphaned Hopper Lock Deep Dive

### 10.1 Lock Lifecycle

1. `Hopper.Claim()` in `/root/vici2/dialer/internal/valkey/hopper.go` runs
   the Lua script `claim_lead_from_hopper.v1.lua`.
2. The Lua script atomically: `ZPOPMIN hopper`, `SET lead_lock TTL lockTTLSec`,
   `HSET in_flight leadID "instanceID:nowMs"`.
3. After T04 `Originate()` returns, the dispatcher calls `Claimer.Release()`
   which runs `release_lead_claim.v1.lua` to `DEL lead_lock` + `HDEL in_flight`.
4. If the pod crashes between step 2 and step 3, both `lead_lock` and
   `in_flight` entries persist.

### 10.2 TTL-Based Self-Healing

The `lead_lock` key has an explicit TTL (30s by default). So:
- `lead_lock` expires automatically after TTL → the lead is re-available for
  hopper pop on next `SETNX` attempt (but the in_flight entry lingers).
- `in_flight` HASH entry has NO TTL — it persists until explicitly cleaned.

The `picker.Janitor.SweepOrphans()` at
`/root/vici2/dialer/internal/picker/janitor.go` sweeps `in_flight` entries
older than 5 minutes using the `claim_ts_ms` embedded in the value.
E06 calls this as a sub-sweep rather than duplicating the logic.

### 10.3 What E06 Actually Sweeps

E06's `orphan_locks.go` calls three existing sweep functions:
1. `picker.Janitor.SweepOrphans(ctx)` — in_flight HASH orphans
2. `originate.Service.SweepOrphans(ctx)` — originate_audit `OTHER` rows > 5min
3. Reports the counts to metrics

E06 does NOT directly modify Valkey lead_lock keys because those have TTL-based
self-healing. The orphan count metric is the signal, not the remediation.

---

## 11. Open Questions

### Q1: Multi-Host FS Deployments

In Phase 4, vici2 will support multiple FS hosts. The `esl.Client` already
manages multiple connections (`HealthyHosts()` returns a list). E06's
stuck-channel sweeper must query `show channels as json` on EACH healthy host.
The conference sweeper similarly must query `conference json_list` on each host.

**Resolution:** E06 iterates over `eslClient.HealthyHosts()` and sweeps each
host independently. The DB cross-reference (call_log) is global, so a stuck
channel found in the DB but missing from all FS hosts is also a valid kill
target.

### Q2: Partition Boundary for call_log Queries

`call_log` is partitioned by `call_started` (RANGE COLUMNS). The stuck-channel
query must include `call_started >= NOW() - INTERVAL 35 DAY` as a partition
pruning hint (matching the pattern in `originate/janitor.go` which uses a
35-day floor). Without this, the query scans all historical partitions.

**Resolution:** Apply the 35-day floor on all `call_log` queries in E06.

### Q3: Agent Logout During Sweep

If an agent logs out while the stale conference sweeper is running, the
conference transitions from "agent home (protected)" to "abandoned" in the
same tick. The sweep should not race with the logout procedure
(`conference.Operator.DestroyAgentConf`).

**Resolution:** The sweeper checks the live FS state AFTER the Valkey agent
status. If `Keys.Agent(userID)` has `status=LOGOUT`, the conference is no
longer protected. This is a non-critical race (worst case: one extra tick
before the conf is killed, or the logout handler kills it first).

### Q4: Conference Empty-Since Tracking TTL

The `t:<tid>:janitor:empty_confs` Valkey HASH records when each conference
first became empty. What TTL should this hash have?

**Resolution:** No TTL on the HASH; individual fields are deleted when the
janitor either: (a) kills the conference, or (b) observes it become
non-empty again. The hash is small (<1KB for typical deployments).

### Q5: Alertmanager Integration Timing

O03 is not yet merged. The Prometheus alert rules (`.yml` files) should be
written as stubs in `prometheus/rules/janitor.yml` and activated when O03
merges.

**Resolution:** E06 commits the rule file as a stub. The rules fire when
Alertmanager is configured (O03's responsibility).

### Q6: Test Strategy for Stuck Channels

The integration test must insert a real `call_log` row with `call_ended=NULL`
and `call_started = NOW() - INTERVAL 5 HOUR`, then run the sweeper. The FS
ESL side is mocked with `esl/testutil.FakeFS`.

**Resolution:** See PLAN §11 for detailed test spec.
