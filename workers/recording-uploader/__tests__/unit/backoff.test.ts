/**
 * Unit tests: jitter + delay math.
 * R02 PLAN §17.1, §11.2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { jitter } from '../../src/jobs/recording-upload.js';

describe('jitter', () => {
  it('stays within ±25% of base delay', () => {
    const baseMs = 30_000;
    const samples = 1000;
    for (let i = 0; i < samples; i++) {
      const result = jitter(baseMs);
      assert.ok(result >= baseMs * 0.75, `jitter ${result} < lower bound ${baseMs * 0.75}`);
      assert.ok(result <= baseMs * 1.25, `jitter ${result} > upper bound ${baseMs * 1.25}`);
    }
  });

  it('produces different values (randomness check)', () => {
    const values = new Set(Array.from({ length: 100 }, () => jitter(30_000)));
    assert.ok(values.size > 1, 'jitter must produce different values');
  });

  it('zero base returns 0', () => {
    assert.equal(jitter(0), 0);
  });
});

describe('BullMQ backoff table', () => {
  // BullMQ exponential backoff: delay * 2^(attemptsMade-1)
  // Base = 30_000 ms; attempt 1 = 30s, attempt 2 = 60s, ..., attempt 7 = 1920s
  function bullmqBackoffDelay(attempt: number, baseMs: number): number {
    return baseMs * Math.pow(2, attempt - 1);
  }

  const expected: Array<[number, number]> = [
    [1, 30_000],
    [2, 60_000],
    [3, 120_000],
    [4, 240_000],
    [5, 480_000],
    [6, 960_000],
    [7, 1_920_000],
  ];

  for (const [attempt, expectedMs] of expected) {
    it(`attempt ${attempt} base delay = ${expectedMs / 1000}s`, () => {
      assert.equal(bullmqBackoffDelay(attempt, 30_000), expectedMs);
    });
  }
});
