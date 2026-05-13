/**
 * workers/src/jobs/rnd-scrub/__tests__/batcher.test.ts
 *
 * N06 — Unit tests for batcher utility functions.
 */

import { describe, it, expect } from 'vitest';
import {
  chunkPhones,
  selectQueryMode,
  formatConsentDate,
  toQueryItems,
  API_BATCH_SIZE,
  SFTP_THRESHOLD,
  type PhoneWithConsent,
} from '../../src/jobs/rnd-scrub/batcher.js';

describe('chunkPhones', () => {
  it('returns empty array for empty input', () => {
    expect(chunkPhones([], 100)).toEqual([]);
  });

  it('returns single chunk when phones < batch size', () => {
    const phones = Array.from({ length: 5 }, (_, i) => `+1202555000${i}`);
    const chunks = chunkPhones(phones, API_BATCH_SIZE);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(5);
  });

  it('splits exactly at batch boundary', () => {
    const phones = Array.from({ length: 2000 }, (_, i) => `+1202555${String(i).padStart(4, '0')}`);
    const chunks = chunkPhones(phones, API_BATCH_SIZE);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1]).toHaveLength(1000);
  });

  it('handles remainder chunk', () => {
    const phones = Array.from({ length: 1500 }, (_, i) => `+120255${String(i).padStart(5, '0')}`);
    const chunks = chunkPhones(phones, API_BATCH_SIZE);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1000);
    expect(chunks[1]).toHaveLength(500);
  });
});

describe('selectQueryMode', () => {
  it('returns api for small lists', () => {
    expect(selectQueryMode(100)).toBe('api');
    expect(selectQueryMode(SFTP_THRESHOLD)).toBe('api');
  });

  it('returns sftp above threshold', () => {
    expect(selectQueryMode(SFTP_THRESHOLD + 1)).toBe('sftp');
    expect(selectQueryMode(1_000_000)).toBe('sftp');
  });

  it('respects forced mode', () => {
    expect(selectQueryMode(1_000_000, 'api')).toBe('api');
    expect(selectQueryMode(100, 'sftp')).toBe('sftp');
  });
});

describe('formatConsentDate', () => {
  it('formats date as YYYY-MM-DD', () => {
    const d = new Date('2026-05-13T00:00:00Z');
    expect(formatConsentDate(d)).toBe('2026-05-13');
  });

  it('zero-pads month and day', () => {
    const d = new Date('2026-01-05T00:00:00Z');
    expect(formatConsentDate(d)).toBe('2026-01-05');
  });
});

describe('toQueryItems', () => {
  it('converts PhoneWithConsent to RndQueryItem', () => {
    const phones: PhoneWithConsent[] = [
      {
        phoneE164: '+12025551234',
        consentDate: new Date('2025-06-01T00:00:00Z'),
        consentDateSrc: 'pewc',
      },
      {
        phoneE164: '+19175559876',
        consentDate: new Date('2025-01-15T00:00:00Z'),
        consentDateSrc: 'fallback',
      },
    ];
    const items = toQueryItems(phones);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ tn: '+12025551234', date: '2025-06-01' });
    expect(items[1]).toEqual({ tn: '+19175559876', date: '2025-01-15' });
  });

  it('handles empty input', () => {
    expect(toQueryItems([])).toEqual([]);
  });
});
