import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ShutdownManager } from '../shutdown.js';
import type { Logger } from 'pino';

const noop = () => {};
const makeLogger = (): Logger =>
  ({
    info: noop,
    warn: noop,
    error: noop,
    child: () => makeLogger(),
  }) as unknown as Logger;

describe('ShutdownManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('closes resources in reverse registration order', async () => {
    const order: string[] = [];
    const sm = new ShutdownManager();
    sm.register({ name: 'a', close: async () => { order.push('a'); } });
    sm.register({ name: 'b', close: async () => { order.push('b'); } });
    sm.register({ name: 'c', close: async () => { order.push('c'); } });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await sm.shutdown('SIGTERM', makeLogger());

    expect(order).toEqual(['c', 'b', 'a']);
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('force-closes a resource that exceeds its timeout', async () => {
    const sm = new ShutdownManager();
    let slowResolved = false;

    sm.register({
      name: 'slow',
      timeoutMs: 100,
      close: () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            slowResolved = true;
            resolve();
          }, 500);
        }),
    });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const shutdownPromise = sm.shutdown('SIGTERM', makeLogger());

    // Advance past the resource timeout
    await vi.advanceTimersByTimeAsync(200);
    await shutdownPromise;

    expect(slowResolved).toBe(false); // was force-closed before it could resolve
    expect(exitSpy).toHaveBeenCalledWith(0);
    exitSpy.mockRestore();
  });

  it('is idempotent (double shutdown calls exit(0) immediately)', async () => {
    const sm = new ShutdownManager();
    const closed: string[] = [];
    sm.register({ name: 'r', close: async () => { closed.push('r'); } });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await sm.shutdown('SIGTERM', makeLogger());
    await sm.shutdown('SIGTERM', makeLogger());

    // Resource should only have been closed once
    expect(closed).toHaveLength(1);
    expect(exitSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    exitSpy.mockRestore();
  });

  it('reports isShuttingDown after first shutdown call', async () => {
    const sm = new ShutdownManager();
    expect(sm.isShuttingDown).toBe(false);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const p = sm.shutdown('SIGTERM', makeLogger());
    expect(sm.isShuttingDown).toBe(true);
    await p;
    exitSpy.mockRestore();
  });
});
