"""
workers/transcription/python/pii/custom_recognizers.py

Custom Presidio recognizers for call-center-specific PII:
  - AccountNumber (generic 8–18 digit account/loan number)
  - DateOfBirth (spoken/written date of birth patterns)
  - LoanNumber (loan-specific 10–14 digit IDs)

N07 PLAN §4.5.
"""

import re
from typing import Optional, List

try:
    from presidio_analyzer import EntityRecognizer, RecognizerResult
    from presidio_analyzer.nlp_engine import NlpArtifacts

    class AccountNumberRecognizer(EntityRecognizer):
        """Recognises generic 8–18 digit account numbers."""

        PATTERNS = [
            re.compile(r"\b\d{8,18}\b"),
        ]
        DENY_LIST_PREFIXES = {"1800", "1888", "1877", "1866"}  # toll-free — not accounts

        def __init__(self):
            super().__init__(
                supported_entities=["ACCOUNT_NUMBER"],
                name="AccountNumberRecognizer",
                supported_language="en",
            )

        def load(self) -> None:  # required by base class
            pass

        def analyze(
            self, text: str, entities: List[str], nlp_artifacts: Optional[NlpArtifacts] = None
        ) -> List[RecognizerResult]:
            results = []
            for pattern in self.PATTERNS:
                for match in pattern.finditer(text):
                    token = match.group()
                    if any(token.startswith(p) for p in self.DENY_LIST_PREFIXES):
                        continue
                    results.append(
                        RecognizerResult(
                            entity_type="ACCOUNT_NUMBER",
                            start=match.start(),
                            end=match.end(),
                            score=0.6,
                        )
                    )
            return results

    class DateOfBirthRecognizer(EntityRecognizer):
        """Recognises date-of-birth phrases in spoken text."""

        PATTERNS = [
            re.compile(
                r"\b(?:born|dob|date of birth|birthday)[:\s]+(\w+ \d{1,2},? \d{4}|\d{1,2}/\d{1,2}/\d{2,4}|\d{4}-\d{2}-\d{2})\b",
                re.IGNORECASE,
            ),
            re.compile(
                r"\b(?:january|february|march|april|may|june|july|august|september|october|november|december)"
                r"\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b",
                re.IGNORECASE,
            ),
        ]

        def __init__(self):
            super().__init__(
                supported_entities=["DATE_OF_BIRTH"],
                name="DateOfBirthRecognizer",
                supported_language="en",
            )

        def load(self) -> None:
            pass

        def analyze(
            self, text: str, entities: List[str], nlp_artifacts: Optional[NlpArtifacts] = None
        ) -> List[RecognizerResult]:
            results = []
            for pattern in self.PATTERNS:
                for match in pattern.finditer(text):
                    results.append(
                        RecognizerResult(
                            entity_type="DATE_OF_BIRTH",
                            start=match.start(),
                            end=match.end(),
                            score=0.75,
                        )
                    )
            return results

    class LoanNumberRecognizer(EntityRecognizer):
        """Recognises loan numbers (10–14 digit IDs prefixed by 'loan')."""

        PATTERN = re.compile(
            r"\b(?:loan(?:\s+number)?(?:\s+is)?[:\s#]+)(\d{10,14})\b",
            re.IGNORECASE,
        )

        def __init__(self):
            super().__init__(
                supported_entities=["LOAN_NUMBER"],
                name="LoanNumberRecognizer",
                supported_language="en",
            )

        def load(self) -> None:
            pass

        def analyze(
            self, text: str, entities: List[str], nlp_artifacts: Optional[NlpArtifacts] = None
        ) -> List[RecognizerResult]:
            results = []
            for match in self.PATTERN.finditer(text):
                results.append(
                    RecognizerResult(
                        entity_type="LOAN_NUMBER",
                        start=match.start(1),
                        end=match.end(1),
                        score=0.85,
                    )
                )
            return results

    ALL_CUSTOM_RECOGNIZERS = [
        AccountNumberRecognizer(),
        DateOfBirthRecognizer(),
        LoanNumberRecognizer(),
    ]

except ImportError:
    ALL_CUSTOM_RECOGNIZERS = []  # type: ignore[assignment]
