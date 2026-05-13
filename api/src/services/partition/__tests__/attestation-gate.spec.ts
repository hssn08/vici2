/**
 * api/src/services/partition/__tests__/attestation-gate.spec.ts
 *
 * C04 — Tests for the Merkle attestation gate.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { checkAttestation, lastDayOfWindow } from '../attestation-gate.js';

function makePrisma(cntOverride?: number, throwError?: Error): PrismaClient {
  return {
    $queryRawUnsafe: vi.fn(async () => {
      if (throwError) throw throwError;
      return [{ cnt: cntOverride ?? 1 }];
    }),
  } as unknown as PrismaClient;
}

describe('checkAttestation', () => {
  it('returns ok=true when attestation row exists', async () => {
    const db = makePrisma(1);
    const result = await checkAttestation(db, 'audit_log', '2026-04-30');
    expect(result.ok).toBe(true);
  });

  it('returns ok=false with attestation_absent when count is 0', async () => {
    const db = makePrisma(0);
    const result = await checkAttestation(db, 'audit_log', '2026-04-30');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('attestation_absent');
    }
  });

  it('returns ok=false with attestation_table_missing when table not found', async () => {
    const db = makePrisma(undefined, new Error("Table 'vici2.audit_attestation' doesn't exist"));
    const result = await checkAttestation(db, 'audit_log', '2026-04-30');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('attestation_table_missing');
    }
  });

  it('returns ok=false with db_error for other DB errors', async () => {
    const db = makePrisma(undefined, new Error('Connection lost'));
    const result = await checkAttestation(db, 'audit_log', '2026-04-30');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('db_error');
    }
  });

  it('returns ok=false with attestation_table_missing for ER_NO_SUCH_TABLE', async () => {
    const db = makePrisma(undefined, new Error('ER_NO_SUCH_TABLE: Table not found'));
    const result = await checkAttestation(db, 'audit_log', '2026-04-30');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('attestation_table_missing');
    }
  });
});

describe('lastDayOfWindow', () => {
  it('returns the day before the given boundary date', () => {
    expect(lastDayOfWindow('2026-05-01')).toBe('2026-04-30');
    expect(lastDayOfWindow('2026-03-01')).toBe('2026-02-28');
    expect(lastDayOfWindow('2024-03-01')).toBe('2024-02-29'); // leap year
    expect(lastDayOfWindow('2027-01-01')).toBe('2026-12-31');
  });
});
