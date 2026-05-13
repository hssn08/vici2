# R02 — Recording S3 Upload Pipeline — RESEARCH

| Field | Value |
|---|---|
| Module | R02 (asynchronous shipper: FS-host local WAV → object store + verify + delete local) |
| Phase | 1 (MVP) |
| Owner agent type | backend-node + sre (Node 20 BullMQ-or-Streams worker; SRE owns bucket + KMS terraform) |
| Status | RESEARCH (PLAN blocked on confirmation of three open questions in §16; F02-`recordings` is PLAN-stable; R01 PLAN landed; C02 PLAN landed) |
| Date | 2026-05-13 |
| Module-spec source | `/root/vici2/spec/modules/R02.md` (the 80-line spec stub names ffmpeg WAV→MP3 + S3 upload + Object Lock 4-year retention; this RESEARCH supersedes that recommendation with: keep WAV at rest for legal evidence, defer MP3 to R03 playback path, raise retention to 7 years to match TSR §310.5 + state mini-TCPAs) |
| Related plans read | R01 PLAN §3 / §5 / §7 / §8 / §10 (file path, failure model, T01 consumer contract, R02 hand-off); F02 PLAN §4.18 (`recordings` lifecycle table — non-partitioned, FK-able) + §4.26 (`recording_log` partitioned write log); F04 PLAN §4.10 / §5 (event streams + consumer groups + XAUTOCLAIM); C02 PLAN §7.3 (`vici2_consent_status` channel-var → `recording_log.consent_status` ENUM); C03 PLAN §3.6 (audit_log hash chain — R02 events go through it); F03 PLAN §10 / §14.2 (FS `record-template` matches §3 below); DESIGN §2.1, §17.3 (object store; cost line "$23/TB-mo"), §21.1 (audit log immutability + S3 object lock 4-year) |

---

## 1. Executive summary (10 bullets)

1. **R02 is the asynchronous shipper that turns "WAV on the FS host" into "URI in `recording_log.storage_url` + bytes safe in S3 Object Lock Compliance bucket".** Per SPEC §R02 "Recording metadata + S3 upload" and R01 PLAN §10.4, R01 owns the FS-side `record_session` + `recording_log` row write; R02 owns the upload + verify + lifecycle-state advance + local delete. R02 does NOT touch FreeSWITCH ESL. R02 does NOT decide consent (C02 does; R02 reads `consent_status` from the row and short-circuits if `prompted_declined`/`skipped`). R02 does NOT transcode for playback in Phase 1 — we ship raw stereo WAV at rest (smaller object set + faithful evidence). The transcode for browser playback is **R03's** problem (R03 either serves WAV directly via `<audio>` — works in Chrome/Firefox/Safari — or generates an on-demand MP3/Opus via a transcoder microservice). This contradicts the R02.md stub's "encode WAV→MP3 in worker"; justification in §3.

2. **Default target = AWS S3 in Standard storage class, transitioned via Lifecycle to Glacier Instant Retrieval at day 30, deleted at day 2557 (~7 yrs).** S3 Standard at $0.023/GB-mo is overkill once the recording is past the "Did the supervisor playback this morning?" 24-hour hot window; Standard-IA ($0.0125/GB-mo, 30-day minimum) is the natural day-30 destination, but Glacier Instant Retrieval ($0.004/GB-mo, 90-day minimum, millisecond retrieval, $0.03/GB retrieval fee) is **5.7× cheaper than Standard-IA** at rest and still serves R03 playback with no wait. For a 100-agent tenant at 57 GB/day saturation: Standard = $1,310/mo just for the first 30 days; Glacier IR for the cold 6 yr 11 mo (20 TB) = $82/mo. Math in §6. **Recommendation: skip Standard-IA entirely, transition Standard → GIR at day 30.** Deep Archive deferred to Phase 4 (10-hr restore latency unacceptable for litigation discovery deadlines).

3. **Storage backend is pluggable; ship S3 (AWS) as the production default + MinIO for `make dev`.** Cloudflare R2 (zero egress, $0.015/GB-mo, bucket-locks GA 2025-03) is the **best fit for self-host customers paying their own egress** — operator-replay of one recording = no fee. Backblaze B2 ($0.006/GB-mo, full S3-compatible Object Lock with `compliance`+`governance` modes since 2023) is **cheapest for cold-only workloads** but has higher egress than R2 + the API rate-limits hit at ~750 TPS per bucket per [Backblaze docs]. We pick AWS S3 as the **shipped default** because (a) the largest customer cohort is already on AWS; (b) bucket-keys + SSE-KMS + Object Lock + KMS-grants are all mature and have CloudTrail integration that auditors expect; (c) AWS Glacier Instant Retrieval at $0.004/GB-mo is unbeaten on cold storage for sub-second-retrieval workloads. We make it **swap-out-able via one env-var** (`R02_STORAGE_BACKEND=s3|r2|b2|minio`) so a tenant on R2 picks R2 with no R02 code change. Full backend comparison in §4.

4. **Upload strategy is "single PutObject for ≤16 MB, multipart for >16 MB with 16 MB parts and 4 concurrent part-uploads".** AWS recommends 100 MB as the multipart threshold for **CLI** uploads but the SDK doc recommends 16–64 MB part sizes for optimal throughput. Our 57 GB/day capacity = ~600 calls/100-agent/hr × 11.5 MB average = mostly single-PUT-eligible; a 1-hour call at stereo 8 kHz = 115 MB and a 4-hour debt-collection runaway = 460 MB **need** multipart. 16 MB threshold is conservative — uses multipart for any call >~8 min. The `@aws-sdk/lib-storage` `Upload` class handles part-level CRC32 (default in SDK v3 ≥3.700, see [aws-sdk-js-v3 docs]) + composite CRC32 validation on `CompleteMultipartUpload` automatically. We **layer** a client-computed SHA-256 (full-object) on top of CRC32 (part-level), stored as `x-amz-checksum-sha256` object metadata + mirrored in `recording_log.sha256` (F02 column — needs amendment, see §13). Full part-size math + checksum protocol in §7.

5. **Encryption = SSE-KMS with one customer-managed KMS key per tenant, S3 Bucket Keys enabled.** Tenant isolation must survive a stolen-IAM-creds blast radius: per-tenant CMK means an attacker who exfiltrates tenant A's KMS-Decrypt grant cannot decrypt tenant B's recordings. CloudTrail captures each key use, satisfying SOC 2 CC6.1 / NIST 800-53 SC-12 / SC-13 evidence asks. The naive cost (1 KMS Decrypt per object × millions of objects/mo) is fatal at scale: a 100-agent tenant at 12k recordings/day × 30 days × 100 listens/day for QA = 36M KMS calls = ~$108k/yr without bucket keys. **S3 Bucket Keys reduce KMS request volume by ~99%** by caching a per-bucket-day data key. Result: 100-tenant deployment costs ~$100/mo for KMS keys + ~$10/mo for KMS requests. The AWS Storage Blog 2020 reference and 2024 best-practices doc both endorse this pattern for SSE-KMS at any non-trivial scale. We rule out SSE-C (customer-provided keys per object): AWS announced April 2026 that SSE-C is disabled-by-default for new buckets, AWS-recommended ransomware-resilience strategies treat SSE-C as anti-pattern, and our threat model (lost agent laptop / accidentally-public bucket) is better defended by IAM + KMS grants than per-object keys. Encryption design in §8.

6. **Object Lock Compliance mode for 7 years on every uploaded object, set at PutObject time (not bucket default), with optional Legal Hold for litigation events.** TCPA statute of limitations is 4 years federal, but **TSR §310.5 (16 CFR 310.5) requires 5-year retention for sales-call records as updated 2024-03**, and several states (CA CIPA, FL FTSA) read this as a floor not a ceiling; 7 years is the de-facto safe-harbor across state mini-TCPAs (RESEARCH on this point in C02 PLAN §RESEARCH-13). Compliance mode prevents *even root* from shortening the retention or deleting the object — the only way to delete before retention expiry is to delete the entire AWS account, which is the property auditors want. **Per-object retention is critical** because legal hold + bucket-default would lock new objects with whatever retention was set at bucket creation; we want every R02 PutObject to carry its own `ObjectLockRetentionMode=COMPLIANCE` + `ObjectLockRetainUntilDate=<now + 7y>` headers so retention-policy *changes* (e.g., regulator extends to 10 years) apply only to **new** uploads. Legal Hold (independent of retention period) is toggled by C03's hold workflow when a TCPA class-action complaint cites a specific tenant_id + date range. Full Object Lock design in §9.

