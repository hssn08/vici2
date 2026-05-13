import { describe, it, expect } from 'vitest';
import { jitter, exponentialBackoff } from '../backoff.js';

describe('jitter()', () => {
  it('returns a value within [base*(1-fraction), base*(1+fraction)]', () => {
    const base = 1_000;
    const fraction = 0.25;
    for (let i = 0; i < 1_000; i++) {
      const result = jitter(base, fraction);
      expect(result).toBeGreaterThanOrEqual(base * (1 - fraction));
      expect(result).toBeLessThanOrEqual(base * (1 + fraction));
    }
  });

  it('uses 0.25 default fraction', () => {
    const base = 1_000;
    for (let i = 0; i < 500; i++) {
      const result = jitter(base);
      expect(result).toBeGreaterThanOrEqual(750);
      expect(result).toBeLessThanOrEqual(1_250);
    }
  });

  it('returns base when fraction is 0', () => {
    expect(jitter(500, 0)).toBe(500);
  });
});

describe('exponentialBackoff()', () => {
  it('doubles delay with each attempt (before jitter)', () => {
    // With fraction=0 jitter disabled, values are deterministic
    expect(exponentialBackoff(0, 1_000, 3_600_000, 0)).toBe(1_000);
    expect(exponentialBackoff(1, 1_000, 3_600_000, 0)).toBe(2_000);
    expect(exponentialBackoff(2, 1_000, 3_600_000, 0)).toBe(4_000);
  });

  it('caps at maxMs', () => {
    const result = exponentialBackoff(20, 1_000, 5_000, 0);
    expect(result).toBe(5_000);
  });

  it('applies jitter from default fraction', () => {
    const base = 1_000;
    const attempt = 0;
    for (let i = 0; i < 200; i++) {
      const result = exponentialBackoff(attempt, base);
      expect(result).toBeGreaterThanOrEqual(750);
      expect(result).toBeLessThanOrEqual(1_250);
    }
  });
});
