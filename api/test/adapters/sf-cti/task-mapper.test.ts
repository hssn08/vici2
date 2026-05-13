// N03 — Unit tests for SF Task mapper.

import { describe, it, expect } from 'vitest';
import { mapDispoToSfTask, type DispoCommitPayload } from '../../../src/routes/adapters/sf-integration/task-mapper.js';
import type { SfFieldMappings } from '../../../src/routes/adapters/sf-integration/schema.js';

const BASE_PAYLOAD: DispoCommitPayload = {
  callId: 'test-call-123',
  dispo: 'SALE',
  dispoLabel: 'Sale',
  notes: 'Great call!',
  callDurationSeconds: 120,
  callStartAt: '2026-05-13T14:30:00.000Z',
  direction: 'outbound',
};

describe('mapDispoToSfTask', () => {
  it('maps SALE dispo to Completed status by default', () => {
    const task = mapDispoToSfTask(BASE_PAYLOAD, {});
    expect(task.Status).toBe('Completed');
    expect(task.Subject).toBe('Call: Sale');
    expect(task.CallType).toBe('Outbound');
    expect(task.CallDurationInSeconds).toBe(120);
    expect(task.ActivityDate).toBe('2026-05-13');
    expect(task.Description).toContain('[vici2:callId:test-call-123]');
    expect(task.Description).toContain('Notes: Great call!');
  });

  it('maps NOANSWER dispo to Not Started by default', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, dispo: 'NOANSWER', dispoLabel: 'No Answer' }, {});
    expect(task.Status).toBe('Not Started');
  });

  it('maps BUSY dispo to Not Started by default', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, dispo: 'BUSY', dispoLabel: 'Busy' }, {});
    expect(task.Status).toBe('Not Started');
  });

  it('maps DNC dispo to Deferred by default', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, dispo: 'DNC', dispoLabel: 'DNC' }, {});
    expect(task.Status).toBe('Deferred');
  });

  it('maps CALLBACK dispo to In Progress by default', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, dispo: 'CALLBACK', dispoLabel: 'Callback' }, {});
    expect(task.Status).toBe('In Progress');
  });

  it('falls back to Completed for unknown dispo codes', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, dispo: 'MYSTERY', dispoLabel: 'Mystery' }, {});
    expect(task.Status).toBe('Completed');
  });

  it('applies custom dispo→status override from fieldMappings', () => {
    const mappings: SfFieldMappings = {
      dispoToTaskStatus: { SALE: 'In Progress', CUSTOM: 'Deferred' },
    };
    const task = mapDispoToSfTask(BASE_PAYLOAD, mappings);
    expect(task.Status).toBe('In Progress');
  });

  it('custom mapping takes precedence over default for same dispo code', () => {
    const mappings: SfFieldMappings = { dispoToTaskStatus: { NOANSWER: 'Waiting on someone else' } };
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, dispo: 'NOANSWER', dispoLabel: 'No Answer' }, mappings);
    expect(task.Status).toBe('Waiting on someone else');
  });

  it('sets CallType to Inbound for inbound direction', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, direction: 'inbound' }, {});
    expect(task.CallType).toBe('Inbound');
  });

  it('applies dispoToCallType override from fieldMappings', () => {
    const mappings: SfFieldMappings = { dispoToCallType: { SALE: 'Inbound' } };
    const task = mapDispoToSfTask(BASE_PAYLOAD, mappings);
    expect(task.CallType).toBe('Inbound');
  });

  it('sets WhoId when sfRecordId is provided', () => {
    const task = mapDispoToSfTask(
      { ...BASE_PAYLOAD, sfRecordId: '003xx000001234', sfObjectType: 'Contact' },
      {},
    );
    expect(task.WhoId).toBe('003xx000001234');
  });

  it('does not set WhoId when sfRecordId is absent', () => {
    const task = mapDispoToSfTask(BASE_PAYLOAD, {});
    expect(task.WhoId).toBeUndefined();
  });

  it('handles missing callStartAt gracefully', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, callStartAt: '' }, {});
    // Should produce today's date in YYYY-MM-DD format
    expect(task.ActivityDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('includes call ID dedup marker in Description', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, callId: 'uuid-abc-123' }, {});
    expect(task.Description).toContain('[vici2:callId:uuid-abc-123]');
  });

  it('omits notes line when notes is empty', () => {
    const task = mapDispoToSfTask({ ...BASE_PAYLOAD, notes: '' }, {});
    expect(task.Description).not.toContain('Notes:');
  });
});
