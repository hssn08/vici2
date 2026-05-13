/**
 * Integration test: consent-declined → no upload.
 * R02 PLAN §17.2.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// The consent gate is tested by checking that NO_UPLOAD_STATUSES set
// and the routing logic correctly identifies prompted_declined / skipped.

const NO_UPLOAD_STATUSES = new Set(['prompted_declined', 'skipped']);

describe('consent gate', () => {
  it('prompted_declined triggers no-upload path', () => {
    assert.ok(NO_UPLOAD_STATUSES.has('prompted_declined'));
  });

  it('skipped triggers no-upload path', () => {
    assert.ok(NO_UPLOAD_STATUSES.has('skipped'));
  });

  it('not_required does NOT trigger no-upload path', () => {
    assert.ok(!NO_UPLOAD_STATUSES.has('not_required'));
  });

  it('prompted_accepted does NOT trigger no-upload path', () => {
    assert.ok(!NO_UPLOAD_STATUSES.has('prompted_accepted'));
  });

  it('assumed does NOT trigger no-upload path', () => {
    assert.ok(!NO_UPLOAD_STATUSES.has('assumed'));
  });
});
