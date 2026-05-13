# N07 — Call Transcription Pipeline (Whisper) — PLAN

| Field | Value |
|---|---|
| Module | N07 — post-call speech-to-text, diarization, PII redaction |
| Phase | 3 (plan ready; implementation gate = R02 DONE + Phase 3 kickoff) |
| Owner agent type | backend-python (GPU worker) + backend-node (job queue / API) |
| Status | PLAN |
| Date | 2026-05-13 |
| Depends-on (DONE/PLAN-stable) | R01 (stereo WAV contract), R02 (S3 upload + `lifecycle_state='available'`), C02 (consent gate), C03 (AuditWriter), F02 (`recording_log` schema) |
| Blocks | A05/A07 (transcript playback UI), C04 (retention sweep must include transcript sidecar), future: sentiment/QA modules |
| Source RESEARCH | [N07/RESEARCH.md](RESEARCH.md) |

---

## 1. Goals and Non-Goals

### 1.1 Goals — what N07 owns

1. **Consume** `events:vici2.transcription.requested` (Redis Stream, published by R02 on `lifecycle_state='available'`).
2. **Consent gate** — check `recording_log.consent_status`; skip transcription and set `transcript_status='consent_blocked'` for `prompted_declined`/`skipped` recordings.
3. **Download WAV** from S3 using pre-signed URL (R02's `getPlaybackUrl()` helper) or via direct IAM access.
4. **Stereo demux** — split L/R channels into `customer.wav` / `agent.wav`; resample 8 kHz → 16 kHz for Whisper.
5. **Transcribe** each channel independently with `faster-whisper` (`large-v3-turbo`, INT8).
6. **Align word timestamps** using WhisperX forced alignment.
7. **Mono fallback** — if stereo check fails, run WhisperX diarization (pyannote 3.x) and assign `SPEAKER_00` / `SPEAKER_01` labels.
8. **Merge** customer + agent (or diarized) segments into an interleaved timeline sorted by `start`.
9. **Language detection** — record detected language in `recording_log.transcript_lang` (BCP-47).
10. **PII redaction** — run Presidio (`en` + `es` pipelines in Phase 3); produce `transcript.json` (redacted) and optionally `transcript.raw.json` (raw, encrypted, superadmin-only).
11. **Upload** JSON sidecars to S3; same tenant CMK + Object Lock as WAV.
12. **Update** `recording_log.transcript_uri`, `.transcript_status`, `.transcript_lang`, `.transcript_word_count`.
13. **Emit** C03 audit row `transcription.completed` (and `transcription.pii_redacted` if PII found).
14. **Prometheus metrics** (`vici2_transcription_*` family).
15. **DLQ + alerts** for terminal failures.

### 1.2 Non-goals (explicit)

| Deferred to | What |
|---|---|
| **R01** | Recording start/stop; WAV creation |
| **R02** | S3 upload of WAV; `lifecycle_state='available'` gate |
| **C02** | Recording consent decision; N07 reads the result, does not re-decide |
| **C03** | Audit log immutability; N07 calls `AuditWriter`, does not write `audit_log` directly |
| **C04** | Transcript retention/deletion sweep (C04 reads `recording_log.transcript_uri`) |
| **A05/A07** | UI playback of transcript; N07 provides the API endpoint, not the UI component |
| **Phase 4** | Real-time streaming transcription (sub-5-second latency during live call) |
| **Phase 4** | Sentiment analysis, topic detection, QA scoring on transcript text |
| **Phase 4** | WhisperJAX / TPU execution |
| **Phase 4** | Per-language model routing (all Phase 3 uses `large-v3-turbo` multilingual) |
| **Phase 4** | NeMo MSDD diarization upgrade |
| **Phase 4** | Additional PII languages beyond `en` + `es` |
| **Phase 4** | AWS Comprehend PII backend |

---

## 2. Engine Choice

### 2.1 Phase 3 default: faster-whisper self-hosted

**Engine:** `faster-whisper` 1.x with `large-v3-turbo` model, INT8 quantization, batched inference (batch=8).

**Rationale:**

| Factor | faster-whisper self-host | Deepgram API (next-best) |
|---|---|---|
| Price (100k min/day) | $0.00034/min | $0.0043/min (12.6× more) |
| WER (G.711 English) | ~3–4% | ~8–10% |
| On-prem support | Yes | License required |
| Training data | Never leaves environment | Opt-out required |
| Diarization | WhisperX (open-source) | Built-in |
| PII redaction | Presidio (self-hosted) | Built-in |
| Word timestamps | Yes (WhisperX alignment) | Yes |

Self-hosted wins on cost, accuracy, data sovereignty, and PII control. The operational overhead of a GPU pod is offset by the 12.6× cost reduction at scale.

**Hardware target:** AWS `g5.xlarge` (NVIDIA A10G, 24 GB VRAM) or GCP `g2-standard-4` (L4, 24 GB). 2 GPU pods Phase 3; autoscale to 4 on BullMQ queue depth >500.

### 2.2 Phase 3+ vendor API fallback

`N07_FALLBACK_BACKEND ∈ {deepgram, assemblyai, none}` (default `none`). When set:

- GPU pod is unavailable or overloaded (circuit breaker: queue depth >2000 for >15 min).
- Tenant has explicitly opted for vendor API (`tenants.settings.transcription_backend = 'deepgram'`).

Vendor API path uses the same BullMQ job; the Python worker is replaced by an HTTP call to the vendor, and the JSON sidecar is constructed from the vendor's response. Presidio PII redaction still runs on the vendor transcript text before upload.

### 2.3 Model variants

| Tenant setting `transcription_model` | Model used | Notes |
|---|---|---|
| `auto` (default) | `large-v3-turbo` | Best accuracy/speed balance |
| `fast` | `distil-large-v3` | English-only; ~2× faster; WER +0.3% |
| `economy` | `medium` | ~2× faster than turbo; WER +0.7% |
| `large` | `large-v3` | Highest accuracy; ~2.5× slower |

---

## 3. Architecture

### 3.1 Component overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  R02 worker (Node.js)                                               │
│  After recording_log.lifecycle_state → 'available':                 │
│  XADD events:vici2.transcription.requested                          │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  N07 Stream Consumer  (Node.js / BullMQ enqueuer)                   │
│  workers/transcription/src/stream-consumer.ts                       │
│                                                                     │
│  XREADGROUP  events:vici2.transcription.requested                   │
│  GROUP:      n07-transcriber                                        │
│  BLOCK:      5000 ms  COUNT: 10                                     │
│                                                                     │
│  → consent gate: consent_status = 'prompted_declined'?              │
│       YES → UPDATE transcript_status='consent_blocked'; XACK        │
│       NO  → enqueue BullMQ 'transcription-job' (jobId=recordingLogId) │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  BullMQ Queue: 'transcription'   (Redis, same cluster as R02)       │
│  concurrency: 4 per worker process (I/O-bound: download + upload)   │
│  attempts: 6   backoff: exponential 60s base ±25% jitter            │
└────────────────────────────┬────────────────────────────────────────┘
                             │  Job payload: { recordingLogId, callUuid,
                             │                storageUrl, tenantId,
                             │                consentStatus, durationSec }
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  N07 GPU Worker  (Python / FastAPI gRPC service)                    │
│  workers/transcription/python/transcription_service.py              │
│                                                                     │
│  Called by BullMQ job via HTTP POST localhost:8765/transcribe       │
│  (sidecar pod on same Kubernetes node, or Docker network)           │
│                                                                     │
│  Steps:                                                             │
│  1. Download WAV from S3 → /tmp/<uuid>.wav                          │
│  2. Stereo check → demux L/R or flag mono fallback                  │
│  3. Resample 8kHz → 16kHz (torchaudio)                             │
│  4. Detect language (30-sec Whisper pass on customer channel)       │
│  5. Transcribe customer.wav + agent.wav in parallel (2 GPU streams) │
│  6. WhisperX word alignment on each channel                         │
│  7. Merge + sort segments by start time                             │
│  8. Presidio PII redaction (en/es pipeline)                         │
│  9. Return structured JSON (redacted + raw flag)                    │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  N07 BullMQ Job (Node.js) — post-GPU steps                         │
│  workers/transcription/src/jobs/transcription-job.ts               │
│                                                                     │
│  10. Upload transcript.json + transcript.raw.json to S3             │
│  11. UPDATE recording_log: transcript_uri, transcript_status,       │
│      transcript_lang, transcript_word_count                         │
│  12. AuditWriter.append('transcription.completed')                  │
│  13. AuditWriter.append('transcription.pii_redacted') if PII found  │
│  14. Prometheus metrics                                             │
│  15. XACK                                                           │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 GPU pod scheduling

**Kubernetes (Phase 3 target):**

```yaml
# workers/transcription/k8s/gpu-worker-deployment.yaml
resources:
  limits:
    nvidia.com/gpu: "1"
  requests:
    nvidia.com/gpu: "1"
    memory: "8Gi"
    cpu: "2"
nodeSelector:
  karpenter.k8s.aws/instance-gpu-manufacturer: nvidia
  karpenter.k8s.aws/instance-gpu-memory: "24576"  # A10G = 24 GB
```

**BullMQ queue-depth-based autoscale (KEDA):**

```yaml
# workers/transcription/k8s/keda-scaledobject.yaml
triggers:
  - type: redis
    metadata:
      listName: bull:transcription:wait
      listLength: "50"          # scale up at 50 pending jobs
      activationListLength: "5" # at least 5 to trigger scale
minReplicaCount: 1
maxReplicaCount: 4
```

**Docker Compose dev:**

```yaml
services:
  n07-python-worker:
    build: workers/transcription/python/
    runtime: nvidia              # requires nvidia-container-toolkit
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
    environment:
      - WHISPER_MODEL=large-v3-turbo
      - WHISPER_DEVICE=cuda
      - WHISPER_COMPUTE_TYPE=int8
  n07-node-worker:
    build: workers/transcription/
    depends_on: [n07-python-worker, redis]
```

**CPU fallback (no GPU):** Set `WHISPER_DEVICE=cpu`, `WHISPER_COMPUTE_TYPE=int8`. RTF ~0.6× for `large-v3-turbo`. Viable for <5k min/day tenants.

---

## 4. Job Flow (Step-by-Step)

### 4.1 R02 → N07 trigger

R02 IMPLEMENT adds to `workers/recording-uploader/src/jobs/recording-upload.ts`:

```typescript
// After lifecycle_state set to 'available':
await redis.xadd('events:vici2.transcription.requested', '*',
  'recording_log_id', recordingLogId.toString(),
  'call_uuid',        event.callUuid,
  'tenant_id',        event.tenantId.toString(),
  'storage_url',      storageUrl,
  'consent_status',   consentStatus,
  'duration_sec',     durationSec.toString(),
  'published_at',     Date.now().toString(),
);
```

**Note:** R02 PLAN §1.2 marks N07 as Phase 4. This plan re-classifies it as Phase 3. The `XADD` call in R02 is a net-new line added by N07 IMPLEMENT (N07 IMPLEMENT amends R02 worker, not N07 itself).

### 4.2 Stream consumer consent gate

```typescript
// workers/transcription/src/stream-consumer.ts
const consentBlocked = ['prompted_declined', 'skipped'].includes(msg.consent_status);
if (consentBlocked) {
  await prisma.recordingLog.update({
    where: { id: BigInt(msg.recording_log_id), startTime: /* partition key */ },
    data: { transcriptStatus: 'consent_blocked' },
  });
  await redis.xack('events:vici2.transcription.requested', 'n07-transcriber', msg.id);
  return;
}
```

### 4.3 Python GPU worker: transcription service

```python
# workers/transcription/python/transcription_service.py (key logic)

from faster_whisper import WhisperModel, BatchedInferencePipeline
import soundfile as sf
import numpy as np
import torchaudio

model = WhisperModel("large-v3-turbo", device="cuda", compute_type="int8")
batched = BatchedInferencePipeline(model=model)

def transcribe_channel(audio_np: np.ndarray, lang_hint: str | None) -> dict:
    segments, info = batched.transcribe(
        audio_np,
        language=lang_hint,        # None = auto-detect
        batch_size=8,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
    )
    return {
        "lang": info.language,
        "lang_prob": info.language_probability,
        "segments": [
            {
                "start": s.start,
                "end": s.end,
                "text": s.text,
                "words": [{"word": w.word, "start": w.start, "end": w.end, "score": w.probability}
                           for w in (s.words or [])],
            }
            for s in segments
        ],
    }

def demux_stereo(wav_path: str) -> tuple[np.ndarray, np.ndarray, int]:
    data, sr = sf.read(wav_path, dtype="int16", always_2d=True)
    if data.ndim == 1 or data.shape[1] == 1:
        return None, None, sr   # mono — trigger diarization path
    customer = data[:, 0].astype(np.float32) / 32768.0
    agent    = data[:, 1].astype(np.float32) / 32768.0
    return customer, agent, sr

def resample(audio: np.ndarray, orig_sr: int, target_sr: int = 16000) -> np.ndarray:
    t = torch.from_numpy(audio).unsqueeze(0)
    r = torchaudio.functional.resample(t, orig_sr, target_sr)
    return r.squeeze(0).numpy()
```

### 4.4 Merge + sidecar assembly

```python
def merge_segments(customer_segs, agent_segs) -> list:
    merged = (
        [{"channel": "customer", **s} for s in customer_segs] +
        [{"channel": "agent",    **s} for s in agent_segs]
    )
    return sorted(merged, key=lambda s: s["start"])
```

### 4.5 PII redaction (Presidio)

```python
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine

analyzer  = AnalyzerEngine()   # loaded once at startup; ~3s init
anonymizer = AnonymizerEngine()

def redact_segments(segments: list, lang: str) -> tuple[list, int, list]:
    """Returns (redacted_segments, entity_count, entity_types_found)"""
    entity_count = 0
    entity_types = set()
    redacted = []
    for seg in segments:
        results = analyzer.analyze(text=seg["text"], language=lang[:2])
        if results:
            entity_count += len(results)
            entity_types.update(r.entity_type for r in results)
            anonymized = anonymizer.anonymize(text=seg["text"], analyzer_results=results)
            redacted.append({**seg, "text": anonymized.text})
        else:
            redacted.append(seg)
    return redacted, entity_count, sorted(entity_types)
```

### 4.6 S3 upload (Node.js post-GPU step)

```typescript
// workers/transcription/src/jobs/transcription-job.ts
const transcriptKey    = `tenants/${tenantId}/calls/${yyyy}/${mm}/${dd}/${callUuid}.transcript.json`;
const rawTranscriptKey = `tenants/${tenantId}/calls/${yyyy}/${mm}/${dd}/${callUuid}.transcript.raw.json`;

await s3.send(new PutObjectCommand({
  Bucket: bucket,
  Key: transcriptKey,
  Body: JSON.stringify(redactedTranscript),
  ContentType: 'application/json',
  ServerSideEncryption: 'aws:kms',
  SSEKMSKeyId: tenantKmsArn,
  BucketKeyEnabled: true,
  ObjectLockMode: 'COMPLIANCE',
  ObjectLockRetainUntilDate: retainUntilDate,
  Metadata: { 'recording-log-id': recordingLogId.toString() },
}));

if (retainRaw) {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: rawTranscriptKey,
    Body: JSON.stringify(rawTranscript),
    // same SSE-KMS + Object Lock as above
    Metadata: { 'pii-present': 'true', 'access-role': 'compliance' },
  }));
}
```

---

## 5. Schema Amendments

N07 IMPLEMENT files a Prisma migration adding 4 columns to `recording_log` and a new enum:

```prisma
// N07 amendments on RecordingLog:
transcriptUri       String?          @map("transcript_uri") @db.VarChar(512)
transcriptStatus    TranscriptStatus @default(pending) @map("transcript_status")
transcriptLang      String?          @map("transcript_lang") @db.VarChar(16)
transcriptWordCount Int?             @map("transcript_word_count")
```

```prisma
enum TranscriptStatus {
  pending          // recording uploaded; not yet enqueued
  queued           // BullMQ job created
  processing       // GPU worker has audio
  completed        // transcript.json uploaded; URI set
  failed           // terminal failure after retries
  skipped          // no transcription configured for this tenant
  consent_blocked  // consent_status blocks transcription
}
```

**Migration SQL (generated by Prisma):**

```sql
ALTER TABLE recording_log
  ADD COLUMN transcript_uri       VARCHAR(512)  NULL              AFTER storage_url,
  ADD COLUMN transcript_status    ENUM(
    'pending','queued','processing','completed',
    'failed','skipped','consent_blocked'
  ) NOT NULL DEFAULT 'pending'                                     AFTER transcript_uri,
  ADD COLUMN transcript_lang      VARCHAR(16)   NULL              AFTER transcript_status,
  ADD COLUMN transcript_word_count INT          NULL              AFTER transcript_lang;

CREATE INDEX idx_recording_log_t_transcript
  ON recording_log (tenant_id, transcript_status, start_time);
```

No changes to `recordings` table. No changes to `tenants` schema (transcript settings live in `tenants.settings` JSON).

**`tenants.settings` additions (documented, no schema change):**

```json
{
  "transcription_enabled": true,
  "transcription_model": "auto",
  "transcription_backend": "self-hosted",
  "transcription_lang_hint": null,
  "transcription_retain_raw": true,
  "transcription_pii_backend": "presidio"
}
```

---

## 6. Idempotency, Retry Policy, and DLQ

### 6.1 Idempotency contract

| Layer | Mechanism |
|---|---|
| Redis Stream | XAUTOCLAIM after 120s idle; re-delivers to stream consumer |
| BullMQ job | `jobId = recordingLogId.toString()` — BullMQ deduplicates active+waiting jobs by ID |
| GPU worker | Stateless; transcript JSON computed from WAV bytes; safe to recompute |
| S3 upload | `PutObject` is idempotent; Object Lock version stacking avoided by checking `HeadObject` on retry (`job.attemptsMade > 0`) |
| DB UPDATE | `WHERE transcript_uri IS NULL` CAS; no-op if already set |

### 6.2 Retry policy

```typescript
{
  attempts: 6,
  backoff: { type: 'exponential', delay: 60_000 },  // 60s base ±25% jitter
  removeOnComplete: 50,
  removeOnFail: 500,
  jobId: recordingLogId.toString(),
}
```

| Attempt | Delay before | Cumulative |
|---|---|---|
| 1 (initial) | 0 | 0 |
| 2 | 60 s | ~60 s |
| 3 | 120 s | ~3 min |
| 4 | 240 s | ~7 min |
| 5 | 480 s | ~15 min |
| 6 | 960 s | ~31 min |
| DLQ | — | ~1 hr |

After 6 attempts: `transcript_status = 'failed'`; `AuditWriter.append('transcription.failed')`; DLQ job `transcription-dlq`.

### 6.3 DLQ

Queue: `bull:transcription-dlq`. Jobs remain for 30 days (manual review). Alert: `rate(vici2_transcription_dlq_total[15m]) > 0` → SEV-2.

### 6.4 Failure modes

| Failure | Detection | Action |
|---|---|---|
| GPU OOM | Python service returns 500 | BullMQ retry (exponential) |
| S3 download failure (WAV not yet available) | HTTP 403/404 | Retry; if `recording_log.lifecycle_state != 'available'` after 3 retries: DLQ |
| Whisper CUDA error | Python exception | Restart GPU service; job retried by BullMQ |
| Presidio timeout (>10 s) | HTTP timeout | Skip redaction; set `transcript_flags: ["presidio_timeout"]`; upload unredacted (log warn + SEV-2) |
| DB update failure (MySQL deadlock) | Prisma error | BullMQ retry |
| Consent blocked (late detection) | `consent_status` field | Set `transcript_status='consent_blocked'`; no upload; XACK |

---

## 7. API: GET /api/recordings/:id/transcript

### 7.1 Endpoint design

```
GET /api/recordings/:id/transcript
Authorization: Bearer <session>
Query params:
  ?format=json       (default) — return transcript JSON inline (if word_count < 5000)
  ?format=url        — return pre-signed S3 URL (always, for large transcripts)
  ?raw=true          — include raw (pre-redaction) segments (superadmin + compliance_auditor only)
```

**Response (inline, word_count < 5000):**

```json
HTTP 200
{
  "recording_log_id": 12345,
  "call_uuid": "8a3e1c4f-...",
  "transcript_status": "completed",
  "transcript_lang": "en-US",
  "word_count": 842,
  "processing_ms": 14420,
  "engine": "faster-whisper",
  "model": "large-v3-turbo",
  "stereo_mode": true,
  "pii_redacted": true,
  "segments": [...]
}
```

**Response (URL mode or word_count >= 5000):**

```json
HTTP 200
{
  "transcript_status": "completed",
  "transcript_url": "https://s3.amazonaws.com/...?X-Amz-Signature=...",
  "expires_in_seconds": 300
}
```

**Error responses:**

| Case | HTTP |
|---|---|
| transcript_status = 'pending'/'queued'/'processing' | 202 + `{"status": "processing"}` |
| transcript_status = 'failed' | 200 + `{"status": "failed", "retry_available": true}` |
| transcript_status = 'consent_blocked' | 403 + `{"error": "transcript_consent_blocked"}` |
| Caller lacks RBAC (agent requesting another agent's call) | 403 |
| Caller requests `?raw=true` without compliance role | 403 |

### 7.2 RBAC

| Role | Access |
|---|---|
| `agent` | Own calls only (userId match) |
| `supervisor` | All calls in their campaigns |
| `admin` | All calls in their tenant |
| `superadmin` | All calls; `?raw=true` allowed |
| `compliance_auditor` | All calls in their tenant; `?raw=true` allowed |

### 7.3 Manual re-transcription

```
POST /api/recordings/:id/transcript/retry
Authorization: Bearer <session> (admin+ only)
```

Enqueues a new BullMQ job (bypasses stream consumer). Resets `transcript_status='queued'`. Returns `202`. Rate-limited to 1 re-transcription per recording per hour.

---

## 8. UI Hooks (A05/A07)

### 8.1 A07 — Supervisor historical review

A07 IMPLEMENT will:

1. Call `GET /api/recordings/:id/transcript` on the recording detail panel.
2. If `transcript_status ∈ {pending, queued, processing}`: show a spinner + "Transcription in progress" with 10-second polling.
3. If `completed`: render the transcript in a scrollable panel with speaker color-coding (customer = blue, agent = green).
4. Word-click → seek audio playback to `word.start` timestamp (requires R03's `<audio>` element with `currentTime` setter).
5. PII redaction indicator: tooltip on redacted tokens showing entity type (e.g., `[CREDIT_CARD]`).

### 8.2 A05 — Agent post-call summary (Phase 3+)

A05 (agent desktop) displays a condensed post-call transcript summary (customer-turn-only highlights) after call disposition. Full transcript links to A07.

### 8.3 Search integration (Phase 4)

Full-text search on `segments[*].text` is deferred to Phase 4 (requires Elasticsearch / OpenSearch ingestion pipeline). N07 does not write to search indexes in Phase 3.

---

## 9. Quality KPIs

### 9.1 WER (Word Error Rate)

Measured quarterly against a golden test set of 100 manually-transcribed calls per language:

| Language | Phase 3 target WER | Alert threshold |
|---|---|---|
| English (G.711 8kHz) | <5% | >7% → SEV-2 + model upgrade |
| Spanish (G.711 8kHz) | <8% | >12% → SEV-2 |
| Other | track only | N/A |

**WER measurement pipeline:**

```python
# scripts/eval/measure_wer.py
from jiwer import wer
reference = load_golden_transcripts("eval/golden/en/")
hypothesis = load_n07_transcripts(recording_ids)
print(wer(reference, hypothesis))
```

Golden fixtures stored in `workers/transcription/eval/golden/{lang}/` (WAV + ground-truth `.txt` pairs). Excluded from production S3 bucket.

### 9.2 Processing latency

Prometheus histogram: `vici2_transcription_processing_duration_seconds` (labels: `model`, `lang`, `stereo`, `size_bucket`).

| p50 target | p99 target |
|---|---|
| <10 s for 6-min call | <45 s for 6-min call |

Alert: `histogram_quantile(0.99, rate(vici2_transcription_processing_duration_seconds_bucket[10m])) > 60` → SEV-2.

### 9.3 PII redaction recall

Measured weekly against a synthetic golden set of 50 transcripts with known PII injected:

- SSN recall target: >99%
- Credit card recall target: >99%
- General PII recall target: >95%

Measured via `scripts/eval/measure_pii_recall.py`.

---

## 10. Cost Projection

### 10.1 1,000 min/day (small tenant)

| Component | Unit | Quantity | Rate | Cost/day |
|---|---|---|---|---|
| g5.xlarge (A10G) reserved 1-yr | GPU-hr | 0.05 | $0.636/hr | $0.032 |
| S3 transcript storage (50 KB avg) | GB-mo | 0.0015 | $0.023/GB-mo | $0.0001 |
| Presidio CPU (t3.medium share) | CPU-hr | 0.03 | $0.052/hr | $0.002 |
| Redis BullMQ queue (ElastiCache share) | — | share | share | ~$0.01 |
| **Total** | | | | **~$0.044/day = $0.000044/min** |

### 10.2 100,000 min/day (large tenant)

| Component | Unit | Quantity | Rate | Cost/day |
|---|---|---|---|---|
| g5.xlarge × 2 reserved 1-yr | GPU-hr | 52.8 | $0.636/hr | $33.57 |
| S3 transcript storage | GB-mo | 0.15 | $0.023/GB-mo | $0.003 |
| Presidio CPU (c6i.2xlarge × 1) | CPU-hr | 8 | $0.192/hr | $1.54 |
| Redis ElastiCache (r7g.large) | — | 1 | $0.192/hr | $4.61 |
| **Total** | | | | **~$39.72/day = $0.00040/min** |

Both well under the $0.005/min Phase 3 target.

### 10.3 Break-even vs. Deepgram API

At 1,000 min/day: Deepgram = $4.30/day vs self-host = $0.044/day → 97.7× cheaper.
At 100,000 min/day: Deepgram = $430/day vs self-host = $39.72/day → 10.8× cheaper.

Break-even GPU fixed cost (2 × g5.xlarge reserved): $33.57/day → at 7,800 min/day, Deepgram costs more. Self-host wins above ~7.8k min/day.

---

## 11. Files to Create

### 11.1 Python GPU worker

```
workers/transcription/python/
├── Dockerfile                          # nvidia/cuda:12.1-cudnn8-runtime-ubuntu22.04 base
├── requirements.txt                    # faster-whisper, whisperx, soundfile, torchaudio,
│                                       #   presidio-analyzer, presidio-anonymizer,
│                                       #   spacy, en_core_web_lg, es_core_news_md,
│                                       #   boto3, fastapi, uvicorn
├── transcription_service.py            # FastAPI app; POST /transcribe endpoint
├── engine/
│   ├── __init__.py
│   ├── model_loader.py                 # WhisperModel + BatchedInferencePipeline init (singleton)
│   ├── demux.py                        # stereo check + demux + resample
│   ├── transcriber.py                  # transcribe_channel(); mono diarization fallback
│   ├── merger.py                       # merge_segments(); timeline sort
│   └── language.py                     # detect_language(); BCP-47 mapping
├── pii/
│   ├── __init__.py
│   ├── redactor.py                     # redact_segments(); Presidio pipeline init
│   └── custom_recognizers.py           # AccountNumber, DateOfBirth, LoanNumber
├── tests/
│   ├── test_demux.py                   # stereo demux + mono detection
│   ├── test_transcriber.py             # mock WhisperModel; segment structure
│   ├── test_merger.py                  # interleave + sort
│   ├── test_redactor.py                # SSN, CC, phone redaction fixtures
│   └── fixtures/
│       ├── stereo_8khz_30s.wav         # synthetic 2-channel test WAV
│       ├── mono_8khz_30s.wav           # mono fallback fixture
│       └── golden_en_6min.wav          # 6-min golden fixture (WER eval)
```

### 11.2 Node.js BullMQ worker

```
workers/transcription/
├── package.json                        # bullmq, ioredis, @aws-sdk/client-s3,
│                                       #   @aws-sdk/s3-request-presigner, @prisma/client,
│                                       #   prom-client, zod, axios
├── src/
│   ├── index.ts                        # entry: start stream-consumer + BullMQ worker
│   ├── stream-consumer.ts              # XREADGROUP loop; consent gate; BullMQ enqueue
│   ├── config.ts                       # Zod-validated env + tenants.settings cache
│   ├── metrics.ts                      # prom-client counters/histograms/gauges
│   └── jobs/
│       ├── transcription-job.ts        # BullMQ worker: download → call Python → upload → DB
│       └── transcription-retry.ts      # manual retry endpoint handler
├── __tests__/
│   ├── unit/
│   │   ├── stream-consumer.test.ts     # consent gate; enqueue logic; XACK
│   │   ├── s3-upload.test.ts           # key generation; Object Lock params
│   │   └── db-update.test.ts           # CAS UPDATE idempotency
│   └── integration/
│       ├── full-flow.test.ts           # LocalStack + mock Python service → DB update
│       ├── consent-blocked.test.ts     # consent_status=prompted_declined → transcript_status=consent_blocked
│       ├── retry-idempotency.test.ts   # duplicate job → single S3 object version
│       └── dlq.test.ts                 # 6-attempt exhaustion → DLQ; transcript_status=failed
```

### 11.3 API route

```
api/src/routes/recordings/
├── transcript.ts                       # GET /api/recordings/:id/transcript
│                                       # POST /api/recordings/:id/transcript/retry
```

### 11.4 Schema migration

```
api/prisma/migrations/<timestamp>_n07_transcript_columns/
└── migration.sql                       # ALTER TABLE recording_log + ENUM + INDEX
```

### 11.5 Kubernetes/Docker

```
workers/transcription/
├── k8s/
│   ├── gpu-worker-deployment.yaml      # NVIDIA A10G node selector; resource limits
│   ├── node-worker-deployment.yaml     # BullMQ Node.js worker; no GPU
│   └── keda-scaledobject.yaml          # Redis queue depth autoscaler
└── docker-compose.override.yml         # local GPU dev override (nvidia runtime)
```

### 11.6 Evaluation scripts

```
workers/transcription/eval/
├── measure_wer.py                      # jiwer-based WER against golden fixtures
├── measure_pii_recall.py               # Presidio recall against synthetic PII fixtures
└── golden/
    ├── en/                             # English golden WAV + ground-truth .txt pairs
    └── es/                             # Spanish golden pairs
```

---

## 12. Test Plan

### 12.1 Python unit tests

| Test file | What it verifies |
|---|---|
| `test_demux.py` | Stereo WAV → two mono channels; channel 0 = customer; 8kHz→16kHz resample; mono WAV returns `None, None` |
| `test_transcriber.py` | Mock `BatchedInferencePipeline`; segment structure matches schema; empty audio → empty segments |
| `test_merger.py` | 10 customer + 10 agent segments → 20 merged; sorted by `start`; no gaps between adjacent timestamps |
| `test_redactor.py` | SSN `123-45-6789` → `<US_SSN>` in output; CC `4111 1111 1111 1111` → `<CREDIT_CARD>`; clean text unchanged; Spanish phone number detected with `es` pipeline |

### 12.2 Node.js unit tests

| Test | What it verifies |
|---|---|
| `stream-consumer.test.ts` | `consent_status='prompted_declined'` → `transcript_status='consent_blocked'`; XACK; no BullMQ job |
| `stream-consumer.test.ts` | `consent_status='not_required'` → BullMQ job enqueued with correct `jobId = recordingLogId` |
| `s3-upload.test.ts` | Transcript key matches `tenants/<tid>/calls/<YYYY>/<MM>/<DD>/<uuid>.transcript.json`; Object Lock set |
| `db-update.test.ts` | First call: `transcript_uri` set; second call (idempotent): no-op (`WHERE transcript_uri IS NULL`) |

### 12.3 Integration tests

| Test | What it verifies |
|---|---|
| `full-flow.test.ts` | End-to-end with LocalStack S3 + mock Python service: stream message → consent check → BullMQ job → mock GPU response → S3 upload → DB update; `transcript_status='completed'`; `transcript_uri` set |
| `consent-blocked.test.ts` | `consent_status='prompted_declined'` → `transcript_status='consent_blocked'`; no S3 object created |
| `retry-idempotency.test.ts` | Two identical stream messages → one BullMQ job (deduplicated by `jobId`); one S3 object version |
| `dlq.test.ts` | Python service always returns 500; after 6 BullMQ attempts: job in DLQ; `transcript_status='failed'`; `vici2_transcription_dlq_total` incremented |

### 12.4 WER golden fixtures

```bash
# CI gate: run before merge to main
python workers/transcription/eval/measure_wer.py \
  --golden-dir workers/transcription/eval/golden/en/ \
  --max-wer 0.05
```

3 English golden fixtures (30 s, 3 min, 6 min) generated from publicly licensed audio (LibriVox + synthetic). Spanish: 2 fixtures (3 min, 6 min).

### 12.5 End-to-end smoke test

1. Place a 2-minute SIPp call through the full stack (R01 → R02).
2. Wait for `recording_log.lifecycle_state = 'available'` (R02 complete).
3. Verify `events:vici2.transcription.requested` published within 5 seconds.
4. Wait ≤ 3 minutes.
5. Verify `recording_log.transcript_status = 'completed'`.
6. Verify `recording_log.transcript_uri` matches `s3://.../<call_uuid>.transcript.json`.
7. Verify `GET /api/recordings/:id/transcript` returns `200` with segment array.
8. Verify `audit_log` contains `action='transcription.completed'` row.
9. Verify transcript JSON in S3 is parseable; `word_count > 0`; `lang_detected = 'en'`.

---

## 13. Acceptance Criteria

N07 IMPLEMENT is DONE when all of the following pass:

| # | Criterion |
|---|---|
| AC-1 | All Python unit tests green (`pytest workers/transcription/python/tests/ -v`) |
| AC-2 | All Node.js unit tests green |
| AC-3 | All Node.js integration tests green in CI (LocalStack + mock Python sidecar) |
| AC-4 | WER golden fixture CI gate passes: `en` WER < 5%; `es` WER < 8% |
| AC-5 | End-to-end smoke test (§12.5) passes on dev stack |
| AC-6 | A consent-declined call (`consent_status='prompted_declined'`) produces no S3 transcript object; `transcript_status='consent_blocked'` |
| AC-7 | A 6-minute call transcription completes within 30 seconds of job pickup (p50 measured on dev GPU stack) |
| AC-8 | `GET /api/recordings/:id/transcript` returns `200` with correct segment array for a completed transcription |
| AC-9 | `GET /api/recordings/:id/transcript?raw=true` returns `403` for agent/supervisor roles; `200` for superadmin |
| AC-10 | PII redaction: synthetic fixture with 1× SSN + 1× CC → both replaced with entity tags in `transcript.json`; originals visible in `transcript.raw.json` |
| AC-11 | F02 Prisma migration (`n07_transcript_columns`) applies cleanly on `make db-reset`; no schema drift |
| AC-12 | Prometheus scrape shows `vici2_transcription_completed_total` increment after smoke test |
| AC-13 | DLQ alert fires: inject a job with unreachable Python sidecar; after 6 retries, `transcription-dlq` queue non-zero; `vici2_transcription_dlq_total` incremented |
| AC-14 | Manual retry endpoint (`POST /api/recordings/:id/transcript/retry`) re-enqueues job; `transcript_status` resets to `queued` |
| AC-15 | Stereo anomaly detection: a mono WAV triggers diarization path; `transcript_flags` contains `["mono_fallback"]` in sidecar JSON |

---

## 14. Dependencies and Risks

| Item | Dependency / Risk | Mitigation |
|---|---|---|
| R02 `XADD` trigger | R02 IMPLEMENT must add the `XADD events:vici2.transcription.requested` line; this is a net-new addition owned by N07 IMPLEMENT (N07 amends R02 worker) | Document in N07 IMPLEMENT ticket; add to R02 acceptance criteria retroactively |
| R02 `lifecycle_state='available'` race | N07 stream consumer may receive event before `recording_log.lifecycle_state` is `available` | N07 job checks `lifecycle_state` before download; if not `available`: delay 30s retry (up to 3 times before DLQ) |
| GPU availability (Phase 3 infra) | A10G / L4 instance availability varies by region | Reserve 1-year EC2 at project start; CPU fallback path (`WHISPER_DEVICE=cpu`) for emergencies |
| pyannote Hugging Face token | `pyannote/speaker-diarization-3.1` requires HF token + user agreement acceptance | HF token stored in O05 secrets; agreement accepted by platform account at Phase 3 start |
| Presidio spaCy model size | `en_core_web_lg` = 560 MB; `es_core_news_md` = 50 MB; Docker image ~8 GB total | Multi-stage Docker build; models downloaded at build time; image cached in ECR |
| CUDA version pinning | faster-whisper 1.x requires CUDA ≥ 11.8; CTranslate2 built against CUDA 12.1 | Base image: `nvidia/cuda:12.1-cudnn8-runtime`; pin in Dockerfile FROM |
| Object Lock on transcript sidecar | Transcript JSON is locked alongside WAV (7 years); content cannot be modified post-upload | Raw transcript stored separately; redacted version is final; correctness must be verified pre-upload |
| Raw transcript access control | `transcript.raw.json` must never be returned to non-compliance roles | API RBAC enforced at route level; S3 IAM policy restricts `s3:GetObject` on `*.raw.json` keys to `compliance-*` IAM roles |
| Phase 3 R02 PLAN says "N07 Phase 4" | R02 PLAN §1.2 labels N07 as Phase 4; this PLAN reclassifies to Phase 3 | N07 IMPLEMENT updates R02 PLAN cross-reference at implementation time; no functional impact on R02 |
| Multi-language PII gap | Presidio `es` pipeline has lower NER recall (~85%) than `en` (~95%) | Flag `transcript_flags: ["pii_lang_limited"]` for non-en/es languages; log warn; Phase 4 upgrade |
| Whisper hallucination on silence | Whisper may hallucinate text on silent audio segments | VAD filter (Silero) pre-strips silence before transcription; residual hallucinations caught by confidence threshold (`word.score < 0.4` → flagged) |
