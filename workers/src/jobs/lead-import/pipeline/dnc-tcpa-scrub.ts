// D02 Stage 6 — DNC + TCPA scrub Transform (PLAN §9)
// DNC: BF.MEXISTS pipeline per 100 phones → MySQL confirm on positives.
// TZ: D03 tz.Resolve confidence → tz_blocked flag.

import { Transform } from "node:stream";
import type { TransformCallback } from "node:stream";
import type { ValidRow, RowError } from "../types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRedis = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPrisma = any;

const DNC_BATCH_SIZE = 100;

type DncPolicy = "skip" | "mark" | "proceed";
type TzPolicy = "skip" | "mark" | "proceed";

export interface DncTcpaScrubOptions {
  redis: AnyRedis | null;
  prisma: AnyPrisma;
  tenantId: number;
  dncPolicy: DncPolicy;
  tzPolicy: TzPolicy;
  onRowError: (errors: RowError[]) => void;
}

interface ScrubResult {
  isDnc: boolean;
  dncSources: string[];
  tzConfidence: "KNOWN" | "ZIP" | "NXX" | "NPA" | "STATE_DEFAULT" | "CAMPAIGN_DEFAULT" | "NONE";
}

/** Check DNC via Bloom → MySQL confirm pattern. */
async function checkDnc(
  redis: AnyRedis | null,
  prisma: AnyPrisma,
  phones: string[],
  tenantId: number,
): Promise<Map<string, { isDnc: boolean; sources: string[] }>> {
  const result = new Map<string, { isDnc: boolean; sources: string[] }>();

  // Initialize all as clean
  for (const p of phones) result.set(p, { isDnc: false, sources: [] });

  if (phones.length === 0) return result;

  try {
    // Try Bloom filter first (fast path)
    let bloomPositives: string[] = phones; // fallback: check all via MySQL

    if (redis) {
      try {
        const pipeline = redis.pipeline();
        const bloomKeys = [
          "bf:dnc:federal",
          `t:${tenantId}:dnc:state:bloom`,
          `t:${tenantId}:dnc:internal:bloom`,
        ];
        for (const phone of phones) {
          for (const key of bloomKeys) {
            pipeline.call("BF.EXISTS", key, phone);
          }
        }
        const results: Array<[Error | null, number]> = await pipeline.exec();
        bloomPositives = [];
        for (let i = 0; i < phones.length; i++) {
          const baseIdx = i * bloomKeys.length;
          const anyPositive = bloomKeys.some((_, ki) => {
            const pair = results[baseIdx + ki];
            return pair && (pair[0] !== null || pair[1] === 1);
          });
          if (anyPositive) bloomPositives.push(phones[i]!);
        }
      } catch {
        // Bloom unavailable — fallback to MySQL-only check
        bloomPositives = phones;
      }
    }

    if (bloomPositives.length === 0) return result;

    // MySQL confirm for Bloom positives
    const placeholders = bloomPositives.map(() => "?").join(",");
    const rows: Array<{ phone_e164: string; source: string }> =
      await prisma.$queryRawUnsafe(
        `SELECT phone_e164, source FROM dnc
         WHERE phone_e164 IN (${placeholders})
           AND tenant_id IN (?, 0)
           AND (expires_at IS NULL OR expires_at > NOW())
         LIMIT ${bloomPositives.length * 4}`,
        ...bloomPositives,
        tenantId,
      );

    for (const row of rows) {
      const entry = result.get(row.phone_e164);
      if (entry) {
        entry.isDnc = true;
        if (!entry.sources.includes(row.source)) entry.sources.push(row.source);
      }
    }
  } catch {
    // MySQL unavailable after Bloom — abort signal propagated up
    throw new Error("DB_TRANSIENT: DNC MySQL check failed");
  }

  return result;
}

/** Simple TZ confidence from phone NPA/NXX lookup (placeholder for D03 integration). */
async function resolveTimezone(
  prisma: AnyPrisma,
  phone: string,
  state?: string,
): Promise<{ confidence: ScrubResult["tzConfidence"]; iana?: string }> {
  // Extract NPA (area code) and NXX (exchange) from E.164
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 10) return { confidence: "NONE" };

  const npa = digits.slice(-10, -7);
  const nxx = digits.slice(-7, -4);

  try {
    const rows: Array<{ tz_iana: string; confidence: string }> =
      await prisma.$queryRawUnsafe(
        `SELECT tz_iana, confidence FROM phone_codes
         WHERE area_code = ? AND exchange_code = ?
         LIMIT 1`,
        npa, nxx,
      );

    if (rows.length > 0) {
      const row = rows[0]!;
      return {
        confidence: row.confidence === "NXX" ? "NXX" : "NPA",
        iana: row.tz_iana,
      };
    }

    // Fall back to state-level default
    if (state) {
      const stateRows: Array<{ tz_iana: string }> =
        await prisma.$queryRawUnsafe(
          `SELECT tz_iana FROM phone_codes
           WHERE state = ? AND confidence = 'NPA'
           LIMIT 1`,
          state,
        );
      if (stateRows.length > 0) {
        return { confidence: "STATE_DEFAULT", iana: stateRows[0]!.tz_iana };
      }
    }
  } catch {
    // TZ lookup failed — treat as NONE (not fatal)
  }

  return { confidence: "NONE" };
}

