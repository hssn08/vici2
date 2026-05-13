// S05 — ScorecardService unit tests
// Tests computeTotal() and finalize validation
// S05 PLAN §12.1

import { describe, it, expect } from 'vitest';
import { computeTotal, validateScoresComplete } from '../../src/services/coaching/scorecard-service.js';
import type { ScorecardCriterion, ScoreEntry } from '../../src/services/coaching/types.js';

function makeCriterion(overrides: Partial<ScorecardCriterion>): ScorecardCriterion {
  return {
    id: 'c1',
    label: 'Test Criterion',
    type: 'numeric',
    weight: 100,
    max_score: 10,
    ...overrides,
  };
}

describe('computeTotal()', () => {
  it('returns 0 for empty criteria', () => {
    expect(computeTotal([], [])).toBe(0.0);
  });

  it('computes weighted average for all numeric criteria', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', weight: 50, max_score: 10 }),
      makeCriterion({ id: 'c2', weight: 50, max_score: 5 }),
    ];
    const scores: ScoreEntry[] = [
      { criterion_id: 'c1', score: 8 },   // 8/10 = 80%
      { criterion_id: 'c2', score: 5 },   // 5/5 = 100%
    ];
    // weighted: (80% * 50 + 100% * 50) / 100 = (40 + 50) = 90
    expect(computeTotal(criteria, scores)).toBe(90.0);
  });

  it('returns 0 when auto_fail criterion scores 0', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', type: 'auto_fail', weight: 0, max_score: 1, auto_fail: true }),
      makeCriterion({ id: 'c2', weight: 100, max_score: 10 }),
    ];
    const scores: ScoreEntry[] = [
      { criterion_id: 'c1', score: 0 },
      { criterion_id: 'c2', score: 10 },
    ];
    expect(computeTotal(criteria, scores)).toBe(0.0);
  });

  it('does not zero total when auto_fail criterion scores > 0', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', type: 'auto_fail', weight: 0, max_score: 1, auto_fail: true }),
      makeCriterion({ id: 'c2', weight: 100, max_score: 10 }),
    ];
    const scores: ScoreEntry[] = [
      { criterion_id: 'c1', score: 1 },
      { criterion_id: 'c2', score: 8 },
    ];
    expect(computeTotal(criteria, scores)).toBe(80.0);
  });

  it('re-normalizes weights when 2 of 5 criteria are N/A', () => {
    // 5 criteria of equal weight 20 each = 100 total
    const criteria: ScorecardCriterion[] = Array.from({ length: 5 }, (_, i) =>
      makeCriterion({ id: `c${i + 1}`, weight: 20, max_score: 10 }),
    );
    const scores: ScoreEntry[] = [
      { criterion_id: 'c1', score: 10 },          // 100%
      { criterion_id: 'c2', score: 10 },          // 100%
      { criterion_id: 'c3', score: 10 },          // 100%
      { criterion_id: 'c4', score: 0, na: true }, // N/A
      { criterion_id: 'c5', score: 0, na: true }, // N/A
    ];
    // Active 3 criteria, weights are 20+20+20=60. Re-normalized to 100.
    // Each active criterion: (10/10) * (20/60 * 100) = 33.33
    // Total ≈ 100
    expect(computeTotal(criteria, scores)).toBe(100.0);
  });

  it('returns 0 when active weight is 0 (all N/A)', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', weight: 100, max_score: 10 }),
    ];
    const scores: ScoreEntry[] = [{ criterion_id: 'c1', score: 0, na: true }];
    expect(computeTotal(criteria, scores)).toBe(0.0);
  });

  it('ignores text_only criteria in computation', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', type: 'text_only', weight: 0, max_score: 0 }),
      makeCriterion({ id: 'c2', weight: 100, max_score: 10 }),
    ];
    const scores: ScoreEntry[] = [
      { criterion_id: 'c1', score: 0 },
      { criterion_id: 'c2', score: 7 },
    ];
    expect(computeTotal(criteria, scores)).toBe(70.0);
  });

  it('handles binary criterion: yes = max_score, no = 0', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', type: 'binary', weight: 100, max_score: 1 }),
    ];
    expect(computeTotal(criteria, [{ criterion_id: 'c1', score: 1 }])).toBe(100.0);
    expect(computeTotal(criteria, [{ criterion_id: 'c1', score: 0 }])).toBe(0.0);
  });

  it('treats missing score as 0', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', weight: 50, max_score: 10 }),
      makeCriterion({ id: 'c2', weight: 50, max_score: 10 }),
    ];
    const scores: ScoreEntry[] = [
      { criterion_id: 'c1', score: 10 }, // 100%
      // c2 missing → 0
    ];
    // 50% * 100 + 0 = 50
    expect(computeTotal(criteria, scores)).toBe(50.0);
  });

  it('returns correct 2dp rounding', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', weight: 33, max_score: 10 }),
      makeCriterion({ id: 'c2', weight: 33, max_score: 10 }),
      makeCriterion({ id: 'c3', weight: 34, max_score: 10 }),
    ];
    const scores: ScoreEntry[] = [
      { criterion_id: 'c1', score: 10 },
      { criterion_id: 'c2', score: 10 },
      { criterion_id: 'c3', score: 10 },
    ];
    expect(computeTotal(criteria, scores)).toBe(100.0);
  });
});

describe('validateScoresComplete()', () => {
  it('returns null when all required criteria are scored', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', weight: 100, max_score: 10 }),
    ];
    const scores: ScoreEntry[] = [{ criterion_id: 'c1', score: 8 }];
    expect(validateScoresComplete(criteria, scores)).toBeNull();
  });

  it('returns error when a criterion is missing', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', weight: 100, max_score: 10 }),
    ];
    const scores: ScoreEntry[] = [];
    expect(validateScoresComplete(criteria, scores)).toContain('missing a score');
  });

  it('accepts N/A as valid response', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', weight: 100, max_score: 10, na_eligible: true }),
    ];
    const scores: ScoreEntry[] = [{ criterion_id: 'c1', score: 0, na: true }];
    expect(validateScoresComplete(criteria, scores)).toBeNull();
  });

  it('skips text_only criteria in validation', () => {
    const criteria: ScorecardCriterion[] = [
      makeCriterion({ id: 'c1', type: 'text_only', weight: 0, max_score: 0 }),
    ];
    const scores: ScoreEntry[] = [];
    expect(validateScoresComplete(criteria, scores)).toBeNull();
  });
});
