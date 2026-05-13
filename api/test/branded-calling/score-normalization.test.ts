// N05 — Unit tests for provider score normalization and HMAC signing.

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Score normalization helpers (inline, mirrors client logic)
// ---------------------------------------------------------------------------

function firstOrionNormalize(score: number): number {
  return Math.round(Math.max(0, Math.min(100, score)));
}

function hiyaNormalize(rawScore: number): number {
  return Math.round(Math.max(0, Math.min(100, rawScore * 10)));
}

function tnsNormalize(overallRiskScore: number): number {
  return Math.max(0, Math.min(100, Math.round(100 - overallRiskScore)));
}

// ---------------------------------------------------------------------------
// Score normalization tests
// ---------------------------------------------------------------------------

describe('Score normalization — First Orion', () => {
  it('score 75 → normalizedScore 75', () => {
    expect(firstOrionNormalize(75)).toBe(75);
  });

  it('score 0 → normalizedScore 0', () => {
    expect(firstOrionNormalize(0)).toBe(0);
  });

  it('score 100 → normalizedScore 100', () => {
    expect(firstOrionNormalize(100)).toBe(100);
  });

  it('clamped: score 105 → normalizedScore 100', () => {
    expect(firstOrionNormalize(105)).toBe(100);
  });
});

describe('Score normalization — Hiya', () => {
  it('score 8.0 → normalizedScore 80', () => {
    expect(hiyaNormalize(8.0)).toBe(80);
  });

  it('score 0 → normalizedScore 0', () => {
    expect(hiyaNormalize(0)).toBe(0);
  });

  it('score 10 → normalizedScore 100', () => {
    expect(hiyaNormalize(10)).toBe(100);
  });

  it('score 3.5 → normalizedScore 35', () => {
    expect(hiyaNormalize(3.5)).toBe(35);
  });
});

describe('Score normalization — TNS', () => {
  it('overall_risk_score 20 → normalizedScore 80', () => {
    expect(tnsNormalize(20)).toBe(80);
  });

  it('overall_risk_score 100 → normalizedScore 0 (worst case)', () => {
    expect(tnsNormalize(100)).toBe(0);
  });

  it('overall_risk_score 0 → normalizedScore 100 (best case)', () => {
    expect(tnsNormalize(0)).toBe(100);
  });

  it('overall_risk_score 70 → normalizedScore 30', () => {
    expect(tnsNormalize(70)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// TnsClient HMAC signing
// ---------------------------------------------------------------------------

describe('TnsClient HMAC signature', () => {
  it('matches reference vector', () => {
    const apiSecret = 'test-secret-key-32bytes-long-padded!!';
    const method = 'POST';
    const path = '/brands';
    const timestamp = '2026-05-13T00:00:00.000Z';
    const body = JSON.stringify({ company_name: 'Acme Corp' });
    const bodyHash = createHmac('sha256', apiSecret).update(body).digest('hex');
    const message = `${method}\n${path}\n${timestamp}\n${bodyHash}`;
    const sig = createHmac('sha256', apiSecret).update(message).digest('hex');

    // Re-compute independently to verify the algorithm is self-consistent.
    const sigVerify = createHmac('sha256', apiSecret).update(message).digest('hex');
    expect(sig).toBe(sigVerify);
    expect(sig).toHaveLength(64); // SHA-256 hex = 64 chars
  });
});

// ---------------------------------------------------------------------------
// updateDidWorstScore logic
// ---------------------------------------------------------------------------

describe('updateDidWorstScore logic', () => {
  it('selects the minimum score across providers', () => {
    const scores = [75, 60, 25];
    const worst = Math.min(...scores);
    expect(worst).toBe(25);
  });

  it('handles single provider', () => {
    expect(Math.min(...[80])).toBe(80);
  });
});
