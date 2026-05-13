import { describe, it, expect, vi, afterEach } from 'vitest';
import client from 'prom-client';
import {
  startMetricsPoller,
  instrumentWorker,
  registry,
} from '../metrics.js';
import type { Queue, Worker } from 'bullmq';
import type { MetricsRedisClient } from '../metrics.js';

describe('registry', () => {
  it('is a prom-client Registry', () => {
    expect(registry).toBeInstanceOf(client.Registry);
  });

  it('has vici2_bullmq_jobs_active metric registered', async () => {
    const metrics = await registry.metrics();
    expect(metrics).toContain('vici2_bullmq_jobs_active');
  });
});

describe('startMetricsPoller()', () => {
  let stopPoller: (() => void) | undefined;

  afterEach(() => {
    stopPoller?.();
    vi.useRealTimers();
  });

  it('polls queue counts and sets gauges', async () => {
    vi.useFakeTimers();

    const mockQueue = {
      getActiveCount: vi.fn().mockResolvedValue(3),
      getWaitingCount: vi.fn().mockResolvedValue(10),
      getDelayedCount: vi.fn().mockResolvedValue(1),
      getFailedCount: vi.fn().mockResolvedValue(0),
      getCompletedCount: vi.fn().mockResolvedValue(50),
    } as unknown as Queue;

    const mockRedis: MetricsRedisClient = {
      xlen: vi.fn().mockResolvedValue(5),
    };

    const queues = new Map([['vici2:queue:test', mockQueue]]);
    const dlqStreams = new Map([['test-worker', 'events:vici2.dlq.test']]);

    stopPoller = startMetricsPoller(queues, dlqStreams, mockRedis, 1_000);

    await vi.advanceTimersByTimeAsync(1_100);

    expect(mockQueue.getActiveCount).toHaveBeenCalled();
    expect(mockQueue.getWaitingCount).toHaveBeenCalled();
    expect(mockRedis.xlen).toHaveBeenCalledWith('events:vici2.dlq.test');
  });

  it('cleanup function stops the interval', async () => {
    vi.useFakeTimers();

    const mockQueue = {
      getActiveCount: vi.fn().mockResolvedValue(0),
      getWaitingCount: vi.fn().mockResolvedValue(0),
      getDelayedCount: vi.fn().mockResolvedValue(0),
      getFailedCount: vi.fn().mockResolvedValue(0),
      getCompletedCount: vi.fn().mockResolvedValue(0),
    } as unknown as Queue;

    const mockRedis: MetricsRedisClient = { xlen: vi.fn().mockResolvedValue(0) };

    const queues = new Map([['q', mockQueue]]);
    const stop = startMetricsPoller(queues, new Map(), mockRedis, 1_000);

    await vi.advanceTimersByTimeAsync(1_100);
    const callsBefore = (mockQueue.getActiveCount as ReturnType<typeof vi.fn>).mock.calls.length;

    stop();
    await vi.advanceTimersByTimeAsync(2_000);

    const callsAfter = (mockQueue.getActiveCount as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callsAfter).toBe(callsBefore); // no new calls after stop
  });
});

describe('instrumentWorker()', () => {
  it('registers completed and failed listeners on the worker', () => {
    const listeners: Record<string, (...args: unknown[]) => unknown> = {};
    const mockWorker = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => { listeners[event] = handler; },
    } as unknown as Worker;

    instrumentWorker(mockWorker, 'vici2:queue:test');

    expect(typeof listeners['completed']).toBe('function');
    expect(typeof listeners['failed']).toBe('function');
  });

  it('records job duration on completed event', () => {
    const listeners: Record<string, (...args: unknown[]) => unknown> = {};
    const mockWorker = {
      on: (event: string, handler: (...args: unknown[]) => unknown) => { listeners[event] = handler; },
    } as unknown as Worker;

    instrumentWorker(mockWorker, 'vici2:queue:test');

    const mockJob = {
      processedOn: 1000,
      finishedOn: 2000,
      timestamp: 500,
      attemptsMade: 1,
      opts: { attempts: 3 },
    };

    // Should not throw
    expect(() => listeners['completed']!(mockJob)).not.toThrow();
  });
});
