/**
 * workers/transcription/src/stream-consumer.ts
 *
 * Redis Streams consumer group n07-transcriber.
 * Subscribes to events:vici2.transcription.requested (published by R02 after
 * recording_log.lifecycle_state → 'available').
 *
 * Consent gate: prompted_declined / skipped → transcript_status='consent_blocked'; XACK.
 * Otherwise → enqueue BullMQ 'transcription' job.
 *
 * N07 PLAN §4.2 / AC-6.
 */

import type { Redis } from 'ioredis';
import type { Queue } from 'bullmq';
import type { Logger } from 'pino';
import type { TranscriptionJobData } from './jobs/transcription-job.js';

const STREAM = 'events:vici2.transcription.requested';
const GROUP = 'n07-transcriber';
const BLOCK_MS = 5_000;
const COUNT = 10;
const AUTOCLAIM_IDLE_MS = 120_000; // 2 min — claim stalled consumers

// Consent statuses that block transcription (N07 PLAN §4.2)
const CONSENT_BLOCKED_STATUSES = new Set(['prompted_declined', 'skipped']);

export interface DbClient {
   
  $executeRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface StreamConsumerDeps {
  redis: Redis;
  transcriptionQueue: Queue<TranscriptionJobData>;
  db: DbClient;
  logger: Logger;
}

export class TranscriptionStreamConsumer {
  private running = false;
  private readonly consumerId: string;

  constructor(private readonly deps: StreamConsumerDeps) {
    this.consumerId = `n07-transcriber-${process.env['HOSTNAME'] ?? 'local'}-${process.pid}`;
  }

  async start(): Promise<void> {
    await this.ensureGroup();
    this.running = true;
    this.deps.logger.info(
      { stream: STREAM, group: GROUP, consumer: this.consumerId },
      'n07 stream-consumer starting',
    );

    while (this.running) {
      // XAUTOCLAIM — recover stalled pending entries
      try {
        const claimed = await (this.deps.redis as unknown as {
          xautoclaim(
            key: string, group: string, consumer: string, minIdleTime: number, start: string,
            countOption: string, count: number,
          ): Promise<[string, Array<[string, string[]]>]>;
        }).xautoclaim(
          STREAM, GROUP, this.consumerId, AUTOCLAIM_IDLE_MS, '0-0', 'COUNT', COUNT,
        );
        const entries = claimed[1];
        if (entries && entries.length > 0) {
          await this.processEntries(entries);
        }
      } catch {
        // XAUTOCLAIM may fail on older Redis — silently continue
      }

      // XREADGROUP — consume new entries
      try {
        const result = await (this.deps.redis as unknown as {
          xreadgroup(
            groupOption: string, group: string, consumer: string,
            blockOption: string, blockMs: number,
            countOption: string, count: number,
            streamsOption: string, stream: string, id: string,
          ): Promise<Array<[string, Array<[string, string[]]>]> | null>;
        }).xreadgroup(
          'GROUP', GROUP, this.consumerId,
          'BLOCK', BLOCK_MS,
          'COUNT', COUNT,
          'STREAMS', STREAM, '>',
        );
        if (!result) continue;

        for (const [, entries] of result) {
          await this.processEntries(entries);
        }
      } catch (err) {
        if (!this.running) break;
        this.deps.logger.error({ err }, 'stream-consumer read error — retrying in 5 s');
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  private async processEntries(entries: Array<[string, string[]]>): Promise<void> {
    for (const [msgId, fields] of entries) {
      const msg = parseFields(fields);
      try {
        await this.processMessage(msgId, msg);
      } catch (err) {
        this.deps.logger.error({ msgId, msg, err }, 'stream-consumer message processing error');
        // Do not XACK — let it be reclaimed after AUTOCLAIM_IDLE_MS
      }
    }
  }

  private async processMessage(
    msgId: string,
    msg: Record<string, string>,
  ): Promise<void> {
    const recording_log_id = msg['recording_log_id'] ?? '';
    const call_uuid = msg['call_uuid'] ?? '';
    const tenant_id = msg['tenant_id'] ?? '';
    const storage_url = msg['storage_url'] ?? '';
    const consent_status = msg['consent_status'] ?? '';
    const duration_sec = msg['duration_sec'] ?? '0';

    const log = this.deps.logger.child({ msgId, recording_log_id, call_uuid, tenant_id });

    log.debug('n07 stream message received');

    // Consent gate (N07 PLAN §4.2 / AC-6)
    if (CONSENT_BLOCKED_STATUSES.has(consent_status)) {
      log.info({ consent_status }, 'consent blocked — setting transcript_status=consent_blocked');

      await this.deps.db.$executeRaw`
        UPDATE recording_log
        SET transcript_status = 'consent_blocked',
            updated_at = NOW()
        WHERE id = ${BigInt(recording_log_id)}
          AND transcript_status = 'pending'
      `;

      await this.deps.redis.xack(STREAM, GROUP, msgId);
      return;
    }

    // Enqueue BullMQ transcription job
    const jobData: TranscriptionJobData = {
      recordingLogId: recording_log_id,
      callUuid: call_uuid,
      tenantId: tenant_id,
      storageUrl: storage_url,
      consentStatus: consent_status,
      durationSec: Number(duration_sec),
    };

    await this.deps.transcriptionQueue.add('transcription', jobData, {
      jobId: recording_log_id, // BullMQ deduplicates by jobId (AC-idempotency)
      attempts: 6,
      backoff: { type: 'exponential', delay: 60_000 },
      removeOnComplete: 50,
      removeOnFail: 500,
    });

    // Mark queued in DB
    await this.deps.db.$executeRaw`
      UPDATE recording_log
      SET transcript_status = 'queued',
          updated_at = NOW()
      WHERE id = ${BigInt(recording_log_id)}
        AND transcript_status = 'pending'
    `;

    log.info('n07 transcription job enqueued');
    await this.deps.redis.xack(STREAM, GROUP, msgId);
  }

  private async ensureGroup(): Promise<void> {
    try {
      await this.deps.redis.xgroup('CREATE', STREAM, GROUP, '$', 'MKSTREAM');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('BUSYGROUP')) throw err;
      // Group already exists — OK
    }
  }
}

function parseFields(fields: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < fields.length - 1; i += 2) {
    const key = fields[i];
    const val = fields[i + 1];
    if (key !== undefined && val !== undefined) {
      result[key] = val;
    }
  }
  return result;
}
