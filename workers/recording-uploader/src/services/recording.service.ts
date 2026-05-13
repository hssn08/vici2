/**
 * workers/recording-uploader/src/services/recording.service.ts
 *
 * Internal service API:
 *   getPlaybackUrl()   — pre-signed S3 URL for playback (R02 PLAN §12)
 *   setLegalHold()     — Object Lock legal hold toggle (R02 PLAN §1.1.9)
 *   verifyIntegrity()  — HEAD + SHA-256 comparison (R02 PLAN §1.1.10)
 *   isLocalFileGone()  — sweeper verification helper
 *
 * Imported by both worker jobs and api/src/routes/recordings/.
 */

import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import type { DbClient } from '../jobs/recording-upload.js';
import type { StorageBackend } from '../backends/types.js';
import * as metrics from '../metrics.js';

// ---------------------------------------------------------------------------
// AuditWriter stub — real implementation provided by C03 module.
// R02 calls AuditWriter; does NOT write to audit_log directly.
// ---------------------------------------------------------------------------

export interface AuditEntry {
  tenantId: bigint;
  action: string;
  entityType: string;
  entityId: string;
  actorKind: 'user' | 'system' | 'worker' | 'external_api';
  actorUserId?: bigint;
  afterJson?: Record<string, unknown>;
}

export interface AuditWriter {
  append(entry: AuditEntry): Promise<void>;
}

/** No-op AuditWriter for dev / test when C03 is not wired. */
export class NoopAuditWriter implements AuditWriter {
  async append(_entry: AuditEntry): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// RecordingService
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 3600;

export class RecordingService {
  constructor(
    private readonly prisma: DbClient,
    private readonly backend: StorageBackend,
    private readonly defaultBucket: string,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * Generate a pre-signed S3 URL for playback.
   * R02 PLAN §12.
   */
  async getPlaybackUrl(
    tenantId: bigint,
    recordingLogId: bigint,
    actor: { userId?: bigint; role: string },
    ttlSeconds = DEFAULT_TTL_SECONDS,
  ): Promise<string> {
    if (ttlSeconds > MAX_TTL_SECONDS) {
      throw Object.assign(
        new Error(`ttlSeconds ${ttlSeconds} exceeds maximum ${MAX_TTL_SECONDS}`),
        { code: 'TTL_EXCEEDED', status: 400 },
      );
    }

    const row = await this.loadRecordingLog(tenantId, recordingLogId);
    if (!row) throw Object.assign(new Error('recording not found'), { status: 404 });

    const url = await this.backend.getSignedUrl(
      row.bucket,
      row.key,
      ttlSeconds,
    );

    metrics.presignedUrlGeneratedTotal.inc({
      tenant_id: tenantId.toString(),
      requester_role: actor.role,
    });

    await this.audit.append({
      tenantId,
      action: 'recording.presigned_url_generated',
      entityType: 'recording_log',
      entityId: recordingLogId.toString(),
      actorKind: actor.userId ? 'user' : 'system',
      actorUserId: actor.userId,
      afterJson: { ttl_seconds: ttlSeconds, role: actor.role },
    });

    return url;
  }

  /**
   * Apply or release an Object Lock legal hold.
   * R02 PLAN §1.1.9.
   */
  async setLegalHold(
    tenantId: bigint,
    recordingLogIds: bigint[],
    on: boolean,
    actor: { userId?: bigint; role: string },
  ): Promise<void> {
    for (const id of recordingLogIds) {
      const row = await this.loadRecordingLog(tenantId, id);
      if (!row) continue;

      await this.backend.putLegalHold(row.bucket, row.key, on);

      // Update recordings.legal_hold
      await this.prisma.$executeRaw`
        UPDATE recordings
          SET legal_hold = ${on ? 1 : 0}, updated_at = NOW(6)
          WHERE recording_log_id = ${id} AND tenant_id = ${tenantId}
      `;

      if (on) {
        metrics.legalHoldAppliedTotal.inc({ tenant_id: tenantId.toString() });
      }

      await this.audit.append({
        tenantId,
        action: on ? 'recording.legal_hold_applied' : 'recording.legal_hold_released',
        entityType: 'recording_log',
        entityId: id.toString(),
        actorKind: actor.userId ? 'user' : 'system',
        actorUserId: actor.userId,
        afterJson: { legal_hold: on },
      });
    }
  }

  /**
   * Verify S3 integrity: HEAD + SHA-256 match + Object Lock state.
   * R02 PLAN §1.1.10.
   */
  async verifyIntegrity(recordingLogId: bigint): Promise<{
    ok: boolean;
    localSha: string;
    remoteSha: string;
    retainUntilDate: Date | undefined;
    legalHold: boolean;
  }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT tenant_id, storage_url, sha256
      FROM recording_log
      WHERE id = ${recordingLogId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || !row.storage_url) {
      return { ok: false, localSha: '', remoteSha: '', retainUntilDate: undefined, legalHold: false };
    }

    const { bucket, key } = parseStorageUrl(row.storage_url as string, this.defaultBucket);
    const head = await this.backend.headObject(bucket, key);

    const sha256Raw: Buffer | null = row.sha256 ?? null;
    const localSha = sha256Raw ? sha256Raw.toString('hex') : '';
    const remoteSha = head?.clientSha256 ?? head?.checksumSha256 ?? '';
    const ok = !!localSha && !!remoteSha && localSha === remoteSha;

    return {
      ok,
      localSha,
      remoteSha,
      retainUntilDate: head?.objectLockRetainUntilDate,
      legalHold: head?.legalHold ?? false,
    };
  }

  /**
   * Check whether the local recording file has been swept.
   * R02 PLAN §1.1.11.
   */
  async isLocalFileGone(recordingLogId: bigint): Promise<boolean> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT filename FROM recording_log WHERE id = ${recordingLogId} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return true;
    try {
      await access(row.filename as string, fsConstants.F_OK);
      return false; // file exists
    } catch {
      return true; // ENOENT or permission denied → treat as gone
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async loadRecordingLog(
    tenantId: bigint,
    recordingLogId: bigint,
  ): Promise<{ bucket: string; key: string } | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await this.prisma.$queryRaw`
      SELECT storage_url
      FROM recording_log
      WHERE id = ${recordingLogId} AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row?.storage_url) return null;
    return parseStorageUrl(row.storage_url, this.defaultBucket);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function parseStorageUrl(
  storageUrl: string,
  defaultBucket: string,
): { bucket: string; key: string } {
  // Format: s3://<bucket>/<key>
  const match = storageUrl.match(/^s3:\/\/([^/]+)\/(.+)$/);
  if (match) return { bucket: match[1]!, key: match[2]! };
  // Fallback: treat as bare key
  return { bucket: defaultBucket, key: storageUrl };
}
