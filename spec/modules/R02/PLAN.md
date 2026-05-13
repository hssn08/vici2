# R02 — Recording S3 Upload Pipeline — PLAN

| Field | Value |
|---|---|
| Module | R02 — asynchronous WAV shipper (FS-host local file → object store + verify + delete local) |
| Phase | 1 (MVP) |
| Owner agent type | backend-node + sre |
| Status | PLAN |
| Date | 2026-05-13 |
| Depends-on (DONE / PLAN-stable) | R01 (starts/stops; `recording_log` row write contract), F02 (`recordings` + `recording_log` tables), F03 (FS recording dir + channel-vars), F04 (Redis Streams consumer-group infra), C02 (consent_status contract), C03 (AuditWriter), O05 (secrets) |
| Blocks | R03 (playback pre-signed URLs), N07 (Whisper transcription in Phase 4), C04 (retention rotation verifier) |
| Source RESEARCH | [R02/RESEARCH.md](RESEARCH.md) |

---

## 1. Goals and non-goals

### 1.1 Goals — what R02 owns

R01 orchestrates: it starts and stops FreeSWITCH `record_session`, writes the `recording_log` row on `RECORD_STOP`, and emits `events:vici2.recording.stopped` on the Redis Stream. R02 ships: it picks up that event and is solely responsible for:

1. **Consuming** `events:vici2.recording.stopped` (Redis Stream consumer group `r02-uploader`).
2. **Consent gate** — reading `recording_log.consent_status`; routing to `recording-delete-local` job (no upload) when `consent_status ∈ {prompted_declined, assumed-but-skipped}`.
3. **SHA-256 integrity** — streaming the local WAV to compute a client-side SHA-256 before upload.
4. **Upload** — single `PutObject` (≤16 MB) or multipart `Upload` (>16 MB, 16 MB parts, 4 concurrent) to S3 with SSE-KMS + Object Lock Compliance.
5. **Verification** — `HeadObject` post-upload; confirm server-side checksum matches local SHA-256; on mismatch, delete the bad object and retry (max 3); if still failing, DLQ + SEV-1.
6. **DB state advance** — `UPDATE recording_log SET storage_url, sha256, size_bytes, lifecycle_state='uploaded'` (WHERE storage_url IS NULL — idempotent CAS); `INSERT recordings (lifecycle_state='available', deletion_pending=TRUE)` ON DUPLICATE KEY UPDATE.
7. **Local file deletion sweeper** — runs every 5 min; deletes local files where `recordings.deletion_pending=TRUE AND lifecycle_state='available' AND updated_at < now() - 1h`.
8. **Pre-signed URL service** — `getPlaybackUrl(tenantId, recordingLogId, actor, ttlSeconds=300)` → pre-signed S3 URL; consumed by R03.
9. **Legal hold** — `setLegalHold(tenantId, recordingLogIds[], on)` (called by C03 compliance workflow).
10. **Integrity verify API** — `verifyIntegrity(recordingLogId)` → HEAD + SHA-256 comparison; consumed by C03 audit verifier.
11. **Prometheus metrics** — `vici2_recording_upload_*` family (§14).
12. **Audit emit** — every significant event calls C03 `AuditWriter.append(...)`.

### 1.2 Non-goals (explicit)

| Deferred to | What |
|---|---|
| **R01** | `record_session` start/stop; `recording_log` row INSERT; `RECORD_STOP` event emit |
| **R03** | Browser playback UI, `<audio>` element, waveform scrubbing, share-token UI; R03 calls R02's `getPlaybackUrl()` helper |
| **R03 Phase 2** | On-demand MP3/Opus transcode for playback (not needed in 2026; browser WAV support is universal) |
| **N07 (Phase 4)** | Whisper transcription; reads R02-uploaded WAV from S3; R02 grants N07's IAM role `s3:GetObject` on `tenants/<tid>/calls/*` |
| **C04** | 7-year retention worker (Lifecycle rule + Object Lock expiry handle S3 deletion; C04 verifies) |
| **Phase 2** | Multi-region CRR (Cross-Region Replication) |
| **Phase 2** | Opus secondary-copy (behind `tenants.settings.recording_secondary_opus=true`; not Phase 1) |
| **Phase 2** | PCI-Pal / Eckoh DTMF-suppression integration (R01 Phase 2 concern; R02 ships whatever bytes FS produced) |
| **Phase 2** | App-level libsodium encryption on top of SSE-KMS |
| **F05** | KMS CMK provisioning (`alias/vici2-tenant-<tid>-recordings`); R02 reads `tenants.settings.kms_key_arn` |
| **C03** | Audit log chain immutability; R02 calls C03's `AuditWriter`, does not write to `audit_log` directly |
| **C03** | Legal hold UI — legal hold is a compliance act, surfaced only in C03 operator API, not in M01 campaign editor |

---

## 2. File format decision (frozen)

**Phase 1 format at rest: WAV PCM signed 16-bit little-endian, stereo, sample rate driven by carrier codec.**

| Inbound codec | WAV rate |
|---|---|
| PCMU / PCMA (G.711) — Phase 1 default | 8 kHz |
| G.722 | 16 kHz |
| Opus @ 16 kHz | 16 kHz |

R02 does not invoke ffmpeg. It ships whatever bytes `record_session` wrote to disk.

**Why WAV, not MP3 or Opus:**

1. **Evidentiary chain of custody.** PCM is lossless; per NIST SP 800-86 §3.4 and FRE 901(b)(1) precedent, WAV PCM is the de-facto format for legal-evidence audio. A lossy codec can be challenged as a "modified original" in TCPA discovery.
2. **Stereo channel separation preserved for N07.** Left=customer, right=agent (R01 PLAN §2.1). N07 (Phase 4 Whisper) demuxes channels via `ffmpeg -map_channel`; this works cleanly on PCM s16le but degrades with joint-stereo MP3.
3. **Browser-native in 2026.** Chrome, Firefox, Safari (including iOS 17+), Edge all play WAV PCM natively via `<audio src="…">`. The "browser-friendly MP3" argument is 2010-era.
4. **Storage cost is acceptable.** At Glacier IR pricing ($0.004/GB-mo) a 100-agent-tenant at Phase 2 saturation (57 GB/day) costs ~$80/mo for cold storage. A 50% reduction via Opus mono saves only ~$40/mo and loses stereo channel separation.

