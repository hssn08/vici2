"""
workers/transcription/python/engine/merger.py

Merge customer + agent segment lists into an interleaved timeline.
N07 PLAN §4.4.
"""

from typing import List, Dict, Any


def merge_segments(
    customer_segs: List[Dict[str, Any]],
    agent_segs: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """
    Interleave customer + agent segments sorted by start time.

    Each output segment gains a 'channel' key: 'customer' | 'agent'.
    """
    merged = (
        [{"channel": "customer", **s} for s in customer_segs] +
        [{"channel": "agent",    **s} for s in agent_segs]
    )
    return sorted(merged, key=lambda s: s.get("start", 0.0))


def count_words(segments: List[Dict[str, Any]]) -> int:
    """
    Count total words across all segments by splitting on whitespace.
    Used for transcript_word_count in recording_log.
    """
    return sum(len(seg.get("text", "").split()) for seg in segments)
