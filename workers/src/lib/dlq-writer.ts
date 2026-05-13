/**
 * workers/src/lib/dlq-writer.ts
 *
 * DlqWriter — writes dead-letter entries to per-worker Valkey streams.
 *
 * Stream naming (FROZEN): events:vici2.dlq.{worker}
 * Entry schema (FROZEN): see PLAN §5.2
 * Retention: MAXLEN ~ 10000 (approximate, avoids locking on every XADD)
 */

export interface DlqEntry {
  worker: string;
  sourceQueue: string;
  sourceId: string;
  payload: unknown;
  error: Error;
  attempt: number;
  workerId: string;
  tenantId: string | number | bigint;
}

/** Minimal Redis interface needed by DlqWriter (compatible with ioredis). */
export interface DlqRedisClient {
  xadd(
    stream: string,
    ...args: string[]
  ): Promise<string | null>;
}

export class DlqWriter {
  constructor(
    private readonly redis: DlqRedisClient,
    private readonly maxLen: number = 10_000,
  ) {}

  async write(stream: string, entry: DlqEntry): Promise<string | null> {
    return this.redis.xadd(
      stream,
      'MAXLEN',
      '~',
      String(this.maxLen),
      '*',
      'worker',       entry.worker,
      'source_queue', entry.sourceQueue,
      'source_id',    entry.sourceId,
      'payload',      JSON.stringify(entry.payload),
      'error',        entry.error.message.slice(0, 512),
      'error_stack',  entry.error.stack?.slice(0, 1_024) ?? '',
      'attempt',      String(entry.attempt),
      'worker_id',    entry.workerId,
      'tenant_id',    String(entry.tenantId),
      'ts',           String(Date.now()),
    );
  }
}

/** Canonical DLQ stream name for a given worker (FROZEN). */
export const dlqStream = (worker: string): string =>
  `events:vici2.dlq.${worker}`;