Opus secondary-copy for cost-sensitive tenants is reserved as a Phase 2 option (`tenants.settings.recording_secondary_opus=true`). Phase 1 ships WAV only.

---

## 3. S3 path scheme (frozen)

```
s3://<bucket>/tenants/<tenant_id>/calls/<YYYY>/<MM>/<DD>/<call_uuid>.wav
```

**Concrete example:**
```
s3://vici2-recordings-prod-us-east-1/tenants/1/calls/2026/05/06/8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav
```

**Design decisions:**

- `tenants/<tid>/` prefix first — enables tenant-scoped IAM policies (`arn:aws:s3:::bucket/tenants/42/*`) and per-tenant KMS cryptographic isolation.
- `calls/<YYYY>/<MM>/<DD>/` — Hive-style partition; Athena (Phase 4 analytics) understands it natively; aligns with retention-sweep "delete all of 2019-04".
- Object name is `<call_uuid>.wav` only (no campaign/lead prefix). Campaign and lead metadata go in S3 object metadata (`x-amz-meta-campaign-id`, `x-amz-meta-lead-id`), not the key — prevents PII leakage through CloudTrail logs and pre-signed URL referrer headers. Shorter keys also cost less in S3's prefix partitioner.
- S3 auto-partitions internally at up to 3,500 PUT/s per prefix. At Phase 1 scale (100 tenants × ~14 PUT/s per tenant per day-prefix) we are 250× below the threshold; no hash-spreading needed.
- Shared bucket with per-tenant prefix (Phase 1). Per-tenant bucket is the Phase 4 white-label option; tenant isolation is enforced cryptographically via per-tenant KMS CMK.

**Rejected alternatives:**

| Pattern | Reason rejected |
|---|---|
| `s3://bucket/<YYYY>/<MM>/<DD>/<uuid>.wav` | No tenant prefix; no tenant-scoped IAM policies |
| `s3://bucket/<uuid>.wav` (flat) | Prefix-based lifecycle rules and retention sweeps impossible |
| `s3://bucket/<sha[0:4]>/tenants/…` (hashed prefix) | Fragments prefix space for lifecycle rules; not needed at Phase 1 scale |
| Embed phone/campaign in key | PII leakage via CloudTrail + pre-signed URL referrer headers |

**Storage URI in `recording_log.storage_url` (`VARCHAR(512)`):**
```
s3://vici2-recordings-prod-us-east-1/tenants/1/calls/2026/05/06/8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav
```
Max length ≈ 5 + 40 + 80 < 200 characters. Fits comfortably in 512.

---

## 4. Storage: S3 Standard → Glacier Instant Retrieval lifecycle + SSE-KMS + Object Lock Compliance 7yr

### 4.1 Storage class lifecycle (Terraform / Lifecycle rule)

```yaml
LifecycleConfiguration:
  Rules:
    - Id: TransitionToGIRAt30Days
      Status: Enabled
      Filter:
        Prefix: tenants/
        ObjectSizeGreaterThan: 0      # override AWS 2024-09 128 KB default floor
      Transitions:
        - Days: 30
          StorageClass: GLACIER_IR
    - Id: ExpireAfter7Years
      Status: Enabled
      Filter:
        Prefix: tenants/
      Expiration:
        Days: 2557                    # 7 × 365.25 days
    - Id: AbortIncompleteMultipart
      Status: Enabled
      Filter:
        Prefix: tenants/
      AbortIncompleteMultipartUpload:
        DaysAfterInitiation: 7
```

**Rationale for Glacier Instant Retrieval over Standard-IA:**
- GIR = $0.004/GB-mo; Standard-IA = $0.0125/GB-mo — GIR is 3.1× cheaper at rest.
- Millisecond first-byte (no `RestoreObject` ceremony unlike Deep Archive).
- At 100-agent Phase 2 saturation (57 GB/day) the year-7 cold-storage bill is ~$594/mo in GIR vs ~$1,850/mo in Standard-IA.
- 90-day minimum storage charge in GIR is irrelevant at 7-year retention.

**Default backend:** `s3` (AWS). Pluggable via `R02_STORAGE_BACKEND ∈ {s3, r2, b2, minio}` env var; all use `@aws-sdk/client-s3` v3 with backend-specific endpoint config. MinIO is the `make dev` default.

### 4.2 SSE-KMS + Bucket Keys (mandatory)

Every PutObject carries:
```
ServerSideEncryption: 'aws:kms'
SSEKMSKeyId: alias/vici2-tenant-<tid>-recordings   # F05 provisions
BucketKeyEnabled: true
```

**Per-tenant CMK** (not a shared key with prefix conditions): a leaked IAM role for tenant A cannot decrypt tenant B's objects. Each CMK is ~$1/mo; 100 tenants = $100/mo KMS keys.

**Bucket Keys mandatory**: without Bucket Keys, every `GetObject` (replay) = 1 KMS Decrypt call. At 100 agents × 100 QA replays/day × 100 tenants = 1M KMS calls/day = ~$3/day = $1,100/yr. With Bucket Keys, KMS request volume drops 99% (~$0.03/day).

SSE-C is explicitly rejected: disabled-by-default for new buckets since AWS April 2026; incompatible with N07 (Whisper) cross-service access and pre-signed URLs.

### 4.3 Object Lock COMPLIANCE — 7 years, per-object retention

Versioning ON is mandatory for Object Lock (S3 enforces this at bucket creation).

**Per-object retention (not bucket-default):** every PutObject carries:
```
ObjectLockMode: 'COMPLIANCE'
ObjectLockRetainUntilDate: new Date(Date.now() + tenant.settings.recordingRetentionYears * 365.25 * 86400 * 1000)
```

Default `tenants.settings.recording_retention_years = 7` (operator can extend; minimum 5 enforced in admin UI).

**Why Compliance, not Governance:**
Governance mode can be bypassed by any IAM principal with `s3:BypassGovernanceRetention`. Compliance mode means even the root account cannot shorten retention or delete the object before the retain-until date expires. TSR §310.5 (2024-03 update) requires 5-year retention; TCPA safe-harbor + state mini-TCPAs (FL FTSA, CA CIPA) push the safe floor to 7 years.

