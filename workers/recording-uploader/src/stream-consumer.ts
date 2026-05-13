/**
 * workers/recording-uploader/src/stream-consumer.ts
 *
 * Redis Streams consumer group r02-uploader.
 * Subscribes to events:vici2.recording.stopped and routes to BullMQ queues.
 * R02 PLAN §7.2.
 */

import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';

import type { UploadJobData } from './jobs/recording-upload.js';
import type { DeleteLocalJobData } from './jobs/recording-delete-local.js';

const STREAM = 'events:vici2.recording.stopped';
const GROUP = 'r02-uploader';
const BLOCK_MS = 5_000;
const COUNT = 10;
const AUTOCLAIM_IDLE_MS = 60_000;

// Consent statuses that trigger local-delete (no upload)
const NO_UPLOAD_STATUSES = new Set(['prompted_declined', 'skipped']);

export interface StreamConsumerDeps {
  redis: Redis;
  uploadQueue: Queue<UploadJobData>;
  deleteLocalQueue: Queue<DeleteLocalJobData>;
  logger: Logger;
  gracePeriodMs: number; // consent_declined_grace_minutes * 60 * 1000
}

export class StreamConsumer {
  private running = false;
  private readonly consumerId: string;

  constructor(private readonly deps: StreamConsumerDeps) {
    this.consumerId = `r02-uploader-${process.env['HOSTNAME'] ?? 'local'}-${process.pid}`;
  }

  async start(): Promise<void> {
    await this.ensureGroup();
    this.running = true;
    this.deps.logger.info({ stream: STREAM, group: GROUP, consumer: this.consumerId }, 'stream-consumer starting');

    // XAUTOCLAIM loop runs interleaved with XREADGROUP
    let autoclaimed = 0;

    while (this.running) {
      // Claim idle entries from other consumers (crash recovery)
      if (autoclaimed % 10 === 0) {
        await this.autoClaim();
      }
      autoclaimed++;

      await this.readOnce();
    }
  }

  stop(): void {
    this.running = false;
  }

  private async ensureGroup(): Promise<void> {
    try {
      await (this.deps.redis as unknown as { xgroup: (...a: string[]) => Promise<unknown> }).xgroup(
        'CREATE', STREAM, GROUP, '$', 'MKSTREAM',
      );
    } catch (err: unknown) {
      // BUSYGROUP = group already exists
      if (!String(err).includes('BUSYGROUP')) {
        this.deps.logger.warn({ err }, 'stream-consumer: xgroup CREATE error (non-fatal if BUSYGROUP)');
      }
    }
  }

  private async autoClaim(): Promise<void> {
    try {
      // XAUTOCLAIM stream group consumer min-idle-time start [COUNT count]
      const result = await (this.deps.redis as unknown as {
        xautoclaim: (...a: (string | number)[]) => Promise<[string, [string, string[]][]]>;
      }).xautoclaim(
        STREAM, GROUP, this.consumerId, AUTOCLAIM_IDLE_MS, '0-0', 'COUNT', COUNT,
      );
      const entries: [string, string[]][] = result[1] ?? [];
      if (entries.length > 0) {
        this.deps.logger.info({ count: entries.length }, 'stream-consumer: autoclaimed idle entries');
        for (const [id, rawFields] of entries) {
          await this.processEntry(id, rawFields);
        }
      }
    } catch {
      // XAUTOCLAIM not available in older Redis versions — silent fail
    }
  }

  private async readOnce(): Promise<void> {
    try {
      const results = await this.deps.redis.xreadgroup(
        'GROUP', GROUP, this.consumerId,
        'COUNT', COUNT,
        'BLOCK', BLOCK_MS,
        'STREAMS', STREAM,
        '>',
      );
      if (!results) return;
      for (const [, entries] of results as [string, [string, string[]][]][]) {
        for (const [id, rawFields] of entries) {
          await this.processEntry(id, rawFields);
        }
      }
    } catch (err: unknown) {
      this.deps.logger.error({ err }, 'stream-consumer: readgroup error; retrying');
      await sleep(1_000);
    }
  }

  private async processEntry(id: string, rawFields: string[]): Promise<void> {
    const payload = parseFields(rawFields);
    const log = this.deps.logger.child({ stream_id: id, uuid: payload.uuid });

    try {
      const noUpload = NO_UPLOAD_STATUSES.has(payload.consent_status ?? '');

      if (noUpload) {
        log.info({ consent_status: payload.consent_status }, 'routing to recording-delete-local');
        await this.deps.deleteLocalQueue.add(
          'recording-delete-local',
          {
            recordingLogId: String(payload.recording_log_id ?? 0),
            tenantId: String(payload.tenant_id),
            startTime: payload.started_at ?? new Date().toISOString(),
            filename: payload.filename,
            reason: payload.consent_status ?? 'unknown',
          },
          {
            delay: this.deps.gracePeriodMs,
            attempts: 5,
            backoff: { type: 'exponential', delay: 10_000 },
            removeOnComplete: 50,
            removeOnFail: 200,
          },
        );
      } else {
        log.info('routing to recording-upload');
        await this.deps.uploadQueue.add(
          'recording-upload',
          {
            recordingLogId: String(payload.recording_log_id ?? 0),
            tenantId: String(payload.tenant_id),
            startTime: payload.started_at ?? new Date().toISOString(),
          },
          {
            jobId: String(payload.recording_log_id ?? `${payload.uuid}-${Date.now()}`),
            attempts: 8,
            backoff: { type: 'exponential', delay: 30_000 },
            removeOnComplete: 100,
            removeOnFail: 1000,
          },
        );
      }

      await this.deps.redis.xack(STREAM, GROUP, id);
      log.debug({ stream_id: id }, 'stream-consumer: entry ACKed');
    } catch (err: unknown) {
      log.error({ err, stream_id: id }, 'stream-consumer: failed to route entry; will be re-delivered by XAUTOCLAIM');
      // Do NOT XACK — let XAUTOCLAIM re-deliver after idle timeout
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StoppedEvent {
  event_id?: string;
  uuid: string;
  tenant_id: number;
  recording_log_id?: number;
  campaign_id?: string;
  lead_id?: number;
  user_id?: number;
  filename: string;
  duration_ms?: number;
  started_at?: string;
  consent_status?: string;
}

function parseFields(rawFields: string[]): StoppedEvent {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < rawFields.length; i += 2) {
    map[rawFields[i]!] = rawFields[i + 1]!;
  }
  if (map['payload']) {
    return JSON.parse(map['payload']) as StoppedEvent;
  }
  return {
    uuid: map['uuid'] ?? '',
    tenant_id: Number(map['tenant_id'] ?? 1),
    recording_log_id: map['recording_log_id'] ? Number(map['recording_log_id']) : undefined,
    filename: map['filename'] ?? '',
    duration_ms: map['duration_ms'] ? Number(map['duration_ms']) : undefined,
    started_at: map['started_at'],
    consent_status: map['consent_status'],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
