"""
workers/transcription/python/engine/transcriber.py

Whisper transcription per channel + mono diarization fallback.
N07 PLAN §4.3 / AC-15.
"""

import logging
from typing import Optional, Dict, Any, List
import numpy as np

logger = logging.getLogger(__name__)

CONFIDENCE_FLOOR = 0.4  # Words below this are flagged (N07 PLAN §14 risk table)


def transcribe_channel(
    audio_np: np.ndarray,
    batched_pipeline,
    lang_hint: Optional[str] = None,
    batch_size: int = 8,
) -> Dict[str, Any]:
    """
    Transcribe a mono float32 audio array.

    Returns dict with:
      lang, lang_prob, segments (list of dicts with start/end/text/words)
    """
    if audio_np is None or len(audio_np) == 0:
        return {"lang": "en", "lang_prob": 1.0, "segments": []}

    segments_iter, info = batched_pipeline.transcribe(
        audio_np,
        language=lang_hint,
        batch_size=batch_size,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
    )

    segments = []
    for s in segments_iter:
        words = []
        if s.words:
            for w in s.words:
                words.append({
                    "word": w.word,
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "score": round(w.probability, 4),
                    "low_confidence": w.probability < CONFIDENCE_FLOOR,
                })
        segments.append({
            "start": round(s.start, 3),
            "end": round(s.end, 3),
            "text": s.text.strip(),
            "words": words,
        })

    return {
        "lang": info.language,
        "lang_prob": round(info.language_probability, 4),
        "segments": segments,
    }


def transcribe_mono_diarized(
    audio_np: np.ndarray,
    batched_pipeline,
    lang_hint: Optional[str] = None,
    hf_token: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Fallback for mono WAV: run WhisperX diarization (pyannote 3.x)
    to assign SPEAKER_00 / SPEAKER_01 labels.

    Returns same structure as transcribe_channel but with channel='unknown'
    and transcript_flags=['mono_fallback'].
    """
    logger.warning("mono_fallback: running diarization pipeline")

    # First, transcribe the whole mono track
    result = transcribe_channel(audio_np, batched_pipeline, lang_hint)
    segments = result["segments"]

    # Attempt WhisperX diarization
    try:
        import whisperx  # type: ignore[import]
        import torch

        device = "cuda" if torch.cuda.is_available() else "cpu"

        # Align word timestamps
        model_a, metadata = whisperx.load_align_model(
            language_code=result["lang"], device=device
        )
        aligned = whisperx.align(
            segments, model_a, metadata, audio_np, device
        )

        # Diarize
        diarize_model = whisperx.DiarizationPipeline(
            use_auth_token=hf_token, device=device
        )
        diarize_segments = diarize_model(audio_np)
        result_with_speakers = whisperx.assign_word_speakers(
            diarize_segments, aligned
        )

        # Map SPEAKER_00 → customer, SPEAKER_01 → agent (heuristic: more speech = agent)
        speaker_counts: Dict[str, int] = {}
        for seg in result_with_speakers.get("segments", []):
            spk = seg.get("speaker", "SPEAKER_00")
            speaker_counts[spk] = speaker_counts.get(spk, 0) + 1

        # Agent is the speaker with more segments (call-center heuristic)
        speakers_sorted = sorted(speaker_counts, key=lambda x: -speaker_counts[x])
        agent_speaker = speakers_sorted[0] if speakers_sorted else "SPEAKER_00"

        enriched = []
        for seg in result_with_speakers.get("segments", []):
            spk = seg.get("speaker", "SPEAKER_00")
            channel = "agent" if spk == agent_speaker else "customer"
            enriched.append({
                "start": round(seg.get("start", 0), 3),
                "end": round(seg.get("end", 0), 3),
                "text": seg.get("text", "").strip(),
                "words": seg.get("words", []),
                "channel": channel,
                "speaker": spk,
            })

        return {
            "lang": result["lang"],
            "lang_prob": result["lang_prob"],
            "segments": enriched,
            "transcript_flags": ["mono_fallback"],
        }

    except Exception as exc:
        logger.warning("whisperx diarization failed — returning undiarized segments: %s", exc)
        # Fallback: return with unknown channel
        undiarized = [
            {**seg, "channel": "unknown"}
            for seg in segments
        ]
        return {
            "lang": result["lang"],
            "lang_prob": result["lang_prob"],
            "segments": undiarized,
            "transcript_flags": ["mono_fallback", "diarization_failed"],
        }
