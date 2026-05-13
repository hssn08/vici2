/**
 * Unit tests for recording-log-writer.
 * Uses node:test (built-in, no extra deps).
 *
 * Run via: pnpm --filter @vici2/workers test
 */

import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { RecordingLogWriter, STREAM_STOPPED, CONSUMER_GROUP, STREAM_DLQ } from './index.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeLogger() {
  const logs: { level: string; msg: string; data: unknown }[] = [];
  const make = (level: string) =>
    (data: unknown, msg?: string) => logs.push({ level, msg: msg ?? String(data), data });
  const logger = {
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    debug: make('debug'),
    child: () => logger,
    _logs: logs,
  } as unknown as import('pino').Logger & { _logs: typeof logs };
  return logger;
}

interface XReadEntry { id: string; fields: string[] }

function makeRedis(entries: XReadEntry[] = []) {
  const acked: string[] = [];
  const xadded: unknown[] = [];
  const deleted: string[] = [];
  let callCount = 0;

  return {
    xreadgroup: async (..._args: unknown[]) => {
      callCount++;
      if (callCount === 1 && entries.length > 0) {
        return [[STREAM_STOPPED, entries.map(e => [e.id, e.fields])]];
      }
      return null; // simulate empty poll after first batch
    },
    xack: async (_stream: string, _group: string, id: string) => {
      acked.push(id);
      return 1;
    },
    xadd: async (...args: unknown[]) => {
      xadded.push(args);
      return '1-0';
    },
    del: async (key: string) => {
      deleted.push(key);
      return 1;
    },
    hdel: async () => 1,
    _acked: acked,
    _xadded: xadded,
    _deleted: deleted,
  };
}

function makeDb(fail = false) {
  const inserted: unknown[][] = [];
  return {
    queryRaw: async (_sql: string, ...params: unknown[]) => {
      if (fail) throw new Error('DB unavailable');
      inserted.push(params);
      return [];
    },
    _inserted: inserted,
  };
}

function makeStoppedPayload(overrides: Partial<{ uuid: string; filename: string }> = {}) {
  const payload = {
    event_id: 'evt-001',
    uuid: 'call-uuid-001',
    tenant_id: 1,
    campaign_id: 'SOLAR_Q2',
    lead_id: 4287,
    user_id: 901,
    filename: '/nonexistent/recording.wav',
    duration_ms: 312500,
    sample_rate: 8000,
    channels: 2,
    started_at_ns: 1746547200000000000,
    ended_at_ns: 1746547512500000000,
    fs_host: 'fs1',
    consent_status: 'not_required',
    ...overrides,
  };
  return ['payload', JSON.stringify(payload)];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RecordingLogWriter', () => {
  it('writes recording_log row on RECORD_STOP event', async () => {
    const redis = makeRedis([{ id: '1-0', fields: makeStoppedPayload() }]);
    const db = makeDb();
    const logger = makeLogger();

    const writer = new RecordingLogWriter(redis as never, db as never, logger);

    // Run one iteration then stop.
    let resolveStop!: () => void;
    const stopSignal = new Promise<void>((r) => { resolveStop = r; });
    const origStart = writer['processEntry'].bind(writer);
    writer['processEntry'] = async (id: string, fields: string[]) => {
      await origStart(id, fields);
      writer.stop();
      resolveStop();
    };

    await Promise.race([writer.start(), stopSignal]);

    // The DB should have received an INSERT.
    assert.ok(db._inserted.length >= 1, 'expected at least one DB INSERT');
    const row = db._inserted[0]!;
    assert.equal(row[0], 1, 'tenant_id');
    assert.equal(row[1], 'call-uuid-001', 'uuid');
    assert.equal(row[2], 'SOLAR_Q2', 'campaign_id');

    // The stream entry should have been ACKed.
    assert.ok(redis._acked.includes('1-0'), 'expected XACK for entry 1-0');

    // Valkey HASH should have been deleted.
    assert.ok(redis._deleted.some(k => k.includes('call-uuid-001')), 'expected Valkey hash deletion');
  });

  it('dead-letters after MAX_RETRIES when DB keeps failing', async () => {
    const redis = makeRedis([{ id: '2-0', fields: makeStoppedPayload({ uuid: 'call-fail-001' }) }]);
    const db = makeDb(true /* always fail */);
    const logger = makeLogger();

    const writer = new RecordingLogWriter(redis as never, db as never, logger);

    let resolveStop!: () => void;
    const stopSignal = new Promise<void>((r) => { resolveStop = r; });
    const origProcess = writer['processEntry'].bind(writer);
    writer['processEntry'] = async (id: string, fields: string[]) => {
      await origProcess(id, fields);
      writer.stop();
      resolveStop();
    };

    await Promise.race([writer.start(), stopSignal]);

    // Entry must still be ACKed (after DLQ write).
    assert.ok(redis._acked.includes('2-0'), 'expected XACK even after DLQ');
    // DLQ must have received an entry.
    assert.ok(redis._xadded.length >= 1, 'expected XADD to DLQ');
    const [dlqStream] = redis._xadded[0] as string[];
    assert.equal(dlqStream, STREAM_DLQ, 'DLQ stream name');
  });

  it('handles RECORD_STOP with individual fields (no payload blob)', async () => {
    const rawFields = [
      'event_id', 'evt-002',
      'uuid', 'call-uuid-002',
      'tenant_id', '1',
      'campaign_id', 'CAM2',
      'lead_id', '100',
      'user_id', '200',
      'filename', '/rec/test.wav',
      'duration_ms', '60000',
      'sample_rate', '8000',
      'channels', '2',
      'started_at_ns', '1746547200000000000',
      'ended_at_ns', '1746547260000000000',
      'fs_host', 'fs1',
      'consent_status', 'prompted_accepted',
    ];
    const redis = makeRedis([{ id: '3-0', fields: rawFields }]);
    const db = makeDb();
    const logger = makeLogger();

    const writer = new RecordingLogWriter(redis as never, db as never, logger);

    let resolveStop!: () => void;
    const stopSignal = new Promise<void>((r) => { resolveStop = r; });
    const origProcess = writer['processEntry'].bind(writer);
    writer['processEntry'] = async (id: string, fields: string[]) => {
      await origProcess(id, fields);
      writer.stop();
      resolveStop();
    };

    await Promise.race([writer.start(), stopSignal]);

    assert.ok(db._inserted.length >= 1, 'expected INSERT');
    assert.equal(db._inserted[0]![1], 'call-uuid-002', 'uuid from individual fields');
    assert.ok(redis._acked.includes('3-0'), 'expected XACK');
  });
});

describe('stream and group name constants', () => {
  it('STREAM_STOPPED matches T01 PLAN §17.4', () => {
    assert.equal(STREAM_STOPPED, 'events:vici2.recording.stopped');
  });
  it('CONSUMER_GROUP is correct', () => {
    assert.equal(CONSUMER_GROUP, 'recording-log-writer');
  });
});
