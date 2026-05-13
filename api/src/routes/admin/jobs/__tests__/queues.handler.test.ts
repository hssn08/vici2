import { describe, it, expect, vi } from 'vitest';
import { handleGetQueues } from '../queues.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

// Mock dependencies
vi.mock('../../../../lib/redis.js', () => ({
  getRedis: () => ({
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    xlen: vi.fn().mockResolvedValue(5),
    xpending: vi.fn().mockResolvedValue(0),
    pttl: vi.fn().mockResolvedValue(-1),
  }),
}));

vi.mock('../lib/queue-registry.js', () => ({
  getQueue: vi.fn().mockReturnValue({
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 2, active: 1, completed: 10, failed: 3, delayed: 0, paused: 0 }),
    isPaused: vi.fn().mockResolvedValue(false),
  }),
}));

function makeReply() {
  let sent: unknown = null;
  let code = 200;
  const reply = {
    code: (c: number) => { code = c; return reply; },
    send: (data: unknown) => { sent = data; return reply; },
    getSent: () => sent,
    getCode: () => code,
  };
  return reply;
}

function makeReq(overrides: Partial<FastifyRequest> = {}): FastifyRequest {
  return {
    auth: { uid: 1, tenantId: 1, role: 'super_admin' },
    ...overrides,
  } as unknown as FastifyRequest;
}

describe('GET /api/admin/jobs/queues', () => {
  it('returns all queues with fetched at timestamp', async () => {
    const reply = makeReply();
    await handleGetQueues(makeReq(), reply as unknown as FastifyReply);
    const data = reply.getSent() as { queues: unknown[]; fetchedAt: string };
    expect(data.queues).toBeInstanceOf(Array);
    expect(data.queues.length).toBeGreaterThan(0);
    expect(data.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('returns 200 even when a queue fails', async () => {
    const { getQueue } = await import('../lib/queue-registry.js');
    vi.mocked(getQueue).mockImplementationOnce(() => {
      throw new Error('Valkey unavailable');
    });

    const reply = makeReply();
    await handleGetQueues(makeReq(), reply as unknown as FastifyReply);
    expect(reply.getCode()).toBe(200);
    const data = reply.getSent() as { queues: Array<{ warning?: string }> };
    const hasWarning = data.queues.some((q) => q.warning !== undefined);
    expect(hasWarning).toBe(true);
  });

  it('includes kind field on each queue', async () => {
    const reply = makeReply();
    await handleGetQueues(makeReq(), reply as unknown as FastifyReply);
    const data = reply.getSent() as { queues: Array<{ kind: string }> };
    const kinds = new Set(data.queues.map((q) => q.kind));
    expect(kinds.has('bullmq')).toBe(true);
    expect(kinds.has('stream')).toBe(true);
    expect(kinds.has('tick')).toBe(true);
  });
});