**Why per-object retention:** if TCPA/TSR raises the floor (e.g., FCC 10-year rule in 2027), the change applies only to new uploads. Old objects keep their original `RetainUntilDate`. Bucket-default retention would lock new objects with whatever was configured at bucket-creation time and cannot be updated retroactively.

**Legal hold** (independent of retention period) is toggled by C03's `setLegalHold()` workflow — a separate `PutObjectLegalHold` API call. Lifecycle rules respect legal holds; an object with a hold will NOT be deleted at year 7 until the hold is released.

**Idempotency + Versioning interaction:**
- Bucket Versioning is ON (mandatory for Object Lock).
- On the first attempt (BullMQ `job.attemptsMade === 0`): blind PutObject.
- On retry (`job.attemptsMade > 0`): HEAD first; if `x-amz-meta-client-sha256` matches local SHA-256, skip upload and advance to the DB UPDATE step (verify-and-record-only). This avoids creating duplicate locked versions, which would incur double storage cost for 7 years.

---

## 5. Upload strategy + SHA-256 integrity

### 5.1 Threshold

| Object size | Strategy |
|---|---|
| ≤ 16 MB | Single `PutObject` with `ChecksumAlgorithm: 'SHA256'` |
| > 16 MB | `@aws-sdk/lib-storage` `Upload` (multipart, 16 MB parts, `queueSize: 4`) |

The 16 MB threshold is chosen because:
- Most calls (6-min average × 32 KB/s) = 11.5 MB; single-PUT handles the typical case.
- Long calls (4-hr debt-collection = 460 MB) genuinely benefit from multipart concurrency.
- Memory: 4 concurrent parts × 16 MB = 64 MB per upload; 10 concurrent uploads = 640 MB; fits on a `t3.large`.
- 16 MB × 10,000 parts = 160 GB ceiling per object — well above the 460 MB worst case.

### 5.2 SHA-256 checksum protocol

**Client-side SHA-256 is computed by streaming the file once before upload.** This is a cryptographic-strength integrity check layered on top of S3's native per-part CRC32 (SDK v3 ≥ 3.700 default).

SHA-256 is chosen (not CRC32) because:
- Preimage resistance: a malicious insider cannot craft a substituted recording that passes CRC32.
- Consistent with C03's hash-chain algorithm on `audit_log`.
- NIST SP 800-86 / FRE 901 legal evidence chain-of-custody standard.

For **single PutObject** (≤ 16 MB):
1. Stream the file once → compute `sha256Hex`.
2. Pass `ChecksumSHA256: base64(sha256Hex)` to `PutObjectCommand`.
3. S3 stores the checksum natively as `x-amz-checksum-sha256`.
4. Post-upload `HeadObject` confirms `x-amz-checksum-sha256` matches.

For **multipart** (> 16 MB):
1. Stream the file once → compute full-object `sha256Hex`.
2. Store full-object SHA-256 as `Metadata['client-sha256']` on `CreateMultipartUpload` call.
3. SDK computes composite per-part SHA-256 (Merkle root) for transport integrity.
4. Post-upload `HeadObject` confirms `x-amz-meta-client-sha256` matches local computation.

**Verification failure handling:**
- Mismatch → delete the object (`DeleteObject`), retry upload.
- 3 consecutive SHA-256 mismatches → DLQ + SEV-1 page (data corruption suspected).

SHA-256 hex string is written to `recording_log.sha256 BINARY(32)` (R02 schema amendment — see §6).

---

## 6. Schema amendments required (F02 amendment batch)

R02 IMPLEMENT files these as a single Prisma migration in coordination with the C02 amendment batch.

### 6.1 `recording_log` — add columns

```prisma
// New columns on RecordingLog:
sha256         Bytes?                  @map("sha256") @db.Binary(32)
lifecycleState RecordingLogLifecycle   @default(recording_complete) @map("lifecycle_state")
failureReason  String?                 @map("failure_reason") @db.VarChar(64)
```

```prisma
enum RecordingLogLifecycle {
  recording_complete          // R01 wrote row; awaiting R02
  uploading                   // R02 picked up; upload in-flight
  uploaded                    // confirmed in S3; local file still present
  available                   // sweep complete; local file deleted; S3 is authoritative
  failed                      // R01 or R02 terminal failure
  corrupt                     // SHA-256 mismatch after 3 retries
  consent_declined_no_upload  // C02 prompted_declined or skipped → local file deleted without upload
  orphan                      // RECORD_STOP event fired but file not found on disk
  too_short                   // duration_sec < RECORD_MIN_SEC
}
```

### 6.2 `recordings` — add `deletion_pending` column

F02 PLAN §4.18 already provisions `lifecycle_state`, `legal_hold`, `s3_storage_class`, `share_token`. R02 adds:

```prisma
// New column on Recording:
deletionPending Boolean @default(false) @map("deletion_pending")
```

This is the two-phase delete flag: set to `TRUE` after upload+verify; sweeper sets to `FALSE` after `fs.unlink`.

### 6.3 `tenants.settings` JSON shape (documentation only; no schema change)

```json
{
  "recording_backend": "s3",
  "recording_bucket": "vici2-recordings-prod-us-east-1",
  "recording_prefix": "tenants/1/",
  "recording_retention_years": 7,
  "kms_key_arn": "arn:aws:kms:us-east-1:123456789012:alias/vici2-tenant-1-recordings",
  "recording_secondary_opus": false,
  "consent_declined_grace_minutes": 5
}
```

R02 reads `tenants.settings` (already a `Json` column per F02 §4.1) at job startup; caches by `tenant_id` with 60s TTL. Validated with Zod on read.

---

## 7. Worker architecture (two-layer: Redis Stream consumer + BullMQ retry)

### 7.1 Overview

