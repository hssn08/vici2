import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { FastifyRequest, FastifyReply } from 'fastify';

// Mock audit to avoid DB calls
vi.mock('../lib/audit-jobs.js', () => ({
  auditJobRetry: vi.fn().mockResolvedValue(undefined),
  auditJobRemove: vi.fn().mockResolvedValue(undefined),
  auditQueuePause: vi.fn().mockResolvedValue(undefined),
  auditQueueResume: vi.fn().mockResolvedValue(undefined),
  auditQueueDrain: vi.fn().mockResolvedValue(undefined),
}));

// Use vi.hoisted to create the mockQueue so it's available when vi.mock factories run
const mockQueue = vi.hoisted(() => ({
  getJob: vi.fn(),
  isPaused: vi.fn().mockResolvedValue(false),
  pause: vi.fn().mockResolvedValue(undefined),
  resume: vi.fn().mockResolvedValue(undefined),
  drain: vi.fn().mockResolvedValue(undefined),
}));

// Shared job mock
function makeJob(state: string, id = 'job-1') {
  return {
    id,
    getState: vi.fn().mockResolvedValue(state),
    retry: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('../lib/queue-registry.js', () => ({
  getQueue: vi.fn().mockReturnValue(mockQueue),
  resolveQueueName: vi.fn().mockImplementation((n: string) => {
    if (n === 'lead-import') return 'vici2:queue:lead-import';
    return n;
  }),
}));

vi.mock('../lib/queue-meta.js', () => ({
  findQueueMeta: vi.fn().mockReturnValue({ kind: 'bullmq', displayName: 'Lead Import' }),
  QUEUE_META: [],
}));

import {
  handleJobRetry,
  handleJobRemove,
  handleQueuePause,
  handleQueueResume,
  handleQueueDrain,
} from '../queue-actions.js';

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
    params: { queue: 'lead-import', id: 'job-1' },
    body: {},
    query: {},
    ip: '127.0.0.1',
    headers: {},
    ...overrides,
  } as unknown as FastifyRequest;
}

describe('handleJobRetry', () => {
  beforeEach(() => { mockQueue.getJob.mockReset(); });

  it('returns 404 when job not found', async () => {
    mockQueue.getJob.mockResolvedValue(null);
    const reply = makeReply();
    await handleJobRetry(makeReq(), reply as unknown as FastifyReply);
    expect(reply.getCode()).toBe(404);
  });

  it('returns 409 NOT_FAILED when job is not in failed state', async () => {
    mockQueue.getJob.mockResolvedValue(makeJob('active'));
    const reply = makeReply();
    await handleJobRetry(makeReq(), reply as unknown as FastifyReply);
    expect(reply.getCode()).toBe(409);
    expect((reply.getSent() as { error: string }).error).toBe('NOT_FAILED');
  });

  it('retries a failed job and returns new state', async () => {
    const job = makeJob('failed');
    // After retry, getState returns 'waiting'
    job.getState.mockResolvedValueOnce('failed').mockResolvedValueOnce('waiting');
    mockQueue.getJob.mockResolvedValue(job);
    const reply = makeReply();
    await handleJobRetry(makeReq(), reply as unknown as FastifyReply);
    expect(job.retry).toHaveBeenCalledWith('failed');
    expect((reply.getSent() as { state: string }).state).toBe('waiting');
  });
});

describe('handleJobRemove', () => {
  it('removes a job and returns 204', async () => {
    mockQueue.getJob.mockResolvedValue(makeJob('completed'));
    const reply = makeReply();
    await handleJobRemove(makeReq(), reply as unknown as FastifyReply);
    expect(reply.getCode()).toBe(204);
  });

  it('returns 409 JOB_ACTIVE if remove throws active error', async () => {
    const job = makeJob('active');
    job.remove = vi.fn().mockRejectedValue(new Error('Cannot remove active job'));
    mockQueue.getJob.mockResolvedValue(job);
    const reply = makeReply();
    await handleJobRemove(makeReq(), reply as unknown as FastifyReply);
    expect(reply.getCode()).toBe(409);
    expect((reply.getSent() as { error: string }).error).toBe('JOB_ACTIVE');
  });
});

describe('handleQueuePause', () => {
  beforeEach(() => { mockQueue.pause.mockClear(); mockQueue.isPaused.mockReset(); });

  it('pauses a running queue', async () => {
    mockQueue.isPaused.mockResolvedValue(false);
    const reply = makeReply();
    await handleQueuePause(makeReq({ params: { queue: 'lead-import' } }), reply as unknown as FastifyReply);
    expect(mockQueue.pause).toHaveBeenCalled();
    expect((reply.getSent() as { paused: boolean }).paused).toBe(true);
  });

  it('is idempotent — returns 200 if already paused', async () => {
    mockQueue.isPaused.mockResolvedValue(true);
    const reply = makeReply();
    await handleQueuePause(makeReq({ params: { queue: 'lead-import' } }), reply as unknown as FastifyReply);
    expect(mockQueue.pause).not.toHaveBeenCalled();
    expect((reply.getSent() as { paused: boolean }).paused).toBe(true);
  });
});

describe('handleQueueResume', () => {
  it('resumes a paused queue', async () => {
    mockQueue.isPaused.mockResolvedValue(true);
    const reply = makeReply();
    await handleQueueResume(makeReq({ params: { queue: 'lead-import' } }), reply as unknown as FastifyReply);
    expect(mockQueue.resume).toHaveBeenCalled();
    expect((reply.getSent() as { paused: boolean }).paused).toBe(false);
  });
});

describe('handleQueueDrain', () => {
  it('returns 400 CONFIRMATION_REQUIRED if confirm missing', async () => {
    const reply = makeReply();
    await handleQueueDrain(
      makeReq({ params: { queue: 'lead-import' }, body: {} }),
      reply as unknown as FastifyReply,
    );
    expect(reply.getCode()).toBe(400);
    expect((reply.getSent() as { error: string }).error).toBe('CONFIRMATION_REQUIRED');
  });

  it('returns 400 CONFIRMATION_REQUIRED if confirm wrong', async () => {
    const reply = makeReply();
    await handleQueueDrain(
      makeReq({ params: { queue: 'lead-import' }, body: { confirm: 'wrong string' } }),
      reply as unknown as FastifyReply,
    );
    expect(reply.getCode()).toBe(400);
  });

  it('drains queue with correct confirmation', async () => {
    const reply = makeReply();
    await handleQueueDrain(
      makeReq({ params: { queue: 'lead-import' }, body: { confirm: 'drain Lead Import' }, query: {} }),
      reply as unknown as FastifyReply,
    );
    expect(mockQueue.drain).toHaveBeenCalled();
    expect((reply.getSent() as { drained: boolean }).drained).toBe(true);
  });
});
