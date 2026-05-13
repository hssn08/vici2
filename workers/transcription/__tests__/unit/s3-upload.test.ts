/**
 * __tests__/unit/s3-upload.test.ts
 *
 * Unit tests for S3 key generation and Object Lock params.
 * N07 PLAN §12.2.
 */

import { describe, it, expect } from 'vitest';
import { buildTranscriptKey } from '../../src/jobs/transcription-job.js';

describe('buildTranscriptKey', () => {
  const tenantId = 42n;
  const callUuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
  const startTime = new Date('2026-05-13T14:30:00.000Z');

  it('generates correct path for redacted transcript', () => {
    const key = buildTranscriptKey(tenantId, callUuid, startTime, false);
    expect(key).toBe(`tenants/42/calls/2026/05/13/${callUuid}.transcript.json`);
  });

  it('generates correct path for raw transcript', () => {
    const key = buildTranscriptKey(tenantId, callUuid, startTime, true);
    expect(key).toBe(`tenants/42/calls/2026/05/13/${callUuid}.transcript.raw.json`);
  });

  it('uses UTC date components', () => {
    // Date at midnight UTC — verify no off-by-one with local TZ
    const midnight = new Date('2026-03-01T00:00:00.000Z');
    const key = buildTranscriptKey(1n, callUuid, midnight, false);
    expect(key).toContain('2026/03/01');
  });

  it('different tenant ids generate different prefixes', () => {
    const key1 = buildTranscriptKey(1n, callUuid, startTime);
    const key2 = buildTranscriptKey(2n, callUuid, startTime);
    expect(key1).toContain('tenants/1/');
    expect(key2).toContain('tenants/2/');
    expect(key1).not.toBe(key2);
  });
});
