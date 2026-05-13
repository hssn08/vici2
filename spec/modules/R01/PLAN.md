# R01 — Per-Call Recording (record_session + Naming Convention) — PLAN

**Status:** PLAN (RESEARCH approved, 36 citations).
**Date:** 2026-05-06
**Owner agent type:** telephony (FreeSWITCH dialplan amendment + Go in `dialer/internal/recording/`)
**Source RESEARCH:** [R01/RESEARCH.md](RESEARCH.md) (36 citations)
**Companion docs:** [F03/PLAN.md §14.2](../F03/PLAN.md), [F02/PLAN.md §4.18, §4.26](../F02/PLAN.md), [T01/PLAN.md](../T01/PLAN.md), [T03/RESEARCH.md §7](../T03/RESEARCH.md), [T04/RESEARCH.md](../T04/RESEARCH.md), [R01.md](../R01.md), [SPEC §4.1](../../../SPEC.md), [DESIGN §4.6, §18.5](../../../DESIGN.md).

This PLAN is the binding contract for the Phase 1 per-call recording subsystem. It freezes:
- the recording strategy (per-leg on customer leg, single stereo WAV),
- the on-disk path convention,
- the Go API surface (`StartRecording`/`StopRecording`/`PauseRecording`/`ResumeRecording`/`RecordingStatus`),
- the `recording_log` row write contract (T01 stream consumer in `workers/`),
- a small XML amendment request for F03 (channel-vars on customer leg + single pre-start beep).

R01 IMPLEMENT will (a) write the Go package in `dialer/internal/recording/`, (b) file the F03 XML amendment, (c) ship integration tests.

---

## 1. Scope and non-goals

### 1.1 In scope (Phase 1)

