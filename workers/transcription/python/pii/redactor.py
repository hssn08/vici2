"""
workers/transcription/python/pii/redactor.py

Presidio-based PII redaction for transcript segments.
Supports en + es pipelines.
N07 PLAN §4.5 / AC-10.
"""

import logging
import os
from functools import lru_cache
from typing import List, Dict, Any, Tuple

logger = logging.getLogger(__name__)

PRESIDIO_TIMEOUT_SEC = float(os.getenv("N07_PRESIDIO_TIMEOUT_SEC", "10"))


@lru_cache(maxsize=1)
def _get_engines():
    """
    Return (AnalyzerEngine, AnonymizerEngine) singleton.
    Lazy-loaded to avoid import overhead when presidio is not installed.
    """
    try:
        from presidio_analyzer import AnalyzerEngine
        from presidio_analyzer.nlp_engine import NlpEngineProvider
        from presidio_anonymizer import AnonymizerEngine
        from .custom_recognizers import ALL_CUSTOM_RECOGNIZERS
    except ImportError as exc:
        raise RuntimeError(
            "presidio not installed. "
            "Run: pip install presidio-analyzer presidio-anonymizer spacy && "
            "python -m spacy download en_core_web_lg && "
            "python -m spacy download es_core_news_md"
        ) from exc

    # Configure spaCy models for en + es
    provider = NlpEngineProvider(nlp_configuration={
        "nlp_engine_name": "spacy",
        "models": [
            {"lang_code": "en", "model_name": "en_core_web_lg"},
            {"lang_code": "es", "model_name": "es_core_news_md"},
        ],
    })
    nlp_engine = provider.create_engine()

    analyzer = AnalyzerEngine(nlp_engine=nlp_engine, supported_languages=["en", "es"])
    for rec in ALL_CUSTOM_RECOGNIZERS:
        analyzer.registry.add_recognizer(rec)

    anonymizer = AnonymizerEngine()
    logger.info("Presidio analyzer + anonymizer loaded (en + es)")
    return analyzer, anonymizer


def redact_segments(
    segments: List[Dict[str, Any]],
    lang_bcp47: str,
    run_presidio: bool = True,
) -> Tuple[List[Dict[str, Any]], int, List[str], List[str]]:
    """
    Apply Presidio PII redaction to segment texts.

    Args:
        segments:    List of transcript segment dicts.
        lang_bcp47:  BCP-47 language tag (e.g. "en-US", "es-419").
        run_presidio: If False, skip redaction (presidio disabled).

    Returns:
        (redacted_segments, entity_count, entity_types_found, flags)
    """
    if not run_presidio or not segments:
        return segments, 0, [], []

    # Map BCP-47 → Presidio 2-letter code
    presidio_lang = lang_bcp47[:2].lower()
    if presidio_lang not in ("en", "es"):
        logger.warning(
            "presidio lang %s not fully supported — using 'en' pipeline with lower recall",
            presidio_lang,
        )
        flags = ["pii_lang_limited"]
        presidio_lang = "en"
    else:
        flags = []

    try:
        import signal

        def _timeout_handler(signum, frame):
            raise TimeoutError("Presidio timeout")

        # SIGALRM only works on Unix
        try:
            signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(int(PRESIDIO_TIMEOUT_SEC))
        except (AttributeError, OSError):
            pass  # Windows — no SIGALRM; rely on caller timeout

        analyzer, anonymizer = _get_engines()

        entity_count = 0
        entity_types: set = set()
        redacted = []

        for seg in segments:
            text = seg.get("text", "")
            if not text.strip():
                redacted.append(seg)
                continue

            results = analyzer.analyze(text=text, language=presidio_lang)
            if results:
                entity_count += len(results)
                entity_types.update(r.entity_type for r in results)
                anonymized = anonymizer.anonymize(text=text, analyzer_results=results)
                redacted.append({**seg, "text": anonymized.text})
            else:
                redacted.append(seg)

        try:
            signal.alarm(0)
        except (AttributeError, OSError):
            pass

        return redacted, entity_count, sorted(entity_types), flags

    except TimeoutError:
        logger.error("Presidio timed out after %s s — returning unredacted segments", PRESIDIO_TIMEOUT_SEC)
        return segments, 0, [], ["presidio_timeout"]
    except Exception as exc:
        logger.error("Presidio error — returning unredacted segments: %s", exc)
        return segments, 0, [], ["presidio_error"]
