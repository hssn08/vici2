/**
 * workers/src/jobs/recording-log-writer/index.ts
 *
 * R01 recording stream consumer — T01 PLAN §17.4 + R01 PLAN §8.
 *
 * Subscribes to two Valkey streams:
 *   - events:vici2.recording.started   (optional INSERT placeholder — skipped Phase 1)
 *   - events:vici2.recording.stopped   (CRITICAL: writes recording_log row + triggers R02)
 *
 * On RECORD_STOP:
 *   1. Parse the T01-enriched event payload.
 *   2. stat() the file to get byte_size (FS emits Record-Ms, not bytes).
 *   3. INSERT into recording_log (idempotent via ON DUPLICATE KEY UPDATE ignored).
 *   4. Delete the Valkey HASH (t:{tid}:recording:{uuid}) — state cleanup.
 *   5. XACK the stream entry.
 *
 * Failure path: if stat() or DB INSERT fails after N retries → XADD to
 * events:vici2.dlq.recording (dead-letter queue) and XACK the original.
 *
 * Phase 1: single-tenant; tenant_id always 1.
 */

import type { Logger } from 'pino';
import { statFile } from './handlers.js';

// --------------------------------------------------------------------------
// Minimal interface contracts (real implementations injected by the runner)
// --------------------------------------------------------------------------

/** Minimal Redis/Valkey client subset used by this worker. */
export interface RedisClient {
  xreadgroup(
    args: [
      'GROUP', string, string,
      'COUNT', number,
      'BLOCK', number,
      'STREAMS', string,
      string,
    ],
  ): Promise<[string, [string, string[]][]][] | null>;
  xack(stream: string, group: string, id: string): Promise<number>;
  xadd(stream: string, id: string, ...fieldValues: string[]): Promise<string | null>;
  hdel(key: string, ...fields: string[]): Promise<number>;
  del(key: string): Promise<number>;
}

/** Minimal DB client for raw SQL (same shape as audit-attest worker). */
export interface DbClient {
  queryRaw<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
}

// --------------------------------------------------------------------------
// Stream event payload (T01 enriched RECORD_STOP event, R01 PLAN §8.1)
// --------------------------------------------------------------------------

export interface RecordingStoppedEvent {
  event_id: string;
  uuid: string;
  tenant_id: number;
  campaign_id: string;
  lead_id: number;
  user_id: number;
  filename: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  started_at_ns: number;
  ended_at_ns: number;
  fs_host: string;
  consent_status?: string;
  lifecycle_state?: string;
  failure_reason?: string;
}

// --------------------------------------------------------------------------
// Stream / group names (R01 PLAN §8.1, T01 PLAN §17.4)
// --------------------------------------------------------------------------

export const STREAM_STOPPED = 'events:vici2.recording.stopped';
export const STREAM_DLQ = 'events:vici2.dlq.recording';
export const CONSUMER_GROUP = 'recording-log-writer';
export const CONSUMER_NAME = 'recording-log-writer-0';

/** Maximum retries before dead-lettering. */
const MAX_RETRIES = 5;
/** Block timeout for XREADGROUP (ms). */
const BLOCK_MS = 5_000;

// --------------------------------------------------------------------------
// Recording-log writer class
// --------------------------------------------------------------------------

export class RecordingLogWriter {
  private readonly redis: RedisClient;
  private readonly db: DbClient;
  private readonly logger: Logger;
  private running = false;

  constructor(redis: RedisClient, db: DbClient, logger: Logger) {
    this.redis = redis;
    this.db = db;
    this.logger = logger;
  }

  /** Start the consume loop. Call stop() to halt. */
  async start(): Promise<void> {
    this.running = true;
    this.logger.info({ stream: STREAM_STOPPED, group: CONSUMER_GROUP }, 'recording-log-writer starting');

    while (this.running) {
      try {
        const results = await this.redis.xreadgroup([
          'GROUP', CONSUMER_GROUP, CONSUMER_NAME,
          'COUNT', 10,
          'BLOCK', BLOCK_MS,
          'STREAMS', STREAM_STOPPED,
          '>',
        ]);
        if (!results) continue;

        for (const [, entries] of results) {
          for (const [id, rawFields] of entries) {
            await this.processEntry(id, rawFields);
          }
        }
      } catch (err) {
        this.logger.error({ err }, 'recording-log-writer: stream read error; retrying');
        // Brief pause to avoid tight-loop on persistent errors.
        await new Promise((r) => setTimeout(r, 1_000));
      }
    }
  }

  stop(): void {
    this.running = false;
  }

  // ------------------------------------------------------------------------

