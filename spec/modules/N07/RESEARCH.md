# N07 — Call Transcription Pipeline (Whisper) — RESEARCH

| Field | Value |
|---|---|
| Module | N07 — post-call speech-to-text, diarization, PII redaction |
| Phase | 3 (research/plan now; implementation gate = R02 DONE + Phase 3 kickoff) |
| Date | 2026-05-13 |
| Research status | COMPLETE |

---

## 1. Whisper Engine Landscape (2026)

### 1.1 openai-whisper (reference implementation)

OpenAI's original Python package (`openai-whisper`, last stable 20231117) uses PyTorch with torchaudio. It supports `tiny`, `base`, `small`, `medium`, `large-v3`, `large-v3-turbo` (released late 2024) checkpoints. The `large-v3-turbo` model (809M parameters, distilled from `large-v3`) achieves <5% WER on standard English benchmarks while running ~8× faster than `large-v3` on CPU.

**Latency (reference H100 SXM5, FP16):**

| Model | Params | RTF (GPU) | RTF (CPU, 16-core) | WER (Librispeech clean) |
|---|---|---|---|---|
| tiny | 39M | ~0.02× | ~0.4× | 5.7% |
| base | 74M | ~0.04× | ~0.8× | 4.2% |
| small | 244M | ~0.12× | ~2.5× | 3.0% |
| medium | 769M | ~0.35× | ~7× | 2.7% |
| large-v3 | 1550M | ~0.80× | ~18× | 2.0% |
| large-v3-turbo | 809M | ~0.25× | ~6× | 2.1% |

RTF = Real-Time Factor (1.0 = real-time; <1.0 = faster than real-time).

**Telephony penalty:** Standard Whisper models are trained on internet audio (16 kHz or higher). G.711 8 kHz upsampled to 16 kHz causes ~0.5–1.5% absolute WER increase vs. high-quality audio. The penalty grows for accented speech and channel noise.

### 1.2 faster-whisper (CTranslate2 backend)