```
events:vici2.recording.stopped  (T01 emits via recording-log-writer; second consumer group here)
            │
            ▼
  Stream consumer (r02-uploader group)
  workers/recording-uploader/src/stream-consumer.ts
            │
            ├─ consent_status ∈ {prompted_declined, skipped}?
            │       ↓ YES
            │   enqueue BullMQ 'recording-delete-local' job (5-min delay)
            │       ↓ NO
            └─ enqueue BullMQ 'recording-upload' job
                        │
                        ▼
            BullMQ worker pool (10 concurrent)
            workers/recording-uploader/src/jobs/
                        │
                        ├─ hash file (SHA-256 stream)
                        ├─ upload (single-PUT or multipart)
                        ├─ HEAD verify
                        ├─ UPDATE recording_log (idempotent CAS)
                        ├─ INSERT recordings (ON DUPLICATE KEY UPDATE)
                        ├─ AuditWriter.append('recording.uploaded')
                        └─ Prometheus metrics
```

**Why two layers:**
- Stream consumer is a thin router (μs per message); it acks the stream message immediately after enqueue. A stream-level XAUTOCLAIM after 60s handles router crashes.
- BullMQ job owns the heavy work (file I/O, SHA-256, multipart upload, DB updates) with exponential-backoff retries and a dead-letter queue — semantics that Redis Streams alone cannot express cleanly.

### 7.2 Stream consumer

```
STREAM:   events:vici2.recording.stopped
GROUP:    r02-uploader
CONSUMER: r02-uploader-<HOSTNAME>-<PID>
BLOCK:    5000 ms
COUNT:    10 messages per XREADGROUP
XAUTOCLAIM: 60 000 ms idle (re-deliver stuck messages)
```

On `recording_log` row not yet written (race with recording-log-writer): throw `row-not-found-retry`; XAUTOCLAIM re-delivers after 60s.

### 7.3 BullMQ job: `recording-upload`

```typescript
{
  attempts: 8,
  backoff: { type: 'exponential', delay: 30_000 },  // base 30s; ±25% jitter added
  removeOnComplete: 100,
  removeOnFail: 1000,
  jobId: recordingLogId.toString(),   // BullMQ-level idempotency key
}
```

After 8 BullMQ attempts (cumulative ~1.05 hr wall-clock), job moves to a delayed-retry queue:

| Delayed retry | Wait | Cumulative from first attempt |
|---|---|---|
| DR-1 | 1 hr | ~2 hr |
| DR-2 | 4 hr | ~6 hr |
| DR-3 | 18 hr | ~24 hr |
| Terminal DLQ | — | ~30 hr |

Local file is **NOT deleted** while job is in retry or DLQ state.

### 7.4 Worker concurrency tuning

- `concurrency: 10` per worker process.
- Memory: 10 × (4 parts × 16 MB) = 640 MB peak; fits on `t3.large` (8 GB).
- Phase 1: 1 worker process; Phase 2: 2–3 auto-scaled by BullMQ queue depth.

### 7.5 Deployment model: Model B (remote workers pool, NFS mount)

FS hosts export `/var/lib/freeswitch/recordings` via NFSv4. The recording-uploader worker pool mounts it at `/recordings`. R02 reads local files over NFS, uploads to S3, and sweeps via NFS unlink.

Rationale over Model A (co-resident on FS host): horizontal scale of worker pool independent of FS-host count; one container image; same workers pool as recording-log-writer (R01). Phase 2 option to switch to Model A for tenants with high NFS saturation (>50 Mbps average).

---

## 8. Consent enforcement

R02 reads `recording_log.consent_status` before deciding whether to upload. C02 sets this column via the channel-var `vici2_consent_status` → `recording_log.consent_status` contract.

| consent_status value | R02 action |
|---|---|
| `not_required` | Upload to S3 (1-party state; recording allowed without prompt) |
| `prompted_accepted` | Upload to S3 |
| `assumed` | Upload to S3 |
| `prompted_declined` | Do NOT upload; enqueue `recording-delete-local` with `tenants.settings.consent_declined_grace_minutes` (default 5 min) delay; set `lifecycle_state='consent_declined_no_upload'`; audit `recording.consent_declined_no_upload` |
| `skipped` (C02 SKIP decision) | Same as `prompted_declined` — delete local without upload |

The 5-minute grace period on delete allows a supervisor to intervene if C02 misfired (e.g., a typo in state configuration). After grace, the local file is deleted immediately; no S3 copy is ever created.

Audit row emitted regardless of path: `recording.consent_declined_no_upload` or `recording.uploaded`.

---

## 9. Local file deletion — two-phase delete + sweeper

### 9.1 Race-condition design

After upload+verify, R02 does NOT immediately delete the local file. Instead:

**Phase 1 (post-verify — synchronous in the BullMQ job):**
```sql
UPDATE recording_log
  SET storage_url = ?, sha256 = ?, size_bytes = ?, lifecycle_state = 'uploaded', encoded_at = NOW(6)
  WHERE id = ? AND start_time = ? AND storage_url IS NULL;   -- idempotent CAS

INSERT INTO recordings (tenant_id, recording_log_id, lifecycle_state, s3_storage_class, deletion_pending, created_at)
  VALUES (?, ?, 'available', 'STANDARD', TRUE, NOW(6))
  ON DUPLICATE KEY UPDATE lifecycle_state = 'available', deletion_pending = TRUE;
```

**Phase 2 (sweeper — every 5 minutes, same worker process):**
```sql
SELECT r.*, rl.filename
  FROM recordings r JOIN recording_log rl ON r.recording_log_id = rl.id
  WHERE r.deletion_pending = TRUE
    AND r.lifecycle_state = 'available'
    AND r.updated_at < NOW() - INTERVAL 1 HOUR
  LIMIT 1000;
```
For each row: `fs.unlink(filename)` → on success: `UPDATE recordings SET deletion_pending = FALSE` → emit `recording.local_deleted` audit row. On `ENOENT`: mark done (file already gone). On other errors: log + continue; retry next sweep cycle.

### 9.2 Why 1-hour grace

R03 may have started a stream of the local file before the DB row updated. POSIX open-unlink semantics keep the inode alive for readers that already hold an fd open. But a NEW request arriving after the `recordings` row is updated with `deletion_pending=TRUE` falls back to the `s3_path` / `storage_url` in `recording_log` automatically. 1 hour is generous; typical R03 playback is <10 min.

### 9.3 Sweeper ownership

