/**
 * writer.spec.ts — Unit tests for AuditWriter (Zod validation layer).
 *
 * These tests do NOT require a live DB (mock PrismaClient). They verify:
 *   - Valid inputs pass Zod schemas
 *   - Inputs with 0x1F are rejected
 *   - Inputs with NUL bytes are rejected
 *   - Oversized JSON payloads are rejected
 *   - entity_type > 32 chars is rejected
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import {
  AuditLogInputSchema,
  CallWindowAuditInputSchema,
  ConsentLogInputSchema,
  DncSyncLogInputSchema,
} from '../events.js';

describe('AuditLogInputSchema', () => {
  const valid = {
    tenantId: 1n,
    actorKind: 'system' as const,
    action: 'auth.login.success',
    entityType: 'user',
    entityId: '42',
    ts: new Date('2026-05-12T00:00:00Z'),
  };

  it('accepts valid minimum input', () => {
    expect(() => AuditLogInputSchema.parse(valid)).not.toThrow();
  });

  it('rejects action with 0x1F', () => {
    expect(() =>
      AuditLogInputSchema.parse({ ...valid, action: 'bad\x1ffield' })
    ).toThrow(z.ZodError);
  });

  it('rejects entityType with NUL byte', () => {
    expect(() =>
      AuditLogInputSchema.parse({ ...valid, entityType: 'bad\x00type' })
    ).toThrow(z.ZodError);
  });

  it('rejects entityType > 32 chars', () => {
    expect(() =>
      AuditLogInputSchema.parse({ ...valid, entityType: 'x'.repeat(33) })
    ).toThrow(z.ZodError);
  });

  it('rejects after_json > 4 KB', () => {
    const big = { data: 'x'.repeat(4097) };
    expect(() =>
      AuditLogInputSchema.parse({ ...valid, afterJson: big })
    ).toThrow(z.ZodError);
  });

  it('accepts null actorUserId', () => {
    expect(() =>
      AuditLogInputSchema.parse({ ...valid, actorUserId: null })
    ).not.toThrow();
  });

  it('accepts bigint actorUserId', () => {
    expect(() =>
      AuditLogInputSchema.parse({ ...valid, actorUserId: 42n })
    ).not.toThrow();
  });
});

describe('CallWindowAuditInputSchema', () => {
  const valid = {
    tenantId: 1n,
    leadId: 1n,
    phoneE164: '+15551234567',
    campaignId: 'CAMP001',
    decision: 'ALLOW' as const,
    reason: 'within_window',
    enforcementPoint: 'originate_path' as const,
  };

  it('accepts valid input', () => {
    expect(() => CallWindowAuditInputSchema.parse(valid)).not.toThrow();
  });

  it('rejects invalid decision', () => {
    expect(() =>
      CallWindowAuditInputSchema.parse({ ...valid, decision: 'MAYBE' })
    ).toThrow(z.ZodError);
  });

  it('rejects phone_e164 with 0x1F', () => {
    expect(() =>
      CallWindowAuditInputSchema.parse({ ...valid, phoneE164: '+1555\x1f1234567' })
    ).toThrow(z.ZodError);
  });
});

describe('ConsentLogInputSchema', () => {
  const valid = {
    tenantId: 1n,
    callUuid: 'call-001',
    leadId: 1n,
    phoneE164: '+15551234567',
    promptId: 'tcpa_v1',
    outcome: 'accepted' as const,
    promptPlayedAt: new Date(),
  };

  it('accepts valid input', () => {
    expect(() => ConsentLogInputSchema.parse(valid)).not.toThrow();
  });

  it('rejects invalid outcome', () => {
    expect(() =>
      ConsentLogInputSchema.parse({ ...valid, outcome: 'maybe' })
    ).toThrow(z.ZodError);
  });

  it('allows null dtmfResponse', () => {
    expect(() =>
      ConsentLogInputSchema.parse({ ...valid, dtmfResponse: null })
    ).not.toThrow();
  });
});

describe('DncSyncLogInputSchema', () => {
  const valid = {
    source: 'federal',
    kind: 'full' as const,
    startedAt: new Date(),
  };

  it('accepts valid input', () => {
    expect(() => DncSyncLogInputSchema.parse(valid)).not.toThrow();
  });

  it('rejects source with 0x1F', () => {
    expect(() =>
      DncSyncLogInputSchema.parse({ ...valid, source: 'fed\x1feral' })
    ).toThrow(z.ZodError);
  });
});
