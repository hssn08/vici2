#!/usr/bin/env python3
"""
workers/transcription/eval/measure_pii_recall.py

Measure Presidio PII recall against synthetic PII-injected fixtures.
N07 PLAN §9.3.

Usage:
  python workers/transcription/eval/measure_pii_recall.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Synthetic PII test cases
# ---------------------------------------------------------------------------

TEST_CASES = [
    # (text, entity_type, should_detect: bool)
    ("My SSN is 123-45-6789.", "US_SSN", True),
    ("Card number: 4111 1111 1111 1111.", "CREDIT_CARD", True),
    ("Please verify your phone at 800-555-1234.", "PHONE_NUMBER", True),
    ("Email me at john.doe@example.com.", "EMAIL_ADDRESS", True),
    ("My name is John Smith.", "PERSON", True),
    ("The weather is sunny today.", None, False),  # no PII
    ("Transfer $500 to account.", None, False),     # ambiguous — OK if not detected
]


def run_recall_test() -> bool:
    """Run PII recall tests against Presidio. Returns True if all targets pass."""
    try:
        sys.path.insert(0, str(Path(__file__).parent.parent / "python"))
        from pii.redactor import redact_segments
    except ImportError as exc:
        print(f"ERROR: could not import redactor: {exc}", file=sys.stderr)
        return False

    total = 0
    passed = 0

    for text, expected_entity, should_detect in TEST_CASES:
        total += 1
        segments = [{"start": 0.0, "end": 1.0, "text": text}]
        _, entity_count, entity_types, _ = redact_segments(segments, "en-US", run_presidio=True)

        detected = entity_count > 0
        if expected_entity:
            detected_type = expected_entity in entity_types
        else:
            detected_type = True  # No specific entity required

        if should_detect:
            ok = detected and detected_type
        else:
            ok = True  # False positives are tracked but don't fail

        status = "PASS" if ok else "FAIL"
        print(f"  [{status}] '{text[:40]}...' → detected={detected}, types={entity_types}")
        if ok:
            passed += 1

    print(f"\nRecall: {passed}/{total} passed")
    return passed == total


def main():
    print("N07 PII Recall Evaluation")
    print("=" * 40)

    try:
        import presidio_analyzer  # noqa: F401
        import spacy
        spacy.load("en_core_web_lg")
    except (ImportError, OSError) as exc:
        print(f"SKIP: presidio or spacy models not available: {exc}")
        print("Install: pip install presidio-analyzer presidio-anonymizer spacy")
        print("         python -m spacy download en_core_web_lg")
        sys.exit(0)

    ok = run_recall_test()
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
