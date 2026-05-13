/**
 * Unit tests: defensive pre-check assertions.
 * R02 PLAN §11.3, §17.1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateUploadParams } from '../../src/jobs/recording-upload.js';

const VALID_TENANT = 1n;
const VALID_UUID = '8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e';
const VALID_KEY = `tenants/1/calls/2026/05/06/${VALID_UUID}.wav`;
const VALID_RETAIN = new Date(Date.now() + 7 * 365.25 * 86400 * 1000);

describe('validateUploadParams', () => {
  it('passes for valid inputs', () => {
    assert.doesNotThrow(() =>
      validateUploadParams(VALID_TENANT, VALID_UUID, VALID_KEY, VALID_RETAIN),
    );
  });

  it('rejects tenantId = 0', () => {
    assert.throws(() =>
      validateUploadParams(0n, VALID_UUID, VALID_KEY, VALID_RETAIN),
      /invalid tenant/,
    );
  });

  it('rejects invalid UUID format', () => {
    assert.throws(() =>
      validateUploadParams(VALID_TENANT, 'not-a-uuid', VALID_KEY, VALID_RETAIN),
      /invalid call UUID/,
    );
  });

  it('rejects key/tenant mismatch (path injection)', () => {
    const wrongKey = `tenants/999/calls/2026/05/06/${VALID_UUID}.wav`;
    assert.throws(() =>
      validateUploadParams(VALID_TENANT, VALID_UUID, wrongKey, VALID_RETAIN),
      /key\/tenant mismatch/,
    );
  });

  it('rejects retention < 1 year', () => {
    const tooSoon = new Date(Date.now() + 30 * 86400 * 1000); // 30 days
    assert.throws(() =>
      validateUploadParams(VALID_TENANT, VALID_UUID, VALID_KEY, tooSoon),
      /retention < 1 year/,
    );
  });

  it('rejects retention > 10 years', () => {
    const tooFar = new Date(Date.now() + 11 * 365.25 * 86400 * 1000);
    assert.throws(() =>
      validateUploadParams(VALID_TENANT, VALID_UUID, VALID_KEY, tooFar),
      /retention > 10 years/,
    );
  });

  it('rejects key without .wav extension', () => {
    const noWav = VALID_KEY.replace('.wav', '.mp3');
    assert.throws(() =>
      validateUploadParams(VALID_TENANT, VALID_UUID, noWav, VALID_RETAIN),
      /expected .wav extension/,
    );
  });
});