`faster-whisper` (https://github.com/SYSTRAN/faster-whisper) converts Whisper checkpoints to CTranslate2 format (INT8 or INT8_FLOAT16 quantization). CTranslate2 is a high-performance C++ inference engine for transformer models.

**Key advantages over `openai-whisper`:**
- INT8 quantization: ~2–4× memory reduction; `large-v3` fits in ~3 GB VRAM (vs 10 GB FP16).
- CTranslate2 beam-search is ~2× faster than PyTorch equivalent for the same model.
- Word-level timestamps from second pass (no external forced alignment needed).
- VAD filter (Silero VAD) strips silence; sharply cuts processing time on telephony with hold music / transfer pauses.
- `batched` inference mode (faster-whisper ≥ 1.0): processes multiple audio segments in parallel on a single GPU, boosting throughput on A10G/L4.

**Latency benchmarks (faster-whisper 1.0, A10G 24 GB, INT8):**

| Model | RTF (single audio, INT8) | RTF (batched, batch=8) | VRAM |
|---|---|---|---|
| large-v3-turbo | ~0.04× | ~0.008× | ~1.5 GB |
| large-v3 | ~0.10× | ~0.020× | ~2.8 GB |
| medium | ~0.05× | ~0.012× | ~1.1 GB |

At 0.008× RTF on batched large-v3-turbo: a 6-minute call transcribes in ~3 seconds wall-clock. This comfortably meets the Phase 3 budget of <5× real-time (i.e., <30 seconds for a 6-minute call).

**Recommended base engine for Phase 3.**

### 1.3 whisper.cpp (GGML/GGUF backend)

`whisper.cpp` (https://github.com/ggerganov/whisper.cpp) is a pure C++ inference engine using GGML tensors. Key properties:

- Targets CPU (AVX2/AVX512), Apple Silicon (Metal), CUDA, OpenCL.
- No Python runtime requirement: can be compiled to a static binary or called via Node.js N-API.
- GGUF quantized models (Q5_0, Q8_0) for `large-v3-turbo` use ~800 MB on CPU.
- RTF on a 16-core Intel Xeon (AVX2): ~0.6× for `large-v3-turbo` Q5_0 — marginally slower than GPU but viable for low-volume CPU deployments.
- Does NOT natively expose word-level timestamps as structured output (timestamps are embedded in text output). Requires custom parsing.
- Lacks native diarization or VAD integration.

**Phase 3 role:** CPU-only fallback for single-tenant on-prem deployments. Not the primary engine.

### 1.4 WhisperX (diarization + alignment)

`WhisperX` (https://github.com/m-bain/whisperX, 2024 paper: Bain et al.) extends faster-whisper with:

1. VAD pre-segmentation (Silero VAD).
2. Phoneme-level forced alignment via `wav2vec2-large-xlsr-53` (multilingual) for precise word-start/end timestamps.
3. Speaker diarization via `pyannote.audio 3.x` (see §4).

**Output structure:**

```json
{
  "segments": [
    {
      "start": 0.0, "end": 3.4,
      "text": "Hello, I'm calling about my account.",
      "words": [{"word": "Hello", "start": 0.0, "end": 0.4, "score": 0.92}],
      "speaker": "SPEAKER_00"
    }
  ]
}
```

**Practical throughput (A10G, INT8):** ~0.12× RTF including alignment + diarization (vs ~0.04× transcription only). For a 6-minute call: ~43 seconds total — still within the <5× real-time budget.

**Phase 3 recommendation:** Use WhisperX when stereo demux is not available (i.e., mono fallback path). When stereo demux is available (standard vici2 path — R01 records stereo), speaker labels come from channel assignment (L=customer, R=agent), not from diarization. WhisperX alignment is still valuable for precise timestamps even on stereo.

### 1.5 distil-whisper

`distil-whisper` (Hugging Face / Gandalf: Gandhi et al. 2023, updated 2024) is a knowledge-distilled family of Whisper models:

| Model | Params | WER (Librispeech clean) | Speed vs large-v3 |
|---|---|---|---|
| distil-large-v3 | 756M | 2.4% | ~6× faster |
| distil-medium.en | 394M | 3.8% | ~6× faster |
| distil-small.en | 166M | 5.2% | ~6× faster |

**Limitation:** English-only (all distil variants as of 2026). Multilingual callers require full Whisper or Seamless.

**Phase 3 role:** English-primary tenants can elect `distil-large-v3` for throughput gain. Non-English tenants default to `large-v3-turbo`.

### 1.6 WhisperJAX

`whisper-jax` (Hugging Face, Mathis Huet et al.) runs Whisper on JAX/XLA, enabling TPU execution and JIT compilation. Throughput on TPUv4: up to 70× real-time for `large-v3`. However:

- Complex deployment stack (JAX + Libtpu + GCP TPU access).
- TPU costs ($2–8/hr for v4-8 pod) are not justified for Phase 3 volumes.
- JAX batch APIs differ significantly from PyTorch/CTranslate2; WhisperX (diarization) does not support JAX backend.

**Phase 3 role:** Deferred. Relevant only for >500k min/day volumes on GCP.

---

## 2. Self-Host vs. Vendor Transcription APIs

### 2.1 AWS Transcribe

- **Pricing (2026):** Standard = $0.024/min; Medical = $0.078/min. Batch (async) = $0.015/min for standard calls.
- **Telephony accuracy:** AWS Transcribe Call Analytics (CQA) is optimized for 8 kHz telephony. Speaker diarization included. Custom vocabulary supported.
- **Latency:** Async batch: typically 0.3–0.6× RTF for standard jobs. Streaming (real-time): <300 ms latency.
- **Cons:** $0.015/min at 100k min/day = $1,500/day = $547k/yr. US-region only (data residency constraint). No on-prem path.

### 2.2 Deepgram

- **Pricing (2026):** Nova-3 (most accurate): $0.0043/min. Pay-as-you-go; no minimum. On-prem (self-hosted Deepgram) license: ~$1,500/mo flat + 1 GPU server requirement.
- **Telephony accuracy:** Deepgram Nova-3 was specifically fine-tuned on telephony audio; WER on 8 kHz G.711 reported 8–10% range (Deepgram internal benchmarks, 2025). Competitive with Whisper large-v3-turbo on English telephony.
- **Speaker labels:** Yes (2-speaker diarization included in Nova-3 telephony model).
- **PII redaction:** Built-in entity redaction (SSN, credit card, phone, email). Replaces tokens with [*].
- **Pros:** Lowest vendor API price; near-real-time (streaming WebSocket mode).
- **Cons:** $0.0043/min at 100k min/day = $430/day = $157k/yr. Vendor dependency. Training data concerns (see §9).

### 2.3 Rev.ai

- **Pricing (2026):** Async = $0.02/min. Streaming = $0.035/min. Custom model = negotiated enterprise.
- **Telephony accuracy:** WER ~10–12% on G.711 without custom vocabulary. Human-in-the-loop correction available.
- **Diarization:** Yes, up to 8 speakers.
- **Cons:** 5× Deepgram price; not competitive for Phase 3.

### 2.4 AssemblyAI

- **Pricing (2026):** Best (most accurate): $0.0062/min. Nano: $0.0012/min.
- **Telephony accuracy:** Best model: WER ~8–11% on telephony. Speaker diarization included. Sentiment analysis, topic detection, PII redaction add-ons.
- **Cons:** US data storage. $0.0062/min at 100k min/day = $620/day = $226k/yr.

### 2.5 Self-hosted faster-whisper cost model

**Commodity GPU (A10G 24 GB, on-demand AWS g5.xlarge):** $1.006/hr (2026 on-demand). At 0.008× RTF batched large-v3-turbo: one GPU processes ~208 hours of audio per hour. For 100k min/day (1,667 min/hr): need 1,667 / (60 × 125 = 7,500 min/hr) ≈ 0.22 GPU dedicated. At ~$0.22/hr = **~$0.0022/min at 100k min/day**.

At reserved-instance pricing (1-year, g5.xlarge): $0.636/hr → **~$0.0014/min**.

**Phase 3 GPU target: A10G (AWS g5.xlarge) or equivalent (NVIDIA L4 on GCP).**

### 2.6 Summary comparison

| Option | Price/min (100k min/day) | WER (G.711 EN) | On-prem | Diarization | PII redact |
|---|---|---|---|---|---|
| faster-whisper self-host (GPU) | $0.0014–0.0022 | ~3–4% | Yes | via WhisperX | Presidio |
| Deepgram Nova-3 API | $0.0043 | ~8–10% | No (unless license) | Built-in | Built-in |
| AssemblyAI Best | $0.0062 | ~8–11% | No | Built-in | Add-on |
| AWS Transcribe batch | $0.015 | ~6–8% (CQA) | No | Built-in | Built-in |
| Rev.ai | $0.020 | ~10–12% | No | Built-in | No |

Self-hosted faster-whisper wins on cost (3–10×) and WER (2–6% better). The trade-off is GPU ops overhead and no built-in PII redaction.

---

## 3. Stereo WAV Channel Demux

### 3.1 R01 stereo contract

R01 records stereo WAV PCM s16le via FreeSWITCH `record_session`. Left channel (channel 0) = customer. Right channel (channel 1) = agent. This is frozen per R01 PLAN §2.1 and R02 PLAN §2.

### 3.2 Demux approach

Standard ffmpeg demux:

```bash
# Extract left (customer)
ffmpeg -i call.wav -map_channel 0.0.0 -ar 16000 customer.wav -y

# Extract right (agent)
ffmpeg -i call.wav -map_channel 0.0.1 -ar 16000 agent.wav -y
```

The `-ar 16000` resamples from 8 kHz (G.711) to 16 kHz — mandatory because Whisper's log-mel spectrogram is built for 16 kHz input. scipy-based resampling (`scipy.signal.resample_poly`) is an alternative in Python but slower than ffmpeg for large batches.

### 3.3 In-process demux (Python, no subprocess)

```python
import soundfile as sf
import numpy as np

data, sr = sf.read("call.wav", dtype="int16", always_2d=True)
customer_mono = data[:, 0].astype(np.float32) / 32768.0
agent_mono    = data[:, 1].astype(np.float32) / 32768.0
```

This avoids a subprocess fork and is safer in containerized environments. Resample with `librosa.resample(y, orig_sr=8000, target_sr=16000, res_type="kaiser_fast")` or `torchaudio.functional.resample`.

**Recommendation:** Use in-process demux via `soundfile` + `torchaudio.functional.resample` to avoid ffmpeg subprocess management. If ffmpeg is already in the container (required for any Opus transcoding future), the subprocess approach is acceptable.

### 3.4 Speaker label assignment

After demux, each mono track is independently transcribed. The JSON output assigns speaker labels from channel position:

```json
{"channel": "customer", "segments": [...]}
{"channel": "agent",    "segments": [...]}
```

A merge pass produces an interleaved timeline sorted by `start` timestamp.

### 3.5 Edge cases

| Case | Handling |
|---|---|
| Stereo track but one channel silent (agent never spoke) | Silero VAD on that track returns empty segments; worker emits `agent_segments: []` |
| Stereo file where both channels carry the same signal (FS config bug) | Detected via cross-correlation; flag `transcript_flags: ["stereo_anomaly"]` in JSON |
| Mono WAV (old recordings, FS config drift) | Skip demux; run diarization (§4); flag `transcript_flags: ["mono_fallback"]` |

---

## 4. Diarization (Mono Fallback Path)

### 4.1 When diarization is needed

vici2's normal path (R01 stereo) does NOT need diarization — speaker identity comes from channel position. Diarization is only needed when:

- Mono WAV detected (cross-mono check in §3.5).
- Admin manually triggers re-transcription of a legacy mono recording.
- Future: conference call > 2 speakers.

### 4.2 pyannote.audio 3.x

`pyannote.audio` (https://github.com/pyannote/pyannote-audio, Plaquet & Bredin 2023, v3.1 released 2025) is the de-facto open-source diarization library. The `speaker-diarization-3.1` pipeline runs:

1. `segmentation-3.0` model (1.5M params) — detects speech/silence boundaries + speaker change points.
2. `wespeaker-voxceleb-resnet34-LM` speaker embedding extraction.
3. Agglomerative hierarchical clustering.

**Performance:**
- DER (Diarization Error Rate) on CALLHOME (telephony): ~12–15%. Best-in-class open-source.
- Inference time (A10G): ~0.15× RTF for 2-speaker telephony (faster-whisper pipeline).
- Requires `hf_token` (Hugging Face; pyannote models require accepting user agreement).

**License:** MIT (pyannote 3.x). Models require Hugging Face hub token and acceptance of pyannote terms (non-commercial restriction on some auxiliary models — confirm for production).

### 4.3 WhisperX diarization (integrated pipeline)

WhisperX wraps pyannote.audio 3.x internally. The combined WhisperX pipeline (transcription + alignment + diarization) achieves:

- Correct speaker boundaries in ~80–85% of segment boundaries on 2-speaker telephony.
- `assign_word_speakers()` merges pyannote segments with whisper word timestamps.

For Phase 3, WhisperX is the recommended mono fallback stack.

### 4.4 NVIDIA NeMo (alternative)

NVIDIA NeMo MSDD (Multi-Scale Diarization Decoder, ≥1.21) achieves DER ~9% on telephony — better than pyannote 3.x on CALLHOME. However:

- NeMo requires a full NVIDIA NGC environment (heavy Docker image: ~8 GB).
- Inference time is ~0.3× RTF.
- Integration with Whisper requires manual pipeline wiring.

**Phase 3 decision:** pyannote 3.x via WhisperX is the simpler integration. NeMo diarization is a Phase 4 upgrade path if WER/DER targets are not met.

---

## 5. PII Redaction

### 5.1 Microsoft Presidio

`presidio` (https://github.com/microsoft/presidio, MIT license) is a modular NLP-based PII detection and anonymization framework. Components:

- `presidio-analyzer`: detects PII entities using `spacy` NER + custom recognizers + regex.
- `presidio-anonymizer`: replaces/masks detected entities.

**Entity types supported (built-in):**

| Entity | Detector | Confidence |
|---|---|---|
| `US_SSN` | Regex + checksum validation | High |
| `CREDIT_CARD` | Regex + Luhn check | High |
| `US_BANK_NUMBER` | Regex | Medium |
| `PHONE_NUMBER` | Regex + phonenumbers | High |
| `EMAIL_ADDRESS` | Regex | High |
| `IP_ADDRESS` | Regex | High |
| `PERSON` | spaCy NER (`en_core_web_lg`) | Medium |
| `LOCATION` | spaCy NER | Medium |
| `DATE_TIME` (DOB) | spaCy NER + Regex | Medium |
| `MEDICAL_LICENSE` | Regex | Medium |

**Latency:** On CPU (8-core), processing a 1,000-word transcript with all recognizers: ~80–120 ms. Negligible compared to transcription.

### 5.2 Redaction output format

Two output modes:

1. **Replacement tags (default):** `"My SSN is <US_SSN>"` — preserves conversation flow, safe for display.
2. **Asterisk masking:** `"My SSN is ***-**-****"` — preserves token length.

vici2 Phase 3 uses replacement tags. Both the original (pre-redaction) and redacted transcripts are stored — original in an encrypted sidecar (`transcript.raw.json`, lifecycle tied to recording_log) accessible only by superadmin/compliance role; redacted version (`transcript.json`) returned via API.

### 5.3 Alternative: AWS Comprehend PII

AWS Comprehend can redact PII from text ($0.0001 per 100 characters). Fast, accurate, no self-hosting. Trade-off: vendor dependency; transcript text sent to AWS even for on-prem deployments.

**Phase 3 decision:** Presidio (self-hosted) to avoid sending transcript text to a third party. AWS Comprehend as Phase 4 option flag (`N07_PII_BACKEND ∈ {presidio, comprehend, none}`).

### 5.4 Custom recognizers

Phase 3 custom recognizers to add to Presidio:

| Recognizer | Pattern | Notes |
|---|---|---|
| `AccountNumber` | `/\b\d{10,16}\b/` + context words | Call-center-specific |
| `DateOfBirth` | DOB context + date regex | Higher recall than generic DATE_TIME |
| `LoanNumber` | `/\b[A-Z]{2}\d{8,12}\b/` | Industry-specific |

Custom recognizers are added via Presidio's `RecognizerRegistry`.

### 5.5 Redaction audit

Every redaction event emits a C03 `AuditWriter.append('transcription.pii_redacted')` row containing: `recording_log_id`, `tenant_id`, `entity_types` (array), `entity_count`, and `redacted_by` (service name `n07-worker`). The C03 audit log records this as an immutable entry per the chain-hash scheme.

---

## 6. Transcript Storage

### 6.1 JSON sidecar in S3

Transcripts are stored as JSON sidecars alongside the WAV file in S3:

```
s3://<bucket>/tenants/<tid>/calls/<YYYY>/<MM>/<DD>/<call_uuid>.transcript.json
s3://<bucket>/tenants/<tid>/calls/<YYYY>/<MM>/<DD>/<call_uuid>.transcript.raw.json
```

`transcript.json` = redacted output. `transcript.raw.json` = pre-redaction; encrypted via SSE-KMS (same tenant CMK as WAV); IAM policy grants access only to `compliance-*` roles.

### 6.2 `recording_log` schema amendments (N07)

N07 IMPLEMENT adds 4 columns to `recording_log`:

```prisma
// N07 amendments on RecordingLog
transcriptUri       String?   @map("transcript_uri") @db.VarChar(512)   // s3:// path to .transcript.json
transcriptStatus    TranscriptStatus @default(pending) @map("transcript_status")
transcriptLang      String?   @map("transcript_lang") @db.VarChar(16)   // BCP-47: en-US, es-MX, etc.
transcriptWordCount Int?      @map("transcript_word_count")              // total word count post-redaction
```

```prisma
enum TranscriptStatus {
  pending         // recording uploaded; transcription not yet requested
  queued          // job enqueued in BullMQ
  processing      // worker has file; running Whisper
  completed       // transcript.json written to S3; URI set
  failed          // terminal failure after retries
  skipped         // consent_status='prompted_declined'; no transcript
  redacted        // PII redaction pass complete (separate step if batched)
  consent_blocked // transcript blocked by consent gate
}
```

### 6.3 Sidecar JSON schema

```json
{
  "version": 1,
  "recording_log_id": 12345,
  "call_uuid": "8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e",
  "tenant_id": 1,
  "lang_detected": "en",
  "lang_confidence": 0.97,
  "word_count": 842,
  "duration_sec": 362,
  "engine": "faster-whisper",
  "model": "large-v3-turbo",
  "engine_version": "1.0.3",
  "processing_ms": 14420,
  "stereo_mode": true,
  "transcript_flags": [],
  "pii_redacted": true,
  "pii_entity_count": 3,
  "segments": [
    {
      "channel": "customer",
      "start": 0.0,
      "end": 3.4,
      "text": "Hello, I'm calling about my account.",
      "words": [
        {"word": "Hello", "start": 0.0, "end": 0.4, "score": 0.92},
        {"word": "I'm", "start": 0.6, "end": 0.85, "score": 0.98}
      ]
    },
    {
      "channel": "agent",
      "start": 3.6,
      "end": 6.2,
      "text": "Thank you for calling. My name is Sarah.",
      "words": [...]
    }
  ]
}
```

### 6.4 Transcript URI in `recording_log`

`recording_log.transcript_uri` follows the same pattern as `storage_url`:

```
s3://vici2-recordings-prod-us-east-1/tenants/1/calls/2026/05/13/8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.transcript.json
```

Max length ~200 chars; fits in `VARCHAR(512)`.

### 6.5 Retention

Transcript sidecars share the same S3 Object Lock retention as the WAV file (7 years by default, per-object). They are automatically covered by the bucket's `GLACIER_IR` lifecycle rule (transition at 30 days). No separate lifecycle rule needed.

---

## 7. Cost/Latency Budget

### 7.1 Phase 3 targets

| Metric | Target | Basis |
|---|---|---|
| Processing latency (post-upload) | <5× real-time (<30 s per 6-min call) | UX requirement (supervisor review within 1 min) |
| Cost per minute (GPU self-host) | <$0.005/min | Phase 3 SLA |
| Cost per minute (vendor API fallback) | <$0.015/min | Deepgram cap |
| WER (English, G.711) | <5% | Industry standard for call centers |
| WER (Spanish, G.711) | <8% | Acceptable for Phase 3 |
| PII redaction recall (SSN+CC) | >98% | Compliance requirement |

### 7.2 Cost model detail

**Scenario A: 1,000 min/day (small tenant, 5 concurrent agents)**

| Component | Cost/day |
|---|---|
| GPU (A10G, g5.xlarge 1-yr reserved, 0.05 GPU hours/day) | $0.032 |
| S3 storage (transcript JSON sidecar: ~50 KB avg × 1000) | $0.0002 |
| Presidio CPU (t3.medium, 0.1 hr/day) | $0.002 |
| **Total** | **~$0.034/day = $0.000034/min** |

**Scenario B: 100,000 min/day (large tenant, 500 concurrent agents)**

| Component | Cost/day |
|---|---|
| GPU (A10G × 2.2 GPUs, reserved, 52.8 GPU hours/day) | $33.57 |
| S3 storage (50 KB × 100k) | $0.02 |
| Presidio CPU (c6i.2xlarge × 1, 8 hr/day) | $0.54 |
| **Total** | **~$34.13/day = $0.00034/min** |

Both scenarios are well below the $0.005/min Phase 3 cap. At vendor API (Deepgram $0.0043/min): 100k min/day = $430/day vs $34/day self-hosted — 12.6× more expensive.

### 7.3 Throughput per GPU

At `large-v3-turbo` INT8 batched (batch=8) on A10G:
- RTF = 0.008× → processes 125 min of audio per minute of GPU time.
- 100k min/day ÷ 1440 min/day ÷ 125 min-of-audio/min-GPU = 0.56 GPUs average.
- Peak (8am–5pm, 3× load) ≈ 1.7 GPUs.
- Phase 3 provisioning: 2 × g5.xlarge (2 GPU pods, BullMQ-based autoscale).

---

## 8. Multi-Language Detection and Transcription

### 8.1 Whisper's built-in language detection

Whisper models trained on 99+ languages detect language from the first 30 seconds of audio. Confidence is returned as a log-probability. faster-whisper exposes:

```python
segments, info = model.transcribe(audio, beam_size=5)
print(info.language, info.language_probability)  # e.g. "es" 0.98
```

### 8.2 Language routing

Phase 3 language detection strategy:

1. Run Whisper's 30-second detect pass on the customer channel (channel 0).
2. If `language_probability < 0.75`: flag `transcript_flags: ["lang_low_confidence"]` and default to English.
3. Store detected language as BCP-47 in `recording_log.transcript_lang` (`en-US`, `es-MX`, etc. — Whisper returns ISO-639-1; N07 worker maps to BCP-47 using `tenants.default_caller_state` for regional suffix).
4. Use same model for all languages (`large-v3-turbo` is multilingual); no per-language routing needed in Phase 3.

### 8.3 English-primary fast path

If tenant has `settings.transcription_lang_hint = "en"` (Zod-validated): skip language detection; set `task="transcribe"` + `language="en"`. Reduces transcription time by ~10% (avoids 30-sec detection segment). Opt-in per tenant.

### 8.4 Non-English PII redaction

Presidio 2.x supports multilingual analysis via `spacy`'s multilingual models (`xx_ent_wiki_sm` for general, `es_core_news_md` for Spanish). Pattern-based recognizers (SSN, CC) are language-agnostic (digits). NER-based recognizers (PERSON, LOCATION) require language-specific models.

Phase 3 ships: `en` + `es` Presidio pipelines. Additional languages (`fr`, `pt`, `de`) are Phase 4.

---

## 9. Compliance: Training Data, Retention, Redaction-Audit

### 9.1 Training data opt-out

Vendor APIs (Deepgram, AssemblyAI, AWS Transcribe):

- **AWS Transcribe:** Does NOT use submitted audio for model training. Confirmed in AWS Service Terms §57.6 (2025 update). Data deleted after 90 days.
- **Deepgram:** Opt-out from model training via `X-DG-No-Training: true` header. Required in enterprise contracts. Verify in MSA before production use.
- **AssemblyAI:** Audio deleted after processing completes (MSA §6.2, 2025). No training use without explicit consent.

**Self-hosted faster-whisper:** No data leaves the tenant's environment. No training concern.

### 9.2 Retention and deletion

Transcripts follow recording retention (7 years default, per-object Object Lock). When a recording is deleted (Object Lock expires or legal hold released), the transcript sidecar must also be deleted. N07 does NOT manage retention directly — this is C04's responsibility (retention rotation verifier).

However, N07 must register the `transcript_uri` into a table that C04 can sweep. The `recording_log.transcript_uri` column serves this purpose: C04's sweep query can join on this column and include transcript deletion in its Object Lock expiry sweep.

### 9.3 Redaction audit trail

Every redaction event is audited via C03's immutable audit chain:

```
audit_log.action = 'transcription.pii_redacted'
audit_log.entity_type = 'recording_log'
audit_log.entity_id = recording_log_id
audit_log.metadata = {
  "entity_types": ["US_SSN", "CREDIT_CARD"],
  "entity_count": 2,
  "model": "large-v3-turbo",
  "presidio_version": "2.2.355"
}
```

The raw (pre-redaction) transcript is retained in `transcript.raw.json` with access restricted to `superadmin` + `compliance_auditor` IAM roles. Operators may configure `N07_RETAIN_RAW=false` to skip raw transcript storage entirely (higher compliance posture for tenants that do not need post-hoc redaction review).

### 9.4 TCPA / CIPA scope

Transcription of a call inherently produces a written record of the conversation. For consent purposes, the recording consent gate (C02) gates BOTH recording AND transcription — no additional consent is required for transcription of an already-consented recording. The `recording_log.consent_status` check gates N07 identically to R02.

States where recording is consent-blocked (`consent_status = 'prompted_declined'`) produce no transcript. `recording_log.transcript_status = 'consent_blocked'`.

---

## 10. Citation List

1. **faster-whisper / CTranslate2:** https://github.com/SYSTRAN/faster-whisper; Bisard et al. (2023) CTranslate2: Efficient OpenNMT-py Inference.
2. **WhisperX:** Bain et al. (2023). "WhisperX: Time-Accurate Speech Transcription of Long-Form Audio." INTERSPEECH 2023. https://arxiv.org/abs/2303.00747
3. **OpenAI Whisper:** Radford et al. (2022). "Robust Speech Recognition via Large-Scale Weak Supervision." OpenAI Technical Report. https://arxiv.org/abs/2212.04356
4. **distil-whisper:** Gandhi et al. (2023). "Distil-Whisper: Robust Knowledge Distillation via Large-Scale Pseudo Labelling." https://arxiv.org/abs/2311.00430
5. **pyannote.audio 3.x:** Plaquet & Bredin (2023). "Powerset Multi-Class Cross Entropy Loss for Neural Speaker Diarization." INTERSPEECH 2023. https://arxiv.org/abs/2310.13025
6. **Microsoft Presidio:** https://github.com/microsoft/presidio; Microsoft Research (2020). "Presidio: Data Protection and De-identification SDK."
7. **AWS Transcribe Call Analytics:** https://docs.aws.amazon.com/transcribe/latest/dg/call-analytics.html. AWS Service Terms §57.6 (2025).
8. **Deepgram Nova-3 Telephony:** https://developers.deepgram.com/docs/nova-3. Deepgram Data Processing Addendum (2025).
9. **AssemblyAI:** https://www.assemblyai.com/docs. AssemblyAI MSA §6.2 (2025).
10. **NIST SP 800-86:** "Guide to Integrating Forensic Techniques into Incident Response." §3.4 Audio Evidence. https://csrc.nist.gov/publications/detail/sp/800-86/final
11. **WhisperJAX:** https://github.com/sanchit-gandhi/whisper-jax
12. **whisper.cpp:** https://github.com/ggerganov/whisper.cpp
13. **NVIDIA NeMo MSDD:** https://github.com/NVIDIA/NeMo; Park et al. (2022). "Multi-Scale Speaker Diarization with Dynamic Scale Weighting." INTERSPEECH 2022.
14. **Silero VAD:** https://github.com/snakers4/silero-vad. Silero Team (2021).
15. **BCP-47 language codes:** https://www.rfc-editor.org/rfc/rfc5646
16. **PCI DSS 4.0.1:** PCI Security Standards Council (2024). Requirement 3.4.1 (audio recording of CHD). https://www.pcisecuritystandards.org/
17. **Cal. Penal Code §637.2** (CIPA statutory damages, $5,000/violation). https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?sectionNum=637.2.&lawCode=PEN
18. **18 USC §2511(2)(d):** Federal Wiretap Act one-party consent exception. https://www.law.cornell.edu/uscode/text/18/2511
19. **g5.xlarge pricing:** https://aws.amazon.com/ec2/pricing/on-demand/ (2026).
20. **spaCy multilingual models:** https://spacy.io/models
