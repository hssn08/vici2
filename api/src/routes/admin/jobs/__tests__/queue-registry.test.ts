import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock ioredis + bullmq before importing registry
vi.mock('../../../../lib/redis.js', () => ({
  getRedis: () => ({
    xlen: vi.fn().mockResolvedValue(0),
  }),
}));

// Minimal Queue mock factory
function makeMockQueue(name: string) {
  return {
    name,
    getJobCounts: vi.fn().mockResolvedValue({ waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, paused: 0 }),
    isPaused: vi.fn().mockResolvedValue(false),
    getJobs: vi.fn().mockResolvedValue([]),
    getJobCountByTypes: vi.fn().mockResolvedValue(0),
    getJob: vi.fn().mockResolvedValue(null),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  };
}

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation((name: string) => makeMockQueue(name)),
}));

import { getQueue, setQueueForTests, resolveQueueName } from '../lib/queue-registry.js';

describe('queue-registry', () => {
  afterEach(() => {
    // Clean up injected mocks
    setQueueForTests('vici2:queue:lead-import', null);
  });

  it('returns a Queue for a known BullMQ queue (full name)', () => {
    const q = getQueue('vici2:queue:lead-import');
    expect(q).toBeTruthy();
  });

  it('throws 400 for unknown queue', () => {
    expect(() => getQueue('vici2:queue:nonexistent')).toThrow();
    try {
      getQueue('vici2:queue:nonexistent');
    } catch (err: unknown) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
      expect((err as { code: string }).code).toBe('QUEUE_NOT_FOUND');
    }
  });

  it('throws 400 QUEUE_KIND_MISMATCH for stream queue', () => {
    try {
      getQueue('events:vici2.recording-log');
    } catch (err: unknown) {
      expect((err as { statusCode: number }).statusCode).toBe(400);
      expect((err as { code: string }).code).toBe('QUEUE_KIND_MISMATCH');
    }
  });

  it('reuses existing Queue instance (singleton)', () => {
    const q1 = getQueue('vici2:queue:lead-import');
    const q2 = getQueue('vici2:queue:lead-import');
    expect(q1).toBe(q2);
  });

  it('setQueueForTests allows injecting a mock', () => {
    const mock = makeMockQueue('vici2:queue:lead-import') as unknown as import('bullmq').Queue;
    setQueueForTests('vici2:queue:lead-import', mock);
    expect(getQueue('vici2:queue:lead-import')).toBe(mock);
  });

  it('resolveQueueName works with short name', () => {
    const full = resolveQueueName('lead-import');
    expect(full).toBe('vici2:queue:lead-import');
  });

  it('resolveQueueName throws for unknown short name', () => {
    expect(() => resolveQueueName('not-a-queue')).toThrow();
  });
});
