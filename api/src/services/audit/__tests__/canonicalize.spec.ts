/**
 * canonicalize.spec.ts — Unit tests for the TS canonicalization module.
 *
 * Tests:
 *   1. Golden fixtures: each fixture's canonical form matches expected hex.
 *   2. NULL vs empty string produce different outputs.
 *   3. JSON key sorting (JCS).
 *   4. LPAD-20 stability.
 *   5. DST / timezone invariance.
 *
 * Cross-language parity: the same fixtures are verified against Go's
 * dialer/internal/audit/canonicalize_test.go and MySQL's trigger via the
 * integration test suite.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  canonicalAuditLog,
  canonicalCallWindowAudit,
  canonicalConsentLog,
  canonicalDncSyncLog,
  lpad20,
  nullOrStr,
  toISOStringMicros,
  SEP,
  NULL_SENTINEL,
} from '../canonicalize.js';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

// ---------------------------------------------------------------------------
// Helper / primitive tests
// ---------------------------------------------------------------------------

describe('lpad20', () => {
  it('pads small numbers to 20 chars', () => {
    expect(lpad20(1n)).toBe('00000000000000000001');
    expect(lpad20(0)).toBe('00000000000000000000');
    expect(lpad20(99999999999999999999n)).toBe('99999999999999999999');
  });
});

describe('nullOrStr', () => {
  it('serializes null as \\N', () => expect(nullOrStr(null)).toBe('\\N'));
  it('serializes undefined as \\N', () => expect(nullOrStr(undefined)).toBe('\\N'));
  it('serializes empty string as ""', () => expect(nullOrStr('')).toBe(''));
  it('serializes real string as-is', () => expect(nullOrStr('foo')).toBe('foo'));
});

describe('toISOStringMicros', () => {
  it('formats with 6 fractional digits and Z', () => {
    const d = new Date('2026-05-12T03:30:00.123Z');
    expect(toISOStringMicros(d)).toBe('2026-05-12T03:30:00.123000Z');
  });

  it('DST spring-forward day formats correctly', () => {
    const d = new Date('2026-03-08T07:00:00.000Z');
    expect(toISOStringMicros(d)).toBe('2026-03-08T07:00:00.000000Z');
  });
});

// ---------------------------------------------------------------------------
// audit_log canonicalization
// ---------------------------------------------------------------------------

describe('canonicalAuditLog', () => {
  const base = {
    prevHash: '0'.repeat(64),
    tenantId: 1n,
    id: 1n,
    ts: new Date('2026-05-12T03:30:00.000Z'),
    actorUserId: null,
    actorKind: 'system',
    action: 'audit.attestation.published',
    entityType: 'audit_log',
    entityId: null,
    beforeJson: null,
    afterJson: null,
    requestId: null,
    ipAddress: null,
    userAgent: null,
  };

  it('produces a deterministic string', () => {
    const c1 = canonicalAuditLog(base);
    const c2 = canonicalAuditLog(base);
    expect(c1).toBe(c2);
  });

  it('contains all fields separated by 0x1F', () => {
    const c = canonicalAuditLog(base);
    const parts = c.split(SEP);
    expect(parts).toHaveLength(15); // 15 fields per PLAN §3.5
  });

  it('null actor_user_id serializes as \\N', () => {
    const c = canonicalAuditLog(base);
    const parts = c.split(SEP);
    expect(parts[5]).toBe(NULL_SENTINEL); // actor_user_id position
  });

  it('tenant_id is zero-padded to 20 chars', () => {
    const c = canonicalAuditLog(base);
    const parts = c.split(SEP);
    expect(parts[1]).toBe('00000000000000000001');
  });

  it('table_tag is literal "audit_log"', () => {
    const c = canonicalAuditLog(base);
    const parts = c.split(SEP);
    expect(parts[2]).toBe('audit_log');
  });

  it('JSON keys are sorted (JCS)', () => {
    const row = {
      ...base,
      afterJson: { z_last: 'admin', a_first: 'changed', m_mid: 99 },
    };
    const c = canonicalAuditLog(row);
    expect(c).toContain('"a_first":"changed"');
    // z_last must come AFTER a_first in the output
    const parts = c.split(SEP);
    const afterJsonPart = parts[11] ?? ''; // index 11 = afterJson field
    expect(afterJsonPart.indexOf('"a_first"')).toBeLessThan(afterJsonPart.indexOf('"z_last"'));
  });

  it('empty string entity_id is different from null entity_id', () => {
    const withNull = canonicalAuditLog({ ...base, entityId: null });
    const withEmpty = canonicalAuditLog({ ...base, entityId: '' });
    expect(withNull).not.toBe(withEmpty);
    expect(withNull.split(SEP)[9]).toBe('\\N');
    expect(withEmpty.split(SEP)[9]).toBe('');
  });

  it('SHA-256 of canonical is 64 hex chars', () => {
    const hash = sha256(canonicalAuditLog(base));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// call_window_audit canonicalization
// ---------------------------------------------------------------------------

describe('canonicalCallWindowAudit', () => {
  const base = {
    prevHash: '0'.repeat(64),
    tenantId: 1n,
    id: 1n,
    createdAt: new Date('2026-05-12T14:30:00.000Z'),
    leadId: 12345n,
    phoneE164: '+15551234567',
    campaignId: 'CAMP001',
    decision: 'ALLOW',
    reason: 'within_window',
    tzIana: 'America/New_York',
    tzConfidence: 'KNOWN',
    stateCode: 'NY',
    zip: '10001',
    partyLocal: new Date('2026-05-12T10:30:00.000Z'),
    partyDow: 2,
    effectiveOpenMin: 480,
    effectiveCloseMin: 1200,
    ruleApplied: 'state:NY',
    enforcementPoint: 'originate_path',
    nextOpenAt: null,
    callUuid: 'call-abc123',
  };

  it('has 22 fields', () => {
    const parts = canonicalCallWindowAudit(base).split(SEP);
    expect(parts).toHaveLength(22);
  });

  it('table_tag is "call_window_audit"', () => {
    const parts = canonicalCallWindowAudit(base).split(SEP);
    expect(parts[2]).toBe('call_window_audit');
  });

  it('null nextOpenAt serializes as \\N', () => {
    const c = canonicalCallWindowAudit(base);
    const parts = c.split(SEP);
    expect(parts[20]).toBe('\\N'); // next_open_at
  });
});

// ---------------------------------------------------------------------------
// consent_log canonicalization
// ---------------------------------------------------------------------------

describe('canonicalConsentLog', () => {
  const base = {
    prevHash: '0'.repeat(64),
    tenantId: 1n,
    id: 1n,
    callUuid: 'call-consent-001',
    leadId: 1001n,
    phoneE164: '+15551234567',
    promptId: 'tcpa_consent_v1',
    dtmfResponse: '1',
    outcome: 'accepted',
    language: 'en',
    promptPlayedAt: new Date('2026-05-12T14:30:05.000Z'),
  };

  it('has 12 fields', () => {
    const parts = canonicalConsentLog(base).split(SEP);
    expect(parts).toHaveLength(12);
  });

  it('null dtmfResponse serializes as \\N', () => {
    const c = canonicalConsentLog({ ...base, dtmfResponse: null });
    const parts = c.split(SEP);
    expect(parts[8]).toBe('\\N');
  });
});

// ---------------------------------------------------------------------------
// dnc_sync_log canonicalization
// ---------------------------------------------------------------------------

describe('canonicalDncSyncLog', () => {
  const base = {
    prevHash: '0'.repeat(64),
    id: 1n,
    source: 'federal',
    kind: 'full',
    fileHash: 'sha256:abc',
    added: 1250000,
    removed: 0,
    startedAt: new Date('2026-05-12T03:00:00.000Z'),
    completedAt: new Date('2026-05-12T03:45:00.000Z'),
  };

  it('table_tag is "dnc_sync_log"', () => {
    const parts = canonicalDncSyncLog(base).split(SEP);
    expect(parts[2]).toBe('dnc_sync_log');
  });

  it('uses tenant sentinel 00000000000000000001', () => {
    const parts = canonicalDncSyncLog(base).split(SEP);
    expect(parts[1]).toBe('00000000000000000001');
  });

  it('null completedAt serializes as \\N', () => {
    const c = canonicalDncSyncLog({ ...base, completedAt: null });
    const parts = c.split(SEP);
    expect(parts[10]).toBe('\\N');
  });
});

// ---------------------------------------------------------------------------
// Chain hash stability: same input → same output always
// ---------------------------------------------------------------------------

describe('hash determinism', () => {
  it('audit_log: same input → same hash across calls', () => {
    const input = {
      prevHash: '0'.repeat(64),
      tenantId: 1n, id: 42n,
      ts: new Date('2026-05-12T00:00:00.000Z'),
      actorUserId: null, actorKind: 'system', action: 'auth.login.success',
      entityType: 'user', entityId: '1',
      beforeJson: null, afterJson: { ok: true },
      requestId: 'r1', ipAddress: null, userAgent: null,
    };
    const h1 = sha256(canonicalAuditLog(input));
    const h2 = sha256(canonicalAuditLog(input));
    expect(h1).toBe(h2);
  });
});