export class DncTcpaScrubTransform extends Transform {
  private _opts: DncTcpaScrubOptions;
  private _buffer: ValidRow[] = [];

  constructor(opts: DncTcpaScrubOptions) {
    super({ objectMode: true, highWaterMark: 16 });
    this._opts = opts;
  }

  override _transform(row: ValidRow, _enc: string, cb: TransformCallback): void {
    this._buffer.push(row);
    if (this._buffer.length >= DNC_BATCH_SIZE) {
      this._flushBuffer().then(() => cb()).catch((err) => this.emit("error", err));
    } else {
      cb();
    }
  }

  override _flush(cb: TransformCallback): void {
    this._flushBuffer().then(() => cb()).catch((err) => { this.emit("error", err); cb(); });
  }

  private async _flushBuffer(): Promise<void> {
    const batch = this._buffer.splice(0);
    if (batch.length === 0) return;

    const phones = batch.map((r) => r.lead.phoneE164);
    let dncResults: Map<string, { isDnc: boolean; sources: string[] }>;

    try {
      dncResults = await checkDnc(this._opts.redis, this._opts.prisma, phones, this._opts.tenantId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("DB_TRANSIENT")) {
        // Abort — propagate error
        this.emit("error", err);
        return;
      }
      // Unknown error — treat as clean (fail-open on unknown; DNC fail-closed is Bloom only)
      dncResults = new Map(phones.map((p) => [p, { isDnc: false, sources: [] }]));
    }

    for (const row of batch) {
      const dncResult = dncResults.get(row.lead.phoneE164) ?? { isDnc: false, sources: [] };

      // DNC policy
      if (dncResult.isDnc) {
        if (this._opts.dncPolicy === "skip") {
          const err: RowError = {
            code: "DNC_BLOCKED",
            message: `${dncResult.sources.join(", ")} DNC`,
            sourceLine: row.info.lines,
            sourceRecord: row.info.records,
            rawRecord: row.rawRecord,
          };
          this._opts.onRowError([err]);
          continue;
        } else if (this._opts.dncPolicy === "mark") {
          row.lead.dncBlocked = true;
          row.lead.status = "DNC";
          const warn: RowError = {
            code: "DNC_WARN",
            message: `DNC match (mark mode): ${dncResult.sources.join(", ")}`,
            sourceLine: row.info.lines,
            sourceRecord: row.info.records,
            rawRecord: row.rawRecord,
          };
          this._opts.onRowError([warn]);
        }
        // proceed mode: include normally, note in errors.csv as DNC_WARN
        else {
          const warn: RowError = {
            code: "DNC_WARN",
            message: `DNC match (proceed mode): ${dncResult.sources.join(", ")}`,
            sourceLine: row.info.lines,
            sourceRecord: row.info.records,
            rawRecord: row.rawRecord,
          };
          this._opts.onRowError([warn]);
        }
      }

      // TZ policy
      const tzResult = await resolveTimezone(this._opts.prisma, row.lead.phoneE164, row.lead.state);

      if (tzResult.confidence === "NONE") {
        if (this._opts.tzPolicy === "skip") {
          const err: RowError = {
            code: "NO_TIMEZONE",
            message: "D03 returned NONE confidence; tz_policy=skip",
            sourceLine: row.info.lines,
            sourceRecord: row.info.records,
            rawRecord: row.rawRecord,
          };
          this._opts.onRowError([err]);
          continue;
        } else if (this._opts.tzPolicy === "mark") {
          row.lead.tzBlocked = true;
          const warn: RowError = {
            code: "TZ_BLOCKED_WARN",
            message: "No timezone resolved; tz_blocked=true",
            sourceLine: row.info.lines,
            sourceRecord: row.info.records,
            rawRecord: row.rawRecord,
          };
          this._opts.onRowError([warn]);
        }
        // proceed: include normally
      }

      this.push(row);
    }
  }
}