7. **Worker pattern = Node 20 BullMQ worker bound to a Redis Stream consumer group (`r02-uploader`) reading `events:vici2.recording.stopped`, with one job per `(tenant_id, call_uuid)`.** R01 PLAN §8 establishes that T01 fans out `RECORD_STOP` to `events:vici2.recording.stopped` (a CRITICAL stream per T01 PLAN §17.4) and that `workers/recording-log-writer/` writes the `recording_log` row. R02 sits as a **second** consumer group on the same stream — at-least-once delivery, XAUTOCLAIM after 60s, idempotent on `(tenant_id, call_uuid)` via `recording_log.lifecycle_state` advance (SET storage_url WHERE storage_url IS NULL is a natural compare-and-swap). We considered three alternatives — inotify, MySQL outbox poll, BullMQ delayed-by-Node-API — and ruled them out in §10. The "BullMQ" reference in R02.md is **not** what F04 ships — F04 PLAN §4.10 commits to Redis Streams + consumer groups (`XREADGROUP`/`XAUTOCLAIM`) as the canonical event bus; R02 is a stream consumer in that lineage. We DO use BullMQ for the **upload-retry** sub-job (BullMQ's exponential-backoff + DLQ semantics are the cleanest API for the 24-hour-retry contract) — the stream consumer enqueues a BullMQ job and acks the stream message; BullMQ owns retries thereafter. Two-layer design in §11.

8. **Retry policy = exponential backoff with jitter, max 24 hours, then dead-letter to `recording-upload-dlq` queue + Pagerduty SEV-3.** Transient failures (S3 5xx, throttling 503 Slow Down, KMS rate limit, transient TLS, FS-host disk pressure during read) must not lose recordings. BullMQ's built-in exponential backoff (`2^attempt × delay_ms`) is standard; we add ±25% jitter to prevent thundering-herd retries after an S3 regional blip. Max 16 retries × 2^16 × 30s = 23 days wall-clock — too long; we instead cap at **N=8 attempts (8 × 30s base = ~4.3 hours cumulative)**, then move to a delayed-retry queue at 1h / 4h / 24h, then DLQ at attempt 12 (total ~24-26h after first attempt). DLQ entry includes the full job payload + R-cause; an on-call SRE manually re-queues after fixing the root cause. The local FS file is **NOT deleted while job is in retry/DLQ** — it stays until terminal success. Full retry table in §12.

9. **Local file deletion only after `recording_log.lifecycle_state` advances to `available` AND `recordings.deletion_pending=TRUE` + 1-hour grace AND no R03 in-flight read.** R01 PLAN §10.4 explicitly hands this race-condition design to R02. POSIX open()-then-unlink behavior keeps the inode alive for any active reader on Linux, but **only if R03 already has the file descriptor open** — a request that arrives in the 1-second gap between `recording_log.UPDATE` and `unlink()` would 404 if we deleted aggressively. The 1-hour grace + `recordings.deletion_pending` flag gives R03 enough slack to fail-over to S3 when it discovers the local file is gone. Two-phase delete in §13: (a) UPDATE `recordings SET deletion_pending=TRUE, lifecycle_state='available', s3_path=…` after upload+verify, (b) E06-janitor (or R02's own sweeper goroutine — open question §16-3) removes the local file after `lifecycle_state='available' AND deletion_pending=TRUE AND updated_at < now() - 1h`.

10. **Open questions for PLAN (top 7 of 16).** (i) **Format at rest** — keep raw WAV PCM for 7 years (faithful evidence + larger objects) OR transcode to Opus 16 kbps mono (97% size reduction, easier transcription, but loses stereo channel-separation that R03 + N07-Whisper rely on)? Recommend WAV. (ii) **Multipart threshold** — 16 MB (our recommendation) OR 100 MB (AWS CLI default)? Tradeoff: more multiparts = more API calls + slightly more KMS bucket-key fetches. (iii) **Sweeper ownership** — does R02 own the local-file deletion sweeper, or does E06 (channel + conference janitor)? Recommend R02 (single owner of recording lifecycle is simpler). (iv) **Per-tenant CMK or one CMK with key policy conditions on prefix**? Recommend per-tenant CMK for blast-radius clarity; cost is ~$1/tenant/mo. (v) **Legal Hold UI** — admin button in M01 or compliance-only operator API in C03? Recommend C03 (legal hold is a compliance act, not a campaign-config act). (vi) **Path scheme** — `s3://bucket/tenants/<tid>/calls/<yyyy>/<mm>/<dd>/<call_uuid>.wav` (matches R01 on-disk path) OR a hashed-prefix variant for S3 partition scaling (`s3://bucket/<sha256(tid+call_uuid)[0:4]>/tenants/<tid>/…`)? Recommend tenant-first (S3 auto-partitions internally; we will not exceed 3,500 PUT/s/prefix at 100 tenants Phase 1). (vii) **Pre-signed URL TTL** — 5 min (most secure) or 1 hr (less re-sign chatter for waveform-scrubbing UIs)? Recommend 5 min default + R03-configurable per-call. Full list of 16 + recommendations in §16.

---

## 2. Scope, non-goals, and the seam with R01 / R03 / C02 / C03

### 2.1 In scope (Phase 1)

- **Reading** `events:vici2.recording.stopped` Redis stream (consumer group `r02-uploader`, established in F04 PLAN §4.10).
- **Selecting** the right storage backend (`s3` | `r2` | `b2` | `minio`) per tenant config (`tenants.settings.recording_backend`, default `s3`).
- **Per-tenant routing** — recordings for tenant T go to that tenant's `s3_bucket` + `kms_key_arn` + (optional) per-tenant `s3_prefix` (default `tenants/<tid>/`).
- **Reading** the local WAV from `${recordings_dir}/<tid>/<YYYY>/<MM>/<DD>/<file>.wav` on the FS host (over an NFS mount or via an FS-host-resident worker — open question §16-7).
- **Computing** client-side SHA-256 streaming over the read.
- **Uploading** to S3 via `PutObject` (≤16 MB) or `Upload` (multipart, >16 MB), with SSE-KMS + Object Lock Compliance retention.
- **Verifying** integrity by comparing the local SHA-256 to S3 response `x-amz-checksum-sha256` header.
- **Updating** `recording_log SET storage_url=…, sha256=…, size_bytes=…` (single SQL).
- **Inserting** into `recordings` with `lifecycle_state='encoding'` → `'available'` (F02 PLAN §4.18 already provisions the row + lifecycle ENUM).
- **Setting** `recordings.deletion_pending=TRUE` AFTER upload+verify.
- **Sweeping** local files where `recordings.deletion_pending=TRUE AND updated_at < now() - 1h` and `recording_log.lifecycle_state='available'` AND no in-flight R03 read.
- **Honoring** `recording_log.consent_status` — if `prompted_declined` or `skipped`, do NOT upload; delete local immediately (or after a small grace window for audit).
- **Emitting** audit rows via C03's `AuditWriter` (R02 events are auditable: `recording.uploaded`, `recording.local_deleted`, `recording.legal_hold_applied`).
- **Emitting** Prometheus metrics (`vici2_recording_upload_*` family — see §14).
- **Generating** pre-signed URLs on demand for R03's `/api/recordings/:id/url` endpoint (Phase 1).

### 2.2 Out of scope (deferred)

| Deferred to | What |
|---|---|
| **R03** | Browser playback UI, `<audio>` element, waveform scrubbing, share-token UI. R03 calls R02's `GetPlaybackURL(recording_id, tenant_id)` helper to get a pre-signed URL; serves it from the browser. |
| **R03 Phase 1** | On-demand MP3/Opus transcode for browsers without WAV support. Our 8 kHz stereo WAV PCM s16le plays natively in Chrome/Firefox/Safari/Edge per [HTML5 audio compatibility matrix]; transcode would be needed only for very old IE / some mobile browsers and is a Phase-2 nice-to-have. |
| **N07 (Phase 4)** | Whisper transcription. N07 reads R02-uploaded WAV from S3, demuxes stereo to per-speaker mono via ffmpeg (`-map_channel 0.0.0`), feeds each mono to Whisper, stitches result. R02 makes this possible by *not* transcoding (would lose stereo channel separation). |
| **C04 (Phase 1)** | 7-year retention WORKER. C04 deletes `recording_log` partitions ≥7yr old; for the S3 side, Object Lock + a Lifecycle rule with `ExpirationInDays=2557` handles deletion automatically when retention expires. R02 PLAN documents the Lifecycle rule (§9.4); C04 just verifies. |
| **Phase 2** | Multi-region replication (CRR — Cross-Region Replication) for disaster recovery. Object Lock + 7-yr retention in one region is Phase 1; CRR adds another bucket with auto-replication for region-loss survival. Approx +50% storage cost; defer. |
| **Phase 2** | Transcription-driven indexing (Elastic / OpenSearch on transcripts). |
| **Phase 2** | PCI-Pal / Eckoh DTMF-suppression sidecar integration (the `record_session` path for PCI calls). R01 PLAN §4.3 already flags this; R02 just stores whatever WAV R01 produces. |
| **Phase 2** | App-level encryption (e.g., libsodium `crypto_secretstream_xchacha20poly1305`) on top of SSE-KMS. R01 PLAN §6.6 reserves this seam. |

### 2.3 The 5-module recording subsystem (where R02 sits)

```
┌──────────┐   record_session     ┌──────────┐
│ FreeSWITCH │ ─────WAV stream──→  │ Local FS │
└──────────┘                       │ scratch  │
                                   └────┬─────┘
                                        │
   ┌─────────────────────────────┐      │
   │ T01 (ESL bridge, Go)        │      │
   │  emits RECORD_STOP →        │      │
   │  events:vici2.recording.    │      │
   │  stopped stream             │      │
   └────────────┬────────────────┘      │
                │                       │
                │ at-least-once XADD    │
                ▼                       │
┌───────────────────────────────────┐   │
│ workers/recording-log-writer/     │   │
│  (R01 owns)                       │   │
│  group=recording-log-writer       │   │
│  INSERT recording_log             │   │
│  (lifecycle='recording_complete') │   │
│  consent_status from channel-var  │   │
└────────────┬──────────────────────┘   │
             │                          │
             ▼                          │
        ┌─────────┐                     │
        │ MySQL   │                     │
        │ recording_log row             │
        └─────────┘                     │
                                        │
   ┌──────────────────────────────┐     │
   │ workers/recording-uploader/  │     │
   │  (R02 owns — THIS MODULE)    │ ◄───┘ reads local WAV
   │  group=r02-uploader          │
   │  Same stream, second group   │
   │  → if consent_status ∈ {decl,│
   │     skipped}: delete local   │
   │  → else: SHA256 + multipart  │
   │    PutObject + verify        │
   │  → UPDATE recording_log      │
   │     SET storage_url, sha256  │
   │  → INSERT recordings         │
   │     (lifecycle='available')  │
   │  → 1h grace + sweeper unlink │
   └────────────┬─────────────────┘
                │
                ▼
      ┌─────────────────┐    ┌─────────────────┐
      │ S3 / R2 / B2    │    │ MySQL           │
      │ Object Lock     │    │ recordings row  │
      │ Compliance 7y   │    │ recording_log   │
      │ SSE-KMS         │    │ updated         │
      └────────┬────────┘    └────────┬────────┘
               │                      │
               ▼                      ▼
      ┌─────────────────────────────────────────┐
      │ R03 (Phase 1) — playback                │
      │  GET /api/recordings/:id/url            │
      │   → R02.GetPlaybackURL() → pre-signed   │
      │   browser <audio src=presigned_url>     │
      └─────────────────────────────────────────┘
```

R02 is the **only** module that PUTs to the object store in Phase 1. C04 (retention worker) will DELETE via Lifecycle rules (no API call from C04 — S3 expires the object itself when ObjectLock retention lapses). N07 (Phase 4 Whisper) will GET via `GetObject` to feed transcription — R02 owns the bucket policy that grants N07's IAM role `s3:GetObject` on `tenants/<tid>/calls/*`.

### 2.4 What R02 does NOT do

- R02 does NOT invoke ffmpeg. (No transcoding at upload time.)
- R02 does NOT decide consent. R02 reads `recording_log.consent_status` and acts accordingly; C02 sets the channel-var that fed it.
- R02 does NOT write to `audit_log` directly. R02 calls C03's `AuditWriter.append({entity_type:'recording', entity_id, action:'recording.uploaded'/'recording.local_deleted'/...})` which goes through the hash-chain trigger.
- R02 does NOT serve playback. R02 exposes `GetPlaybackURL()` (returns a pre-signed URL) to R03; R03 owns the HTTP/UI surface.
- R02 does NOT manage tenant KMS keys. F05 (auth + RBAC + SIP cred gen) owns KMS key provisioning (it already provisions KEKs for `sip_credentials`); R02 reads `tenants.settings.kms_key_arn` and uses it. F05 amendment may be needed if `tenants.settings.kms_key_arn` isn't already in JSON shape (§13).
- R02 does NOT compute call duration. T01 already computes from `Record-Ms` event header; recording-log-writer writes it. R02 just reads `size_bytes` for upload verification.

---

## 3. File format decision — keep raw stereo WAV PCM at rest (overrides R02.md stub)

### 3.1 The R02.md stub recommends WAV → MP3 transcode at upload. Why we override that.

R02.md (2026-03 draft, before R01 PLAN landed) says "encode WAV→MP3 (smaller, browser-friendly), upload to S3". This was a sensible Phase-0 instinct, but four facts changed the calculus during R01 RESEARCH:

1. **R01 PLAN froze stereo (left=customer, right=agent) for QA + Whisper demux.** R01 PLAN §2.1 / §12.2 — left channel is customer voice, right channel is agent voice. MP3 supports stereo, but typical compression configurations (especially low-bitrate / joint-stereo) blur channel separation. N07 (Phase 4 Whisper) demuxes to per-speaker mono via `ffmpeg -map_channel`; this works cleanly on PCM s16le but is noisier on joint-stereo MP3. Keeping WAV preserves the channel separation N07 needs.

2. **WAV PCM s16le is universally playable in modern browsers.** Per the HTML5 `<audio>` codec matrix: WAV PCM is supported in Chrome (since v3), Firefox (since v3.5), Safari (since v3.1, including iOS), Edge. The "browser-friendly" argument for MP3 was 2010-era. 2026 browsers play 8 kHz mono and stereo WAV natively with `<audio src="recording.wav" controls>`. No transcode needed for the 99% case. The remaining 1% (very old IE, some Android stock browsers) is not a Phase-1 priority.

3. **Storage cost difference is trivial vs Glacier IR pricing.** Stereo WAV @ 8 kHz = 32 KB/s = 11.5 MB/6-min-call. MP3 at 64 kbps stereo = 48 KB/s actual wire-bitrate (LAME overhead) = ~17 MB/6-min-call (wait — that's larger; because MP3 encoder adds overhead at very low source rates, and at 8 kHz source MP3 actually needs to upsample-or-resample to a standard MP3 sample rate). MP3 at 32 kbps mono = ~6 MB/6-min-call (~50% reduction) but loses stereo. At Glacier IR pricing ($0.004/GB-mo × 11.5 MB × 100 agents × 50 calls/day × 30 days × 7 yr × 1024 KB) = $80/mo for a 100-agent tenant. Saving 50% with mono MP3 saves $40/mo — not worth losing channel separation for Whisper.

4. **Forensic evidentiary value of WAV PCM.** PCM is "lossless" (no audio data is removed) and is the de-facto format for legal-evidence audio — court-accepted ([NIST SP 800-86 §3.4 forensic media], multiple FRE 901(b)(1) precedents). A lossy codec like MP3 in a TCPA litigation context can be challenged as "modified original" — defense counsel prefers WAV. (Cite [Eckoh PCI compliance guide 2024 §4.3]: "for TCPA / FTSA evidentiary use, store raw PCM; transcode only for delivery".)

### 3.2 Opus is the right Phase-2 cold-storage candidate but not Phase-1 default

The FusionPBX thread cited in WebSearch shows Opus reducing storage to 3.3% of WAV. At very low source rates (8 kHz speech) Opus at 16 kbps mono produces near-toll-quality speech at ~80× compression. **However:**

- Opus is not natively playable in iOS Safari < 17 (Safari got Opus-in-MP4 in 2023; Opus-in-Ogg still requires JS player). 2026 iOS Safari is on 18 so this is mostly resolved, but corp-managed iPads on older iOS will fail.
- Opus loses stereo channel separation when downmixed for compression efficiency (typical 16 kbps configs).
- The transcode step is CPU-bound — at 100 agents × 200 calls/agent/day = 20k calls/day × ~5s ffmpeg overhead = ~28 ffmpeg-hours/day; needs a separate transcoder worker pool.

**Recommendation:** Phase 1 ships WAV-at-rest. Phase 2 adds an **optional** Opus-secondary-copy for tenants who set `tenants.settings.recording_secondary_opus=true`. The Opus copy lives in a separate Glacier Deep Archive bucket (10-hr restore latency acceptable because it's a backup-of-a-backup); the primary WAV stays in GIR for fast access. Skip Opus in R02 PLAN; reserve the seam.

### 3.3 What we actually ship

```
Filename:  ${call_uuid}.wav
Format:    WAV PCM signed 16-bit little-endian, stereo, 8 kHz
Avg size:  11.5 MB / 6-min call (worst case 460 MB for 4-hr call)
Bytes/sec: 32,000 (8000 Hz × 2 ch × 2 bytes/sample)
```

The 16 kHz WAV variant (when carriers negotiate G.722 or Opus) is sample-rate-driven at FS-record-time per R01 PLAN §2.2; R02 doesn't care — it ships whatever bytes FS wrote.

### 3.4 Decision matrix on format-at-rest

| Format | Size/6-min | Browser playback | Whisper-ready | Evidentiary | Verdict |
|---|---|---|---|---|---|
| WAV PCM s16le stereo 8 kHz | 11.5 MB | yes (all modern) | yes (best, channel sep preserved) | best (lossless PCM) | **✓ Phase 1 ship** |
| MP3 64 kbps stereo | 17 MB (8k source) | yes (all) | OK (channel sep blurry) | medium (lossy compression) | reject Phase 1 |
| MP3 32 kbps mono | 6 MB | yes (all) | OK (no channel sep) | medium | reject Phase 1 |
| Opus 16 kbps mono | 0.4 MB | yes (Safari 17+) | best for downstream | medium (lossy) | Phase 2 secondary copy |
| Opus 24 kbps stereo | 0.5 MB | yes (Safari 17+) | OK | medium | Phase 2 secondary copy |
| FLAC (lossless compressed) | 6 MB | partial (no Safari ≤18) | yes | best (lossless) | reject Phase 1 (Safari) |

---

## 4. Storage backend comparison + the pluggable interface

### 4.1 The four candidate backends

| Backend | Storage $/GB-mo | Egress $/GB | API per 10k PUT | Object Lock | Multipart | Notes |
|---|---|---|---|---|---|---|
| **AWS S3 Standard** | $0.023 | $0.09 (after 100 GB free) | $0.005 | YES (Compliance + Governance, GA since 2018) | YES | Reference implementation; full feature surface |
| **AWS S3 Glacier IR** | $0.004 | $0.09 + $0.03/GB retrieval | $0.02 | YES | YES | 90-day min storage; millisecond first-byte |
| **AWS S3 Glacier Deep Archive** | $0.00099 | $0.09 + $0.02/GB retrieval | $0.05 | YES | YES | 180-day min; 12-hr restore |
| **Cloudflare R2** | $0.015 | **$0** | $4.50 (Class A=PUT) | YES (Bucket Locks GA 2025-03; per-object retention 2025-Q4) | YES | S3-API-compatible with gaps; one-region; no multi-region replication |
| **Backblaze B2** | $0.006 | $0.01 (first 3× storage free) | $4 (Class B=upload) | YES (Compliance + Governance via S3 API since 2023) | YES | S3-API-compatible; ~750 TPS/bucket limit |
| **MinIO (self-host)** | $0 (just disk cost) | $0 (just bandwidth) | $0 | YES (Compliance + Governance) | YES | erasure-coded; for `make dev` + on-prem customers |

(Pricing as of 2026-04 from each vendor's public price page; us-east-1 / EU regions; rounded.)

### 4.2 Why AWS S3 + GIR-tier is the shipped default

- **Mature Object Lock + SSE-KMS + Bucket Keys + CloudTrail integration.** Auditors recognize the stack; SEC 17a-4(f) + FINRA + SOC 2 compliance attestations all reference AWS S3 + Object Lock as the canonical immutable WORM.
- **Cost** — at the 100-agent / 57 GB/day saturation level and 7-year retention, the math (§6) shows GIR is $80/mo for storage. Going to R2 saves the GIR retrieval fee but pays 4× the storage rate; B2 is cheaper still but lacks the egress-free advantage R2 has when a customer-replay rate is high.
- **Glacier Instant Retrieval is a 2021 product** with millisecond first-byte and full S3 API surface (`GetObject` works just like Standard). The only friction is the 90-day minimum-storage charge — fine for 7-yr retention. No `RestoreObject` ceremony needed (unlike Deep Archive).
- **SSE-KMS + Bucket Keys** cuts KMS API costs by 99% — the only AWS-specific savings that R2/B2 can't match (R2 has zero KMS at all; you encrypt client-side if you want it).

### 4.3 Why R2 is the right secondary for self-host / cost-sensitive customers

- **Zero egress** is the win when the customer pattern is "ops listens to 5% of recordings for QA". A 100-agent tenant might re-fetch 30 GB/month (random 1-min samples) — at AWS S3 that's $2.70 in egress; at R2 that's $0.00.
- **Storage at $0.015/GB-mo** is between Standard and Standard-IA; doesn't have GIR's cheap rate but doesn't have AWS's egress fees either.
- **Bucket Locks** (March 2025 launch) provide WORM semantics; **per-object retention** (Q4 2025) brought R2 to feature-parity with S3 Object Lock for our use case.
- **Gaps:** S3 API compat is "mostly there but not 100%" (Cloudflare's own docs flag UploadPartCopy missing edge cases, some ACL ops different). Our usage is plain `PutObject` + `Upload` (multipart) + `GetObject` — all well-tested on R2.
- **No multi-region replication** in R2 yet; if a tenant requires multi-region durability they stay on AWS.

### 4.4 Why MinIO for dev/local + small on-prem

- Already in DESIGN §2.1 as the dev-mode storage; matches `docker-compose.yml` in repo skeleton (F01 PLAN).
- Object Lock Compliance mode shipped 2020; tested in MinIO production for SEC 17a-4 deployments.
- Cost = disk + erasure-coding overhead (~30% redundancy at EC:4 with 8 drives).
- Use case: developer laptops; on-prem deployments where customer data cannot leave their network.

### 4.5 The pluggable interface — `StorageBackend` Go-ish-style TypeScript interface

```typescript
// workers/recording-uploader/src/backends/types.ts

interface StorageBackend {
  // Upload an object with SSE-KMS + Object Lock retention applied.
  // Returns the canonical URI (s3://bucket/key, r2://bucket/key, etc.)
  // and the server-side SHA-256 (or null if backend doesn't compute it).
  put(
    objectKey: string,
    inputStream: Readable,
    opts: {
      sizeBytes: number;
      contentType: 'audio/wav' | 'audio/mpeg';
      sse: { kmsKeyArn: string; bucketKeyEnabled: true };
      objectLock: {
        mode: 'COMPLIANCE';
        retainUntilDate: Date;
        legalHold: boolean;
      };
      sha256: string; // client-computed; passed as x-amz-checksum-sha256
      metadata: {
        tenantId: string;
        callUuid: string;
        leadId?: string;
        campaignId?: string;
        startedAt: string; // ISO8601
      };
    }
  ): Promise<{ uri: string; etag: string; serverSha256?: string }>;

  // Generate a pre-signed URL for R03 playback.
  getPresignedReadUrl(
    objectKey: string,
    ttlSeconds: number
  ): Promise<string>;

  // Apply a legal hold (C03 invokes via R02).
  setLegalHold(objectKey: string, on: boolean): Promise<void>;

  // Verify an object exists with the expected SHA-256.
  headWithChecksum(objectKey: string): Promise<{
    size: number;
    sha256: string;
    retainUntilDate: Date;
    legalHold: boolean;
  }>;
}

// Implementations:
class S3Backend implements StorageBackend { … }
class R2Backend implements StorageBackend { … }
class B2Backend implements StorageBackend { … }
class MinioBackend implements StorageBackend { … }

// Factory:
function makeBackend(): StorageBackend {
  switch (process.env.R02_STORAGE_BACKEND ?? 's3') {
    case 's3':   return new S3Backend(envConfig.s3);
    case 'r2':   return new R2Backend(envConfig.r2);
    case 'b2':   return new B2Backend(envConfig.b2);
    case 'minio': return new MinioBackend(envConfig.minio);
    default: throw new Error('unsupported R02_STORAGE_BACKEND');
  }
}
```

All four backends speak S3 protocol; the differences are URL shape + endpoint config + which features they have. We use `@aws-sdk/client-s3` v3 for all of them (R2 and B2 advertise S3-compatible endpoints — set `endpoint: 'https://<account>.r2.cloudflarestorage.com'`). MinIO endpoint is `http://minio:9000` in docker-compose.

### 4.6 Why we don't pick "storage-agnostic" via a third-party abstraction

We considered `node-cloud-storage` and Apache `libcloud`-style abstractions. Rejected: they lag on Object Lock features; our backend surface is tiny (4 methods); writing 4 thin classes is simpler than depending on a heavy abstraction.

---

## 5. Path scheme + object key design

### 5.1 Final shape (frozen recommendation; PLAN will confirm)

```
s3://<bucket>/tenants/<tenant_id>/calls/<YYYY>/<MM>/<DD>/<call_uuid>.wav
```

Concrete:
```
s3://vici2-recordings-prod-us-east-1/tenants/1/calls/2026/05/06/8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav
```

### 5.2 Why this shape

- **Mirror of R01 on-disk path** (`/var/lib/freeswitch/recordings/<tid>/<YYYY>/<MM>/<DD>/<campaign>_<lead>_<uuid>.wav`) but with a critical difference: **drop the campaign + lead prefix from the filename** in S3. The S3 object name is `<call_uuid>.wav` only, because:
  - call_uuid is globally unique (UUIDv4, 122 bits); no collision risk.
  - Campaign + lead metadata go in **object metadata** (`x-amz-meta-campaign-id`, `x-amz-meta-lead-id`) instead of the key — easier to query, doesn't change the immutable key if a lead is re-attributed.
  - Shorter keys = less hashing overhead in S3's prefix partitioner.
  - Same key shape for ALL recordings (no per-tenant naming variance).
- **`tenants/<tid>/` prefix first** — multi-tenant isolation; bucket policy can grant cross-account read on `arn:aws:s3:::bucket/tenants/42/*` cleanly.
- **`calls/<YYYY>/<MM>/<DD>/` next** — natural Hive-style partition that Athena (Phase 4 analytics) understands; matches retention sweep "delete all of 2019-04". S3 auto-partitions internally — we don't need to hash for partition scaling unless we exceed 3,500 PUT/s/prefix. At 100 tenants × 12k calls/tenant/day / 86400s = ~14 PUT/s per tenant per day-prefix; well below 3,500/s.

### 5.3 Anti-patterns we reject

- ❌ `s3://bucket/<YYYY>/<MM>/<DD>/<call_uuid>.wav` (no tenant prefix). Locks us out of tenant-scoped IAM policies + per-tenant bucket lifecycle rules. **Reject.**
- ❌ `s3://bucket/<call_uuid>.wav` (flat). Makes prefix-based listing impossible; retention sweeps must scan entire bucket. **Reject.**
- ❌ Hashed prefix `s3://bucket/<sha[0:4]>/tenants/<tid>/<call_uuid>.wav` for partition spreading. S3 auto-partitions — hashing fragments the prefix space for retention-by-prefix lifecycle rules. We don't need this at Phase 1 scale. **Reject.** (Re-evaluate if Phase 4 hits >3,500 PUT/s on a single tenant prefix.)
- ❌ Embedding sensitive metadata in the key (`<campaign>_<lead>_<phone>_<uuid>.wav`). Lead phone numbers in the key would leak through CloudTrail logs / pre-signed URLs / referrer headers. **Reject.** Keep keys metadata-free; put metadata in S3 object metadata (KMS-encrypted in transit, not logged).

### 5.4 Per-tenant bucket vs shared bucket-with-prefix

| Option | Pro | Con |
|---|---|---|
| **One global bucket, `tenants/<tid>/` prefix** | One bucket to manage; one Lifecycle config; one CRR config; cheaper IAM | Tenant isolation depends on policy correctness; blast radius of a single bucket-policy bug is "all tenants" |
| **One bucket per tenant** | Hard tenant isolation; tenant-specific KMS key cleanly maps to tenant-specific bucket | Bucket-count grows; AWS limit = 1000 buckets/account by default (request increase); per-bucket Lifecycle + CRR configs to maintain |

**Recommendation: shared bucket + per-tenant prefix.** Reasons:
- The Object Lock + retention math doesn't change with bucket count (per-object retention; bucket-level config is just a default).
- KMS per-tenant key still enforces tenant isolation cryptographically (a leaked AWS IAM role for tenant A's S3 access cannot decrypt tenant B's KMS-encrypted objects even if the role accidentally lists them).
- Operational simplicity: one CRR config to set up, one CloudWatch alarm, one bucket inventory job.
- 1000-bucket AWS soft limit becomes a real ceiling at 1000 tenants — moving from per-tenant bucket to per-tenant prefix is painful at that point.

Caveat: a Phase 4 white-label/VAR deployment where a customer wants their *own* AWS account for their tenants will get per-customer-bucket-set; we don't break that future option.

### 5.5 Storage URI in `recording_log.storage_url`

The column is `VARCHAR(512)` per F02 PLAN §4.26. The URI we write is the canonical S3 URI:
```
s3://vici2-recordings-prod-us-east-1/tenants/1/calls/2026/05/06/8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav
```

Length: `s3://` (5) + bucket (~40 char max) + `/tenants/<10-digit-id>/calls/<10>/<2>/<2>/<36>.wav` (~80) = under 200 chars. Fits in 512.

For non-S3 backends:
```
r2://<account>.r2.cloudflarestorage.com/<bucket>/<key>
b2://s3.<region>.backblazeb2.com/<bucket>/<key>
minio://minio:9000/<bucket>/<key>
```

R03 parses the scheme prefix to pick the right backend for pre-signing. The scheme prefix is **not** what `@aws-sdk/client-s3` expects (it expects you to set `endpoint` in client config) — we use it as a routing hint in our application.

---

## 6. Capacity + cost math (5 scenarios)

### 6.1 Base assumptions

- Stereo WAV PCM s16le @ 8 kHz: 32 KB/s = 1.92 MB/min.
- Avg call duration: 6 min talk-time (R01 PLAN §6.1) → **11.5 MB/call**.
- Phase 1 manual: 100 agents × 25 calls/agent/day = **2,500 calls/day**.
- Phase 2 auto-dial: 100 agents × 50 calls/agent/day = **5,000 calls/day** (capped by carrier CPS + adaptive math; could be lower).
- Daily volume: **29 GB/day Phase 1; 57 GB/day Phase 2** (matches R01 PLAN §6.1).
- Annual volume: **~10 TB/year/tenant Phase 1; ~21 TB/year/tenant Phase 2.**
- Retention: 7 years → **~73 TB/tenant cumulative at Phase 2 saturation** (less if Phase 1 was light first year).

### 6.2 Scenario A — 100% S3 Standard, no lifecycle, 7-yr retention

| Metric | Value |
|---|---|
| Year-1 storage | 21 TB × $0.023/GB × 12mo × avg ½-year-resident = 21 × 1024 × 0.023 × 6 = **$2,966** |
| Year-7 total (peak) | 21 TB × 7 = 147 TB × $0.023/GB-mo × 12 mo = **$41,500/yr at full retention** |
| **Verdict** | Wasteful — Standard is for hot data. Reject. |

### 6.3 Scenario B — Standard 30 days → GIR forever (RECOMMENDED)

| Metric | Value |
|---|---|
| Hot tier (Standard, 30-day window) | 21 TB/yr × (30/365) × 1024 × $0.023 = $40/mo = **$483/yr** |
| Cold tier (GIR, year 1 onward) | 21 TB × 11/12 × 1024 × $0.004 = $79/mo = **$946/yr** year 1; cumulative grows |
| Year-7 cumulative (147 TB minus first-30-days hot) | ~145 TB × 1024 × $0.004 = **$594/mo** = $7,128/yr |
| KMS keys | 1 CMK × $1/mo = **$12/yr** |
| KMS API (bucket-key cached) | ~5k requests/mo × $0.03/10k = **$0.18/yr** (negligible) |
| Multipart abort cleanup (Lifecycle) | $0 (Lifecycle rules free) |
| Multipart PUT requests | 5000 calls/day × 30 × 12 = 1.8M PUTs/yr × $0.005/1000 = **$9/yr** |
| GIR retrieval cost (assume 5% of recordings replayed) | 145 TB × 5% × $0.03/GB = **$2,228/yr** |
| **Total year 7 (full retention)** | **$9,886/yr per 100-agent tenant** ≈ $988/yr/100-agents ≈ **$10/agent/year** |
| **Verdict** | Acceptable. ~$0.83/agent/month cost line. |

### 6.4 Scenario C — Cloudflare R2 (zero egress)

| Metric | Value |
|---|---|
| Storage (no tier; flat $0.015/GB-mo) | 145 TB × 1024 × $0.015 = **$2,227/mo** = $26,724/yr |
| Egress (5% replay) | $0 |
| Class-A operations (PUT) | 5000 × 30 × 12 = 1.8M/yr × $4.50/M = **$8.10/yr** |
| **Total year 7 (full retention)** | **$26,732/yr per tenant** |
| **Verdict** | More expensive than AWS at this scale because zero-egress doesn't outweigh the GIR cost advantage. R2 wins only when egress is high (>50% replay). |

### 6.5 Scenario D — Backblaze B2

| Metric | Value |
|---|---|
| Storage (flat $0.006/GB-mo) | 145 TB × 1024 × $0.006 = **$891/mo** = $10,696/yr |
| Egress (5% replay × 145 TB × 5% = 7.2 TB/yr × $0.01) | **$73/yr** |
| API uploads | ~$10/yr |
| **Total year 7** | **$10,779/yr per tenant** |
| **Verdict** | Slightly more expensive than AWS GIR ($9,886/yr) but no KMS complexity. Good fit if customer doesn't want AWS. |

### 6.6 Scenario E — MinIO on-prem (capex amortized)

| Metric | Value |
|---|---|
| Raw disk for 147 TB usable @ EC:4-on-8 = ~220 TB raw; @ $15/TB enterprise NVMe (2026 prices) = **$3,300 capex** |
| Amortize 5 yr | **$55/mo + power/space ~$30/mo** = $1,020/yr |
| Egress | $0 (LAN) |
| **Total year 1** | $1,020/yr per tenant in TCO |
| **Verdict** | Cheap if you already have the infra. Operations cost is meaningful (replacing drives, monitoring erasure-coding). For SaaS this is not the play. For on-prem regulated industries (gov, healthcare) it's the only play. |

### 6.7 Comparison verdict

| Backend | $/yr at 7-yr retention | Best use case |
|---|---|---|
| AWS S3 Std→GIR (recommended default) | $9,886 | SaaS, anywhere |
| Backblaze B2 | $10,779 | Cheap alternative to AWS; no KMS needs |
| Cloudflare R2 | $26,732 | When >40% of recordings get replayed (rare) |
| MinIO on-prem | $1,020/yr opex + capex | Regulated on-prem only |

**Default: AWS S3 Standard 30d → GIR + SSE-KMS + Object Lock Compliance.**

### 6.8 Bandwidth requirements (FS-host → S3 upload)

Phase 2 saturation 57 GB/day = ~5.4 Mbps average sustained, ~50 Mbps peak (if all of day's recordings ship in the 8 working hours and we don't smooth). 

The FS host is on the same VPC as the worker if R02 is co-resident, OR R02 reads over NFS — bandwidth math:
- Co-resident (R02 worker on FS host): in-process file read, no network — uploaded over the egress link (5 Mbps avg).
- Remote R02 (worker reads FS host via NFS): NFS read AND S3 upload over the egress link — 10 Mbps avg sustained.

A standard 1 Gbps EC2 instance (m6i.large) handles this easily. The bottleneck is more likely **S3-side ingress throttling** for the rare cases where backlog catches up — see §11.4 for backpressure design.

---

## 7. Upload strategy — single PutObject vs multipart, checksum verification

### 7.1 Threshold

AWS recommends **multipart for ≥100 MB** in its CLI docs ([repost.aws/optimize-uploads-s3]); but the SDK guide says **16–64 MB parts give best throughput**. Our objects are mostly small (<20 MB for 6-min calls) but skew tail-heavy (4-hr debt-collection calls hit 460 MB).

**Recommendation: threshold = 16 MB. Below: single PutObject. Above: multipart with 16 MB parts, max 4 concurrent part-uploads.**

Why 16 MB:
- AWS SDK v3 `lib-storage` `Upload` class default `partSize` is 5 MB; below 16 MB the per-part API overhead (each part adds ~1 RTT + 1 KMS bucket-key fetch if not cached) dominates the bytes transferred. 16 MB amortizes that.
- 16 MB × 10,000 parts max = 160 GB upload ceiling per object — well above our 460 MB worst-case.
- Memory: 4 concurrent × 16 MB = 64 MB resident per upload. With 50 concurrent uploads = 3.2 GB — fits on a `t3.large` (8 GB RAM).
- The "power-of-2 MB" recommendation from aws-sdk-js-v3 #4316 plays nicely with `pipe()` chunking.

### 7.2 Single PutObject path (objects ≤16 MB)

```typescript
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

async function uploadSingle(localPath: string, key: string, kmsArn: string, retainUntil: Date) {
  const size = statSync(localPath).size;

  // Stream once to compute SHA-256 (need it as upload header — can't compute post-upload).
  const sha = createHash('sha256');
  await new Promise((res, rej) => {
    createReadStream(localPath).on('data', c => sha.update(c)).on('end', res).on('error', rej);
  });
  const sha256Hex = sha.digest('hex');
  const sha256Base64 = Buffer.from(sha256Hex, 'hex').toString('base64');

  // Now upload — stream again.
  await s3.send(new PutObjectCommand({
    Bucket: 'vici2-recordings-prod-us-east-1',
    Key: key,
    Body: createReadStream(localPath),
    ContentLength: size,
    ContentType: 'audio/wav',
    ServerSideEncryption: 'aws:kms',
    SSEKMSKeyId: kmsArn,
    BucketKeyEnabled: true,
    ObjectLockMode: 'COMPLIANCE',
    ObjectLockRetainUntilDate: retainUntil,
    ChecksumAlgorithm: 'SHA256',
    ChecksumSHA256: sha256Base64,
    Metadata: { tenantId: '1', callUuid: '8a3e…', leadId: '4287', campaignId: 'SOLAR_Q2', startedAt: '2026-05-06T14:23:00Z' },
  }));

  return sha256Hex;
}
```

Two reads of the file (one to hash, one to upload) — acceptable for <16 MB objects; modern NVMe reads 3 GB/s, the 32 ms cost is dominated by the network upload time.

### 7.3 Multipart path (objects >16 MB)

Use `@aws-sdk/lib-storage` `Upload` class — it handles the orchestration (`CreateMultipartUpload`, parallel `UploadPart`, `CompleteMultipartUpload`, retry-per-part).

```typescript
import { Upload } from '@aws-sdk/lib-storage';
import { createReadStream, statSync } from 'node:fs';

async function uploadMultipart(localPath: string, key: string, kmsArn: string, retainUntil: Date, sha256: string) {
  const size = statSync(localPath).size;

  const upload = new Upload({
    client: s3,
    params: {
      Bucket: '…',
      Key: key,
      Body: createReadStream(localPath),
      ContentType: 'audio/wav',
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: kmsArn,
      BucketKeyEnabled: true,
      ObjectLockMode: 'COMPLIANCE',
      ObjectLockRetainUntilDate: retainUntil,
      ChecksumAlgorithm: 'SHA256',  // SDK will use composite SHA-256 per part
      Metadata: { … },
      // The full-object SHA-256 cannot be passed at CreateMultipartUpload time
      // (S3 uses composite hash for multipart). We mirror to metadata for our own verify.
    },
    queueSize: 4,        // 4 concurrent part-uploads
    partSize: 16 * 1024 * 1024, // 16 MB
    leavePartsOnError: false,    // abort cleanly on failure
  });

  // SDK emits progress events; we can log to Prometheus.
  upload.on('httpUploadProgress', p => /* metric */);

  const result = await upload.done();
  return result;
}
```

**Important caveat: multipart-upload composite checksum is NOT a full-object SHA-256.** AWS computes SHA-256 of each part's data, concatenates the part-hashes, hashes that — a **Merkle root**, not the SHA-256 you'd compute on the full file. To get a full-object SHA-256:

(a) Compute client-side SHA-256 by streaming the file once (~150 ms for a 460 MB file at 3 GB/s NVMe), store in our DB.
(b) Set `ChecksumAlgorithm: 'SHA256'` — SDK computes composite per-part, verifies parts arrived intact.
(c) Pass full-object SHA-256 via `Metadata.client-sha256` (custom header).
(d) Verify post-upload by `HeadObject` and confirming `x-amz-meta-client-sha256` matches our local computation.

For **single-PUT** the situation is simpler — `ChecksumSHA256` IS the full-object SHA-256 and S3 stores `x-amz-checksum-sha256` natively.

### 7.4 Checksum-verification protocol (the full integrity chain)

```
FS host writes WAV → R02 reads bytes → R02 computes SHA-256 streaming
                                    ↓
                          R02 uploads (single or multipart)
                                    ↓
                          S3 stores object + (single-PUT only) native SHA-256
                                    ↓
                          R02 issues HeadObject
                                    ↓
                  R02 compares stored sha to local-computed sha
                                    ↓
              MATCH → write recording_log.sha256, set lifecycle='available'
              MISMATCH → retry upload (max 3); after 3, DLQ + alert
```

### 7.5 What if AWS SDK changes the default checksum to CRC32 / CRC64NVME?

AWS SDK v3 since ≥3.700 defaults to CRC32 (April 2025 default-on integrity checks per `s3-checksums.html`). Our code explicitly sets `ChecksumAlgorithm: 'SHA256'` to upgrade. SHA-256 is the chosen algorithm because:
- Cryptographic-strength preimage resistance (CRC32 is not — a malicious actor could craft a substituted object that passes CRC32; we want defense against an insider who tries to swap the recording).
- Standard for legal evidence chain-of-custody (NIST SP 800-86; FRE 901).
- C03's hash-chain on `recording_log` already uses SHA-256; consistent algorithm.

### 7.6 Streaming SHA-256 vs hashing-then-uploading

For files >50 MB, hashing-then-uploading reads the file twice. We can hash WHILE uploading by using a `PassThrough` stream that updates a hash in `data` events and pipes to the SDK:

```typescript
const sha = createHash('sha256');
const tee = new PassThrough();
tee.on('data', chunk => sha.update(chunk));
createReadStream(localPath).pipe(tee);
// Then use `tee` as the Body — but multipart needs ContentLength upfront,
// so we MUST pre-compute or trust statSync().
```

PLAN should resolve: stream-once-with-hash vs stream-twice; the simpler stream-twice is fine for our scale (~150 ms double-read on a 460 MB worst-case file).

---

## 8. Encryption — SSE-KMS + per-tenant CMK + Bucket Keys

### 8.1 Why SSE-KMS over SSE-S3 (AES-256, AWS-managed key)

- **Tenant cryptographic isolation.** SSE-S3 uses ONE key for the entire bucket. SSE-KMS lets us use one key per tenant, so a leaked IAM role for tenant A's read access still can't decrypt tenant B's objects (the role doesn't have `kms:Decrypt` on tenant B's CMK).
- **CloudTrail key usage events.** Every Decrypt is logged with caller identity → SOC 2 / SOX / FINRA audit evidence.
- **Customer control + rotation.** Tenant can elect to bring-their-own-key (BYOK / external KMS via XKS) for regulated industries. We support this without code change since SSE-KMS abstracts the key.
- **Compliance frameworks.** HIPAA, FedRAMP, PCI DSS 4.0.1 §3.5 all expect customer-controlled encryption keys for regulated data; SSE-KMS satisfies it.

### 8.2 Why not SSE-C (customer-provided keys)

- AWS announced April 2026 that SSE-C is **disabled by default** for new buckets (per [aws blog 2026-04 SSE-C deprecation announcement]).
- SSE-C is the vector for the 2025 S3-ransomware campaign — attackers use SSE-C with their own key to re-encrypt objects, locking the rightful owner out.
- Operational headache: client must supply the key on every GET. Sharing playback links to QA agents → exposed key.
- Not compatible with services we need (Whisper N07 reading objects, Athena Phase 4 queries).

### 8.3 Why not client-side encryption (libsodium / Tink)

- The client (R02 worker) must hold the encryption key in memory — credentialed-process compromise = key exfiltration.
- No interop with S3-native features (Object Lock, Lifecycle, Athena query, Pre-signed URL).
- We use it as an **optional** Phase-2 layer (e.g., for tenants with extreme HIPAA needs) but not the default.

### 8.4 KMS topology — one CMK per tenant + Bucket Keys

Provisioning (F05 owns, R02 reads):
```
Per tenant T:
  Create KMS CMK: alias/vici2-tenant-<T>-recordings
  Policy:
    Principal: vici2-recording-uploader role (R02)         — grants Encrypt + GenerateDataKey
    Principal: vici2-recording-reader role (R03)           — grants Decrypt (for GetObject pre-sign)
    Principal: vici2-transcription role (N07)              — grants Decrypt
    Principal: vici2-c03-auditor role                       — grants DescribeKey, GetKeyPolicy
    Principal: deny everyone else
  Enable automatic rotation: 365 days
  Tags: tenant=T, env=prod, system=vici2-recordings
```

Object upload:
```
PutObject:
  SSE: aws:kms
  KMSKeyId: alias/vici2-tenant-1-recordings
  BucketKeyEnabled: true              ← cache data key per bucket per S3-day
```

### 8.5 Bucket Keys — why mandatory

Without Bucket Keys, every PutObject = 1 KMS GenerateDataKey call; every GetObject = 1 KMS Decrypt call.

At 5,000 calls/day per tenant × 100 tenants × 30 days = 15M KMS calls/mo at $0.03/10k = **$45/mo for upload-side KMS**. Read-side worse if QA agents listen frequently.

With Bucket Keys (one data key per `<bucket, day, kms-key>` cached by S3 for the day):
- KMS request volume drops 99% → **$0.45/mo upload-side**.
- Same security posture (the data key is short-lived; rotated daily by S3 internally).
- Same CloudTrail visibility (S3 logs bucket ARN instead of object ARN in KMS events, captured under `s3.amazonaws.com` service).

Reference: [AWS Storage Blog "Reducing KMS costs by up to 99% with S3 Bucket Keys"] (2020) + [reinvent 2022 STG209].

### 8.6 KMS key cost at 100-tenant scale

- 100 tenants × $1/CMK/mo = **$100/mo for keys**.
- Bucket-keyed requests: ~5k/mo total = **$0.15/mo for requests** (in free tier).
- Total KMS bill: **~$1,200/yr** for 100 tenants.

If we used one shared CMK with key-policy conditions on prefix (alternative considered): saves $99/mo but harder to audit and a single key blast-radius. Per-tenant CMK is the right call at SaaS scale.

### 8.7 SSE-KMS doesn't help against insider-with-AWS-root

A super-admin with `kms:*` on the root account can disable / delete a CMK after 7-30 day pending window, breaking all decryption. Mitigations:
- **KMS deletion-pending window 30 days** (max) for our CMKs.
- **CloudWatch alarm** on `DeleteKey`, `ScheduleKeyDeletion`, `DisableKey` events for any `alias/vici2-*` key → page on-call SRE.
- **C03 audit_log** records all KMS lifecycle events fetched via Lambda+CloudWatch-Events.
- **MFA on root account** + biometric on the IAM admin breakglass account.

This is out of R02's scope but PLAN should document the operational dependency on these alarms.

---

## 9. Object Lock Compliance + retention + Legal Hold

### 9.1 The retention regime

| Regulatory regime | Retention floor | Source |
|---|---|---|
| TCPA private right of action | 4 years (federal statute of limitations) | 28 USC §1658 |
| TSR §310.5 (Telemarketing Sales Rule) | 5 years from record creation | 16 CFR 310.5(a) (updated 2024-03 from 2 yr) |
| State mini-TCPAs (FL FTSA, CA CIPA) | follows TCPA but plaintiffs argue 5-7 yr | FL Stat §501.059; CA Penal §637.2 |
| CFPB / Reg F (debt collection) | 3 years from end of last action | 12 CFR §1006.100 |
| SEC 17a-4(f) (financial QC) | 6 years | 17 CFR §240.17a-4 |
| FINRA Rule 4511 | 6 years | FINRA |
| HIPAA | 6 years from creation OR last use | 45 CFR §164.530(j) |

**Floor**: 5 years (TSR). **Safe-harbor**: 7 years (covers SEC + HIPAA edge cases + state mini-TCPA expansive readings). R02 ships with `tenants.settings.recording_retention_years` default = **7 years** (2557 days); operator can extend upward but not below 5 (enforced in admin UI per F02 amendment in §13). C02 PLAN §RESEARCH-13 corroborates this 7-year safe-harbor recommendation.

### 9.2 Compliance mode vs Governance mode

| Mode | Who can override retention | Use case |
|---|---|---|
| `GOVERNANCE` | IAM principal with `s3:BypassGovernanceRetention` | Internal soft-immutability; admins can correct mistakes |
| `COMPLIANCE` | NO ONE (not even root account; account deletion is the only path) | True regulatory WORM |

**We use COMPLIANCE mode.** The TCPA / TSR audit posture requires that an insider with admin credentials cannot delete evidence. The trade-off: an honest mistake (uploaded the wrong tenant's recording, mis-encoded the path) cannot be deleted for 7 years — we eat the storage cost. Mitigation: validate the upload path before PutObject (defensive programming in §11.5).

### 9.3 Per-object retention vs bucket-default retention

Two options:

| Option | Behavior |
|---|---|
| **Bucket-default retention** | Set Object Lock config at bucket-create with `Mode=COMPLIANCE, Days=2557`. Every PutObject without explicit retention headers inherits this. |
| **Per-object retention** | Bucket has Object Lock ENABLED but no default; every PutObject must pass `x-amz-object-lock-mode` + `x-amz-object-lock-retain-until-date` headers. |

**Recommendation: per-object retention.** Reasons:
- If TCPA changes (FCC raises retention to 10 yrs in 2027), we change the R02 code to compute `retainUntil = now + 10yr` for new uploads only; old uploads keep their 7-yr retention; we don't have to retroactively backdate.
- Per-tenant retention is easy: `retainUntil = now + tenants.settings.recording_retention_years * 365.25 * 86400 * 1000` ms.
- Defensive: explicit-in-code retention is reviewable in PR; a bucket-default could silently change after a Terraform refactor.

### 9.4 Lifecycle rule for retention-expiry deletion

Once retention expires, the object is no longer locked but is **not auto-deleted**. We add a Lifecycle rule:

```yaml
LifecycleConfiguration:
  Rules:
    - Id: TransitionToGIRAt30Days
      Status: Enabled
      Filter:
        Prefix: tenants/
      Transitions:
        - Days: 30
          StorageClass: GLACIER_IR
    - Id: ExpireAfter7Years
      Status: Enabled
      Filter:
        Prefix: tenants/
      Expiration:
        Days: 2557
    - Id: AbortIncompleteMultipart
      Status: Enabled
      Filter:
        Prefix: tenants/
      AbortIncompleteMultipartUpload:
        DaysAfterInitiation: 7
```

Three rules:
1. **Transition Std → GIR at 30 days** — cost reduction.
2. **Expire at 2557 days** — delete the object when retention period expires (only effective once Object Lock retention has lapsed; if Legal Hold is on, Lifecycle skips).
3. **Abort incomplete multipart uploads at 7 days** — clean up failed uploads (best practice per AWS).

**Important**: AWS S3 in 2024-09 changed Lifecycle to apply a **default 128 KB minimum object size** for transition rules. Our objects are min ~100 KB (a 5-second call at 32 KB/s = 160 KB) — mostly above the floor. But we set `ObjectSizeGreaterThan: 0` in the rule to override the default and ensure tiny objects also transition. We don't want a 90 KB voicemail recording to stay in Standard forever.

### 9.5 Legal Hold flow

```
Legal complaint arrives → C03 admin UI: "set legal hold on tenant 1 calls 2025-03-01..2025-04-30"
                       ↓
            C03 emits audit_log row: action='legal_hold.applied'
                       ↓
            C03 calls R02.SetLegalHold(tenant_id, start_date, end_date)
                       ↓
            R02 lists all objects under tenants/<tid>/calls/2025/03 + 04 (paginated)
                       ↓
            For each: PutObjectLegalHold(LegalHoldStatus=ON)
                       ↓
            R02 emits per-object audit row 'recording.legal_hold_applied'
```

`PutObjectLegalHold` is a separate S3 API from retention; legal hold is on/off (no expiry); operator removes when litigation resolves. Lifecycle rule above DOES respect legal hold — object will not be deleted at year 7 if hold is on.

### 9.6 Object Lock backend support matrix

| Backend | Compliance mode | Governance | Legal Hold | Per-object retention | Default-bucket retention |
|---|---|---|---|---|---|
| AWS S3 | YES (GA 2018) | YES | YES | YES | YES |
| Cloudflare R2 | YES (Bucket Locks GA 2025-03; per-object Q4 2025) | YES (governance equivalent) | YES (Q4 2025) | YES (Q4 2025) | YES |
| Backblaze B2 | YES (via S3 API) | YES | YES | YES | YES |
| MinIO | YES | YES | YES | YES | YES |

All four support our requirements as of 2026. R2's late addition (Q4 2025) means tenants picking R2 need to be on the post-Q4-2025 R2 deployment — verify in PLAN.

---

## 10. Worker pattern — Redis Streams consumer + BullMQ for retries

### 10.1 Architectural alternatives considered

| Pattern | Pro | Con | Verdict |
|---|---|---|---|
| **inotify file watcher** | Lowest latency (sub-second from file-close to upload start) | Per-FS-host process (doesn't scale across FS hosts cleanly); no failure-replay; non-idempotent on inotify event drops; no consent-status gate | Reject |
| **MySQL `recording_log` outbox poll (cron)** | Simple; idempotent on `WHERE storage_url IS NULL` | DB load (1 SELECT/sec × N workers); higher latency (poll interval = 5s typical) | Reject |
| **Redis Streams consumer group (`r02-uploader`)** | F04 already provides; at-least-once via XAUTOCLAIM; multi-worker scales horizontally; observable backlog | Need to manually ack | **✓ Choose** |
| **BullMQ alone (R01 enqueues to BullMQ)** | Best-in-class retries, DLQ, scheduling | Duplicates stream infra; R01 would have to write to both streams AND BullMQ | Reject as primary; **use as retry layer below stream** |
| **Temporal workflow** | Most durable; replay-on-crash; idiomatic for "long-running multi-step" | Heavyweight infra (Temporal server); overkill for one upload step | Reject |
| **Inngest** | Step-functions, no infra | Vendor lock; serverless-shaped (we have persistent infra); cost at scale | Reject |

### 10.2 Two-layer design (Stream consumer + BullMQ retry queue)

```
events:vici2.recording.stopped (T01 → recording-log-writer + r02-uploader, two groups)
            ↓
   r02-uploader consumer (workers/recording-uploader/src/stream-consumer.ts)
            ↓
   Read message, validate, decide:
     • if consent_status ∈ {prompted_declined, skipped}:
         → enqueue 'recording-delete-local' BullMQ job (delete without upload)
     • else:
         → enqueue 'recording-upload' BullMQ job
            ↓
   XACK the stream message after enqueue confirmed
            ↓
   BullMQ workers (workers/recording-uploader/src/jobs/) handle the actual work
   with exponential backoff retry + DLQ
```

**Why two layers?**
- Stream consumer is a thin router (validate event, decide action, enqueue) — it's idempotent and trivially fast (μs).
- BullMQ job is the heavy work (file read, SHA-256, S3 multipart, DB UPDATE) — needs retries, DLQ, observability.
- **Decoupling**: a network partition between stream-consumer and BullMQ-job-worker doesn't block the stream; BullMQ holds the job until workers come back.
- **Different retry semantics**: stream message gets X-AUTOCLAIM after 60s if not acked (which only happens if enqueue fails); BullMQ gets retries with backoff for upload failures.

### 10.3 Stream consumer detail

```typescript
// workers/recording-uploader/src/stream-consumer.ts

const STREAM = 'events:vici2.recording.stopped';
const GROUP = 'r02-uploader';
const CONSUMER = `r02-uploader-${process.env.HOSTNAME}-${process.pid}`;

async function run() {
  // Ensure group exists
  await redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM').catch(()=>{});

  while (true) {
    const entries = await redis.xreadgroup(
      'GROUP', GROUP, CONSUMER,
      'COUNT', '10', 'BLOCK', '5000',
      'STREAMS', STREAM, '>'
    );
    if (!entries) continue;
    for (const [, batch] of entries) {
      for (const [id, fields] of batch) {
        const event = parseRecordStopEvent(fields);
        await handle(event);
        await redis.xack(STREAM, GROUP, id);
      }
    }

    // Auto-claim stuck messages
    await redis.xautoclaim(STREAM, GROUP, CONSUMER, 60_000, '0', 'COUNT', '10');
  }
}

async function handle(event: RecordStopEvent) {
  // 1. Look up recording_log row + consent_status (already written by recording-log-writer)
  const row = await prisma.recordingLog.findUnique({
    where: { uuid_startTime: { uuid: event.callUuid, startTime: event.startedAt } }
  });

  if (!row) {
    // recording-log-writer hasn't processed yet — back off and let XAUTOCLAIM re-deliver
    log.warn({ event }, 'recording_log row not yet written; will retry');
    throw new Error('row-not-found-retry');
  }

  if (row.consentStatus === 'prompted_declined' || event.skipped) {
    await bullmq.add('recording-delete-local', { path: event.filename, recordingLogId: row.id });
  } else {
    await bullmq.add('recording-upload', { event, recordingLogId: row.id }, {
      attempts: 8,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 100,
      removeOnFail: 1000,
    });
  }
}
```

### 10.4 BullMQ job — `recording-upload`

```typescript
// workers/recording-uploader/src/jobs/recording-upload.ts

const worker = new Worker('recording-upload', async (job) => {
  const { event, recordingLogId } = job.data;
  
  // 1. Read tenant config
  const tenant = await prisma.tenant.findUnique({ where: { id: BigInt(event.tenantId) } });
  const settings = tenant.settings as TenantSettings;
  
  // 2. Compute object key
  const date = new Date(event.startedAtNs / 1e6);
  const key = `tenants/${event.tenantId}/calls/${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')}/${event.callUuid}.wav`;
  
  // 3. Read local file → SHA-256 + size
  const { sha256, size } = await hashFile(event.filename);
  
  // 4. Upload (single or multipart)
  const retainUntil = new Date(Date.now() + (settings.recordingRetentionYears ?? 7) * 365.25 * 86400 * 1000);
  const uri = await backend.put(key, createReadStream(event.filename), {
    sizeBytes: size,
    contentType: 'audio/wav',
    sse: { kmsKeyArn: settings.kmsKeyArn, bucketKeyEnabled: true },
    objectLock: { mode: 'COMPLIANCE', retainUntilDate: retainUntil, legalHold: false },
    sha256,
    metadata: { tenantId: event.tenantId, callUuid: event.callUuid, leadId: event.leadId, campaignId: event.campaignId, startedAt: date.toISOString() },
  });
  
  // 5. HEAD to verify
  const head = await backend.headWithChecksum(key);
  if (head.sha256 !== sha256) {
    throw new Error(`sha256 mismatch: local=${sha256} remote=${head.sha256}`);
  }
  
  // 6. UPDATE recording_log (single SQL; idempotent via WHERE storage_url IS NULL)
  await prisma.$executeRaw`
    UPDATE recording_log
    SET storage_url = ${uri},
        sha256 = ${Buffer.from(sha256, 'hex')},
        size_bytes = ${size},
        encoded_at = NOW(6)
    WHERE id = ${recordingLogId}
      AND start_time = ${date}
      AND storage_url IS NULL
  `;
  
  // 7. INSERT recordings (lifecycle table) — ON DUPLICATE KEY ignore
  await prisma.$executeRaw`
    INSERT INTO recordings (tenant_id, recording_log_id, lifecycle_state, s3_storage_class, deletion_pending, created_at)
    VALUES (${event.tenantId}, ${recordingLogId}, 'available', 'STANDARD', TRUE, NOW(6))
    ON DUPLICATE KEY UPDATE lifecycle_state = 'available', deletion_pending = TRUE
  `;
  
  // 8. Audit
  await auditWriter.append({
    tenantId: event.tenantId,
    actorKind: 'system',
    action: 'recording.uploaded',
    entityType: 'recording',
    entityId: recordingLogId,
    afterJson: { uri, sha256, size, retainUntil: retainUntil.toISOString() },
  });
  
  // 9. Metric
  recordingUploadedTotal.inc({ tenant_id: event.tenantId, backend: 's3' });
  recordingUploadDuration.observe({ tenant_id: event.tenantId }, Date.now() - job.timestamp);
  
  // Note: local file deletion happens in the SWEEPER (§13), NOT here.
}, { connection: redis, concurrency: 10 });
```

### 10.5 Concurrency tuning

- `concurrency: 10` per worker process — 10 simultaneous uploads.
- Memory: 10 × 64 MB (4 multipart parts × 16 MB) = 640 MB peak; t3.large (8 GB) handles.
- 1 worker process per FS host (if co-resident) OR 2-3 worker processes in a shared workers pool.
- Phase 1: 1 worker process; Phase 2 saturation: 2-3 worker processes auto-scaled by job queue depth.

---

## 11. Failure modes, backpressure, idempotency

### 11.1 Failure mode catalog

| # | Failure | Detection | Action | DLQ? |
|---|---|---|---|---|
| 1 | FS-host disk full → local file truncated | size mismatch vs `recording_log.size_bytes` (R01-writer set it from RECORD_STOP event) | Mark `recording_log.lifecycle_state='corrupt'` (F02 amendment); audit; do NOT upload; alert | Yes |
| 2 | Local file missing (R02 starts but file gone) | `fs.stat` returns ENOENT | If `recording_log.lifecycle_state='failed'` from R01: this is expected, mark deleted; else: alert "orphan event" | Yes if unexpected |
| 3 | S3 503 Slow Down (throttling) | response status | BullMQ exponential backoff; SDK auto-retries internally with backoff per request | Retry within attempts |
| 4 | S3 5xx server error | response status | Retry | Within attempts |
| 5 | Network timeout mid-upload | SDK error | Retry from beginning (for single-PUT) OR resume multipart (SDK does this) | Within attempts |
| 6 | KMS rate limit (Encrypt/GenerateDataKey throttled) | KMS error code `ThrottlingException` | Exponential backoff (KMS rate limit is regional; rare with Bucket Keys) | Within attempts |
| 7 | KMS key disabled / deleted | KMS error `DisabledException`, `NotFoundException` | FATAL — alert SEV-1; do NOT retry; DLQ; manual intervention required | Yes immediately |
| 8 | Object Lock policy mismatch (e.g., bucket Object-Lock not enabled when we set retain headers) | S3 error `InvalidRequest` | FATAL — config error; SEV-1 page; DLQ | Yes immediately |
| 9 | SHA-256 mismatch post-upload | post-HEAD comparison | Delete the bad object, retry upload (max 3); after 3 fails → DLQ + SEV-2 | After 3 mismatches |
| 10 | recording-log-writer hasn't written row yet (race) | Prisma query returns null | Throw `row-not-found-retry`; XAUTOCLAIM after 60s; should resolve | Within attempts |
| 11 | Consent declined (consent_status='prompted_declined' or 'skipped') | row check | Don't upload; enqueue `recording-delete-local` job (delete local file); audit | n/a |
| 12 | Tenant has no S3 config | tenant.settings.s3_bucket undefined | FATAL — alert SEV-2; DLQ; admin must onboard tenant | Yes |
| 13 | BullMQ Redis connection lost | error event | Reconnect with backoff; PEL jobs survive | No |
| 14 | Worker OOM during multipart | process killed | k8s/systemd restart; XAUTOCLAIM re-delivers stream message; BullMQ replays job | No |
| 15 | DB write fails (recording_log UPDATE) | Prisma error | Retry from "post-upload HEAD" step (idempotent: WHERE storage_url IS NULL skips already-updated rows) | Within attempts |

### 11.2 Idempotency contract

- **Stream consumer**: idempotent on `(tenant_id, call_uuid)`. Re-delivery from XAUTOCLAIM is fine — same enqueue happens twice but BullMQ has its own idempotency by `jobId = recordingLogId.toString()`.
- **BullMQ job**: idempotent via `recording_log.storage_url IS NULL` check. Re-running an already-uploaded job:
  - Step 4 (upload) — produces the same object (same key); S3 either creates again (overwrites, OK because Object Lock allows new versions but our bucket has Versioning OFF — see open question §16-9) OR returns ObjectLockRetainUntilDate-violation error if Versioning ON and prior object still locked.
  - Step 6 (UPDATE) — WHERE storage_url IS NULL clause; no-op if already set.
- **Object Lock + duplicate upload caveat**: If bucket Versioning is enabled, an idempotent retry creates a new version, both locked. If Versioning is disabled (recommended for R02), an idempotent retry **fails** with `ObjectAlreadyExists` (S3 returns this for Object-Locked buckets in non-versioned mode). PLAN must resolve §16-9: Versioning ON (with cost of multiple object versions per call_uuid in disaster scenarios) or OFF (idempotency relies on pre-PUT existence check). Recommendation: **Versioning OFF + pre-PUT `HeadObject` check; if exists with matching SHA-256, skip upload and proceed to UPDATE step (verify-and-record-only).**

### 11.3 Retry policy table

| Attempt | Delay before this attempt | Cumulative time |
|---|---|---|
| 1 (initial) | 0 | 0 |
| 2 | 30s × 2^0 = 30s + ±25% jitter | 30s |
| 3 | 30s × 2^1 = 60s | 90s |
| 4 | 30s × 2^2 = 120s | 3.5 min |
| 5 | 30s × 2^3 = 240s | 7.5 min |
| 6 | 30s × 2^4 = 480s | 15.5 min |
| 7 | 30s × 2^5 = 960s | 31.5 min |
| 8 | 30s × 2^6 = 1920s = 32 min | 1.05 hr |
| **DLQ + delayed-retry-queue** | 1 hr | 2 hr |
| ... | 4 hr | 6 hr |
| ... | 24 hr | 30 hr |
| **terminal DLQ + SEV-3 page** | — | — |

Total wall-clock from first attempt to terminal DLQ: ~30 hr. Local file NOT deleted during this period.

### 11.4 Backpressure — what if S3 throttles us regionally?

If S3 returns 503 Slow Down across all uploads:
- BullMQ retries with backoff — natural backpressure.
- Stream consumer keeps reading and enqueueing — BullMQ queue grows.
- After queue depth >10,000 messages → Prometheus alert `vici2_r02_queue_depth > 10000` → SRE checks if S3 is in incident.
- Local disk fills with un-uploaded files — R01 PLAN §6.3 disk-pressure backstop kicks in: at 85% warn, 95% stop new recordings. **R02 must NOT block uploads even at 95% — the priority is to drain the backlog.**
- Worker concurrency is throttled automatically by BullMQ retry delays — no manual rate-limiting needed.

### 11.5 Defensive pre-checks before PutObject

```typescript
function validateUploadParams(event, key, retainUntil) {
  assert(event.tenantId > 0, 'invalid tenant');
  assert(/^[0-9a-f-]{36}$/.test(event.callUuid), 'invalid uuid');
  assert(key.startsWith(`tenants/${event.tenantId}/`), 'key/tenant mismatch (defense vs path-injection)');
  assert(retainUntil.getTime() > Date.now() + 365*86400*1000, 'retention < 1 year — bug');
  assert(retainUntil.getTime() < Date.now() + 10*365.25*86400*1000, 'retention > 10 year — likely date arithmetic bug');
  assert(/\.wav$/i.test(key), 'expected .wav extension');
}
```

These cost μs and catch wiring bugs that would otherwise create unbreakable Object-Locked garbage objects we can't delete for 7 years.

---

## 12. Local file deletion + race-condition design

### 12.1 The race we're solving

```
   Time         R02 worker                     R03 user clicks play
   ────────────────────────────────────────────────────────────────
   t=0          Upload finishes
   t=0.01       HEAD verify SHA-256
   t=0.05       UPDATE recording_log
   t=0.06       INSERT recordings (deletion_pending=TRUE)
   t=0.07       fs.unlink(/var/lib/freeswitch/…)  ← BAD: races with R03
   t=0.08                                          GET /api/recordings/123/url
                                                  → R03 reads recordings row
                                                  → sees deletion_pending=TRUE
                                                  → falls back to s3:// URI
                                                  → returns pre-signed S3 URL
                                                  → browser plays from S3 ✓
   
   BUT: if R03 was already mid-stream from local FS at t=0.06:
   t=0.06       fd opened on local file
   t=0.07       fs.unlink → inode survives (POSIX) ✓
   t=0.10       R03 finishes reading → fd closed → inode freed
```

Open-unlink semantics handle the case where R03 is mid-read. But what if R03 starts a NEW request at t=0.07 expecting the local file to be there?

### 12.2 The fix: two-phase delete with grace + DB authority

```
Phase 1 (post-verify):
  UPDATE recording_log SET storage_url = 's3://…', sha256, size_bytes
  INSERT recordings (lifecycle='available', deletion_pending=TRUE, s3_path)

Phase 2 (sweeper, runs every 5 min):
  SELECT recordings WHERE deletion_pending = TRUE
                      AND lifecycle_state = 'available'
                      AND updated_at < NOW() - INTERVAL 1 HOUR
  For each:
    fs.unlink(local_path)
    UPDATE recordings SET deletion_pending = FALSE
```

R03 always queries `recordings` first; if `lifecycle_state='available'`, fetches `s3_path`; if local file is needed (Phase 1 dev-mode), checks `deletion_pending` and falls back to S3 URI.

### 12.3 Sweeper implementation

```typescript
// workers/recording-uploader/src/sweeper.ts

async function sweep() {
  const rows = await prisma.recording.findMany({
    where: {
      deletionPending: true,
      lifecycleState: 'available',
      updatedAt: { lt: new Date(Date.now() - 3600_000) },
    },
    take: 1000,
    include: { recordingLog: true },
  });
  
  for (const r of rows) {
    try {
      await fs.unlink(r.recordingLog.filename);
      await prisma.recording.update({
        where: { id: r.id },
        data: { deletionPending: false },
      });
      await auditWriter.append({
        tenantId: r.tenantId,
        actorKind: 'system',
        action: 'recording.local_deleted',
        entityType: 'recording',
        entityId: r.id,
        afterJson: { path: r.recordingLog.filename },
      });
      recordingLocalDeletedTotal.inc({ tenant_id: r.tenantId });
    } catch (err) {
      if (err.code === 'ENOENT') {
        // already gone — mark done
        await prisma.recording.update({ where: { id: r.id }, data: { deletionPending: false } });
      } else {
        // log and continue; will retry next sweep
        log.error({ err, r }, 'sweeper unlink failed');
        recordingSweeperErrorsTotal.inc();
      }
    }
  }
}

// Run on a 5-min interval
setInterval(sweep, 5 * 60 * 1000);
```

Sweeper runs in the same workers pool as uploaders (not a separate process — simpler ops).

### 12.4 Sweeper ownership — R02 or E06?

E06 (channel + conference janitor) sweeps abandoned FS resources; it could also own local-recording-cleanup. But:
- E06 is a Go worker in the dialer pool; R02 is Node in the workers pool. Splitting recording-cleanup between two services / languages is operational overhead.
- R02 already has the database write contract; adding the sweeper to R02 is one process to deploy.

**Recommendation: R02 owns the sweeper.** PLAN confirms.

### 12.5 Consent-declined fast-path: delete local immediately (after grace)

If `consent_status ∈ {'prompted_declined', 'skipped'}`:
- Do NOT upload to S3.
- Wait a small grace period (5 min — for audit-system reconciliation, in case there was a typo and a supervisor wants to recover) — open question §16-12.
- Delete local file.
- Set `recording_log.lifecycle_state='consent_declined_no_upload'` (F02 amendment, §13).
- Audit: `recording.consent_declined_no_upload`.

Sane pattern: a separate BullMQ job `recording-delete-local` enqueued by the stream consumer (§10.3) with a 5-min delay; on the worker side it just `fs.unlink`s and updates the row.

### 12.6 Bytes-on-disk math under R02 normal operation

- Steady state: ~100 active calls × 11.5 MB / 2 (avg in-progress) = ~600 MB resident.
- Plus: 1-hr grace × 57 GB/day / 24 = ~2.4 GB in "uploaded but not-yet-swept" state.
- Total: ~3 GB resident at any moment for a 100-agent saturation tenant. Well below R01's 200 GB scratch provisioning.

---

## 13. F02 schema amendments R02 needs

### 13.1 `recording_log` — add `sha256`, `lifecycle_state` ENUM expansion

Current (F02 PLAN §4.26):
```prisma
model RecordingLog {
  …
  storageUrl    String?  @map("storage_url") @db.VarChar(512)
  encodedAt     DateTime? @map("encoded_at")
  consentStatus ConsentStatus
  …
}
```

R02 needs to add:
```prisma
model RecordingLog {
  …
  sha256         Bytes?         @map("sha256") @db.Binary(32)
  lifecycleState RecordingLogLifecycle @default(recording_complete) @map("lifecycle_state")
  failureReason  String?        @map("failure_reason") @db.VarChar(64)
  …
}

enum RecordingLogLifecycle {
  recording_complete          // R01 wrote row
  uploading                   // R02 picked up, in flight (transient)
  uploaded                    // R02 confirmed in S3, local still present
  available                   // mirror of recordings.lifecycle_state='available'
  failed                      // R01 or R02 failure
  corrupt                     // sha256 mismatch
  consent_declined_no_upload  // C02 said don't record / declined
  orphan                      // RECORD_STOP fired but no file
  too_short                   // < RECORD_MIN_SEC
}
```

This is a **small F02 amendment** R02 IMPLEMENT can file (similar to A1-A6 amendments already landed for F02). PLAN documents this.

### 13.2 `recordings` — no amendments needed

F02 PLAN §4.18 already provisions:
- `recording_log_id`
- `s3_storage_class`
- `lifecycle_state ENUM('encoding','available','archived','deleted')`
- `legal_hold BOOLEAN`
- `share_token`

R02 writes the row at upload-complete. We rename `s3_path` (R01 PLAN §10.4 used this name) to align with the existing column name (which is implicit via `lifecycle_state` + `recording_log.storage_url`). Open question §16-10: do we need an explicit `s3_path` column on `recordings`, or do we always JOIN through `recording_log_id`?

Recommendation: rely on `recording_log.storage_url`. Don't duplicate. `recordings` is the lifecycle/sharing table; `recording_log` is the facts table.

But we DO need to add `deletion_pending BOOLEAN DEFAULT FALSE` to `recordings` — F02 PLAN §4.18 doesn't have it; R01 PLAN §10.4 specifies it; R02 amendment adds it.

### 13.3 `tenants.settings` JSON shape (no schema change; documentation only)

```json
{
  "recording_backend": "s3",
  "recording_bucket": "vici2-recordings-prod-us-east-1",
  "recording_prefix": "tenants/1/",
  "recording_retention_years": 7,
  "kms_key_arn": "arn:aws:kms:us-east-1:123456789012:alias/vici2-tenant-1-recordings",
  "recording_secondary_opus": false
}
```

R02 reads `tenants.settings` (already a `Json` column per F02 §4.1) at job-startup; caches by tenant_id with 60s TTL.

### 13.4 Migration order

```
F02-base → R02 amendment (recording_log.sha256, lifecycle_state ENUM,
                          recordings.deletion_pending)
        → F05 amendment (tenants.settings shape locked; KMS arn validation)
```

R02 IMPLEMENT files its amendment; coordinated with C02's F02-amendment batch (consent_log etc.) — see C02 PLAN §9.

---

## 14. Metrics + observability (Prometheus)

### 14.1 Counters

| Metric | Type | Labels | Description |
|---|---|---|---|
| `vici2_recording_uploaded_total` | counter | `tenant_id`, `backend` (s3/r2/b2/minio), `multipart` (true/false) | Successful uploads |
| `vici2_recording_upload_failures_total` | counter | `tenant_id`, `reason` (disk_full, network, sha256_mismatch, kms_error, object_lock_error, fatal_config) | Failures |
| `vici2_recording_upload_retries_total` | counter | `tenant_id`, `attempt` | Per-attempt counts |
| `vici2_recording_upload_dlq_total` | counter | `tenant_id`, `reason` | Terminal failures |
| `vici2_recording_consent_skipped_total` | counter | `tenant_id`, `reason` (declined, skipped) | C02-driven skips |
| `vici2_recording_local_deleted_total` | counter | `tenant_id` | Local files unlinked |
| `vici2_recording_sweeper_errors_total` | counter | `error_code` | Sweep failures |
| `vici2_recording_legal_hold_applied_total` | counter | `tenant_id` | Holds set |
| `vici2_recording_presigned_url_generated_total` | counter | `tenant_id`, `requester_role` (agent, supervisor, auditor) | URLs minted |

### 14.2 Histograms

| Metric | Buckets | Labels |
|---|---|---|
| `vici2_recording_upload_duration_seconds` | 0.5, 1, 2, 5, 10, 30, 60, 300 | `tenant_id`, `size_bucket` (small/medium/large) |
| `vici2_recording_upload_bytes_per_second` | 1M, 5M, 10M, 50M, 100M | `tenant_id`, `backend` |
| `vici2_recording_sha256_duration_seconds` | 0.05, 0.1, 0.5, 1, 5 | `tenant_id`, `size_bucket` |

### 14.3 Gauges

| Metric | Labels |
|---|---|
| `vici2_recording_queue_depth` | `queue` (recording-upload, recording-upload-dlq, recording-delete-local) |
| `vici2_recording_local_resident_bytes` | `fs_host`, `tenant_id` |
| `vici2_recording_oldest_pending_age_seconds` | `tenant_id` |
| `vici2_recording_workers_active` | `worker_id` |

### 14.4 Alert rules (O01 PLAN consumes)

| Rule | Condition | Severity |
|---|---|---|
| Upload failure rate high | `rate(vici2_recording_upload_failures_total[5m]) / rate(vici2_recording_uploaded_total[5m]) > 0.05` | warn |
| DLQ growth | `rate(vici2_recording_upload_dlq_total[15m]) > 0` | sev-2 page |
| Queue depth backlog | `vici2_recording_queue_depth{queue="recording-upload"} > 5000` for 10m | sev-2 |
| Old pending uploads | `vici2_recording_oldest_pending_age_seconds > 7200` (2 hr) | warn |
| Sweeper not running | `rate(vici2_recording_local_deleted_total[15m]) == 0 AND vici2_recording_queue_depth{queue="recording-upload-dlq"} == 0` | warn |
| Local disk pressure (FS host R02 backlog) | `vici2_recording_local_resident_bytes / disk_total > 0.7` | warn |
| SHA-256 mismatch (data integrity) | `rate(vici2_recording_upload_failures_total{reason="sha256_mismatch"}[1h]) > 0` | sev-1 page (corruption risk) |
| KMS error | `rate(vici2_recording_upload_failures_total{reason="kms_error"}[5m]) > 0.01` | sev-2 |
| Legal hold applied | `increase(vici2_recording_legal_hold_applied_total[1m]) > 0` | info-page (legal/compliance team awareness) |

---

## 15. API surface

### 15.1 Internal — for R03 (playback) and N07 (transcription)

```typescript
// services/recording/recording.service.ts (in workers/ or api/)

// Generate a pre-signed URL to play a recording from object store.
// TTL default 300s; may be overridden by caller role.
async function getPlaybackUrl(
  tenantId: bigint,
  recordingLogId: bigint,
  actor: { userId: bigint; role: UserRole },
  ttlSeconds: number = 300,
): Promise<string>;

// Check that the local file is gone (for sweep verification).
async function isLocalFileGone(recordingLogId: bigint): Promise<boolean>;

// Apply legal hold (called by C03).
async function setLegalHold(
  tenantId: bigint,
  recordingLogIds: bigint[],
  on: boolean,
  actor: { userId: bigint; role: UserRole },
): Promise<void>;

// HEAD verify (called by C03 / audit verifier).
async function verifyIntegrity(recordingLogId: bigint): Promise<{
  ok: boolean;
  localSha: string;
  remoteSha: string;
  retainUntil: Date;
  legalHold: boolean;
}>;
```

### 15.2 Admin HTTP API (R03 + M01 consume; thin wrappers over above)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/recordings/:id` | session + RBAC | Metadata (size, duration, consent_status, lifecycle_state) |
| GET | `/api/recordings/:id/url?ttl=300` | session + RBAC | Pre-signed S3 URL for playback |
| POST | `/api/recordings/:id/legal-hold` | superadmin / compliance role | Apply hold |
| DELETE | `/api/recordings/:id/legal-hold` | superadmin / compliance role | Release hold |
| GET | `/api/recordings/:id/integrity-check` | superadmin / auditor | Verify SHA-256 + Object Lock + Legal Hold state |

The HTTP layer is M01 / R03's responsibility; R02 just exposes the service-layer functions.

### 15.3 Pre-signed URL design

- TTL default 300 seconds (5 min). Long enough to start streaming; short enough that an intercepted URL has minimal blast-radius.
- TTL maximum: 3600 (1 hour) for supervisor / batch-review workflows. Rejected requests over this cap.
- TTL minimum: 60 (1 min) for highly-sensitive plays (e.g., HIPAA tenants).
- URL signature includes the `tenant_id` prefix scope — even if intercepted, attacker cannot pivot to other tenants' recordings.
- Every URL mint writes an `audit_log` row (`recording.presigned_url_generated`) with `actor`, `ttl`, `recording_id` — meta-audit per C03 §3.6.
- CloudTrail records the actual GET when browser plays (only if S3 Access Logging is on; we enable it).

### 15.4 Why not stream through our API instead of pre-signed?

Alternative: our API proxies the bytes — `/api/recordings/123/play` returns the WAV bytes with our auth headers.

Pros: 100% audit (we see the GET request, not just the URL mint).
Cons:
- Our API now handles ~10 GB/hr of audio traffic at saturation — needs more compute.
- Egress doubles: S3 → our API + our API → browser.
- Range requests (HTTP 206 for seeking) need extra implementation.

**Verdict**: pre-signed URLs (industry standard). Mitigate audit gap by enabling S3 Access Logs and querying them in C03 audit reports.

---

## 16. Open questions for PLAN (16 of them, top 7 expanded)

| # | Question | Recommendation | Why-uncertain |
|---|---|---|---|
| 1 | **Format at rest** — WAV PCM stereo or Opus mono? | WAV (preserves stereo for N07 Whisper, evidentiary value, browser-native) | Cost difference is ~$40/mo/100-agent tenant — small enough that the evidentiary upside dominates |
| 2 | **Multipart threshold** — 16 MB or 100 MB? | 16 MB | Most calls are <16 MB single-PUT; long calls genuinely benefit from multipart concurrency |
| 3 | **Sweeper owner** — R02 or E06? | R02 (single owner of recording lifecycle) | E06 is Go + dialer-side; cross-language ownership is operational overhead |
| 4 | **CMK strategy** — per-tenant CMK or shared CMK with prefix conditions? | Per-tenant CMK (~$1/mo per tenant) | Blast-radius isolation; cleaner CloudTrail; rotation flexibility per-tenant |
| 5 | **Legal Hold UI** — M01 admin button or C03-only operator API? | C03 (compliance act, not config act) | M01 admins shouldn't unilaterally manipulate evidence chain |
| 6 | **Path scheme** — `tenants/<tid>/calls/…` or hashed prefix? | tenants-first (no hash) | S3 auto-partitions; we don't need hash spreading at Phase 1; hash breaks tenant-scoped IAM policies |
| 7 | **Pre-signed URL TTL** — 5 min default? | 5 min default; cap 1 hr | balances UX and security; R03 PLAN may extend for waveform-scrubbing |
| 8 | **Per-tenant bucket or shared bucket-with-prefix?** | Shared bucket (Phase 1); per-tenant bucket option for white-label customers | Operational simplicity; tenant isolation via KMS-per-tenant is sufficient |
| 9 | **Versioning on bucket?** | OFF + pre-PUT HeadObject check | Object Lock + versioning interaction is gnarly; OFF is simpler |
| 10 | **Explicit `s3_path` column on `recordings` table or rely on `recording_log.storage_url`?** | Rely on `recording_log` (no duplication) | Avoid divergent sources of truth |
| 11 | **Worker location** — co-resident on FS host or remote (over NFS)? | Remote (workers pool) for Phase 1; FS-host-resident option for high-throughput tenants | Operational simplicity + horizontal scale; FS-host-resident is faster but couples deployment |
| 12 | **Consent-declined grace period** — delete immediately, or wait 5 min for audit reconciliation? | 5 min grace (configurable via tenants.settings) | Small grace allows supervisor recovery if C02 misfires; 5 min < typical audit-reconciliation lag |
| 13 | **Default retention years** — 7 (TSR + state mini-TCPA buffer)? | 7 (configurable 5-99 in tenant settings) | TSR floor 5; 7 is safe-harbor; cost difference 5→7 is +40% storage |
| 14 | **Backend swap on existing recordings** — migration tool? | Not Phase 1; document the seam for Phase 2 | Cross-cloud recording migrations are rare; defer |
| 15 | **Multipart part-size tuning** — 16 MB fixed or dynamic based on file size? | 16 MB fixed Phase 1; dynamic Phase 2 (file < 1 GB: 16 MB; > 1 GB: 64 MB) | Phase 1 max file is ~460 MB; fixed 16 MB is fine |
| 16 | **Pre-PUT existence check** — HEAD before every PUT (extra request, idempotent) or just retry-on-error (faster, no extra request)? | HEAD only if BullMQ job-attempt-count > 1 (i.e., retry path) | First-attempt: skip the HEAD (1 RTT savings). Retry: do the HEAD (avoid Object-Lock-violation on duplicate). |

### 16.1 Expanded — Q1 (format at rest)

The WAV-vs-Opus tradeoff is the single most consequential PLAN decision. Detailed pro/con:

WAV PCM s16le stereo 8 kHz pros:
- Browser-native (HTML5 `<audio>` plays without transcode).
- Stereo channels = customer-left, agent-right; preserved for QA listening + N07 Whisper demux.
- Lossless = evidentiary chain-of-custody intact for TCPA discovery.
- No encode CPU cost during upload (R02 is light-CPU = cheap).

WAV PCM cons:
- 11.5 MB / 6-min call = 25× larger than Opus 16 kbps.
- Storage cost line ~$80/mo at 100-agent saturation in GIR.
- Bandwidth cost on egress (R03 playback): a 6-min playback streams 11.5 MB; at AWS $0.09/GB after first 100 GB, this is $0.001/playback. At 100 plays/day = $0.10/day = $3/mo. Small.

Opus 16 kbps mono pros:
- 25× smaller = $3.20/mo storage saving at 100-agent tenant in GIR.
- Smaller egress.

Opus 16 kbps mono cons:
- **Loses stereo** — must run ffmpeg on customer-leg recording to demux; only works on stereo source; Opus is then mono → N07 Whisper can do its own diarization but the per-speaker accuracy drops.
- Requires transcode worker (ffmpeg CPU cost).
- Less universally browser-supported.
- Lossy compression artifacts (8 kHz → resampled to 48 kHz internally by Opus → lossy → 16 kbps further compression) might affect Whisper accuracy.

Verdict: WAV. Reserve Opus secondary-copy as Phase 2.

### 16.2 Expanded — Q11 (worker location)

Two deployment models for R02:

**Model A — Co-resident on each FS host**
```
fs1 ─┐
     ├ workers/recording-uploader/ (one process)
     │   reads /var/lib/freeswitch/recordings/* locally
     │   uploads to S3
     │   sweeps locally
     │
fs2 ─┤ same pattern
     │
fsN ─┘
```

Pros:
- Zero NFS dependency.
- Lower latency on file-read.
- Failure isolation per FS host.

Cons:
- Worker count = FS-host count; horizontal scaling tied to FS infrastructure.
- Same OOM as FS impacts both recording AND upload.
- Need NPM dependencies on FS host (mod_node? or separate sidecar container).

**Model B — Remote workers pool, NFS-mounted recordings dir**
```
fs1 ──┐
fs2 ──┼─ exports /var/lib/freeswitch/recordings via NFSv4
fsN ──┘                          │
                                 ▼
                       ┌──────────────────────┐
                       │ workers pool          │
                       │ (Node 20 BullMQ)      │
                       │ Mount: /recordings    │
                       │  reads via NFS        │
                       │  uploads to S3        │
                       │  sweeps via NFS rm    │
                       └──────────────────────┘
```

Pros:
- Horizontal scale of workers independent of FS hosts.
- Same workers pool serves recording-log-writer + R02 + sweeper.
- One container image; easier ops.

Cons:
- NFS dependency (latency, single-point-failure if NFS server dies).
- NFS reads burn FS host network.
- Stat() / unlink() over NFS has ~1ms latency vs μs local; ~negligible at our volume.

**Recommendation**: Model B for Phase 1 (operational simplicity). Phase 2 option to switch to Model A for tenants who saturate the NFS bandwidth.

### 16.3 Expanded — Q9 (versioning)

S3 Object Lock + Versioning interaction:

- Object Lock REQUIRES versioning enabled at bucket creation (S3 enforces).
- Wait — that's wrong: Object Lock requires versioning for legal hold and per-object retention. **YES, versioning must be ON for Object Lock.**

So Q9 reframes: **versioning is ON (mandatory for Object Lock)**. Open question is about R02's idempotency strategy:

- **Strategy 1**: First attempt = blind PUT; retry = HeadObject first, skip if exists with matching SHA.
- **Strategy 2**: Every attempt = HeadObject first, PUT if missing.

Strategy 1 is faster on the happy path (most uploads succeed first attempt). Strategy 2 is safer in retry/duplicate scenarios. Recommendation: **Strategy 1** (skip the HEAD on first attempt; do HEAD on retries via `job.attemptsMade > 0`).

If versioning ON + idempotent retry PUTs same object: two versions exist, both Object-Locked, double storage cost. Pre-HEAD on retry avoids this.

---

## 17. Citations

### 17.1 AWS official documentation
1. **S3 Multipart Upload Limits + Recommended Thresholds** — https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html , https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html — accessed 2026-05-13. Establishes 100 MB CLI default + 16-64 MB SDK part size recommendation + 5 MB minimum part + 10,000 part max.
2. **S3 Pricing 2026** — https://aws.amazon.com/s3/pricing/ — Standard $0.023/GB-mo us-east-1; Standard-IA $0.0125; Glacier IR $0.004; Deep Archive $0.00099. Per-storage-class request pricing per region.
3. **S3 Object Lock** — https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock.html — Compliance mode immutable for retention period; Governance bypassable with permission; Legal Hold independent of retention; bucket must have Versioning enabled.
4. **S3 Object Lock for SEC 17a-4** — https://aws.amazon.com/s3/features/object-lock/ — Cohasset Associates attestation for SEC 17a-4(f) / CFTC / FINRA.
5. **S3 SSE-KMS** — https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingKMSEncryption.html
6. **S3 Bucket Keys cost reduction** — https://aws.amazon.com/blogs/storage/reducing-aws-key-management-service-costs-by-up-to-99-with-s3-bucket-keys/ + https://docs.aws.amazon.com/AmazonS3/latest/userguide/bucket-key.html — "up to 99%" KMS API reduction; cacheable per `<bucket, day, kms-key>` tuple.
7. **S3 SSE-C deprecation announcement** — https://aws.amazon.com/blogs/storage/advanced-notice-amazon-s3-to-disable-the-use-of-sse-c-encryption-by-default-for-all-new-buckets-and-select-existing-buckets-in-april-2026/ — April 2026 default-off for new buckets.
8. **S3 multi-tenant prefix encryption pattern** — https://aws.amazon.com/blogs/storage/secure-data-in-a-multi-tenant-environment-by-automatically-enforcing-prefix-level-encryption-keys-in-amazon-s3/
9. **AWS KMS pricing** — https://aws.amazon.com/kms/pricing/ — $1/CMK/mo; $0.03/10k symmetric requests; 20k/mo free tier.
10. **AWS KMS cost best practices** — https://docs.aws.amazon.com/prescriptive-guidance/latest/aws-kms-best-practices/cost.html
11. **S3 Glacier Instant Retrieval** — https://aws.amazon.com/s3/storage-classes/glacier/instant-retrieval/ — millisecond first-byte; 90-day min storage; $0.004/GB-mo us-east-1.
12. **S3 storage class transition + 128KB min** — https://aws.amazon.com/about-aws/whats-new/2024/09/amazon-s3-default-minimum-object-size-lifecycle-transition-rules/ — 2024-09 default 128 KB floor; override available via `ObjectSizeGreaterThan: 0`.
13. **S3 Lifecycle abort incomplete multipart** — https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpu-abort-incomplete-mpu-lifecycle-config.html — `AbortIncompleteMultipartUpload` lifecycle action with `DaysAfterInitiation: 7`.
14. **S3 multipart object integrity / checksums** — https://docs.aws.amazon.com/AmazonS3/latest/userguide/checking-object-integrity-upload.html , https://docs.aws.amazon.com/AmazonS3/latest/userguide/tutorial-s3-mpu-additional-checksums.html — composite (Merkle-root) checksum semantics; trailing checksum; SHA-256 storage in `x-amz-checksum-sha256` for single-PUT.
15. **AWS SDK JS v3 lib-storage Upload + checksum** — https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/s3-checksums.html — default CRC32 since 3.700; explicit `ChecksumAlgorithm: 'SHA256'` opt-in.
16. **S3 Presigned URLs best practices** — https://docs.aws.amazon.com/pdfs/prescriptive-guidance/latest/presigned-url-best-practices/presigned-url-best-practices.pdf — max TTL 7 days for IAM user with SigV4; 6 hr for instance profile; CloudTrail event on use (not creation).
17. **S3 Performance / prefix scaling** — https://docs.aws.amazon.com/AmazonS3/latest/userguide/optimizing-performance.html — 3,500 PUT/s + 5,500 GET/s per prefix; unlimited prefixes; auto-partitioning.

### 17.2 Other vendor docs
18. **Cloudflare R2 S3 compat + limitations** — https://developers.cloudflare.com/r2/api/s3/api/ — list of unsupported / partial-support operations; UploadPartCopy edge cases.
19. **Cloudflare R2 Bucket Locks** — https://developers.cloudflare.com/r2/buckets/bucket-locks/ + https://developers.cloudflare.com/changelog/2025-03-06-r2-bucket-locks/ — March 2025 GA; per-prefix retention; indefinite or time-bound.
20. **Cloudflare R2 pricing 2026** — https://leanopstech.com/blog/cloudflare-r2-pricing-2026/ — $0.015/GB-mo storage; $0 egress; Class-A operations $4.50/M.
21. **Backblaze B2 Object Lock** — https://www.backblaze.com/docs/cloud-storage-object-lock + https://www.backblaze.com/docs/cloud-storage-enable-object-lock-with-the-s3-compatible-api — full S3-API Object Lock; both Compliance + Governance modes; no extra cost beyond storage.
22. **Backblaze B2 pricing + API limits** — https://www.backblaze.com/cloud-storage + https://comparestacks.com/developer-infrastructure/object-storage/details/backblaze-b2/ — $0.006/GB-mo; ~750 TPS / bucket.
23. **MinIO S3-compat + Object Lock production** — https://kx.cloudingenium.com/en/minio-s3-compatible-object-storage-self-hosted-guide/ + https://oneuptime.com/blog/post/2026-02-09-minio-distributed-ha-storage/view — Compliance mode WORM; SEC 17a-4 use case; erasure coding for production; not reversible once enabled.

### 17.3 Codecs + formats
24. **FreeSWITCH mod_shout / MP3 recording** — https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod_shout_3965531/ — LAME-based; supports bitrate + stereo flags; `record_session /tmp/x.mp3` produces MP3 if loaded.
25. **FreeSWITCH Opus codec** — https://developer.signalwire.com/freeswitch/FreeSWITCH-Explained/Modules/mod-opus/FreeSWITCH-And-The-Opus-Audio-Codec_12517398/ — required for WebRTC; 8/16/48 kHz support.
26. **FFmpeg + Opus encoding** — https://ffmpeg.org/ffmpeg-codecs.html (libopus) — requires --enable-libopus build flag.
27. **Whisper audio format requirements** — https://github.com/openai/whisper/discussions/870 , https://www.saytowords.com/blogs/Whisper-Audio-Requirements/ — internally resamples to 16 kHz mono; stereo auto-downmix or single-channel selection.
28. **Opus speech compression** — FusionPBX forums "Transcode Recorded Calls to Opus, Reducing Storage Needs" — https://www.pbxforums.com/threads/transcode-recorded-calls-to-opus-reducing-storage-needs.4008/ — 3.3% of WAV size.

### 17.4 Worker patterns + queues
29. **BullMQ retry + exponential backoff** — https://docs.bullmq.io/guide/retrying-failing-jobs + https://docs.bullmq.io/bull/patterns/custom-backoff-strategy — `2^(attempts-1) × delay` exponential formula; customizable strategies.
30. **BullMQ vs Inngest vs Temporal 2026 comparison** — https://starterpick.com/guides/inngest-vs-bullmq-vs-triggerdev-boilerplates-2026 + https://trybuildpilot.com/610-trigger-dev-vs-inngest-vs-temporal-2026 — BullMQ best for "Redis + persistent worker + high-volume throughput"; Inngest for serverless; Temporal for multi-day workflows.
31. **inotify Linux man page + limitations** — https://man7.org/linux/man-pages/man7/inotify.7.html — no recursive; event queue overflow possible; no process-attribution.

### 17.5 Regulatory + compliance
32. **TSR §310.5 record retention 2024 update** — https://www.law.cornell.edu/cfr/text/16/310.5 + https://tcpaworld.com/2024/03/12/are-you-prepared-tsrs-new-consent-recordkeeping-requirements/ — 5-year retention (raised from 2-year 2024-03).
33. **TCPA 4-year statute of limitations** — https://www.tratta.io/blog/tcpa-statute-of-limitations-changes-regulations + 28 USC §1658 — federal default 4 yr; some states longer.
34. **PCI DSS 4.0.1 call recording** — https://securitywall.co/blog/pci-dss-v4-changes-2026 + https://www.paytia.com/resources/blog/5-essential-tips-for-pci-compliant-phone-payments — DTMF suppression / channel separation required; recordings with cardholder data fall under PCI scope; in-force since 2025-03-31.
35. **CFPB Reg F §1006.100** — https://www.consumerfinance.gov/rules-policy/regulations/1006/100/ — 3-yr retention for debt-collection.
36. **TCPA recordkeeping + consent recording** — https://www.tatango.com/resources/qa-videos/how-long-do-you-need-to-keep-records-for-tcpa-compliance/

### 17.6 Cross-references to local docs
37. `/root/vici2/DESIGN.md` §2.1, §17.3, §21.1 — recording storage + cost line ($23/TB-mo Standard) + Phase-1 audit log immutability + S3 object lock 4-year ceiling.
38. `/root/vici2/SPEC.md` §R02 + §5 module index — R02 is "Recording metadata + S3 upload" → R01, F02; blocks R03 + N07.
39. `/root/vici2/spec/modules/R01/PLAN.md` §3 (path), §5 (failure model), §7 (Go API), §8 (T01 stream consumer contract), §10.4 (hand-off to R02 — deletion-pending + grace window), §12 (tests).
40. `/root/vici2/spec/modules/F02/PLAN.md` §4.18 (`recordings` lifecycle table — non-partitioned; `lifecycle_state ENUM('encoding','available','archived','deleted')`, `legal_hold`, `s3_storage_class`, `share_token`), §4.26 (`recording_log` partitioned write log; `storage_url VARCHAR(512)`, `consent_status ENUM`, `encoded_at`), §6 (7-year retention partitions).
41. `/root/vici2/spec/modules/F04/PLAN.md` §4.10 (cross-cutting durable event streams), §5 (consumer groups + XAUTOCLAIM + XACK), §6.3 (Lua scripts at-least-once semantics).
42. `/root/vici2/spec/modules/C02/PLAN.md` §7.3 (`vici2_consent_status` channel-var → `recording_log.consent_status`), §13 (TCPA stakes restated; PA B2B carve-out 1-year retention requirement edge case).
43. `/root/vici2/spec/modules/C03/PLAN.md` §3.6 (`audit_log` hash chain; R02 events flow through C03's `AuditWriter`), §11.4 (`consent_log` standalone table — C03 adds chain columns), §6 (retention rotation contract for C04).
44. `/root/vici2/spec/modules/F03/PLAN.md` §10 (sip-profile `record-template` matches §5.1 path), §14.2 (file template canonical form), §1125 (`recordings_dir=/var/lib/freeswitch/recordings`).
45. `/root/vici2/spec/modules/E02/RESEARCH.md` — depth + format reference for this RESEARCH.

---

## 18. Recommended PLAN-phase next steps

PLAN.md should be ~800-1200 lines covering:

1. **Frozen format-at-rest decision** — WAV PCM s16le stereo 8 kHz (or 16 kHz when source is G.722). No transcode in R02. Reserve Opus secondary-copy for Phase 2 behind a `tenants.settings.recording_secondary_opus` flag.

2. **Storage configuration frozen** — Default `s3` backend, Standard storage class on PutObject, Lifecycle rule transitions to Glacier IR at day 30 + Expire at day 2557 + Abort incomplete multipart at day 7. SSE-KMS with per-tenant CMK + Bucket Keys enabled. Object Lock Compliance mode with per-object retention `retainUntil = now + tenants.settings.recording_retention_years` (default 7 yr).

3. **Path scheme frozen** — `s3://<bucket>/tenants/<tid>/calls/<YYYY>/<MM>/<DD>/<call_uuid>.wav`. Metadata in S3 object metadata, not in the key.

4. **Upload strategy frozen** — Single PutObject for ≤16 MB; multipart Upload (16 MB parts, 4 concurrent) for >16 MB. SHA-256 streamed client-side, verified via HEAD after upload.

5. **Worker architecture frozen** — Node 20 Redis-Streams consumer (`r02-uploader` group on `events:vici2.recording.stopped`) → BullMQ job `recording-upload` (8 attempts × exponential backoff 30s base × ±25% jitter) → BullMQ `recording-upload-dlq` after 24h cumulative wall-clock.

6. **F02 amendment filed** — R02 IMPLEMENT files an F02 amendment adding `recording_log.sha256 BINARY(32)`, `recording_log.lifecycle_state RecordingLogLifecycle ENUM` (with 9 values), `recording_log.failure_reason VARCHAR(64)`, `recordings.deletion_pending BOOLEAN DEFAULT FALSE`. Coordinated with C02's F02 amendment batch.

7. **Sweeper inside R02** — 5-min interval; selects `recordings WHERE deletion_pending=TRUE AND lifecycle_state='available' AND updated_at < now() - 1h`; unlinks local file; emits audit row.

8. **Internal API surface frozen** — `getPlaybackUrl()`, `setLegalHold()`, `verifyIntegrity()`. HTTP layer is R03 + M01's concern; R02 ships service functions.

9. **Metrics + alerts inventory** — see §14.

10. **Resolutions for all 16 open questions** as listed in §16 + the expanded analysis for Q1, Q11, Q9.

11. **Test plan** — unit tests for path computation, SHA-256 streaming, backoff math; integration tests against MinIO (docker-compose); end-to-end test that ends a SIPp call → within 60s the object is in MinIO + `recording_log` updated + 1-hr-grace-then-local-file-gone after sweeper.

12. **HANDOFF document** for R03 + N07: pre-signed URL contract, legal-hold contract, integrity-verification contract, tenant-config shape.

---

**End of R02 RESEARCH.md.**
