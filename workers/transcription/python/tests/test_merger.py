"""
tests/test_merger.py

Unit tests for engine.merger — interleave + sort.
N07 PLAN §12.1 / AC-1.
"""

import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from engine.merger import merge_segments, count_words


def _make_seg(start, end, text, channel=None):
    seg = {"start": start, "end": end, "text": text}
    if channel:
        seg["channel"] = channel
    return seg


def test_merge_interleaves_and_sorts_by_start():
    """10 customer + 10 agent → 20 merged; sorted by start."""
    customer = [_make_seg(i * 2.0, i * 2.0 + 1.0, f"C{i}") for i in range(10)]
    agent = [_make_seg(i * 2.0 + 1.0, i * 2.0 + 2.0, f"A{i}") for i in range(10)]

    merged = merge_segments(customer, agent)
    assert len(merged) == 20

    # Verify sorted by start
    starts = [s["start"] for s in merged]
    assert starts == sorted(starts)


def test_channel_labels_assigned():
    """Merged segments have 'channel' = 'customer' or 'agent'."""
    customer = [_make_seg(0.0, 1.0, "hello")]
    agent = [_make_seg(1.0, 2.0, "world")]

    merged = merge_segments(customer, agent)
    channels = {s["channel"] for s in merged}
    assert "customer" in channels
    assert "agent" in channels


def test_empty_inputs_return_empty():
    """Both empty → empty result."""
    assert merge_segments([], []) == []


def test_one_empty_side():
    """One empty channel → only other channel's segments."""
    customer = [_make_seg(0.0, 1.0, "hello")]
    merged = merge_segments(customer, [])
    assert len(merged) == 1
    assert merged[0]["channel"] == "customer"


def test_count_words():
    """count_words sums whitespace-split word counts."""
    segs = [
        {"text": "hello world", "start": 0.0, "end": 1.0},
        {"text": "foo bar baz", "start": 1.0, "end": 2.0},
    ]
    assert count_words(segs) == 5


def test_count_words_empty():
    assert count_words([]) == 0
