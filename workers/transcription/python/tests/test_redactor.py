"""
tests/test_redactor.py

Unit tests for pii.redactor — SSN, CC, phone, clean-text, Spanish.
N07 PLAN §12.1 / AC-10 / AC-1.

NOTE: These tests require presidio to be installed.
They are skipped if presidio is not available (dev without GPU deps).
"""

import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def presidio_available():
    try:
        import presidio_analyzer  # noqa: F401
        import spacy
        # Check that en_core_web_lg is installed
        try:
            spacy.load("en_core_web_lg")
            return True
        except OSError:
            return False
    except ImportError:
        return False


PRESIDIO_SKIP = pytest.mark.skipif(
    not presidio_available(),
    reason="presidio + spacy models not installed",
)


@PRESIDIO_SKIP
def test_ssn_redacted():
    """SSN 123-45-6789 → <US_SSN> in redacted output (AC-10)."""
    from pii.redactor import redact_segments

    segments = [{"start": 0.0, "end": 1.0, "text": "My SSN is 123-45-6789."}]
    redacted, count, types, flags = redact_segments(segments, "en-US", run_presidio=True)

    assert count > 0
    assert "US_SSN" in types
    assert "123-45-6789" not in redacted[0]["text"]


@PRESIDIO_SKIP
def test_credit_card_redacted():
    """Visa CC 4111 1111 1111 1111 → redacted (AC-10)."""
    from pii.redactor import redact_segments

    segments = [{"start": 0.0, "end": 1.0, "text": "My card is 4111 1111 1111 1111."}]
    redacted, count, types, flags = redact_segments(segments, "en-US", run_presidio=True)

    assert count > 0
    assert "CREDIT_CARD" in types
    assert "4111 1111 1111 1111" not in redacted[0]["text"]


@PRESIDIO_SKIP
def test_clean_text_unchanged():
    """Text without PII remains unchanged."""
    from pii.redactor import redact_segments

    original = "The weather is great today."
    segments = [{"start": 0.0, "end": 1.0, "text": original}]
    redacted, count, types, flags = redact_segments(segments, "en-US", run_presidio=True)

    assert count == 0
    assert redacted[0]["text"] == original


@PRESIDIO_SKIP
def test_presidio_disabled_returns_unchanged():
    """run_presidio=False → segments unchanged, count=0."""
    from pii.redactor import redact_segments

    original = "My SSN is 123-45-6789."
    segments = [{"start": 0.0, "end": 1.0, "text": original}]
    redacted, count, types, flags = redact_segments(segments, "en-US", run_presidio=False)

    assert count == 0
    assert redacted[0]["text"] == original


def test_redact_empty_segments():
    """Empty segment list → empty result."""
    from pii.redactor import redact_segments

    result, count, types, flags = redact_segments([], "en-US", run_presidio=False)
    assert result == []
    assert count == 0