R02 owns the sweeper (not E06 / channel+conference janitor). R02 already holds the recording-lifecycle DB contract; splitting ownership across two services in different languages (Node vs Go) adds operational overhead. Sweeper runs in the same process as the uploader workers.

---

## 10. Idempotency contract

| Layer | Mechanism |
|---|---|
| Redis Stream | XAUTOCLAIM re-delivers if consumer crashes before XACK; stream consumer enqueues again with same BullMQ `jobId = recordingLogId.toString()` — BullMQ deduplicates by jobId within its queue |
| BullMQ job | `jobId = recordingLogId.toString()` prevents duplicate active jobs |
| S3 upload (first attempt) | Blind PutObject; no pre-HEAD |
| S3 upload (retry, `job.attemptsMade > 0`) | HEAD first; if object exists with matching `x-amz-meta-client-sha256`, skip upload, proceed to DB UPDATE |
| DB UPDATE | `WHERE storage_url IS NULL` — no-op if already set |
| DB INSERT recordings | `ON DUPLICATE KEY UPDATE` — idempotent |
| Sweeper | ENOENT on unlink is treated as success; `deletion_pending = FALSE` update is idempotent |

The retry-only HEAD avoids creating duplicate locked S3 object versions (which would incur 7 years × double storage cost per duplicate).

---

## 11. Failure policy

### 11.1 Failure catalog

| # | Failure | Detection | Action | DLQ? |
|---|---|---|---|---|
| 1 | Local file truncated (disk full) | `size_bytes` from `recording_log` vs `statSync()` mismatch | `lifecycle_state='corrupt'`; audit; do NOT upload; alert SEV-2 | Yes |
| 2 | Local file missing (ENOENT) | `fs.stat` fails | If `lifecycle_state='failed'` from R01: expected; mark orphan. Else: alert SEV-2 | Yes (unexpected) |
| 3 | S3 503 Slow Down | HTTP status | BullMQ exponential backoff | Within attempts |
| 4 | S3 5xx server error | HTTP status | Retry | Within attempts |
| 5 | Network timeout mid-upload | SDK error | Retry; multipart resume handled by SDK | Within attempts |
| 6 | KMS ThrottlingException | Error code | Exponential backoff (Bucket Keys reduces frequency 99%) | Within attempts |
| 7 | KMS key disabled / deleted | `DisabledException` / `NotFoundException` | FATAL; SEV-1 page; DLQ immediately | Yes |
| 8 | Object Lock policy mismatch (bucket not configured) | S3 `InvalidRequest` | FATAL; SEV-1; DLQ immediately | Yes |
| 9 | SHA-256 mismatch post-upload | HEAD comparison | Delete bad object; retry (max 3); after 3: DLQ + SEV-1 (corruption) | After 3 |
| 10 | `recording_log` row not yet written (race) | Prisma returns null | `row-not-found-retry`; XAUTOCLAIM after 60s | No |
| 11 | Consent declined | `consent_status` check | Enqueue `recording-delete-local`; no upload | n/a |
| 12 | Tenant has no S3 config | `tenants.settings.recording_bucket` undefined | FATAL; SEV-2; DLQ; admin must onboard tenant | Yes |
| 13 | BullMQ Redis connection lost | Error event | Reconnect with backoff; PEL (Pending Entry List) jobs survive | No |
| 14 | Worker OOM mid-multipart | Process kill | systemd/k8s restart; XAUTOCLAIM + BullMQ PEL re-deliver | No |
| 15 | DB write fails after successful S3 upload | Prisma error | Retry from HEAD verify step (idempotent: `WHERE storage_url IS NULL`) | Within attempts |

### 11.2 Exponential backoff table

| BullMQ attempt | Base delay before attempt | Cumulative wall-clock |
|---|---|---|
| 1 (initial) | 0 | 0 |
| 2 | 30 s ± 25% jitter | ~30 s |
| 3 | 60 s | ~90 s |
| 4 | 120 s | ~3.5 min |
| 5 | 240 s | ~7.5 min |
| 6 | 480 s | ~15.5 min |
| 7 | 960 s | ~31.5 min |
| 8 | 1920 s | ~1.05 hr |
| Delayed retry DR-1 | 1 hr | ~2 hr |
| Delayed retry DR-2 | 4 hr | ~6 hr |
| Delayed retry DR-3 | 18 hr | ~24 hr |
| **Terminal DLQ + SEV-3** | — | ~30 hr |

±25% jitter (uniform random) prevents thundering-herd retries after S3 regional incidents.

### 11.3 Defensive pre-checks before PutObject

```typescript
function validateUploadParams(event, key, retainUntil) {
  assert(event.tenantId > 0n, 'invalid tenant');
  assert(/^[0-9a-f-]{36}$/.test(event.callUuid), 'invalid call UUID');
  assert(key.startsWith(`tenants/${event.tenantId}/`), 'key/tenant mismatch — path injection defense');
  assert(retainUntil.getTime() > Date.now() + 365 * 86400 * 1000, 'retention < 1 year — date arithmetic bug');
  assert(retainUntil.getTime() < Date.now() + 10 * 365.25 * 86400 * 1000, 'retention > 10 years — date arithmetic bug');
  assert(/\.wav$/i.test(key), 'expected .wav extension');
}
```

These μs-cost guards prevent Object-Lock-locked garbage objects (unbreakable for 7 years) from being created by wiring bugs.

---

## 12. Pre-signed URL service

### 12.1 Design

- Default TTL: **300 seconds (5 minutes)**. Short enough that an intercepted URL has minimal blast radius; long enough for R03 to start streaming.
- Maximum TTL: **3600 seconds (1 hour)** — for supervisor batch-review workflows or waveform-scrubbing UIs. Requests above this cap are rejected.
- Every URL mint writes an `audit_log` row (`recording.presigned_url_generated`) with actor, TTL, and `recording_log_id` via C03 `AuditWriter`.
- The signed URL encodes the `tenants/<tid>/` prefix scope; even if intercepted it cannot pivot to other tenants' objects (bucket policy enforces prefix scope on the IAM role used for signing).
- Pre-signing uses `@aws-sdk/s3-request-presigner` `getSignedUrl(s3Client, new GetObjectCommand({...}))`.

### 12.2 Why pre-signed URLs (not API proxy)

