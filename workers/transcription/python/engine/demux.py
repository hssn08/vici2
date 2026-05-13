"""
workers/transcription/python/engine/demux.py

Stereo WAV channel demux + 8kHz→16kHz resampling.
N07 PLAN §4.3 / AC-15 (mono fallback detection).
"""

import logging
from typing import Optional, Tuple
import numpy as np

logger = logging.getLogger(__name__)

TARGET_SR = 16_000  # Whisper expects 16 kHz


def demux_stereo(
    wav_path: str,
) -> Tuple[Optional[np.ndarray], Optional[np.ndarray], int]:
    """
    Read WAV file and split into (customer, agent) mono channels.

    Channel assignment (N07 PLAN §1.1 §4):
      L (channel 0) = customer
      R (channel 1) = agent

    Returns:
      (customer_f32, agent_f32, sample_rate)
      If mono: returns (None, None, sample_rate) → caller triggers diarization path.

    The returned arrays are float32 in [-1.0, 1.0] at the original sample rate.
    Use resample() to convert to 16 kHz.
    """
    try:
        import soundfile as sf
    except ImportError as exc:
        raise RuntimeError("soundfile not installed. Run: pip install soundfile") from exc

    data, sr = sf.read(wav_path, dtype="int16", always_2d=True)

    if data.ndim == 1 or data.shape[1] < 2:
        logger.warning("mono WAV detected — diarization fallback required: %s", wav_path)
        return None, None, sr

    customer = data[:, 0].astype(np.float32) / 32768.0
    agent    = data[:, 1].astype(np.float32) / 32768.0
    logger.debug("demux ok: sr=%d samples=%d", sr, data.shape[0])
    return customer, agent, sr


def resample(audio: np.ndarray, orig_sr: int, target_sr: int = TARGET_SR) -> np.ndarray:
    """
    Resample a mono float32 array from orig_sr to target_sr using torchaudio.
    Falls back to scipy.signal.resample_poly if torchaudio not available.
    """
    if orig_sr == target_sr:
        return audio

    try:
        import torch
        import torchaudio.functional as F  # type: ignore[import]
        t = torch.from_numpy(audio).unsqueeze(0)
        r = F.resample(t, orig_sr, target_sr)
        return r.squeeze(0).numpy()
    except ImportError:
        pass

    try:
        from scipy.signal import resample_poly  # type: ignore[import]
        import math
        g = math.gcd(orig_sr, target_sr)
        return resample_poly(audio, target_sr // g, orig_sr // g).astype(np.float32)
    except ImportError as exc:
        raise RuntimeError(
            "Neither torchaudio nor scipy is available for resampling."
        ) from exc
