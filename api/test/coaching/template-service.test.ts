// S05 — TemplateService unit tests
// Tests criteria validation rules
// S05 PLAN §12.1

import { describe, it, expect } from 'vitest';
import { validateCriteria } from '../../src/services/coaching/template-service.js';
import type { ScorecardCriterion } from '../../src/services/coaching/types.js';

function makeNumeric(id: string, weight: number, max_score = 10): ScorecardCriterion {
  return { id, label: `Criterion ${id}`, type: 'numeric', weight, max_score };
}

function makeBinary(id: string, weight: number): ScorecardCriterion {
  return { id, label: `Criterion ${id}`, type: 'binary', weight, max_score: 1 };
}

describe('validateCriteria()', () => {
  it('accepts valid single numeric criterion with weight=100', () => {
    const errors = validateCriteria([makeNumeric('c1', 100)]);
    expect(errors).toHaveLength(0);
  });

  it('accepts multiple criteria with weights summing to 100', () => {
    const errors = validateCriteria([
      makeNumeric('c1', 50),
      makeNumeric('c2', 30),
      makeBinary('c3', 20),
    ]);
    expect(errors).toHaveLength(0);
  });

  it('rejects weight sum = 99.5 (below tolerance)', () => {
    const errors = validateCriteria([
      makeNumeric('c1', 50),
      makeNumeric('c2', 49.5),
    ]);
    expect(errors.some(e => e.field === 'criteria')).toBe(true);
    expect(errors[0].message).toMatch(/sum to 100/);
  });

  it('rejects weight sum > 100.01', () => {
    const errors = validateCriteria([
      makeNumeric('c1', 50),
      makeNumeric('c2', 50.02),
    ]);
    expect(errors.some(e => e.field === 'criteria')).toBe(true);
  });

  it('accepts weight sum = 100.01 (at tolerance boundary)', () => {
    const errors = validateCriteria([
      makeNumeric('c1', 50),
      makeNumeric('c2', 50.01),
    ]);
    expect(errors).toHaveLength(0);
  });

  it('rejects auto_fail criterion with weight > 0', () => {
    const criteria: ScorecardCriterion[] = [
      { id: 'af1', label: 'Auto Fail', type: 'auto_fail', weight: 10, max_score: 1, auto_fail: true },
      makeNumeric('c2', 90),
    ];
    const errors = validateCriteria(criteria);
    expect(errors.some(e => e.message.includes('weight=0'))).toBe(true);
  });

  it('rejects text_only criterion with weight > 0', () => {
    const criteria: ScorecardCriterion[] = [
      { id: 'tx1', label: 'Comment', type: 'text_only', weight: 10, max_score: 0 },
      makeNumeric('c2', 90),
    ];
    const errors = validateCriteria(criteria);
    expect(errors.some(e => e.message.includes('weight=0'))).toBe(true);
  });

  it('rejects template with 0 scoring criteria', () => {
    const criteria: ScorecardCriterion[] = [
      { id: 'tx1', label: 'Comment', type: 'text_only', weight: 0, max_score: 0 },
      { id: 'af1', label: 'Auto Fail', type: 'auto_fail', weight: 0, max_score: 1, auto_fail: true },
    ];
    const errors = validateCriteria(criteria);
    expect(errors.some(e => e.message.includes('At least one scoring criterion'))).toBe(true);
  });

  it('rejects template with 51 criteria', () => {
    const criteria = Array.from({ length: 51 }, (_, i) =>
      makeNumeric(`c${i}`, i === 0 ? 100 : 0),
    );
    const errors = validateCriteria(criteria);
    expect(errors.some(e => e.message.includes('Maximum 50'))).toBe(true);
  });

  it('rejects numeric criterion with max_score < 1', () => {
    const criteria: ScorecardCriterion[] = [
      { id: 'c1', label: 'Bad', type: 'numeric', weight: 100, max_score: 0 },
    ];
    const errors = validateCriteria(criteria);
    expect(errors.some(e => e.message.includes('≥ 1'))).toBe(true);
  });

  it('rejects binary criterion with max_score != 1', () => {
    const criteria: ScorecardCriterion[] = [
      { id: 'c1', label: 'Binary', type: 'binary', weight: 100, max_score: 5 },
    ];
    const errors = validateCriteria(criteria);
    expect(errors.some(e => e.message.includes('max_score=1'))).toBe(true);
  });

  it('rejects empty criteria array', () => {
    const errors = validateCriteria([]);
    expect(errors.some(e => e.message.includes('At least one criterion'))).toBe(true);
  });

  it('accepts auto_fail + numeric with correct weights', () => {
    const criteria: ScorecardCriterion[] = [
      { id: 'af1', label: 'Auto Fail', type: 'auto_fail', weight: 0, max_score: 1, auto_fail: true },
      makeNumeric('c1', 100),
    ];
    const errors = validateCriteria(criteria);
    expect(errors).toHaveLength(0);
  });
});
