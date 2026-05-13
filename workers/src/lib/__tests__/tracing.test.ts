import { describe, it, expect, vi } from 'vitest';
import type { Job } from 'bullmq';
import {
  extractTraceparent,
  extractTraceContext,
  propagateTraceparent,
  logJobStart,
} from '../tracing.js';

function makeJob(tracecontext?: Record<string, string>): Job {
  return {
    id: 'test-job-id',
    attemptsMade: 0,
    data: { tenantId: 1 },
    opts: tracecontext ? { tracecontext } : {},
  } as unknown as Job;
}

describe('extractTraceparent()', () => {
  it('returns undefined when tracecontext is missing', () => {
    expect(extractTraceparent(makeJob())).toBeUndefined();
  });

  it('returns undefined when traceparent is not set', () => {
    expect(extractTraceparent(makeJob({ tracestate: 'foo=bar' }))).toBeUndefined();
  });

  it('returns the traceparent when present', () => {
    const tp = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    expect(extractTraceparent(makeJob({ traceparent: tp }))).toBe(tp);
  });
});

describe('extractTraceContext()', () => {
  it('returns both traceparent and tracestate', () => {
    const tp = '00-aabbcc-ddeeff-01';
    const ts = 'foo=bar';
    const ctx = extractTraceContext(makeJob({ traceparent: tp, tracestate: ts }));
    expect(ctx.traceparent).toBe(tp);
    expect(ctx.tracestate).toBe(ts);
  });
});

describe('propagateTraceparent()', () => {
  it('sets traceparent header when present', () => {
    const tp = '00-aabbcc-ddeeff-01';
    const job = makeJob({ traceparent: tp });
    const headers = propagateTraceparent(job, { Authorization: 'Bearer token' });
    expect(headers.traceparent).toBe(tp);
    expect(headers.Authorization).toBe('Bearer token');
  });

  it('omits traceparent header when missing', () => {
    const headers = propagateTraceparent(makeJob());
    expect(headers.traceparent).toBeUndefined();
  });
});

describe('logJobStart()', () => {
  it('logs at INFO with jobId, queue, attempt, traceparent, tenantId', () => {
    const tp = '00-aabbcc-ddeeff-01';
    const job = makeJob({ traceparent: tp });
    const logger = { info: vi.fn() };
    logJobStart(logger as unknown as import('pino').Logger, job, 'vici2:queue:test');
    expect(logger.info).toHaveBeenCalledOnce();
    const [fields, msg] = logger.info.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.jobId).toBe('test-job-id');
    expect(fields.queue).toBe('vici2:queue:test');
    expect(fields.traceparent).toBe(tp);
    expect(msg).toContain('job started');
  });
});
