"""
workers/transcription/python/engine/model_loader.py

Singleton loader for faster-whisper WhisperModel + BatchedInferencePipeline.
Loaded once at startup; ~3–5 s init on GPU, ~10–20 s on CPU.

N07 PLAN §4.3 / §2.1.
"""

import os
import logging
from functools import lru_cache
from typing import Optional

logger = logging.getLogger(__name__)

# Model variant map (N07 PLAN §2.3)
MODEL_VARIANT_MAP = {
    "auto": "large-v3-turbo",
    "fast": "distil-large-v3",
    "economy": "medium",
    "large": "large-v3",
}


@lru_cache(maxsize=1)
def get_model(
    model_variant: str = "auto",
    device: str = "auto",
    compute_type: str = "int8",
):
    """
    Return (WhisperModel, BatchedInferencePipeline) singleton.

    device: "auto" | "cuda" | "cpu"
    compute_type: "int8" | "float16" | "int8_float16"
    """
    try:
        from faster_whisper import WhisperModel, BatchedInferencePipeline
    except ImportError as e:
        raise RuntimeError(
            "faster_whisper not installed. "
            "Run: pip install faster-whisper"
        ) from e

    resolved_device = device
    if device == "auto":
        try:
            import torch
            resolved_device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            resolved_device = "cpu"

    model_name = MODEL_VARIANT_MAP.get(model_variant, "large-v3-turbo")
    logger.info(
        "loading whisper model: model=%s device=%s compute_type=%s",
        model_name,
        resolved_device,
        compute_type,
    )

    model = WhisperModel(model_name, device=resolved_device, compute_type=compute_type)
    batched = BatchedInferencePipeline(model=model)

    logger.info("whisper model loaded: %s", model_name)
    return model, batched, model_name, resolved_device
