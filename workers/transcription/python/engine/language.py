"""
workers/transcription/python/engine/language.py

Language detection via a quick 30-second Whisper pass on the customer channel.
Maps Whisper language codes to BCP-47 tags.
N07 PLAN §1.1 item 9.
"""

import logging
from typing import Optional
import numpy as np

logger = logging.getLogger(__name__)

# Whisper language code → BCP-47
LANG_TO_BCP47: dict[str, str] = {
    "en": "en-US",
    "es": "es-419",  # Latin American Spanish (most likely in US call centers)
    "fr": "fr-FR",
    "de": "de-DE",
    "pt": "pt-BR",
    "zh": "zh-Hans",
    "ja": "ja-JP",
    "ko": "ko-KR",
    "ar": "ar-SA",
    "hi": "hi-IN",
    "ru": "ru-RU",
    "it": "it-IT",
    "nl": "nl-NL",
    "pl": "pl-PL",
    "tr": "tr-TR",
}


def detect_language(
    customer_audio: np.ndarray,
    model,  # WhisperModel (not batched — faster for detection)
    sample_rate: int = 16_000,
    probe_seconds: int = 30,
) -> str:
    """
    Run a quick language detection pass on up to probe_seconds of audio.
    Returns a BCP-47 language tag.
    """
    probe = customer_audio[: probe_seconds * sample_rate]
    if len(probe) == 0:
        logger.warning("empty audio for language detection — defaulting to en-US")
        return "en-US"

    try:
        _, info = model.transcribe(probe, language=None, beam_size=1, best_of=1)
        whisper_lang = info.language or "en"
        bcp47 = LANG_TO_BCP47.get(whisper_lang, whisper_lang)
        logger.debug(
            "detected lang=%s (prob=%.2f) → BCP-47=%s",
            whisper_lang,
            info.language_probability,
            bcp47,
        )
        return bcp47
    except Exception as exc:
        logger.warning("language detection failed — defaulting to en-US: %s", exc)
        return "en-US"