Proxying WAV bytes through the API would handle ~10 GB/hr of audio traffic at Phase 2 saturation, doubling egress cost (S3 → API + API → browser). Range requests (HTTP 206, needed for waveform scrubbing) would need extra implementation. Pre-signed URLs are the industry standard. S3 Access Logging is enabled to fill the audit gap (CloudTrail records actual GET events).

---

## 13. Internal service API surface

These TypeScript functions live in `workers/recording-uploader/src/services/recording.service.ts` and are imported by both the worker jobs and by `api/src/routes/recordings/`.

```typescript
// Generate a pre-signed S3 URL for playback.
async function getPlaybackUrl(
  tenantId: bigint,
  recordingLogId: bigint,
  actor: { userId: bigint; role: UserRole },
  ttlSeconds?: number,           // default 300; max 3600
): Promise<string>

// Apply or release a legal hold (invoked by C03 compliance workflow).
async function setLegalHold(
  tenantId: bigint,
  recordingLogIds: bigint[],
  on: boolean,
  actor: { userId: bigint; role: UserRole },
): Promise<void>

// Verify S3 integrity: HEAD + SHA-256 match + Object Lock state.
async function verifyIntegrity(recordingLogId: bigint): Promise<{
  ok: boolean;
  localSha: string;
  remoteSha: string;
  retainUntilDate: Date;
  legalHold: boolean;
}>

// Check whether the local file has been swept (for sweeper verification).
async function isLocalFileGone(recordingLogId: bigint): Promise<boolean>
```

---

## 14. HTTP API endpoints

These thin wrappers are implemented in `api/src/routes/recordings/`. R02 provides the service layer; R03 and M01 own the UI surface.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/internal/recordings/queue` | service-to-service token (R01 → R02) | R01 triggers R02 to pick up a completed recording (alternative to stream-consumer for direct calls — Phase 1 stream is primary) |
| `GET` | `/api/recordings/:id` | session + RBAC | Metadata: size, duration, consent_status, lifecycle_state, sha256, retention info |
| `GET` | `/api/recordings/:id/url` | session + RBAC | Pre-signed S3 URL; `?ttl=300` query param (max 3600) |
| `POST` | `/api/recordings/:id/legal-hold` | superadmin + compliance role | Apply legal hold; emits audit row |
| `DELETE` | `/api/recordings/:id/legal-hold` | superadmin + compliance role | Release legal hold; emits audit row |
| `GET` | `/api/recordings/:id/integrity-check` | superadmin + auditor role | Run `verifyIntegrity()`; returns SHA-256 match + Object Lock state |

All endpoints enforce tenant scoping: the session's `tenant_id` must match the recording's `tenant_id`.

---

## 15. Prometheus metrics

### 15.1 Counters

| Metric | Labels | Description |
|---|---|---|
| `vici2_recording_uploaded_total` | `tenant_id`, `backend`, `multipart` | Successful uploads |
| `vici2_recording_upload_failures_total` | `tenant_id`, `reason` | Failures by reason code |
| `vici2_recording_upload_retries_total` | `tenant_id`, `attempt` | Per-BullMQ-attempt counts |
| `vici2_recording_upload_dlq_total` | `tenant_id`, `reason` | Terminal DLQ entries |
| `vici2_recording_consent_skipped_total` | `tenant_id`, `reason` | C02-driven no-upload decisions |
| `vici2_recording_local_deleted_total` | `tenant_id` | Sweeper unlinks |
| `vici2_recording_sweeper_errors_total` | `error_code` | Sweep failures |
| `vici2_recording_legal_hold_applied_total` | `tenant_id` | Holds set |
| `vici2_recording_presigned_url_generated_total` | `tenant_id`, `requester_role` | URLs minted |

### 15.2 Histograms

| Metric | Buckets | Labels |
|---|---|---|
| `vici2_recording_upload_duration_seconds` | 0.5, 1, 2, 5, 10, 30, 60, 300 | `tenant_id`, `size_bucket` (small/medium/large) |
| `vici2_recording_upload_bytes_per_second` | 1M, 5M, 10M, 50M, 100M | `tenant_id`, `backend` |
| `vici2_recording_sha256_duration_seconds` | 0.05, 0.1, 0.5, 1, 5 | `tenant_id`, `size_bucket` |

### 15.3 Gauges

| Metric | Labels |
|---|---|
| `vici2_recording_queue_depth` | `queue` (recording-upload, recording-upload-dlq, recording-delete-local) |
| `vici2_recording_local_resident_bytes` | `fs_host`, `tenant_id` |
| `vici2_recording_oldest_pending_age_seconds` | `tenant_id` |
| `vici2_recording_workers_active` | `worker_id` |

### 15.4 Alert rules

| Rule | Condition | Severity |
|---|---|---|
| Upload failure rate | `rate(failures[5m]) / rate(uploaded[5m]) > 0.05` | warn |
| DLQ growth | `rate(dlq_total[15m]) > 0` | SEV-2 page |
| Queue depth | `queue_depth{queue="recording-upload"} > 5000` for 10m | SEV-2 |
| Old pending uploads | `oldest_pending_age_seconds > 7200` (2 hr) | warn |
| Sweeper stalled | `rate(local_deleted[15m]) == 0 AND queue_depth{queue="dlq"} == 0` | warn |
| SHA-256 mismatch | `rate(failures{reason="sha256_mismatch"}[1h]) > 0` | SEV-1 page |
| KMS errors | `rate(failures{reason="kms_error"}[5m]) > 0.01` | SEV-2 |
| KMS key disabled/deleted | `rate(failures{reason="kms_fatal"}[1m]) > 0` | SEV-1 page |
| Legal hold applied | `increase(legal_hold_applied[1m]) > 0` | info (compliance team notification) |

---

## 16. Files to create

### 16.1 `workers/recording-uploader/`

```
workers/recording-uploader/
├── package.json                          # BullMQ, @aws-sdk/client-s3, @aws-sdk/lib-storage,
│                                         #   @aws-sdk/s3-request-presigner, prom-client, zod, ioredis, prisma
├── src/
│   ├── index.ts                          # entry point: start stream-consumer + sweeper
│   ├── stream-consumer.ts                # XREADGROUP loop; routes to BullMQ jobs
│   ├── sweeper.ts                        # 5-min interval; selects + unlinks + audits
│   ├── config.ts                         # Zod-validated env vars + tenants.settings cache
│   ├── metrics.ts                        # prom-client counters/histograms/gauges
│   ├── backends/
│   │   ├── types.ts                      # StorageBackend interface
│   │   ├── s3.ts                         # S3Backend (AWS default)
│   │   ├── r2.ts                         # R2Backend (Cloudflare)
│   │   ├── b2.ts                         # B2Backend (Backblaze)
│   │   ├── minio.ts                      # MinioBackend (dev + on-prem)
│   │   └── factory.ts                    # makeBackend() factory
│   ├── jobs/
│   │   ├── recording-upload.ts           # BullMQ Worker for 'recording-upload'
│   │   └── recording-delete-local.ts     # BullMQ Worker for 'recording-delete-local'
│   └── services/
│       └── recording.service.ts          # getPlaybackUrl(), setLegalHold(),
│                                         #   verifyIntegrity(), isLocalFileGone()
└── __tests__/
    ├── unit/
    │   ├── path-key.test.ts              # object key generation
    │   ├── sha256.test.ts                # SHA-256 streaming correctness
    │   ├── backoff.test.ts               # jitter + delay math
    │   └── validate-upload-params.test.ts # defensive pre-check assertions
    └── integration/
        ├── upload-localstack.test.ts     # PutObject + HEAD + lifecycle-state via LocalStack S3
        ├── multipart-localstack.test.ts  # >16 MB upload + composite checksum
        ├── sweep.test.ts                 # deletion_pending + 1-hr grace + unlink
        ├── consent-skip.test.ts          # prompted_declined → delete-local; no S3 object
        └── idempotency.test.ts           # retry with pre-existing object (HEAD-skip path)
