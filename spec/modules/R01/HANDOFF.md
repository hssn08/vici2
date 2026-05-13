# R01 — Per-Call Recording — HANDOFF

**Status:** DONE
**Date:** 2026-05-13
**Branch:** feat/R01-implement

---

## What was built

### Go package: `dialer/internal/recording/`

| File | Purpose |
|------|---------|
| `errors.go` | 6 typed error sentinels (`ErrRecordingFailed`, `ErrDiskFull`, `ErrConsentMissing`, `ErrModeForbidden`, `ErrCallNotActive`, `ErrAlreadyActive`) |
| `path.go` | `ComputePath()` — canonical path per R01 PLAN §3 + F03 PLAN §14.2 |
| `status.go` | Valkey HASH r/w for in-progress recording state (`t:{tid}:recording:{uuid}`) |
| `metrics.go` | 8 Prometheus metrics per R01 PLAN §7.5 |
| `record.go` | `Recorder` interface + `recorder` impl: `StartRecording / StopRecording / PauseRecording / ResumeRecording / RecordingStatus` |
| `record_test.go` | 12 unit tests covering all lifecycle paths |
| `path_test.go` | 4 path computation tests (standard case, date boundary, tenant isolation, no-epoch) |
| `status_test.go` | 6 Valkey HASH tests (write/read/set-state/del/paused_at) |

**All 22 Go tests pass.**

### Node.js worker: `workers/src/jobs/recording-log-writer/`

| File | Purpose |
|------|---------|
| `index.ts` | `RecordingLogWriter` class — XREADGROUP consumer on `events:vici2.recording.stopped`; writes `recording_log` row; dead-letters after 5 retries |
| `handlers.ts` | `statFile()` — `fs.stat()` wrapper for byte_size population |
| `index.test.ts` | 5 unit tests (happy path, DLQ on DB failure, individual-field parsing, constant assertions) |

**All 5 Node.js tests pass.**

### FreeSWITCH dialplan (F03 amendment)

| File | Change |
|------|--------|
| `freeswitch/conf/dialplan/default/30_recording.xml` | **NEW** — `recording_vars` + `record_session_if_enabled` extensions |
| `freeswitch/conf/dialplan/default/01_agent_conference.xml` | **AMENDED** — `customer_into_agent_conf` now uses `execute_extension` for recording_vars, consent check, and record_session_if_enabled |

### Integration test scripts

`freeswitch/tests/recording_*.sh` — 5 scripts:
- `recording_basic_e2e.sh` — places call; verifies WAV exists at expected path
- `recording_stereo_verify.sh` — ffprobe channel=2 + demux left/right
- `recording_pause_resume.sh` — mask/unmask via fs_cli; verifies single contiguous WAV
- `recording_mode_NEVER.sh` — verifies no file when `recording_mode_skip=true`
- `recording_consent_declined.sh` — verifies no file when `consent_record_enabled=false`

---

## Key contracts for downstream modules

### Path convention (frozen, per R01 PLAN §3)

```
${recordings_dir}/${tenant_id}/${YYYY}/${MM}/${DD}/${campaign_id}_${lead_id}_${call_uuid}.wav
```

`ComputePath(recordingsDir, tenantID, campaignID, leadID, callUUID, startedAt)` is the canonical Go implementation. Dialplan uses the same template via FreeSWITCH variable expansion.

**`${start_epoch}` is NOT in the filename** (R01 PLAN §3.1 — dropped; UUID provides global uniqueness).

### Valkey state key (R01 PLAN §7.4)

```
t:{tenant_id}:recording:{call_uuid}  — HASH, TTL 24h
Fields: path, state, started_at, paused_at, resumed_at, pause_count, campaign_id, lead_id
```

Deleted by `recording.DeleteStatus(ctx, rdb, tenantID, callUUID)` on `RECORD_STOP`.

### Valkey stream (T01 PLAN §17.4)

- Input stream: `events:vici2.recording.stopped` (consumer group `recording-log-writer`)
- Dead-letter: `events:vici2.dlq.recording`

### `recording_log` row

Written by `workers/src/jobs/recording-log-writer/` on `RECORD_STOP` event. Schema per F02 PLAN §4.26. `byte_size` from `fs.stat()`; `duration_sec` from `duration_ms / 1000`.

### C02 consent gate

`StartRecording` checks `ConsentStatus` field of `StartRequest`. Allowed values: `not_required`, `prompted_accepted`, `assumed`, `beep_only`, `prompted_assumed`. Any other value (including `prompted_declined` or empty) returns `ErrConsentMissing`.

Dialplan gate: `consent_record_enabled=true` (set by C02's `recording_consent_check` extension).

### Mode gate (T04 / API layer)

`recording_mode_skip=true` channel-var prevents `record_session` from firing in dialplan.
For ALLFORCE mode, API layer must return 403 on agent pause/resume before calling `PauseRecording` / `ResumeRecording`. R01's Go API does NOT check ALLFORCE — that is the API layer's responsibility per R01 PLAN §7.1.

---

## PCI caveat — MUST appear in admin UI tooltip on pause/resume controls

> "Mask/unmask reduces but does not eliminate PCI scope. Per PCI DSS 4.0.1
> (mandatory 2025-04-01) and PCI SSC 2024+ guidance, manual pause/resume is
> treated as obsolete for PCI compliance — any failure puts the recording
> system back in scope. Use a PCI-DSS-certified payment IVR or DTMF-suppression
> sidecar (e.g., PCI Pal, Eckoh, Semafone, Aeriandi) for actual cardholder-data
> capture in Phase 2+. R01 ships mask/unmask as table-stakes capability; we do
> NOT market this as PCI-compliant."

---

## What R01 does NOT do

- R01 does NOT upload to S3 → R02 owns that.
- R01 does NOT delete local files → R02 owns that.
- R01 does NOT check ALLFORCE mode → API layer (A05 / admin API) owns that.
- R01 does NOT compute SHA-256 checksums → R02 owns that.
- R01 does NOT transcode MP3 → R02 worker owns that.
- R01 does NOT enforce per-tenant XFS quotas → Phase 2.

---

## For R02

R02 consumes:
1. `events:vici2.recording.stopped` stream (T01 fan-out, same as R01's worker).
2. `recording_log` rows written by `workers/recording-log-writer`.

R02 then UPDATEs `recording_log.storage_url` and INSERTs into `recordings`.

File path for upload: use `recording_log.filename` (absolute local path).

---

## Tests run

```
go test ./dialer/internal/recording/... -v -count=1
# PASS: 22 tests

node --test --import tsx/esm workers/src/jobs/recording-log-writer/index.test.ts
# PASS: 5 tests
```
