import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

// Minimal DLQ entry
const ENTRY_ID = '1715123456789-0';
const FIELDS = [
  'worker', 'lead-import',
  'source_queue', 'vici2:queue:lead-import',
  'source_id', 'job-1',
  'payload', JSON.stringify({ phone: '555-123-4567', name: 'Test' }),
  'error', 'Error: something failed',
  'error_stack', 'Error: something failed\n  at worker.ts:42',
  'attempt', '3',
  'worker_id', 'host-1234',
  'tenant_id', '1',
];

const mockRedis = {
  xrange: vi.fn().mockResolvedValue([[ENTRY_ID, FIELDS]]),
  xrevrange: vi.fn().mockResolvedValue([[ENTRY_ID, FIELDS]]),
  xlen: vi.fn().mockResolvedValue(1),
  xtrim: vi.fn().mockResolvedValue(1),
  xdel: vi.fn().mockResolvedValue(1),
  xadd: vi.fn().mockResolvedValue('1715123456790-0'),
};

vi.mock('../../../../lib/redis.js', () => ({ getRedis: () => mockRedis }));

vi.mock('../lib/audit-jobs.js', () => ({
  auditDlqRetry: vi.fn().mockResolvedValue(undefined),
  auditDlqDrain: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/queue-registry.js', () => ({
  getQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({ id: 'new-job-id' }),
  }),
  resolveQueueName: vi.fn().mockReturnValue('vici2:queue:lead-import'),
}));

import { handleGetDlq, handleDlqRetry, handleDlqDrain } from '../dlq.js';

function makeReply() {
  let sent: unknown = null;
  let statusCode = 200;
  const r = {
    code: (c: number) => { statusCode = c; return r; },
    send: (d?: unknown) => { sent = d; return r; },
    getSent: () => sent,
    getCode: () => statusCode,
  };
  return r;
}

function makeReq(overrides: Record<string, unknown> = {}): FastifyRequest {
  return {
    auth: { uid: 1, tenantId: 1, role: 'admin' },
    params: { queue: 'lead-import' },
    query: {},
    body: {},
    ip: '127.0.0.1',
    headers: {},
    ...overrides,
  } as unknown as FastifyRequest;
}

describe('handleGetDlq', () => {
  it('returns entries from XREVRANGE by default', async () => {
    const reply = makeReply();
    await handleGetDlq(makeReq(), reply as unknown as FastifyReply);
    expect(mockRedis.xrevrange).toHaveBeenCalled();
    const data = reply.getSent() as { entries: unknown[]; total: number };
    expect(data.entries).toHaveLength(1);
    expect(data.total).toBe(1);
  });

  it('masks PII in payload by default (non-super_admin)', async () => {
    const reply = makeReply();
    await handleGetDlq(makeReq({ auth: { uid: 1, tenantId: 1, role: 'admin' } }), reply as unknown as FastifyReply);
    const data = reply.getSent() as { entries: Array<{ payload: Record<string, unknown> }> };
    expect(data.entries[0].payload.phone).toBe('***REDACTED***');
  });

  it('uses XRANGE for order=asc', async () => {
    const reply = makeReply();
    await handleGetDlq(makeReq({ query: { order: 'asc' } }), reply as unknown as FastifyReply);
    expect(mockRedis.xrange).toHaveBeenCalled();
  });
});

describe('handleDlqRetry', () => {
  beforeEach(() => {
    mockRedis.xrange.mockResolvedValue([[ENTRY_ID, FIELDS]]);
    mockRedis.xdel.mockResolvedValue(1);
  });

  it('returns 404 when entry not found', async () => {
    mockRedis.xrange.mockResolvedValueOnce([]);
    const reply = makeReply();
    await handleDlqRetry(
      makeReq({ params: { queue: 'lead-import', eid: 'nonexistent-0' } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.getCode()).toBe(404);
  });

  it('calls XDEL after successful retry', async () => {
    const reply = makeReply();
    await handleDlqRetry(
      makeReq({ params: { queue: 'lead-import', eid: ENTRY_ID } }),
      reply as unknown as FastifyReply,
    );
    expect(mockRedis.xdel).toHaveBeenCalledWith(
      expect.stringContaining('dlq'),
      ENTRY_ID,
    );
    const data = reply.getSent() as { retried: boolean };
    expect(data.retried).toBe(true);
  });
});

describe('handleDlqDrain', () => {
  it('returns 400 CONFIRMATION_REQUIRED without confirm', async () => {
    const reply = makeReply();
    await handleDlqDrain(makeReq({ body: {} }), reply as unknown as FastifyReply);
    expect(reply.getCode()).toBe(400);
    expect((reply.getSent() as { error: string }).error).toBe('CONFIRMATION_REQUIRED');
  });

  it('calls XTRIM with MAXLEN 0 on correct confirmation', async () => {
    const reply = makeReply();
    await handleDlqDrain(
      makeReq({ body: { confirm: 'drain dlq lead-import' } }),
      reply as unknown as FastifyReply,
    );
    expect(mockRedis.xtrim).toHaveBeenCalledWith(
      expect.stringContaining('dlq'),
      'MAXLEN',
      0,
    );
    const data = reply.getSent() as { drained: boolean; entriesRemoved: number };
    expect(data.drained).toBe(true);
    expect(data.entriesRemoved).toBe(1);
  });
});
