/**
 * Unit tests: object key generation.
 * R02 PLAN §17.1.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildObjectKey } from '../../src/jobs/recording-upload.js';

describe('buildObjectKey', () => {
  it('generates correct key for standard date and tenant', () => {
    const tenantId = 42n;
    const callUuid = '8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e';
    const startTime = new Date('2026-05-06T12:00:00Z');

    const key = buildObjectKey(tenantId, callUuid, startTime);
    assert.equal(key, 'tenants/42/calls/2026/05/06/8a3e1c4f-0b91-46e2-9b53-9d2e1b1f3a4e.wav');
  });

  it('zero-pads month and day', () => {
    const key = buildObjectKey(1n, '00000000-0000-0000-0000-000000000001', new Date('2026-01-02T00:00:00Z'));
    assert.match(key, /\/2026\/01\/02\//);
  });

  it('always ends with .wav', () => {
    const key = buildObjectKey(1n, '00000000-0000-0000-0000-000000000002', new Date('2026-12-31T23:59:59Z'));
    assert.match(key, /\.wav$/);
  });

  it('includes tenant_id prefix for IAM isolation', () => {
    const key = buildObjectKey(99n, '00000000-0000-0000-0000-000000000003', new Date('2026-06-15T00:00:00Z'));
    assert.ok(key.startsWith('tenants/99/'));
  });
});
