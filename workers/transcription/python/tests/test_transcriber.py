"""
tests/test_transcriber.py

Unit tests for engine.transcriber — mocked WhisperModel / BatchedInferencePipeline.
N07 PLAN §12.1 / AC-1.
"""

import sys
import os
from unittest.mock import MagicMock, patch
from types import SimpleNamespace

import numpy as np
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engine.transcriber import transcribe_channel


def _make_mock_segment(start, end, text, words=None):
    seg = SimpleNamespace(
        start=start,
        end=end,
        text=text,
        words=words or [],
    )
    return seg


def _make_mock_pipeline(segments, lang="en", lang_prob=0.98):
    info = SimpleNamespace(language=lang, language_probability=lang_prob)
    pipeline = MagicMock()
    pipeline.transcribe.return_value = (iter(segments), info)
    return pipeline


def test_segment_structure_matches_schema():
    """Output segment dicts must contain start, end, text, words keys."""
    word = SimpleNamespace(word="hello", start=0.0, end=0.3, probability=0.95)
    seg = _make_mock_segment(0.0, 0.5, " hello", [word])
    pipeline = _make_mock_pipeline([seg])

    audio = np.zeros(16_000, dtype=np.float32)
    result = transcribe_channel(audio, pipeline)

    assert result["lang"] == "en"
    assert result["lang_prob"] == pytest.approx(0.98, abs=1e-3)
    assert len(result["segments"]) == 1
    s = result["segments"][0]
    assert "start" in s
    assert "end" in s
    assert "text" in s
    assert "words" in s


def test_empty_audio_returns_empty_segments():
    """Empty audio (zero-length) → empty segments."""
    pipeline = _make_mock_pipeline([])
    result = transcribe_channel(np.array([], dtype=np.float32), pipeline)
    assert result["segments"] == []


def test_none_audio_returns_empty_segments():
    """None audio → empty segments without crashing."""
    pipeline = _make_mock_pipeline([])
    result = transcribe_channel(None, pipeline)
    assert result["segments"] == []


def test_low_confidence_words_flagged():
    """Words with score < 0.4 get low_confidence=True."""
    word = SimpleNamespace(word="inaudible", start=0.0, end=0.2, probability=0.2)
    seg = _make_mock_segment(0.0, 0.3, " inaudible", [word])
    pipeline = _make_mock_pipeline([seg])

    audio = np.zeros(16_000, dtype=np.float32)
    result = transcribe_channel(audio, pipeline)

    assert result["segments"][0]["words"][0]["low_confidence"] is True


def test_multiple_segments_preserved():
    """Multiple segments are all returned."""
    segs = [
        _make_mock_segment(0.0, 1.0, " Hello"),
        _make_mock_segment(1.5, 2.5, " World"),
    ]
    pipeline = _make_mock_pipeline(segs)

    audio = np.zeros(32_000, dtype=np.float32)
    result = transcribe_channel(audio, pipeline)

    assert len(result["segments"]) == 2
    assert result["segments"][0]["text"] == "Hello"
    assert result["segments"][1]["text"] == "World"
