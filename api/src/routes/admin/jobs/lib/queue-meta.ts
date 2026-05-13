/**
 * W02 — Static metadata for all queues defined in W01.
 *
 * This list is FROZEN per W01 PLAN. Adding/removing queues requires a W01 RFC.
 */

export type QueueKind = 'bullmq' | 'stream' | 'tick';

export interface QueueMeta {
  name: string;         // full queue name or stream name as used in Valkey
  displayName: string;
  kind: QueueKind;
  owner: string;        // module that owns this queue
  workerPackage: string;
  dlqStreamName: string | null; // null if no DLQ
}

/** All 11 queues from W01. */
export const QUEUE_META: readonly QueueMeta[] = [
  // ----- BullMQ queues -----
  {
    name: 'vici2:queue:lead-import',
    displayName: 'Lead Import',
    kind: 'bullmq',
    owner: 'D02',
    workerPackage: '@vici2/workers',
    dlqStreamName: 'events:vici2.dlq.lead-import',
  },
  {
    name: 'vici2:queue:recording-upload',
    displayName: 'Recording Upload',
    kind: 'bullmq',
    owner: 'R01',
    workerPackage: '@vici2/workers',
    dlqStreamName: 'events:vici2.dlq.recording-upload',
  },
  {
    name: 'vici2:queue:recording-delete-local',
    displayName: 'Recording Delete Local',
    kind: 'bullmq',
    owner: 'R01',
    workerPackage: '@vici2/workers',
    dlqStreamName: 'events:vici2.dlq.recording-delete-local',
  },
  {
    name: 'vici2:queue:audit-attest',
    displayName: 'Audit Attest',
    kind: 'bullmq',
    owner: 'C03',
    workerPackage: '@vici2/workers',
    dlqStreamName: 'events:vici2.dlq.audit-attest',
  },
  {
    name: 'vici2:queue:federal-dnc-sync',
    displayName: 'Federal DNC Sync',
    kind: 'bullmq',
    owner: 'D04',
    workerPackage: '@vici2/workers',
    dlqStreamName: 'events:vici2.dlq.federal-dnc-sync',
  },
  {
    name: 'vici2:queue:state-dnc-sync',
    displayName: 'State DNC Sync',
    kind: 'bullmq',
    owner: 'D04',
    workerPackage: '@vici2/workers',
    dlqStreamName: 'events:vici2.dlq.state-dnc-sync',
  },
  // ----- Stream (XREADGROUP) queues -----
  {
    name: 'events:vici2.recording-log',
    displayName: 'Recording Log Writer',
    kind: 'stream',
    owner: 'R01',
    workerPackage: '@vici2/workers',
    dlqStreamName: 'events:vici2.dlq.recording-log-writer',
  },
  {
    name: 'events:vici2.freeswitch',
    displayName: 'FreeSWITCH Event Router',
    kind: 'stream',
    owner: 'F01',
    workerPackage: '@vici2/workers',
    dlqStreamName: 'events:vici2.dlq.freeswitch-event-router',
  },
  // ----- Tick (setInterval + advisory lock) queues -----
  {
    name: 'vici2:lock:callback-fire',
    displayName: 'Callback Fire',
    kind: 'tick',
    owner: 'CB01',
    workerPackage: '@vici2/workers',
    dlqStreamName: null,
  },
  {
    name: 'vici2:lock:callback-upcoming',
    displayName: 'Callback Upcoming',
    kind: 'tick',
    owner: 'CB01',
    workerPackage: '@vici2/workers',
    dlqStreamName: null,
  },
  {
    name: 'vici2:lock:callback-stale',
    displayName: 'Callback Stale',
    kind: 'tick',
    owner: 'CB01',
    workerPackage: '@vici2/workers',
    dlqStreamName: null,
  },
] as const;

/** BullMQ queue names only (for registry). */
export const BULLMQ_QUEUE_NAMES = QUEUE_META
  .filter((q) => q.kind === 'bullmq')
  .map((q) => q.name);

/** Map from short name (last segment after ':') to full metadata. */
const BY_SHORT: Map<string, QueueMeta> = new Map(
  QUEUE_META.map((q) => {
    const parts = q.name.split(':');
    const short = parts[parts.length - 1];
    return [short, q];
  }),
);

/** Map from full name to metadata. */
const BY_FULL: Map<string, QueueMeta> = new Map(
  QUEUE_META.map((q) => [q.name, q]),
);

export function findQueueMeta(nameOrShort: string): QueueMeta | undefined {
  return BY_FULL.get(nameOrShort) ?? BY_SHORT.get(nameOrShort);
}