```

### 16.2 `api/src/routes/recordings/`

```
api/src/routes/recordings/
├── index.ts           # Express router; mounts the sub-routes
├── metadata.ts        # GET /api/recordings/:id
├── url.ts             # GET /api/recordings/:id/url
├── legal-hold.ts      # POST/DELETE /api/recordings/:id/legal-hold
└── integrity.ts       # GET /api/recordings/:id/integrity-check
```

### 16.3 `api/prisma/migrations/` (R02 amendment)

One new migration file (timestamp assigned by Prisma at generate time) containing:

```sql
-- recording_log: add sha256 BINARY(32), lifecycle_state ENUM, failure_reason VARCHAR(64)
ALTER TABLE recording_log
  ADD COLUMN sha256 BINARY(32) NULL AFTER storage_url,
  ADD COLUMN lifecycle_state ENUM(
    'recording_complete','uploading','uploaded','available',
    'failed','corrupt','consent_declined_no_upload','orphan','too_short'
  ) NOT NULL DEFAULT 'recording_complete' AFTER sha256,
  ADD COLUMN failure_reason VARCHAR(64) NULL AFTER lifecycle_state;

-- recordings: add deletion_pending BOOLEAN
ALTER TABLE recordings
  ADD COLUMN deletion_pending TINYINT(1) NOT NULL DEFAULT 0 AFTER legal_hold;

CREATE INDEX idx_recordings_sweep
  ON recordings (tenant_id, deletion_pending, lifecycle_state, updated_at);
