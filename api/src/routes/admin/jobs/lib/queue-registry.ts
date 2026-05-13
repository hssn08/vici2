/**
 * W02 — BullMQ Queue registry singleton.
 *
 * Creates lightweight read/write Queue instances (not Workers) for each
 * BullMQ queue. Safe to instantiate in the API process — no job consumption.
 * Reuses instances across requests via a module-level Map.
 */

import { Queue, type ConnectionOptions } from 'bullmq';
import { getRedis } from '../../../../lib/redis.js';
import { QUEUE_META, BULLMQ_QUEUE_NAMES } from './queue-meta.js';

const _registry = new Map<string, Queue>();

function getConnection(): ConnectionOptions {
  // BullMQ accepts an ioredis instance directly.
  return getRedis() as unknown as ConnectionOptions;
}

/**
 * Returns the BullMQ Queue instance for the given full queue name.
 * Creates it on first call and caches it.
 *
 * Throws 400-shaped error if the queue is not a BullMQ queue.
 */
export function getQueue(name: string): Queue {
  if (_registry.has(name)) return _registry.get(name)!;

  const meta = QUEUE_META.find((q) => q.name === name || q.name.endsWith(':' + name));
  if (!meta) {
    const err = Object.assign(new Error(`Unknown queue: ${name}`), {
      statusCode: 400,
      code: 'QUEUE_NOT_FOUND',
    });
    throw err;
  }
  if (meta.kind !== 'bullmq') {
    const err = Object.assign(
      new Error(`Queue ${name} is kind=${meta.kind}, not bullmq`),
      { statusCode: 400, code: 'QUEUE_KIND_MISMATCH' },
    );
    throw err;
  }

  const queue = new Queue(meta.name, {
    connection: getConnection(),
    prefix: '', // names already include the prefix
  });
  _registry.set(meta.name, queue);
  return queue;
}

/** Return all BullMQ Queue instances (initializing if needed). */
export function getAllQueues(): Map<string, Queue> {
  for (const name of BULLMQ_QUEUE_NAMES) {
    getQueue(name);
  }
  return _registry;
}

/** Inject a mock queue instance for tests. */
export function setQueueForTests(name: string, q: Queue | null): void {
  if (q === null) {
    _registry.delete(name);
  } else {
    _registry.set(name, q);
  }
}

/** Resolve the full BullMQ queue name from a short name or full name. */
export function resolveQueueName(nameOrShort: string): string {
  // already full?
  const direct = QUEUE_META.find((q) => q.name === nameOrShort);
  if (direct) return direct.name;
  // try by last segment
  const byShort = QUEUE_META.find(
    (q) => q.name.endsWith(':' + nameOrShort) || q.name === nameOrShort,
  );
  if (byShort) return byShort.name;
  const err = Object.assign(new Error(`Unknown queue: ${nameOrShort}`), {
    statusCode: 400,
    code: 'QUEUE_NOT_FOUND',
  });
  throw err;
}
