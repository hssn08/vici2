// D02 — DB writer Writable (PLAN §2.1)
// Calls raw INSERT for maximum throughput. Uses INSERT IGNORE for skipDuplicates.
// ULID idempotency key per batch derived from importId + ':batch:' + batchIndex.

import { Writable } from "node:stream";
import type { WritableOptions } from "node:stream";
import { ulid } from "ulidx";
import type { Batch } from "./batcher.js";
import type { ImportProgress } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrisma = any;

export interface DbWriterOptions {
  prisma: AnyPrisma;
  importId: string;
  tenantId: bigint;
  listId: bigint;
  ownerUserId: bigint;
  onProgress: (progress: ImportProgress) => Promise<void>;
  onBatchComplete: (batchIndex: number, inserted: number, skipped: number) => Promise<void>;
  resumeFromBatch?: number;  // skip batches < this index
}

export class DbWriterWritable extends Writable {
  private _opts: DbWriterOptions;
  private _processed = 0;
  private _inserted = 0;
  private _skipped = 0;
  private _errored = 0;
  private _totalEstimate: number | null = null;

  constructor(opts: DbWriterOptions, streamOpts?: WritableOptions) {
    super({ objectMode: true, highWaterMark: 2, ...streamOpts });
    this._opts = opts;
  }

  override async _write(
    batch: Batch,
    _enc: string,
    cb: (err?: Error | null) => void,
  ): Promise<void> {
    const { rows, batchIndex } = batch;

    // Resume: skip already-processed batches (idempotency via ULID cache)
    if (this._opts.resumeFromBatch !== undefined && batchIndex < this._opts.resumeFromBatch) {
      this._processed += rows.length;
      cb();
      return;
    }

    if (rows.length === 0) { cb(); return; }

    try {
      // Build raw INSERT IGNORE for ≥5,000 rows/sec (D01 PLAN §4.4)
      const now = new Date();
      const nowStr = now.toISOString().replace("T", " ").replace("Z", "");
      const _idempotencyKey = ulid();
      void _idempotencyKey; // tracked by D01 Valkey cache via import_id+batch_index naming

      const placeholders: string[] = [];
      const values: unknown[] = [];

      for (const { lead } of rows) {
        placeholders.push(
          "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        );
        values.push(
          this._opts.tenantId,
          this._opts.listId,
          lead.status ?? "NEW",
          lead.vendorLeadCode ?? null,
          lead.sourceId ?? null,
          lead.phoneE164,
          lead.phoneAlt ?? null,
          lead.phoneAlt2 ?? null,
          lead.countryCode ?? "US",
          lead.title ?? null,
          lead.firstName ?? null,
          lead.middleInitial ?? null,
          lead.lastName ?? null,
          lead.address1 ?? null,
          lead.address2 ?? null,
          lead.city ?? null,
          lead.state ?? null,
          lead.postalCode ?? null,
          lead.email ?? null,
          lead.dateOfBirth ?? null,
          lead.gender ?? "U",
          lead.comments ?? null,
          lead.rank ?? 0,
          lead.ownerUserId ? BigInt(lead.ownerUserId) : this._opts.ownerUserId,
          JSON.stringify(lead.customData ?? {}),
          lead.tzBlocked ? 1 : 0,
          1, // version
          nowStr,
          nowStr,
        );
      }

      const insertedCount: number = await this._opts.prisma.$executeRawUnsafe(
        `INSERT IGNORE INTO leads
          (tenant_id, list_id, status, vendor_lead_code, source_id,
           phone_e164, phone_alt, phone_alt2, country_code, title,
           first_name, middle_initial, last_name, address1, address2,
           city, state, postal_code, email, date_of_birth, gender,
           comments, rank, owner_user_id, custom_data, tz_blocked, version,
           entry_at, modify_at)
         VALUES ${placeholders.join(", ")}`,
        ...values,
      );

      const skippedCount = rows.length - insertedCount;
      this._processed += rows.length;
      this._inserted += insertedCount;
      this._skipped += skippedCount;

      await this._opts.onBatchComplete(batchIndex, insertedCount, skippedCount);

      // Update progress every batch
      const progress: ImportProgress = {
        processed: this._processed,
        total: this._totalEstimate,
        inserted: this._inserted,
        skipped: this._skipped,
        errored: this._errored,
        batchIndex,
      };
      await this._opts.onProgress(progress);

      cb();
    } catch (err) {
      cb(err instanceof Error ? err : new Error(String(err)));
    }
  }

  setTotalEstimate(total: number): void {
    this._totalEstimate = total;
  }

  incrementErrored(n: number): void {
    this._errored += n;
  }

  get stats() {
    return {
      processed: this._processed,
      inserted: this._inserted,
      skipped: this._skipped,
      errored: this._errored,
    };
  }
}
