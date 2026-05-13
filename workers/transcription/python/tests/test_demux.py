"""
tests/test_demux.py

Unit tests for engine.demux — stereo demux + mono detection + resample.
N07 PLAN §12.1 / AC-1 / AC-15.
"""

import os
import numpy as np
import pytest

# Resolve fixtures directory relative to this file
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")
STEREO_WAV = os.path.join(FIXTURES, "stereo_8khz_30s.wav")
MONO_WAV = os.path.join(FIXTURES, "mono_8khz_30s.wav")


def test_stereo_demux_returns_two_channels():
    """Stereo WAV → two mono float32 arrays (N07 PLAN §4.3)."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from engine.demux import demux_stereo

    customer, agent, sr = demux_stereo(STEREO_WAV)
    assert customer is not None, "customer channel should not be None for stereo"
    assert agent is not None, "agent channel should not be None for stereo"
    assert customer.dtype == np.float32
    assert agent.dtype == np.float32
    assert sr == 8000


def test_stereo_demux_channel_lengths_match():
    """Both channels should have equal number of samples."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from engine.demux import demux_stereo

    customer, agent, sr = demux_stereo(STEREO_WAV)
    assert len(customer) == len(agent)


def test_stereo_demux_float32_range():
    """Samples should be in [-1.0, 1.0]."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from engine.demux import demux_stereo

    customer, agent, sr = demux_stereo(STEREO_WAV)
    assert float(np.max(np.abs(customer))) <= 1.0
    assert float(np.max(np.abs(agent))) <= 1.0


def test_mono_wav_returns_none_channels():
    """Mono WAV → (None, None, sr) — triggers diarization path (AC-15)."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from engine.demux import demux_stereo

    customer, agent, sr = demux_stereo(MONO_WAV)
    assert customer is None, "mono WAV should return None for customer"
    assert agent is None, "mono WAV should return None for agent"
    assert sr == 8000


def test_resample_8khz_to_16khz():
    """Resample 8 kHz → 16 kHz doubles sample count (approximately)."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from engine.demux import demux_stereo, resample

    customer, _, sr = demux_stereo(STEREO_WAV)
    resampled = resample(customer, sr, 16_000)
    # Should have approximately 2× samples
    assert abs(len(resampled) - len(customer) * 2) < 10


def test_resample_noop_when_same_sr():
    """resample() with orig_sr == target_sr returns the same array."""
    import sys
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from engine.demux import resample

    audio = np.ones(1000, dtype=np.float32)
    result = resample(audio, 16_000, 16_000)
    np.testing.assert_array_equal(audio, result)
