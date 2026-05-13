import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DlqWriter, dlqStream } from '../dlq-writer.js';
import type { DlqRedisClient } from '../dlq-writer.js';

function makeRedis(): { xadd: ReturnType<typeof vi.fn>; calls: string[][] } & DlqRedisClient {
  const calls: string[][] = [];
  const xadd = vi.fn(async (...args: string[]) => {
    calls.push(args);
    return '1234567890-0';
  });
  return { xadd, calls } as unknown as { xadd: ReturnType<typeof vi.fn>; calls: string[][] } & DlqRedisClient;
}

describe('DlqWriter', () => {
  let redis: ReturnType<typeof makeRedis>;
  let writer: DlqWriter;

  beforeEach(() => {
    redis = makeRedis();
    writer = new DlqWriter(redis, 10_000);
  });

  it('calls XADD with MAXLEN ~ 10000 and correct stream', async () => {
    const stream = 'events:vici2.dlq.lead-import';
    await writer.write(stream, {
      worker: 'lead-import',
      sourceQueue: 'vici2:queue:lead-import',
      sourceId: 'job-123',
      payload: { tenantId: 1 },
      error: new Error('something failed'),
      attempt: 3,
      workerId: 'host-1234',
      tenantId: 1,
    });

    expect(redis.xadd).toHaveBeenCalledOnce();
    const args: string[] = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
    expect(args[0]).toBe(stream);
    expect(args[1]).toBe('MAXLEN');
    expect(args[2]).toBe('~');
    expect(args[3]).toBe('10000');
    expect(args[4]).toBe('*');

    // Check field values
    const fields = Object.fromEntries(
      args.slice(5).reduce<[string, string][]>((pairs, val, idx, arr) => {
        if (idx % 2 === 0) pairs.push([val, arr[idx + 1] as string]);
        return pairs;
      }, []),
    );
    expect(fields['worker']).toBe('lead-import');
    expect(fields['source_queue']).toBe('vici2:queue:lead-import');
    expect(fields['source_id']).toBe('job-123');
    expect(fields['error']).toBe('something failed');
    expect(fields['attempt']).toBe('3');
    expect(fields['tenant_id']).toBe('1');
  });

  it('truncates error message at 512 chars', async () => {
    const longMsg = 'x'.repeat(600);
    await writer.write('events:vici2.dlq.test', {
      worker: 'test',
      sourceQueue: 'test-queue',
      sourceId: 'j1',
      payload: {},
      error: new Error(longMsg),
      attempt: 1,
      workerId: 'host-1',
      tenantId: 1,
    });

    const args: string[] = (redis.xadd as ReturnType<typeof vi.fn>).mock.calls[0] as string[];
    const fields = Object.fromEntries(
      args.slice(5).reduce<[string, string][]>((pairs, val, idx, arr) => {
        if (idx % 2 === 0) pairs.push([val, arr[idx + 1] as string]);
        return pairs;
      }, []),
    );
    expect(fields['error']!.length).toBe(512);
  });

  it('returns the stream entry id from XADD', async () => {
    const result = await writer.write('events:vici2.dlq.test', {
      worker: 'test',
      sourceQueue: 'test-queue',
      sourceId: 'j1',
      payload: {},
      error: new Error('err'),
      attempt: 1,
      workerId: 'host-1',
      tenantId: 1,
    });
    expect(result).toBe('1234567890-0');
  });
});

describe('dlqStream()', () => {
  it('constructs the canonical stream name', () => {
    expect(dlqStream('lead-import')).toBe('events:vici2.dlq.lead-import');
    expect(dlqStream('audit-attest')).toBe('events:vici2.dlq.audit-attest');
  });
});