- Per-call WAV recording on the customer leg via FreeSWITCH `record_session` (declarative, dialplan) + `uuid_record` (imperative, ESL via T01's `UUIDRecord` primitive).
- Stereo capture (left=customer / read, right=agent / write), survives transfers.
- Deterministic on-disk path under `${recordings_dir}/${tenant_id}/${YYYY}/${MM}/${DD}/${campaign_id}_${lead_id}_${call_uuid}.wav`.
- Start trigger: customer-leg `CHANNEL_ANSWER` AFTER C02 consent prompt completes (in 2-party-consent jurisdictions).
- Stop trigger: customer-leg `CHANNEL_HANGUP_COMPLETE`.
- Pause/resume via `uuid_record mask|unmask` for PCI DTMF masking (with prominent "not PCI-compliant per PCI SSC 2024+" caveat in HANDOFF + admin UI tooltip).
- Single pre-start beep tone for jurisdictions that require notification.
- Disk-pressure backstop (85% warn, 95% stop new recordings, 100% fail-open / call continues).
- `recording_log` row written by T01's stream consumer in `workers/` on `RECORD_STOP` event (schema per F02 PLAN §4.26).
- Capacity planning sized for 100-agent tenant at saturation (~57 GB/day).
- Prometheus metrics for failures, lifecycle, disk pressure.

### 1.2 Out of scope (deferred)

| Deferred to | What |
|---|---|
| **R02 (Phase 1)** | S3 upload, MP3 transcode (post-upload), local-file deletion after upload+verify, SHA-256 integrity check |
| **R03 (Phase 1)** | Web playback, signed URLs, share-tokens |
| **C02 (Phase 1)** | Consent prompt audio, decision matrix per state, `consent_status` channel-var contract |
| **N07 (Phase 4)** | Whisper transcription (consumes stereo WAV; demuxes to per-speaker mono) |
| **Phase 2** | Continuous beep tone via `displace_session beep.wav loop` (mod_displace), MP3-direct via mod_shout, PCI sidecar integration |
| **Phase 2** | Per-tenant XFS project quotas on `${recordings_dir}/<tenant_id>` |
| **Phase 2** | Encryption-at-rest on scratch volume (LUKS / dm-crypt) |
| **Phase 2** | `RECORD_MAX_LEN` ceiling (4-hour runaway protection) — Phase 1 has no cap |
| **Phase 2** | Multi-segment marker (`RECORD_MARK`) for transfer boundaries — Phase 1 ships single contiguous file |
| **Phase 4** | Conference-level recording (broken stereo per [signalwire/freeswitch#895](https://github.com/signalwire/freeswitch/issues/895)) — never; we always per-leg |

### 1.3 What this PLAN does NOT define

- The C02 consent state machine (C02 PLAN owns).
- The R02 S3 upload pipeline (R02 PLAN owns).
- The `tenants.recording_stereo BOOLEAN DEFAULT TRUE` column (D01 PLAN owns; R01 reads).
- The campaign `recording_mode` enum semantics (already in D01 / F02 PLAN as `ENUM('NEVER','ONDEMAND','ALL','ALLFORCE') NOT NULL DEFAULT 'ALL'`).

---

## 2. Strategy decision (frozen)

### 2.1 Per-leg on customer leg with `RECORD_STEREO=true` + `recording_follow_transfer=true`

Single stereo WAV per call:
- Left channel = customer voice (read stream of customer leg).
- Right channel = agent voice (write stream of customer leg, sourced from the bridge → conference).

Why per-leg, not conference:
- `RECORD_STEREO` does not work on conference recordings ([signalwire/freeswitch#895](https://github.com/signalwire/freeswitch/issues/895), reproduced 2018+2020) — both channels contain mixed audio.
- Conference recording emits `CUSTOM conference::maintenance` events, not `RECORD_START`/`RECORD_STOP`, so we lose `lead_id`/`campaign_id`/`tenant_id` enrichment vars.
- Conference recording does NOT honor `recording_follow_transfer` semantics — if the customer is `uuid_transfer`'d out, the conference recording stops.

Why customer leg, not agent leg:
- Agent is permanent in their conference across many customer calls per shift — per-agent recording would produce one giant file per shift with no per-call boundaries.
- Customer leg's `record_session` captures **both** read (customer) and write (audio FS sends to customer, which includes agent voice via the bridge) — full conversation in one bug.

### 2.2 Format: WAV PCM s16le, codec-driven sample rate

| Inbound carrier codec | WAV sample rate |
|---|---|
| PCMU / PCMA (G.711) — Phase 1 default | 8 kHz |
| G.722 | 16 kHz |
| OPUS @ 16 kHz (browser/wss leg) | 16 kHz |
| OPUS @ 48 kHz (rare; not Phase 1) | 48 kHz |

We do NOT set `record_sample_rate` — let FreeSWITCH pick from the stream's actual rate. Forcing 16 kHz on an 8 kHz source wastes disk and adds zero fidelity. Conference profile is 8 kHz Phase 1 (per F03 PLAN §10), so PCMU/PCMA carriers produce 8 kHz stereo WAV.

MP3 (mod_shout/lame) is **deferred to R02 worker** (post-upload transcode); FS box does not encode MP3 live.

### 2.3 Acceptable storage cost

Stereo WAV @ 8 kHz = **32 KB/s** per active call = **115 MB/agent-hour**.

100-agent tenant at Phase-2 saturation (~50 calls/agent/day × 6-min average) = **~57 GB/day per tenant**. See §6 for capacity sizing.

---

## 3. File path convention (frozen, matches F03 PLAN §14.2)

```
${recordings_dir}/${tenant_id}/${YYYY}/${MM}/${DD}/${campaign_id}_${lead_id}_${call_uuid}.wav
```

Concrete example:
```
/var/lib/freeswitch/recordings/1/2026/05/06/SOLAR_Q2_4287_8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav
```

### 3.1 Drop `${start_epoch}` from R01.md spec — RESOLVED

R01.md spec mentions `${start_epoch}` as a filename token. **PLAN drops it** for the same reason F03 PLAN §14.2 already dropped it:
- `${call_uuid}` is globally unique (36 hex chars w/ hyphens; collision is mathematically zero); epoch adds no information.
- Adding epoch creates a two-clocks problem (FS `strftime` vs the `start_epoch` we'd separately compute).
- Cleaner directory listings; easier glob patterns.

**Action:** R01 IMPLEMENT updates R01.md spec text to reflect the 3-token name (no epoch).

### 3.2 Why this shape

- **`${tenant_id}` first** — multi-tenant from day 1 (SPEC §4.5). `find /var/lib/freeswitch/recordings/1/` answers "all of tenant 1's recordings". Per-tenant XFS project quotas (Phase 2) work cleanly.
- **`${YYYY}/${MM}/${DD}` next** — natural directory partitioning for retention sweeps (`find ... -mtime +N -delete`). Keeps any single directory under ~50,000 files (a 100-agent center does ~40k recordings/day max).
- **`${campaign_id}_${lead_id}_${call_uuid}` filename** — three identifiers in increasing uniqueness order. Globbing `SOLAR_Q2_*` pulls a campaign's recordings without opening the file. `${call_uuid}` is the FreeSWITCH channel UUID, the join key with `call_log.uuid` and `recording_log.uuid`.

### 3.3 Directory creation

`record_session` creates intermediate directories on its own (mod_sndfile uses `switch_dir_make_recursive`). No pre-create cron needed. `recordings_dir` itself is the volume mount-point declared in F01's compose; FS init creates `${tenant_id}/...` paths on first use.

### 3.4 Path computation (Go)

`dialer/internal/recording/path.go` exposes:
```go
func ComputePath(recordingsDir string, tenantID int64, campaignID string, leadID int64, callUUID string, startedAt time.Time) string
```
Used by:
- `StartRecording` (when invoked imperatively for ONDEMAND mode) to compute `<path>` for `bgapi uuid_record <uuid> start <path>`.
- `RecordingStatus` to verify the actual on-disk path matches the expected template.
- T01 stream consumer to sanity-check the `RECORD_STOP` event's `Record-File-Path` matches the template (alert on mismatch — indicates dialplan drift).

The dialplan (F03 amendment, §10 below) uses raw FreeSWITCH variable expansion of the same template; `path.go` is the canonical Go-side implementation that R02, R03, and tests share.

---

## 4. Trigger logic (start / stop / pause / resume)

### 4.1 Start trigger

**When:** Customer-leg `CHANNEL_ANSWER`, AFTER C02 consent prompt completes (in 2-party-consent jurisdictions), AFTER conference bridge action begins.

**Belt-and-suspenders var:** `media_bug_answer_req=true` set on the channel — delays ALL media bugs (including ours) until the channel is actually answered. Defends against `record_session` being called pre-answer (would write silence; `RECORD_MIN_SEC=2` filters but we'd still do the I/O).

**Per recording_mode:**

| `campaigns.recording_mode` | Behavior |
|---|---|
| `NEVER` | Skip `record_session` entirely in dialplan (gated on `${recording_mode_skip}` channel var which T03/T04 sets from campaign config). |
| `ONDEMAND` | Skip `record_session` in dialplan; agent UI POSTs `/api/agent/recording {action:'start'}` mid-call → API → dialer → `StartRecording(callUUID, ...)` → `bgapi uuid_record <uuid> start <path>`. |
| `ALL` | Dialplan executes `record_session` declaratively at bridge time. Agent CAN pause/resume via `PauseRecording`/`ResumeRecording`. |
| `ALLFORCE` | Dialplan executes `record_session`; agent CANNOT pause/resume (API returns 403; enforcement in API layer). Supervisor with elevated role CAN. |

### 4.2 Stop trigger

Customer-leg `CHANNEL_HANGUP_COMPLETE` — FreeSWITCH automatically tears down the media bug and emits `RECORD_STOP`. We do NOT explicitly call `StopRecording` on hangup; the dialplan/FS handles it.

`StopRecording` Go API exists for **forced stop** by supervisor (kill-switch / legal hold weirdness / agent training override) — it issues `bgapi uuid_record <uuid> stop <path>` mid-call.

### 4.3 Pause/resume — `uuid_record mask|unmask`

Mask substitutes silence into the recording without stopping the underlying media bug. Unmask resumes live audio capture. The recording file remains a single continuous WAV — listeners hear silence during the masked period.

**Why mask/unmask, NOT `stop_record_session` + `RECORD_APPEND=true`:**
- `RECORD_APPEND` is broken in many FS versions (Igor Olkhovskyi reported distorted resume audio in 1.6.18; not re-validated for 1.10.x).
- mask/unmask preserves a single file (one `recording_log` row) — semantically simpler.
- FusionPBX (PR #5373, 2020), NEventSocket, and production callers all use mask/unmask for PCI.

**The PCI caveat (MUST be in HANDOFF and admin UI tooltip):**
> "Mask/unmask reduces but does not eliminate PCI scope. Per PCI DSS 4.0.1 (mandatory 2025-04-01) and PCI SSC 2024+ guidance, manual pause/resume is treated as obsolete for PCI compliance — any failure puts the recording system back in scope. Use a PCI-DSS-certified payment IVR or DTMF-suppression sidecar (e.g., PCI Pal, Eckoh, Semafone, Aeriandi) for actual cardholder-data capture in Phase 2+. R01 ships mask/unmask as table-stakes capability; we do NOT market this as PCI-compliant."

The seam for the Phase-2 sidecar is the same `recording_consent_audio` / `record_session` dialplan branch — a payment IVR overlays the path.

### 4.4 Audit trail per pause/resume invocation

Every `PauseRecording` / `ResumeRecording` invocation writes one row to `audit_log` (consumed by C03):
```
{
  ts, tenant_id, user_id (agent or supervisor),
  entity_type='recording', entity_id (recording_log.id),
  action='pause' | 'resume',
  metadata: { call_uuid, path }
}
```
M08 reports surface "% of calls paused" by agent for QA outlier detection.

### 4.5 Permissions matrix

| recording_mode | Agent can start | Agent can stop | Agent can pause/resume | Supervisor can stop | Supervisor can pause/resume |
|---|---|---|---|---|---|
| NEVER | n/a | n/a | n/a | n/a | n/a |
| ONDEMAND | YES | YES | YES | YES | YES |
| ALL | (auto) | NO | YES | YES (force) | YES |
| ALLFORCE | (auto) | NO | NO | YES (force, audit-heavy) | YES (audit-heavy) |

Enforced in the API layer (`api/src/services/recording/decide-mode.ts` per R01.md) BEFORE dispatching ESL command.

---

## 5. Failure handling

### 5.1 Recording failures are non-fatal to the call — frozen

**No recording failure ever hangs up a call.** Customer attention and agent productivity are higher-value than one call's audio capture. Recording failure → metric increment → `recording_log.lifecycle_state='failed'` → ops gets paged → call continues.

The exception (informational only): if `campaigns.recording_required=true` AND failure detected mid-call, API may signal agent UI "recording broken; please end call gracefully" via soft warning. System does NOT auto-hangup.

### 5.2 Failure modes table

| Failure | Cause | Detection | Action | Reason label |
|---|---|---|---|---|
| Disk full | All scratch space consumed | `record_session` returns -ERR; `RECORD_STOP` empty Path or Record-Ms=0 | log error, `recording_log.lifecycle_state='failed'`, **call continues** | `disk_full` |
| Permission denied | Volume mount perms wrong | Same as above | Same; alert SRE — likely deploy bug | `permission_denied` |
| Path not creatable | `tenant_id` or `campaign_id` var unresolved | `record_session` returns -ERR | Same; specifically labeled to find dialplan bugs | `path_unresolved` |
| Codec mismatch | Source codec FS can't read | Media bug attached but no audio captured; resulting WAV is silence or 0 bytes | `RECORD_MIN_SEC=2` filters short files; bug report | `codec` |
| FS process crash mid-recording | OOM, segfault | RECORD_STOP never fires; partial WAV on disk | T01's reconcile-on-reconnect finds orphan files; janitor (E06) reaps after grace; `recording_log.lifecycle_state='orphan'` | `orphan` |
| Network partition: dialer → ESL | Mask/unmask command never reaches FS | `bgapi` returns timeout / no BACKGROUND_JOB | API returns 503; agent re-tries; pause was no-op (safer than half-state) | `esl_timeout` |
| Consent missing | `consent_status` channel-var not set or = `prompted_declined` | `StartRecording` invoked without consent context | Return `ErrConsentMissing`; do NOT start; emit metric | `consent_missing` |

### 5.3 Failed recordings still get a `recording_log` row

For audit completeness, T01 stream consumer writes the row even on failure:
```
{
  ...
  filename: <intended path>,
  storage_url: NULL,
  duration_sec: 0,
  byte_size: 0,
  lifecycle_state: 'failed',
  failure_reason: 'disk_full' | 'permission_denied' | ...
}
```

R03 playback UI shows "Recording unavailable — failed" for these; never returns 404.

### 5.4 RECORD_STOP event hygiene

Headers we capture:
- `Record-File-Path` — full file path
- `Record-Ms` — duration in ms (also `record_ms` channel var)
- `Record-Read-Sample-Rate` — Hz
- `variable_uuid`, `variable_lead_id`, `variable_campaign_id`, `variable_tenant_id`, `variable_user_id` — our enrichment vars
- `variable_record_samples` — total samples written

`size_bytes` is NOT in the event; the T01 stream consumer in `workers/` calls `os.Stat()` on the file path to populate it. If `os.Stat()` fails (file deleted by R02 racing the stream consumer — rare), we mark `lifecycle_state='orphan'`.

### 5.5 Typed errors (Go)

`dialer/internal/recording/errors.go` exports:
```go
var (
    ErrRecordingFailed = errors.New("recording: start/stop failed at FS")
    ErrDiskFull        = errors.New("recording: scratch volume at capacity")
    ErrConsentMissing  = errors.New("recording: cannot start without consent_status set")
    ErrModeForbidden   = errors.New("recording: campaign mode forbids this action")
    ErrCallNotActive   = errors.New("recording: call_uuid not in active recordings hash")
    ErrAlreadyActive   = errors.New("recording: already recording this call")
)
```

---

## 6. Capacity planning (frozen)

### 6.1 Per-tenant daily volume

| Variable | Value |
|---|---|
| Concurrent agents | 100 |
| Avg call talk-time | 6 min |
| Calls/agent/workday (Phase 2 auto-dial) | ~50 |
| Calls/agent/workday (Phase 1 manual) | ~25 |
| Bytes/sec stereo WAV @ 8 kHz | 32,000 |
| Bytes per 6-min call | ~11.5 MB |

- **Phase 1 manual:** 100 × 25 × 11.5 MB ≈ **29 GB/day per tenant**.
- **Phase 2 auto-dial:** 100 × 50 × 11.5 MB ≈ **57 GB/day per tenant**.

Plan around the **57 GB/day** ceiling.

### 6.2 Local disk sizing

R02 deletes after upload+verify (target: 5-min latency). Steady-state resident: ~200 MB.

**Plan-for worst case:** R02 down for 8 hours during peak.
- 8 hr × 7 GB/hr peak ≈ **56 GB backlog**.
- Round up + headroom for FS logs / system overhead → **200 GB recording scratch volume per FS instance** is the minimum sane size.

### 6.3 Disk-pressure backstop (frozen thresholds)

| Threshold | Action | Metric |
|---|---|---|
| > 85% used | Warn alertmanager; **keep recording**; log warnings | `vici2_recording_disk_used_percent` gauge crosses 0.85 → warn |
| > 95% used | **Stop starting NEW recordings** (set tenant-wide flag; new originates skip `record_session`); R02 emergency-flush oldest; alarms loud | gauge > 0.95 → page |
| 100% (write fails) | `record_session` returns error; **call continues**; `recording_log.lifecycle_state='failed'`; failure metric increments | failure counter increments |

**Ongoing recordings continue at 95%** — partial-loss is worse than full-loss for compliance.

### 6.4 Per-call worst case

A 1-hour call at stereo WAV 8 kHz = **115 MB**. A 4-hour call (rare; debt collection) = **460 MB**. Phase 1 ships with **no `RECORD_MAX_LEN`** (let calls run as long as they want); Phase 2 considers a 4-hour cap as runaway protection.

### 6.5 Per-tenant quotas

XFS project quotas per `tenant_id` directory (`xfs_quota -x -c 'project -s -p /recordings/<tid> <projid>'`) deferred to Phase 2 / multi-tenant rollout. Phase 1 single-tenant uses the volume's overall capacity.

### 6.6 Encryption-at-rest

Phase 1: rely on host-FS encryption (LUKS / dm-crypt on the recordings volume). Documented in F03 deploy docs as a recommended host-config baseline. Phase 2 (HIPAA-adjacent workloads): app-level encryption seam (currently out of scope; reserved).

---

## 7. Go API surface — `dialer/internal/recording/`

All methods are thin wrappers around T01's `UUIDRecord` ESL primitive (T01 PLAN §16.6 / `dialer/internal/esl/record.go`). R01 owns the business logic (path computation, status tracking, mode enforcement, audit emission); T01 owns the wire-level FS interaction.

### 7.1 Public API (frozen)

```go
package recording

// Recorder is the contract upstream services (T04 originate, A05 agent UI bridge,
// supervisor force-stop, PCI DTMF flow) bind against.
type Recorder interface {
    // StartRecording begins a recording on the customer leg of an active call.
    // Used for ONDEMAND mode (agent presses Record) and as a programmatic
    // alternative to dialplan record_session for ALL/ALLFORCE modes when the
    // dialplan path was skipped (rare; e.g. campaign override mid-call).
    // MUST NOT be called before C02 consent_status is set on the channel.
    // Returns the on-disk path and ErrConsentMissing | ErrAlreadyActive | ErrRecordingFailed.
    StartRecording(ctx context.Context, callUUID string, tenantID, campaignID, leadID int64) (path string, err error)

    // StopRecording forces a stop (supervisor override / kill-switch / legal hold).
    // Idempotent — returns nil if recording already stopped.
    StopRecording(ctx context.Context, callUUID string) error

    // PauseRecording masks the recording with silence (PCI use case).
    // Returns ErrModeForbidden if campaign is ALLFORCE and caller is agent (not supervisor).
    PauseRecording(ctx context.Context, callUUID string) error

    // ResumeRecording unmasks (audio captured normally again).
    // Returns ErrModeForbidden if campaign is ALLFORCE and caller is agent (not supervisor).
    ResumeRecording(ctx context.Context, callUUID string) error

    // RecordingStatus reports current state of a recording for a given call.
    RecordingStatus(ctx context.Context, callUUID string) (RecordingStatus, error)
}

type RecordingStatus struct {
    CallUUID    string
    Path        string
    State       LifecycleState // recording | masked | stopped | failed | not_active
    StartedAt   time.Time
    PausedAt    *time.Time     // last mask time, nil if not currently masked
    ResumedAt   *time.Time     // last unmask time
    PauseCount  int            // total mask invocations this call
}

type LifecycleState string

const (
    StateRecording  LifecycleState = "recording"
    StateMasked     LifecycleState = "masked"
    StateStopped    LifecycleState = "stopped"
    StateFailed     LifecycleState = "failed"
    StateNotActive  LifecycleState = "not_active"
)
```

Note: `PauseRecording` / `ResumeRecording` deliberately do NOT take an actor-role argument — that auth check happens in the API layer (`api/src/services/recording/decide-mode.ts`) BEFORE this API is called. R01 just executes; auth is upstream.

### 7.2 Internal: `bgapi` mapping

| API method | ESL call (via T01 `UUIDRecord`) |
|---|---|
| `StartRecording` | `bgapi uuid_record <uuid> start <path>` |
| `StopRecording` | `bgapi uuid_record <uuid> stop <path>` |
| `PauseRecording` | `bgapi uuid_record <uuid> mask <path>` |
| `ResumeRecording` | `bgapi uuid_record <uuid> unmask <path>` |

The `<path>` argument MUST match the active recording's path for mask/unmask to find the right bug. We read it from `t:{tid}:recording:{call_uuid}` Valkey HASH (§7.4).

### 7.3 Code structure

```
dialer/internal/recording/
├── record.go      # Recorder impl: Start/Stop/Pause/Resume API, audit emission
├── path.go        # ComputePath() — single canonical path computation
├── status.go      # Valkey HASH r/w for in-progress tracking
├── metrics.go     # Prometheus counters/gauges/histograms
├── errors.go      # Typed errors (ErrRecordingFailed, ErrDiskFull, ...)
└── record_test.go # Unit tests (path, status, mode enforcement)
```

R01 does NOT spawn its own dialer worker process. It rides T01's existing event-bus consumer in `workers/` — see §8.

### 7.4 In-progress tracking via Valkey

Active recordings are tracked in a Valkey HASH per `(tenant_id, call_uuid)`:

```
Key:   t:{tenant_id}:recording:{call_uuid}
Type:  HASH
Fields:
  path           string   on-disk path
  state          string   recording | masked
  started_at     int64    epoch nanoseconds
  paused_at      int64    epoch ns (0 if not currently masked)
  pause_count    int      cumulative mask invocations
  campaign_id    int64
  lead_id        int64
TTL:   24h (call duration ceiling; Phase-2 may extend for 4h-cap calls)
```

Written by:
- `StartRecording` (on success).
- `PauseRecording` (state=masked, paused_at=now, pause_count++).
- `ResumeRecording` (state=recording, paused_at=0).
- T01 stream consumer (deletes on `RECORD_STOP`).

Read by:
- `PauseRecording` / `ResumeRecording` to look up `<path>` for the ESL command.
- `RecordingStatus` to answer status queries from API layer.
- Dashboards (vici2_recording_active_count gauge sourced from `SCAN t:*:recording:*` count).

### 7.5 Metrics (frozen)

| Metric | Type | Labels |
|---|---|---|
| `vici2_recording_started_total` | counter | `tenant_id`, `campaign_id`, `mode` (auto\|ondemand) |
| `vici2_recording_completed_total` | counter | `tenant_id`, `campaign_id` |
| `vici2_recording_failures_total` | counter | `tenant_id`, `reason` (disk_full\|permission_denied\|path_unresolved\|codec\|orphan\|consent_missing\|esl_timeout) |
| `vici2_recording_duration_seconds` | histogram | `tenant_id`, `campaign_id` |
| `vici2_recording_disk_used_percent` | gauge | `fs_host` |
| `vici2_recording_active_count` | gauge | `tenant_id` |
| `vici2_recording_pause_total` | counter | `tenant_id`, `actor_role` (agent\|supervisor) |
| `vici2_recording_resume_total` | counter | `tenant_id`, `actor_role` |

O01 PLAN consumes these for the "Recording" Grafana panel. Alerts:
- `rate(vici2_recording_failures_total[5m]) > 0.01` per tenant → page.
- `vici2_recording_disk_used_percent > 0.85` for 2m → warn.
- `vici2_recording_disk_used_percent > 0.95` for 30s → page.
- Sudden drop in `rate(vici2_recording_started_total[5m])` while `rate(vici2_call_answered[5m])` is normal → page.

---

## 8. T01 stream consumer — `recording_log` row write contract

R01 does NOT own its own dialer worker. It rides T01's existing event-bus consumer architecture (T01 PLAN §16). A dedicated handler in `workers/` consumes the recording stream and writes `recording_log` rows.

### 8.1 Stream contract (input from T01)

T01 fans out:
- `RECORD_START` event → Redis stream `events:vici2.recording.started`
- `RECORD_STOP` event → Redis stream `events:vici2.recording.stopped` (CRITICAL stream per T01 PLAN §17.4)

Each `RECORD_STOP` event payload:
```json
{
  "event_id": "<deterministic uuid>",
  "uuid": "<channel_uuid>",
  "tenant_id": 1,
  "campaign_id": "SOLAR_Q2",
  "lead_id": 4287,
  "user_id": 901,
  "filename": "/var/lib/freeswitch/recordings/1/2026/05/06/SOLAR_Q2_4287_<uuid>.wav",
  "duration_ms": 312500,
  "sample_rate": 8000,
  "channels": 2,
  "started_at_ns": 1746547200000000000,
  "ended_at_ns": 1746547512500000000,
  "fs_host": "fs1"
}
```

### 8.2 Consumer location: `workers/recording-log-writer/`

- Node.js worker (per SPEC §3 "workers/" location for Node consumers).
- Subscribes to `events:vici2.recording.started` and `events:vici2.recording.stopped` consumer group.
- On `RECORD_START`: optional INSERT placeholder row with `lifecycle_state='recording'` (skipped Phase 1 — wait for STOP to write a complete row; reduces churn).
- On `RECORD_STOP`: INSERT into `recording_log` with full metadata + os.Stat() the file for `byte_size`.
- Idempotent: keyed on `(tenant_id, call_uuid)`; duplicate `RECORD_STOP` events (T01 at-least-once) → `ON DUPLICATE KEY UPDATE` no-op.
- On failure (file Stat fails, DB write fails): retry per T01's stream-consumer retry policy; after N retries, dead-letter to `events:vici2.dlq.recording`.

### 8.3 `recording_log` row schema (per F02 PLAN §4.26)

The consumer writes:
```
INSERT INTO recording_log (
  tenant_id, call_uuid, campaign_id, lead_id, user_id,
  file_path, byte_size, duration_sec, codec, channel_count,
  sample_rate, started_at, ended_at,
  lifecycle_state, consent_status, failure_reason
) VALUES (...)
```

Where:
- `codec` derived from `sample_rate` + `channels` + extension (e.g. "wav-pcm-s16le-stereo-8khz").
- `lifecycle_state` = `'recording_complete'` on normal stop, `'failed'` on disk_full / path_unresolved, `'too_short'` if Record-Ms < (RECORD_MIN_SEC × 1000) (FS deletes the file in this case; row exists for audit).
- `consent_status` mirrored from the channel-var C02 wrote (`not_required` | `prompted_accepted` | `prompted_declined` | `assumed`).
- `failure_reason` NULL on success.

R02 then UPDATEs the same row with `storage_url` after S3 upload + sets `recordings.lifecycle_state='available'` (per F02 PLAN §4.18).

---

## 9. `recordings` table (lifecycle) — write contract

Per F02 PLAN §4.18, `recordings` is the non-partitioned lifecycle table that holds shareable tokens, lifecycle state, legal hold, storage class, deletion-pending markers.

R01 does NOT write this table directly. R02 does (after upload). For R01-PLAN's purposes, the row layout R02 will create is:

| Column | Type | Notes |
|---|---|---|
| `id` | BIGINT PK | |
| `recording_log_id` | BIGINT NOT NULL | logical pointer; no FK (recording_log is partitioned) |
| `s3_path` | VARCHAR(512) NULL | populated by R02 post-upload |
| `share_token` | VARCHAR(64) UNIQUE NULL | populated by R03 on first share |
| `legal_hold` | BOOLEAN DEFAULT FALSE | C04 retention worker checks |
| `storage_class` | VARCHAR(32) | e.g. STANDARD / GLACIER |
| `deletion_pending` | BOOLEAN DEFAULT FALSE | R02 deletion race guard (see §10.4 below) |
| `lifecycle_state` | ENUM('encoding','available','archived','deleted') | per F02 PLAN §4.18 |
| `created_at`, `updated_at` | TIMESTAMP | |

R01 PLAN's only job here is to **document the write contract for downstream R02**: R01 writes `recording_log` (via T01 consumer); R02 reads `recording_log`, uploads, writes `recordings`.

---

## 10. Hand-off contracts

### 10.1 ← C02 (consent gating) — INPUT

**C02 owns enforcement; R01 owns mechanism.**

C02 runs the consent prompt + decision matrix (per state law, per `lead.state`, per campaign override). C02 sets `consent_status` channel-var on the customer leg BEFORE R01's `record_session` action runs:

| `consent_status` value | R01 behavior |
|---|---|
| `not_required` | Run `record_session` immediately (one-party state, no prompt needed). |
| `prompted_accepted` | Run `record_session` (prompt completed, consent captured). |
| `prompted_declined` | DO NOT run `record_session`; per `campaign.opt_out_action`, hangup OR continue without record. |
| `assumed` | Treat as `prompted_accepted` if C02 actually played prompt; else as `prompted_declined` (default-restrictive). |

The dialplan amendment (§11) gates `record_session` on `${consent_record_enabled}` (a bool C02 derives from `consent_status`).

### 10.2 ← T01 (UUIDRecord primitive) — INPUT

Per T01 PLAN §16.6 / §17.6, T01 exposes `UUIDRecord(ctx, fsHost, callUUID, action, path)` where action ∈ {start, stop, mask, unmask}. R01 calls this for every imperative recording action. Payload of the `UUIDRecord` Go type and error semantics are owned by T01.

R01 also consumes T01's two recording event streams (`events:vici2.recording.started`, `events:vici2.recording.stopped`) via the T01 stream consumer in `workers/`.

### 10.3 ← T04 (originate) — INPUT

T04 sets the recording channel-vars in the originate channel-var blob BEFORE `&park()`:
```
{origination_uuid=...,RECORD_STEREO=true,RECORD_MIN_SEC=2,recording_follow_transfer=true,media_bug_answer_req=true,record_beep_pre=tone:%(500,0,800),tenant_id=1,campaign_id=SOLAR_Q2,lead_id=4287,...}sofia/gateway/...
```

T04 also triggers `StartRecording` on call answer for ONDEMAND mode if the agent has pre-armed it (rare; usually agent presses Record mid-call via A05).

### 10.4 → R02 (S3 upload worker) — OUTPUT

R02 consumes:
- Redis stream `events:vici2.recording.stopped` (T01 fan-out).
- `recording_log` row (written by T01 stream consumer in `workers/recording-log-writer/`).

R02 produces:
- UPDATE `recording_log SET storage_url='s3://bucket/<path>'`.
- INSERT into `recordings` with `lifecycle_state='encoding'` → `'available'`.
- Local file deletion ONLY after:
  - `recording_log.lifecycle_state='uploaded'` AND
  - SHA-256 verify passes AND
  - `recordings.deletion_pending=true` set + grace period (>1h) elapsed AND no R03 in-flight access.

This addresses the R02-deletion-vs-R03-streaming race noted in RESEARCH §11.10. R02 PLAN owns the implementation; R01 PLAN documents the contract.

R01 does NOT delete local files. R01 does NOT touch S3. Clear separation.

### 10.5 → R03 (playback) — OUTPUT

R03 reads:
- `recordings.share_token` for shareable links.
- `recording_log` for metadata (duration, codec, file_path).
- The on-disk WAV (Phase 1) or S3 (post-upload) for streaming.

R01's contract to R03: file path is deterministic (per §3); stereo (verifiable via `ffmpeg -i ... 2>&1 | grep Audio` reporting `stereo`); WAV PCM s16le.

### 10.6 → O01 (observability) — OUTPUT

R01 emits the metrics in §7.5; O01's "Recording" Grafana panel pulls them. Alert rules per §7.5.

### 10.7 → F03 (FreeSWITCH base) — AMENDMENT REQUEST

R01 IMPLEMENT files a small XML amendment to F03 — see §11 below.

### 10.8 → R01.md spec edit

R01 IMPLEMENT updates R01.md spec text to drop `${start_epoch}` from the filename template (already dropped by F03 PLAN §14.2; R01.md must align).

---

## 11. F03 amendment request (R01 IMPLEMENT files this)

R01 IMPLEMENT will file a small XML amendment to F03 covering:

### 11.1 Channel-vars on customer leg (set BEFORE answer / before bridge)

In `freeswitch/conf/dialplan/default/30_recording.xml` (new file, R01-owned):

```xml
<include>
  <!-- Set recording channel-vars on the customer leg.
       Invoked by T03's customer_into_agent_conf extension via execute_extension
       BEFORE C02's consent gate and BEFORE the conference action. -->
  <extension name="recording_vars" continue="true">
    <condition>
      <action application="set" data="media_bug_answer_req=true"/>
      <action application="set" data="RECORD_STEREO=true"/>
      <action application="set" data="RECORD_MIN_SEC=2"/>
      <action application="set" data="recording_follow_transfer=true"/>
      <!-- Single pre-start beep tone (jurisdictions requiring notification).
           Phase 2: continuous beep via displace_session beep.wav loop. -->
      <action application="set" data="record_beep_pre=tone_stream://%(500,0,800)"/>
    </condition>
  </extension>

  <!-- Conditional record_session — only fires if C02 set consent_record_enabled=true
       AND campaign mode != NEVER/ONDEMAND. T03 sets recording_mode_skip=true for
       NEVER/ONDEMAND so we short-circuit. -->
  <extension name="record_session_if_enabled">
    <condition field="${recording_mode_skip}" expression="^true$">
      <action application="log" data="INFO recording skipped: mode=${recording_mode}"/>
    </condition>
    <condition field="${consent_record_enabled}" expression="^true$">
      <action application="record_session"
              data="$${recordings_dir}/$${tenant_id}/${strftime(%Y/%m/%d)}/${campaign_id}_${lead_id}_${uuid}.wav"/>
    </condition>
  </extension>
</include>
```

### 11.2 Wiring into T03's `customer_into_agent_conf` extension

T03's existing extension (per F03 PLAN §4.2 / line ~510) already sets some recording vars inline. The amendment cleans this up by replacing inline `<action set>`s with two `execute_extension` calls:

```xml
<extension name="customer_into_agent_conf">
  <condition field="destination_number" expression="^conf_(\d+)$">
    <action application="answer"/>
    <!-- Recording channel-vars (R01-owned; in 30_recording.xml) -->
    <action application="execute_extension" data="recording_vars XML default"/>
    <!-- C02 consent gate (sets consent_record_enabled) -->
    <action application="execute_extension" data="recording_consent_check XML default"/>
    <!-- Conditional record_session (R01-owned; gates on consent + mode) -->
    <action application="execute_extension" data="record_session_if_enabled XML default"/>
    <!-- Join the conference -->
    <action application="conference" data="agent_$1@default+flags{endconf=false}"/>
    <action application="hangup"/>
  </condition>
</extension>
```

### 11.3 Why this amendment (rationale for F03 reviewer)

- Centralizes recording vars in one R01-owned XML file (separation of concerns).
- Adds `media_bug_answer_req=true` (defense-in-depth pre-answer guard).
- Adds `record_beep_pre` for jurisdictional beep notification (Phase 1 single beep).
- Makes the `record_session` action conditional on consent (C02) + mode (campaign config), rather than unconditional as in current F03 PLAN §4.2.
- Preserves `recording_follow_transfer=true` and `RECORD_STEREO=true` per existing F03 PLAN §14.2 commitments.

### 11.4 Files added by amendment

| Path | Owner | Purpose |
|---|---|---|
| `freeswitch/conf/dialplan/default/30_recording.xml` | R01 | New file, contents per §11.1 |
| `freeswitch/conf/dialplan/default/15_agent_conf.xml` (or wherever T03 lives) | T03 (R01 patches) | Amend `customer_into_agent_conf` per §11.2 |

### 11.5 Files NOT changed

- `freeswitch/conf/sip_profiles/external/*` — `record-template` already correct per F03 PLAN §10.
- `freeswitch/conf/autoload_configs/modules.conf.xml` — `mod_sndfile` and `mod_dptools` already loaded per F03 PLAN §8.

---

## 12. Tests

### 12.1 Unit tests (Go) — `dialer/internal/recording/*_test.go`

| Test | What |
|---|---|
| `TestComputePath_StandardCase` | tenant=1, campaign="SOLAR_Q2", lead=4287, uuid=fixed → exact expected path |
| `TestComputePath_DateBoundary` | started_at at 23:59:59 UTC vs 00:00:00 UTC produces correct YYYY/MM/DD |
| `TestComputePath_TenantIsolation` | different tenant_ids never collide |
| `TestStatus_StartTracksInValkey` | `StartRecording` writes HASH with correct fields |
| `TestStatus_PauseUpdatesState` | `PauseRecording` flips state=masked, increments pause_count |
| `TestStatus_StopDeletes` | T01 stream consumer simulation deletes HASH on RECORD_STOP |
| `TestPause_ForbiddenInALLFORCE` | `PauseRecording` returns ErrModeForbidden when mode=ALLFORCE |
| `TestStart_RequiresConsent` | `StartRecording` returns ErrConsentMissing when consent_status absent |
| `TestErrors_TypedErrors` | All error types are exported and matchable via errors.Is |

### 12.2 Integration tests (docker-compose; requires F03 IMPLEMENT)

| Test | What |
|---|---|
| `recording_basic_e2e.sh` | Place SIPp call → expect WAV at predicted path; assert exists, non-zero, > 2s |
| `recording_stereo_verify.sh` | `ffmpeg -i recording.wav 2>&1 \| grep Audio` reports `stereo`; `ffmpeg -map_channel 0.0.0 left.wav -map_channel 0.0.1 right.wav` produces two distinct mono files |
| `recording_follow_transfer.sh` | Place call, transfer mid-call, expect single WAV that grew across the transfer (duration > pre-transfer duration) |
| `recording_pause_resume.sh` | Call, mask 5s, unmask, verify recording has audible silence in middle |
| `recording_disk_full.sh` | Fill scratch volume, place call, assert: call completes, recording_log row has lifecycle_state='failed', call NOT hung up |
| `recording_consent_declined.sh` | C02 prompts, customer presses 2 (decline), no recording file created, recording_log row exists with `consent_status='prompted_declined'` |
| `recording_mode_NEVER.sh` | Set campaign mode=NEVER, place call, no recording file created |
| `recording_mode_ONDEMAND.sh` | Mode=ONDEMAND, no auto-record; mid-call POST /api/agent/recording {action:'start'}, verify recording starts mid-call |

### 12.3 Manual verification (R01 VERIFY phase)

1. Place 30s test call; speak as customer (read), agent speaks (write).
2. `soxi recording.wav` reports `Channels: 2`, `Sample Rate: 8000`, `Precision: 16-bit`.
3. `ffmpeg -i recording.wav -map_channel 0.0.0 left.wav -map_channel 0.0.1 right.wav`.
4. Listen to left.wav: only customer voice. Listen to right.wav: only agent voice.
5. Repeat after 3-way transfer: stereo recording continues; right channel has agent + 3rd party.
6. Trigger pause mid-call; resume after 5s; verify single contiguous WAV with silence in middle.
7. Verify `recording_log` row has correct fields including `consent_status`, `byte_size`, `duration_sec`.

---

## 13. Resolution of RESEARCH open questions (all 13)

| # | Question | PLAN resolution |
|---|---|---|
| 1 | Drop `${start_epoch}` from filename? | **YES** — drop. UUID is already unique; F03 PLAN §14.2 already dropped. R01 IMPLEMENT updates R01.md spec text. |
| 2 | `record_sample_rate` override or auto? | **AUTO** — let codec drive. Don't override. |
| 3 | `RECORD_MAX_LEN` ceiling? | **NONE Phase 1** — let calls run as long as they want. Phase 2 considers 4-hour cap (14400s) configurable per campaign. |
| 4 | Multi-segment marker on transfer? | **SINGLE FILE** via `recording_follow_transfer=true`. No `RECORD_MARK` in Phase 1; transfer events captured in `audit_log` for QA. |
| 5 | recording_required handoff between R01 and C02? | **C02 owns enforcement; R01 owns mechanism.** C02 sets `consent_status`; R01 dialplan gates `record_session` on `consent_record_enabled`. `campaigns.opt_out_action` decides hangup vs continue-without-record (defined in C02 PLAN). |
| 6 | Mid-call recording-mode change? | **NOT SUPPORTED Phase 1.** Mode locks at call start. Supervisor can issue one-off `StopRecording(uuid)` for a specific call; bulk mode change applies to NEW calls only. |
| 7 | Encryption-at-rest on scratch? | **HOST-FS encryption (LUKS / dm-crypt)** documented in F03 deploy docs as recommended baseline. App-level encryption seam reserved for Phase 2. |
| 8 | Beep tone seam? | **Phase 1: single pre-start beep** via `record_beep_pre=tone_stream://%(500,0,800)`. Phase 2: continuous beep via `displace_session beep.wav loop` (mod_displace). |
| 9 | R01 own dialer worker or ride T01? | **RIDES T01** — uses T01's `UUIDRecord` primitive + T01's stream consumer in `workers/recording-log-writer/`. No separate process. |
| 10 | R02 deletion race with R03 streaming? | R02 only deletes after `recording_log.lifecycle_state='uploaded'` AND `recordings.deletion_pending=true` set + >1h grace AND no R03 in-flight. R03 PLAN documents POSIX-mmap'd-handle behavior on local FS. |
| 11 | Per-tenant stereo opt-out? | **YES** — `tenants.recording_stereo BOOLEAN DEFAULT TRUE`. D01 PLAN adds the column; R01 reads via T03/T04 dialplan var injection. |
| 12 | SHA-256 tamper-evidence? | **R02 computes on upload**; stored in `recordings.checksum` (R02 adds the column). Phase 2 (legal hold) requires; Phase 1 nice-to-have. |
| 13 | `RECORD_MIN_SEC` actually deletes short files? | **YES** — works because we set both `media_bug_answer_req=true` AND use `record_session`. VERIFY phase tests it explicitly (`recording_min_sec.sh`: place 1s call, confirm no file, confirm `recording_log` row written with `lifecycle_state='too_short'`). |

---

## 14. File inventory (R01 IMPLEMENT will create/modify)

### Created

| Path | Purpose |
|---|---|
| `dialer/internal/recording/record.go` | Recorder impl |
| `dialer/internal/recording/path.go` | ComputePath() |
| `dialer/internal/recording/status.go` | Valkey HASH r/w |
| `dialer/internal/recording/metrics.go` | Prometheus metrics |
| `dialer/internal/recording/errors.go` | Typed errors |
| `dialer/internal/recording/record_test.go` | Unit tests |
| `dialer/internal/recording/path_test.go` | Path computation tests |
| `dialer/internal/recording/status_test.go` | Status tracking tests |
| `freeswitch/conf/dialplan/default/30_recording.xml` | F03 amendment §11.1 |
| `workers/recording-log-writer/index.ts` | T01 stream consumer; writes `recording_log` |
| `workers/recording-log-writer/handlers.ts` | RECORD_STOP handler |
| `workers/recording-log-writer/package.json` | Node worker package |
| `freeswitch/tests/recording_basic_e2e.sh` | Integration test |
| `freeswitch/tests/recording_stereo_verify.sh` | Stereo verification |
| `freeswitch/tests/recording_follow_transfer.sh` | Transfer test |
| `freeswitch/tests/recording_pause_resume.sh` | Pause/resume test |
| `freeswitch/tests/recording_disk_full.sh` | Disk pressure test |
| `freeswitch/tests/recording_consent_declined.sh` | C02 integration |
| `freeswitch/tests/recording_mode_NEVER.sh` | Mode test |
| `freeswitch/tests/recording_mode_ONDEMAND.sh` | Mode test |
| `freeswitch/tests/recording_min_sec.sh` | Q13 verification |
| `spec/modules/R01/HANDOFF.md` | Hand-off doc with PCI caveat tooltip text |

### Modified

| Path | Change |
|---|---|
| `freeswitch/conf/dialplan/default/15_agent_conf.xml` (T03's file) | Replace inline recording-var actions with `execute_extension` per §11.2 |
| `spec/modules/R01.md` | Drop `${start_epoch}` from filename template; update public interface section |

### NOT modified (read only)

- T01 PLAN (`UUIDRecord` consumed as-is).
- F02 PLAN (`recording_log`, `recordings` schemas consumed as-is).
- C02 PLAN (`consent_status` channel-var read as-is).

---

## 15. STOP — PLAN complete

Per task constraint: PLAN.md only. NO Go code. NO XML beyond illustrative examples. R01 IMPLEMENT phase will produce the actual code/XML/tests.

**Next steps (NOT this PLAN's job):**
- R01 IMPLEMENT: write the Go package, file the F03 amendment, ship the integration tests.
- R02 RESEARCH/PLAN/IMPLEMENT: S3 upload worker (consumes the `recording_log` rows we write).
- R03 RESEARCH/PLAN/IMPLEMENT: web playback + share tokens.
- C02 PLAN: consent state machine + `consent_status` channel-var contract.

**End of R01 PLAN.md.**
