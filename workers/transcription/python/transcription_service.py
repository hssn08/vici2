"""
workers/transcription/python/transcription_service.py

FastAPI sidecar for N07 GPU transcription.
Listens on localhost:8765; called by the Node.js BullMQ job.

POST /transcribe — main transcription endpoint
GET  /health    — health check

N07 PLAN §3.1 / §4.3.
"""

from __future__ import annotations

import copy
import logging
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

# Internal engine modules
from engine.model_loader import get_model
from engine.demux import demux_stereo, resample, TARGET_SR
from engine.transcriber import transcribe_channel, transcribe_mono_diarized
from engine.merger import merge_segments, count_words
from engine.language import detect_language
from pii.redactor import redact_segments

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
logger = logging.getLogger("transcription_service")

# ---------------------------------------------------------------------------
# Config (from environment)
# ---------------------------------------------------------------------------

WHISPER_MODEL_VARIANT = os.getenv("WHISPER_MODEL", "auto")
WHISPER_DEVICE = os.getenv("WHISPER_DEVICE", "auto")
WHISPER_COMPUTE_TYPE = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
HF_TOKEN = os.getenv("HF_AUTH_TOKEN")  # pyannote diarization

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="vici2 N07 Transcription Sidecar", version="1.0.0")


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class TranscribeRequest(BaseModel):
    wav_path: str
    call_uuid: str
    lang_hint: Optional[str] = None
    model: str = "auto"
    run_presidio: bool = True
    retain_raw: bool = True


class TranscribeResponse(BaseModel):
    engine: str
    model: str
    stereo_mode: bool
    lang_detected: str
    word_count: int
    processing_ms: int
    pii_redacted: bool
    pii_entity_count: int
    pii_entity_types: List[str]
    transcript_flags: List[str]
    segments: List[Dict[str, Any]]
    raw_segments: Optional[List[Dict[str, Any]]] = None


# ---------------------------------------------------------------------------
# Startup: pre-load model to avoid cold-start on first request
# ---------------------------------------------------------------------------


@app.on_event("startup")
async def startup():
    logger.info(
        "pre-loading whisper model: variant=%s device=%s compute_type=%s",
        WHISPER_MODEL_VARIANT,
        WHISPER_DEVICE,
        WHISPER_COMPUTE_TYPE,
    )
    try:
        get_model(WHISPER_MODEL_VARIANT, WHISPER_DEVICE, WHISPER_COMPUTE_TYPE)
        logger.info("whisper model pre-loaded")
    except Exception as exc:
        logger.warning("model pre-load failed (will retry on first request): %s", exc)


# ---------------------------------------------------------------------------
# POST /transcribe
# ---------------------------------------------------------------------------


@app.post("/transcribe", response_model=TranscribeResponse)
async def transcribe(req: TranscribeRequest) -> TranscribeResponse:
    t0 = time.monotonic()
    logger.info("transcription request: call_uuid=%s wav=%s", req.call_uuid, req.wav_path)

    # Load model (singleton; cached after first call)
    try:
        _base_model, batched_pipeline, model_name, device = get_model(
            req.model or WHISPER_MODEL_VARIANT,
            WHISPER_DEVICE,
            WHISPER_COMPUTE_TYPE,
        )
    except Exception as exc:
        logger.error("model load failed: %s", exc)
        raise HTTPException(status_code=503, detail=f"model_unavailable: {exc}") from exc

    # 1. Demux stereo → customer/agent or detect mono
    try:
        customer_raw, agent_raw, sr = demux_stereo(req.wav_path)
    except Exception as exc:
        logger.error("demux failed: %s", exc)
        raise HTTPException(status_code=422, detail=f"demux_error: {exc}") from exc

    stereo_mode = customer_raw is not None
    transcript_flags: List[str] = []

    if not stereo_mode:
        # Mono fallback path (AC-15)
        import soundfile as sf
        import numpy as np

        data, sr = sf.read(req.wav_path, dtype="float32", always_2d=False)
        mono_audio = resample(data if data.ndim == 1 else data[:, 0], sr, TARGET_SR)

        mono_result = transcribe_mono_diarized(
            mono_audio, batched_pipeline, req.lang_hint, HF_TOKEN
        )
        merged_segments = mono_result["segments"]
        lang_detected = mono_result["lang"]
        transcript_flags.extend(mono_result.get("transcript_flags", []))
    else:
        # Stereo path: resample both channels
        import numpy as np

        customer_16k = resample(customer_raw, sr, TARGET_SR)
        agent_16k = resample(agent_raw, sr, TARGET_SR)

        # 2. Language detection (30-s probe on customer channel)
        lang_detected = detect_language(customer_16k, _base_model, TARGET_SR)
        lang_hint_resolved = req.lang_hint or lang_detected[:2]

        # 3. Transcribe both channels
        customer_result = transcribe_channel(customer_16k, batched_pipeline, lang_hint_resolved)
        agent_result = transcribe_channel(agent_16k, batched_pipeline, lang_hint_resolved)

        # 4. Merge + sort
        merged_segments = merge_segments(customer_result["segments"], agent_result["segments"])

    # Store raw segments before redaction
    raw_segments = copy.deepcopy(merged_segments) if req.retain_raw else None

    # 5. Presidio PII redaction
    redacted_segments, entity_count, entity_types, pii_flags = redact_segments(
        merged_segments, lang_detected, run_presidio=req.run_presidio
    )
    transcript_flags.extend(pii_flags)

    pii_redacted = entity_count > 0

    # 6. Word count
    word_count = count_words(redacted_segments)

    processing_ms = int((time.monotonic() - t0) * 1000)
    logger.info(
        "transcription complete: call_uuid=%s lang=%s words=%d stereo=%s pii=%s ms=%d",
        req.call_uuid,
        lang_detected,
        word_count,
        stereo_mode,
        pii_redacted,
        processing_ms,
    )

    return TranscribeResponse(
        engine="faster-whisper",
        model=model_name,
        stereo_mode=stereo_mode,
        lang_detected=lang_detected,
        word_count=word_count,
        processing_ms=processing_ms,
        pii_redacted=pii_redacted,
        pii_entity_count=entity_count,
        pii_entity_types=entity_types,
        transcript_flags=transcript_flags,
        segments=redacted_segments,
        raw_segments=raw_segments if (pii_redacted and req.retain_raw) else None,
    )


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


@app.get("/health")
async def health():
    return {"status": "ok", "service": "n07-transcription-sidecar"}


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("N07_SIDECAR_PORT", "8765"))
    uvicorn.run("transcription_service:app", host="0.0.0.0", port=port, log_level="info")
