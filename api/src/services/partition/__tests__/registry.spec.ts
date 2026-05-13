/**
 * api/src/services/partition/__tests__/registry.spec.ts
 *
 * C04 — Validates the retention matrix in registry.ts.
 * These tests catch accidental changes to retention windows (regulatory risk).
 */

import { describe, it, expect } from 'vitest';
import { TABLE_REGISTRY, TABLE_MAP } from '../registry.js';

describe('TABLE_REGISTRY', () => {
  it('contains all required tables', () => {
    const tables = TABLE_REGISTRY.map((t) => t.table);
    const required = [
      'call_log',
      'recording_log',
      'audit_log',
      'agent_log',
      'drop_log',
      'call_window_audit',
      'dnc_sync_log',
      'originate_audit',
      'drop_gate_transition_log',
      'import_errors',
      'queue_calls',
      'queue_log',
      'consent_log',
    ];
    for (const name of required) {
      expect(tables, `${name} must be in registry`).toContain(name);
    }
  });

  it('has correct retention windows for TCPA-critical tables', () => {
    // 7-year = 84 months
    const sevenYear = ['recording_log', 'audit_log', 'drop_log', 'dnc_sync_log', 'originate_audit', 'consent_log', 'drop_gate_transition_log'];
    for (const name of sevenYear) {
      const cfg = TABLE_MAP.get(name);
      expect(cfg, `${name} must exist`).toBeDefined();
      expect(cfg!.retentionMonths, `${name} must be 84 months`).toBe(84);
    }
  });

  it('has correct retention windows for 4-year tables', () => {
    // 4-year = 48 months
    const fourYear = ['call_log', 'call_window_audit'];
    for (const name of fourYear) {
      const cfg = TABLE_MAP.get(name);
      expect(cfg!.retentionMonths, `${name} must be 48 months`).toBe(48);
    }
  });

  it('has correct retention for agent_log (13 months)', () => {
    expect(TABLE_MAP.get('agent_log')!.retentionMonths).toBe(13);
  });

  it('has correct retention for short-window tables (3 months ≈ 90 days)', () => {
    const shortWindow = ['import_errors', 'queue_calls', 'queue_log'];
    for (const name of shortWindow) {
      const cfg = TABLE_MAP.get(name);
      expect(cfg!.retentionMonths, `${name} must be 3 months`).toBe(3);
    }
  });

  it('requires attestation only for the correct tables', () => {
    const mustAttest = ['audit_log', 'call_window_audit', 'dnc_sync_log', 'originate_audit', 'consent_log'];
    const mustNotAttest = ['call_log', 'recording_log', 'agent_log', 'drop_log', 'drop_gate_transition_log', 'import_errors', 'queue_calls', 'queue_log'];

    for (const name of mustAttest) {
      expect(TABLE_MAP.get(name)!.requireAttestation, `${name} must require attestation`).toBe(true);
    }
    for (const name of mustNotAttest) {
      expect(TABLE_MAP.get(name)!.requireAttestation, `${name} must NOT require attestation`).toBe(false);
    }
  });

  it('TABLE_MAP has the same entries as TABLE_REGISTRY', () => {
    expect(TABLE_MAP.size).toBe(TABLE_REGISTRY.length);
    for (const cfg of TABLE_REGISTRY) {
      expect(TABLE_MAP.get(cfg.table)).toBe(cfg);
    }
  });

  it('has no duplicate table names', () => {
    const names = TABLE_REGISTRY.map((t) => t.table);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it('all retentionMonths values are positive integers', () => {
    for (const cfg of TABLE_REGISTRY) {
      expect(cfg.retentionMonths).toBeGreaterThan(0);
      expect(Number.isInteger(cfg.retentionMonths)).toBe(true);
    }
  });
});
