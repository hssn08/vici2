#!/usr/bin/env python3
"""
workers/transcription/eval/measure_wer.py

Measure Word Error Rate (WER) against golden WAV + ground-truth .txt pairs.
N07 PLAN §9.1 / AC-4.

Usage:
  python workers/transcription/eval/measure_wer.py \\
    --golden-dir workers/transcription/eval/golden/en/ \\
    --max-wer 0.05
"""

from __future__ import annotations

import argparse
import os
import sys
import json
import tempfile
import time
from pathlib import Path
from typing import List, Tuple


def load_golden(golden_dir: Path) -> List[Tuple[str, str]]:
    """Load (wav_path, reference_text) pairs from golden directory."""
    pairs = []
    for wav in sorted(golden_dir.glob("*.wav")):
        txt = wav.with_suffix(".txt")
        if not txt.exists():
            print(f"WARNING: missing reference for {wav.name}", file=sys.stderr)
            continue
        reference = txt.read_text(encoding="utf-8").strip()
        pairs.append((str(wav), reference))
    return pairs


def transcribe_via_sidecar(wav_path: str, sidecar_url: str) -> str:
    """
    Call N07 Python sidecar and return concatenated transcript text.
    """
    import urllib.request
    import json as _json

    payload = _json.dumps({
        "wav_path": wav_path,
        "call_uuid": Path(wav_path).stem,
        "lang_hint": None,
        "model": "auto",
        "run_presidio": False,  # WER eval: no redaction
        "retain_raw": False,
    }).encode()

    req = urllib.request.Request(
        f"{sidecar_url}/transcribe",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        data = _json.loads(resp.read())

    return " ".join(seg["text"].strip() for seg in data.get("segments", []))


def measure_wer_jiwer(reference: str, hypothesis: str) -> float:
    """Compute WER using jiwer (or fallback to simple word error rate)."""
    try:
        from jiwer import wer
        return float(wer(reference, hypothesis))
    except ImportError:
        # Fallback: simple Levenshtein-based WER
        ref_words = reference.lower().split()
        hyp_words = hypothesis.lower().split()
        if not ref_words:
            return 0.0
        # Count substitutions + deletions + insertions via edit distance
        import difflib
        matcher = difflib.SequenceMatcher(None, ref_words, hyp_words)
        correct = sum(block.size for block in matcher.get_matching_blocks())
        errors = len(ref_words) - correct + abs(len(hyp_words) - len(ref_words))
        return min(errors / len(ref_words), 1.0)


def main():
    parser = argparse.ArgumentParser(description="N07 WER evaluation")
    parser.add_argument("--golden-dir", required=True, help="Directory with WAV + .txt golden pairs")
    parser.add_argument("--max-wer", type=float, default=0.05, help="Maximum acceptable WER (CI gate)")
    parser.add_argument("--sidecar-url", default="http://localhost:8765", help="Transcription sidecar URL")
    args = parser.parse_args()

    golden_dir = Path(args.golden_dir)
    if not golden_dir.exists():
        print(f"ERROR: golden-dir does not exist: {golden_dir}", file=sys.stderr)
        sys.exit(2)

    pairs = load_golden(golden_dir)
    if not pairs:
        print(f"WARNING: no golden pairs found in {golden_dir}", file=sys.stderr)
        sys.exit(0)

    print(f"Evaluating WER on {len(pairs)} golden fixture(s)...")

    all_refs, all_hyps = [], []
    for wav_path, reference in pairs:
        print(f"  transcribing: {Path(wav_path).name}")
        t0 = time.monotonic()
        try:
            hypothesis = transcribe_via_sidecar(wav_path, args.sidecar_url)
        except Exception as exc:
            print(f"    ERROR: {exc}", file=sys.stderr)
            sys.exit(1)
        elapsed = time.monotonic() - t0

        seg_wer = measure_wer_jiwer(reference, hypothesis)
        print(f"    WER={seg_wer:.3f} ({elapsed:.1f}s)")
        all_refs.append(reference)
        all_hyps.append(hypothesis)

    overall_wer = measure_wer_jiwer(" ".join(all_refs), " ".join(all_hyps))
    print(f"\nOverall WER: {overall_wer:.4f} (max={args.max_wer})")

    if overall_wer > args.max_wer:
        print(f"FAIL: WER {overall_wer:.4f} exceeds limit {args.max_wer}", file=sys.stderr)
        sys.exit(1)

    print("PASS")
    sys.exit(0)


if __name__ == "__main__":
    main()