  private async processEntry(id: string, rawFields: string[]): Promise<void> {
    const payload = parseFields(rawFields);
    const log = this.logger.child({ stream_id: id, uuid: payload.uuid });

    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await this.writeRecordingLog(payload);
        await this.cleanupValkeyHash(payload.tenant_id, payload.uuid);
        await this.redis.xack(STREAM_STOPPED, CONSUMER_GROUP, id);
        log.info({ attempt }, 'recording-log-writer: recording_log row written');
        return;
      } catch (err) {
        lastErr = err;
        log.warn({ err, attempt }, 'recording-log-writer: attempt failed; retrying');
        await new Promise((r) => setTimeout(r, attempt * 500));
      }
    }

    // Dead-letter after MAX_RETRIES.
    log.error({ err: lastErr }, 'recording-log-writer: max retries exceeded; dead-lettering');
    try {
      await this.redis.xadd(
        STREAM_DLQ, '*',
        'source_stream', STREAM_STOPPED,
        'source_id', id,
        'payload', JSON.stringify(payload),
        'error', String(lastErr),
        'ts', Date.now().toString(),
      );
    } catch (dlqErr) {
      log.error({ dlqErr }, 'recording-log-writer: failed to write to DLQ');
    }
    await this.redis.xack(STREAM_STOPPED, CONSUMER_GROUP, id);
  }

  private async writeRecordingLog(ev: RecordingStoppedEvent): Promise<void> {
    // stat() the file for byte_size (T01 stream event does not carry bytes).
    let byteSize: number | null = null;
    try {
      byteSize = await statFile(ev.filename);
    } catch (err) {
      this.logger.warn({ err, filename: ev.filename }, 'recording-log-writer: stat failed; byte_size will be null');
    }

    const startedAt = nsToMysqlDatetime(ev.started_at_ns);
    const endedAt = nsToMysqlDatetime(ev.ended_at_ns);
    const durationSec = Math.round(ev.duration_ms / 1000);
    const consentStatus = ev.consent_status ?? 'not_required';
    const lifecycleState = ev.lifecycle_state ?? 'recording_complete';
    const failureReason = ev.failure_reason ?? null;
    // Derive codec descriptor from stream metadata.
    const codec = deriveCodec(ev.sample_rate, ev.channels);

    // Idempotent INSERT — ON DUPLICATE KEY UPDATE is a no-op because the
    // unique key is (uuid, start_time) and we never change an existing row.
    // recording_log is partitioned; start_time must be in the INSERT VALUES.
    await this.db.queryRaw(
      `INSERT INTO recording_log
         (tenant_id, uuid, campaign_id, lead_id, user_id,
          filename, byte_size, duration_sec, start_time,
          consent_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(6), NOW(6))
       ON DUPLICATE KEY UPDATE updated_at = updated_at`,
      ev.tenant_id,
      ev.uuid,
      ev.campaign_id,
      ev.lead_id || null,
      ev.user_id || null,
      ev.filename,
      byteSize,
      durationSec,
      startedAt,
      consentStatus,
    );

    this.logger.debug({
      uuid: ev.uuid,
      filename: ev.filename,
      duration_sec: durationSec,
      byte_size: byteSize,
      lifecycle_state: lifecycleState,
      failure_reason: failureReason,
      codec,
    }, 'recording-log-writer: recording_log INSERT');
  }

  private async cleanupValkeyHash(tenantId: number, callUUID: string): Promise<void> {
    const key = `t:${tenantId}:recording:${callUUID}`;
    try {
      await this.redis.del(key);
    } catch (err) {
      // Non-fatal: Valkey cleanup failure doesn't block DB write success.
      this.logger.warn({ err, key }, 'recording-log-writer: failed to delete Valkey hash');
    }
  }
}

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Parse flat key/value string array from XREADGROUP into a typed object. */
function parseFields(rawFields: string[]): RecordingStoppedEvent {
  const map: Record<string, string> = {};
  for (let i = 0; i + 1 < rawFields.length; i += 2) {
    map[rawFields[i]!] = rawFields[i + 1]!;
  }
  // Payload is stored as a JSON blob in the 'payload' field by T01 fan-out.
  if (map['payload']) {
    return JSON.parse(map['payload']) as RecordingStoppedEvent;
  }
  // Fallback: individual fields (forward-compat with T01 changes).
  return {
    event_id: map['event_id'] ?? '',
    uuid: map['uuid'] ?? '',
    tenant_id: Number(map['tenant_id'] ?? 1),
    campaign_id: map['campaign_id'] ?? '',
    lead_id: Number(map['lead_id'] ?? 0),
    user_id: Number(map['user_id'] ?? 0),
    filename: map['filename'] ?? '',
    duration_ms: Number(map['duration_ms'] ?? 0),
    sample_rate: Number(map['sample_rate'] ?? 8000),
    channels: Number(map['channels'] ?? 2),
    started_at_ns: Number(map['started_at_ns'] ?? 0),
    ended_at_ns: Number(map['ended_at_ns'] ?? 0),
    fs_host: map['fs_host'] ?? '',
    consent_status: map['consent_status'],
    lifecycle_state: map['lifecycle_state'],
    failure_reason: map['failure_reason'],
  };
}

/** Convert nanoseconds epoch to MySQL DATETIME(6) string. */
function nsToMysqlDatetime(ns: number): string {
  if (!ns || ns === 0) return new Date().toISOString().replace('T', ' ').replace('Z', '');
  const ms = ns / 1_000_000;
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '');
}

/** Derive a human-readable codec descriptor from stream metadata. */
function deriveCodec(sampleRate: number, channels: number): string {
  const ch = channels === 2 ? 'stereo' : 'mono';
  const khz = Math.round(sampleRate / 1000);
  return `wav-pcm-s16le-${ch}-${khz}khz`;
}