```

---

## 17. Test plan

### 17.1 Unit tests (no external deps)

| Test | What it verifies |
|---|---|
| `path-key.test.ts` | Key generation matches `tenants/<tid>/calls/<YYYY>/<MM>/<DD>/<uuid>.wav` for various dates and UUIDs |
| `sha256.test.ts` | SHA-256 of a known byte sequence; streaming hash produces same result as one-shot |
| `backoff.test.ts` | Delay sequence matches the table in §11.2; jitter stays within ±25% |
| `validate-upload-params.test.ts` | All 6 assertions fire on bad input; valid input passes |

### 17.2 Integration tests (LocalStack S3 via docker-compose)

LocalStack is already in the project's docker-compose. Tests run in CI with `R02_STORAGE_BACKEND=minio` (or LocalStack's S3-compatible endpoint).

| Test | What it verifies |
|---|---|
| `upload-localstack.test.ts` | Full flow: create temp WAV → stream-consumer enqueue → BullMQ job → PutObject → HeadObject SHA-256 match → `recording_log.storage_url` set → `recordings.deletion_pending=TRUE` |
| `multipart-localstack.test.ts` | A synthetic 20 MB file triggers multipart path; part count = 2; composite checksum recorded in metadata |
| `sweep.test.ts` | After upload: `deletion_pending=TRUE`; sweeper does NOT delete before 1h; after simulated 1h (`updatedAt` backdated): sweeper calls `fs.unlink`; `deletion_pending=FALSE` |
| `consent-skip.test.ts` | Insert `recording_log` row with `consent_status='prompted_declined'`; stream-consumer routes to `recording-delete-local`; no S3 object created; `lifecycle_state='consent_declined_no_upload'` set |
| `idempotency.test.ts` | Run upload job twice; second run issues HEAD; finds matching SHA-256; skips PutObject; DB UPDATE is no-op (`WHERE storage_url IS NULL`); exactly 1 S3 object version exists |

### 17.3 End-to-end smoke test

Manual + CI gate (extends R01's SIPp smoke test):

1. Place a SIPp call via R01's test harness.
2. Verify `recording_log` row written by recording-log-writer (R01).
3. Wait ≤ 60 seconds.
4. Verify `recording_log.storage_url` set and `lifecycle_state='uploaded'`.
5. Verify S3 object exists with correct key, Object Lock Compliance mode, 7-year retain-until, SSE-KMS.
6. Verify `recordings.deletion_pending=TRUE`.
7. Advance `recordings.updated_at` to `now() - 1h` in test DB; trigger sweeper manually.
8. Verify local file is gone; `deletion_pending=FALSE`; `lifecycle_state='available'`.
9. Call `GET /api/recordings/:id/url`; verify returned URL is a valid pre-signed S3 URL with TTL ≤ 300s; verify HTTP GET on the URL returns WAV bytes with correct Content-Type.

---

## 18. Acceptance criteria

R02 IMPLEMENT is DONE when all of the following pass:

| # | Criterion |
|---|---|
| AC-1 | All unit tests green |
| AC-2 | All LocalStack integration tests green in CI |
| AC-3 | End-to-end smoke test (§17.3) passes against a live FreeSWITCH + MinIO dev stack |
| AC-4 | A 6-min SIPp call produces an S3 object at the correct path with `lifecycle_state='available'` within 90s of hangup |
| AC-5 | A consent-declined call produces no S3 object; local file is deleted within 6 minutes; `lifecycle_state='consent_declined_no_upload'` |
| AC-6 | Idempotent retry (kill the worker mid-upload, restart) produces exactly 1 S3 object version |
| AC-7 | `GET /api/recordings/:id/url` returns a pre-signed URL that plays back in a browser `<audio>` element |
| AC-8 | `GET /api/recordings/:id/integrity-check` returns `ok: true` with matching SHA-256 for a successfully uploaded recording |
| AC-9 | F02 amendment migration applies cleanly on a fresh `make db-reset`; Prisma generate produces no drift |
| AC-10 | Prometheus scrape at `:9090` shows `vici2_recording_uploaded_total` increment after the smoke test |
| AC-11 | DLQ alert fires in test: inject a BullMQ job with an unreachable S3 endpoint; confirm `recording-upload-dlq` grows and `vici2_recording_upload_dlq_total` increments |
| AC-12 | Pre-signed URL TTL > 3600s is rejected with HTTP 400 |
| AC-13 | A recording with `legal_hold=TRUE` cannot be deleted by the sweeper (sweeper skips it; `deletion_pending` remains TRUE) |

---

## 19. Dependencies and risks

| Item | Dependency / Risk | Mitigation |
|---|---|---|
| R01 stream contract | R02 depends on `events:vici2.recording.stopped` field shape frozen in R01 PLAN §8 | R01 PLAN is PLAN-stable; field names documented in R01 PLAN §8; R02 validates with Zod on read |
| F02 `recording_log` row | Stream consumer waits for recording-log-writer (R01) to write the row; race possible | `row-not-found-retry` pattern + 60s XAUTOCLAIM; resolves in practice within 1s |
| F05 KMS CMK provisioning | `tenants.settings.kms_key_arn` must be set before any upload for that tenant | If absent: FATAL DLQ + SEV-2; admin must onboard tenant before recordings are taken |
| NFS availability | Model B depends on NFSv4 export from FS hosts | NFS HA is an O02 / infra concern; worker retries handle short NFS blips; long NFS outages manifest as BullMQ queue backlog and DLQ |
| S3 Object Lock + Versioning | Versioning ON is mandatory (S3 enforces for Object Lock); affects cost on retry-created duplicate versions | Pre-HEAD on retry (`job.attemptsMade > 0`) prevents duplicate versions |
| AWS SDK v3 checksum default change | SDK ≥ 3.700 defaults to CRC32; we explicitly set `ChecksumAlgorithm: 'SHA256'` in all upload calls | Explicit opt-in is in code; Zod validates it is set at startup |
| TSR §310.5 retention floor | Currently 5 yr; could be raised by FCC | Per-object retention: only new uploads affected by a code change; old objects retain their `RetainUntilDate` |
| Accidental Object-Lock garbage | A wiring bug (wrong tenant_id, wrong key) creates an unbreakable 7-year locked object | `validateUploadParams()` assertions fire before any PutObject; ~$0.004/GB-mo × 460 MB worst-case = < $0.02/yr cost of a garbage object |
| Legal Hold bulk apply | C03 may apply legal hold to thousands of objects at once (date-range query) | `setLegalHold()` uses paginated S3 list + batched `PutObjectLegalHold`; Prometheus counter fires per-object; no timeout risk at Phase 1 volumes |
| Phase 2 Opus secondary copy | `tenants.settings.recording_secondary_opus` flag is reserved but not implemented | Phase 2 task; seam is documented; R02 Phase 1 code ignores the flag |

---

## 20. Open questions resolved (from RESEARCH §16)

| # | Question | Resolution |
|---|---|---|
| Q1 | Format at rest | **WAV PCM stereo** (evidentiary integrity + stereo for N07 + browser-native). No transcode in R02. |
| Q2 | Multipart threshold | **16 MB** (handles 99% of calls as single-PUT; long calls use multipart concurrency) |
| Q3 | Sweeper owner | **R02** (single owner of recording lifecycle; simpler ops than E06 cross-language split) |
| Q4 | CMK strategy | **Per-tenant CMK** (~$1/mo/tenant; ~$100/mo at 100 tenants; blast-radius isolation) |
| Q5 | Legal Hold UI | **C03-only operator API** (legal hold is a compliance act, not campaign config) |
| Q6 | Path scheme | **`tenants/<tid>/calls/<YYYY>/<MM>/<DD>/<uuid>.wav`** (no hash prefix; S3 auto-partitions) |
| Q7 | Pre-signed URL TTL | **300s default; 3600s max cap** |
| Q8 | Shared vs per-tenant bucket | **Shared bucket + per-tenant prefix** (Phase 1); per-tenant-bucket as Phase 4 white-label option |
| Q9 | Versioning on bucket | **ON** (mandatory for Object Lock; idempotency handled by pre-HEAD on retry) |
| Q10 | `s3_path` column on `recordings` | **Rely on `recording_log.storage_url`** (no duplication; single source of truth) |
| Q11 | Worker location | **Model B — remote workers pool, NFS mount** (Phase 1 simplicity; Phase 2 co-resident option) |
| Q12 | Consent-declined grace | **5 min** (configurable via `tenants.settings.consent_declined_grace_minutes`) |
| Q13 | Default retention years | **7 years** (configurable 5–99; TSR floor 5 yr; 7 yr covers state mini-TCPAs) |
| Q14 | Backend migration tool | **Not Phase 1** |
| Q15 | Multipart part size | **16 MB fixed** (Phase 1); dynamic (16/64 MB based on file size) deferred to Phase 2 |
| Q16 | Pre-PUT existence check | **HEAD only if `job.attemptsMade > 0`** (skip on first attempt; check on retry) |
