// M08 — ReportingService: compliance reporting queries.
//
// CRITICAL INVARIANT (D04 PLAN §8.2 / check-drop-rate-denominator.sh):
//   The FCC 3% drop-rate denominator is ALWAYS SUM(s.human_answered).
//   Never COUNT(*) alone. CI grep enforces this.
//
// All reads use the vici2_audit_reader access pattern (SELECT only).

import type { PrismaClient } from "@prisma/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FccDropRateRow {
  campaignId: string;
  totalCalls: number;
  humanAnswered: number; // FCC drop-rate denominator: SUM(s.human_answered)
  drops: number;
  sales: number;
  dropRatePct: number | null; // drops / NULLIF(human_answered, 0) * 100
  fromDate: string;
  toDate: string;
}

export interface FccTimelineBucket {
  date: string; // YYYY-MM-DD
  totalCalls: number;
  humanAnswered: number;
  drops: number;
  dropRatePct: number | null;
}

export interface EvidencePack {
  callUuid: string;
  originateAudit: unknown[];
  callWindowAudit: unknown[];
  consentLog: unknown[];
  auditLog: unknown[];
  dncSyncLogContext: unknown[];
}

export interface DncSyncHistoryRow {
  id: bigint;
  source: string;
  kind: string;
  outcome: string;
  added: number;
  removed: number;
  errorCount: number;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  notes: string | null;
  prevHash: string;
  rowHash: string;
}

export interface AttestationRow {
  id: bigint;
  tenantId: bigint;
  tableName: string;
  windowDate: Date;
  rowCount: bigint;
  merkleRoot: string;
  keyId: string;
  signatureB64: string;
  s3Key: string;
  computedAt: Date;
}

// ── Raw SQL row shapes ────────────────────────────────────────────────────────

interface FccRawRow {
  campaign_id: string;
  total_calls: string | number | bigint;
  // FCC drop-rate denominator: SUM(s.human_answered) — canonical per D04 PLAN §8.2
  human_answered: string | number | bigint;
  drops: string | number | bigint;
  sales: string | number | bigint;
}

interface FccTimelineRawRow {
  bucket_date: string;
  total_calls: string | number | bigint;
  human_answered: string | number | bigint;
  drops: string | number | bigint;
}

// ── ReportingService ──────────────────────────────────────────────────────────

export class ReportingService {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------------------------------------------------------------------------
  // FCC drop-rate report (rolling window, per-campaign)
  //
  // Canonical SQL per D04 PLAN §8.2.
  // drop_rate = drops / NULLIF(SUM(s.human_answered), 0) — FCC 3% threshold.
  // ---------------------------------------------------------------------------
  async getFccDropRate(
    tenantId: bigint,
    campaignId: string,
    fromDate: Date,
    toDate: Date,
  ): Promise<FccDropRateRow> {
    const days = Math.ceil(
      (toDate.getTime() - fromDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    // Canonical denominator: SUM(s.human_answered) per D04 PLAN §8.2
    const rows = await this.prisma.$queryRawUnsafe<FccRawRow[]>(
      `SELECT
           SUM(s.sale)                                    AS sales,
           SUM(s.human_answered)                          AS human_answered,
           SUM(s.human_answered AND cl.is_drop = 1)       AS drops,
           COUNT(*)                                       AS total_calls,
           cl.campaign_id
       FROM call_log cl
       JOIN statuses s
         ON s.tenant_id = cl.tenant_id
        AND s.campaign_id = '__SYS__'
        AND s.status = cl.status
       WHERE cl.tenant_id = ?
         AND cl.campaign_id = ?
         AND cl.call_started >= NOW() - INTERVAL ? DAY
       GROUP BY cl.campaign_id`,
      tenantId,
      campaignId,
      days,
    );

    const row = rows[0];
    if (!row) {
      return {
        campaignId,
        totalCalls: 0,
        humanAnswered: 0,
        drops: 0,
        sales: 0,
        dropRatePct: null,
        fromDate: fromDate.toISOString().slice(0, 10),
        toDate: toDate.toISOString().slice(0, 10),
      };
    }

    const humanAnswered = Number(row.human_answered ?? 0);
    const drops = Number(row.drops ?? 0);
    const dropRatePct = humanAnswered > 0 ? (drops / humanAnswered) * 100 : null;

    return {
      campaignId: row.campaign_id,
      totalCalls: Number(row.total_calls ?? 0),
      humanAnswered, // FCC drop-rate denominator: SUM(s.human_answered)
      drops,
      sales: Number(row.sales ?? 0),
      dropRatePct: dropRatePct !== null ? Math.round(dropRatePct * 100) / 100 : null,
      fromDate: fromDate.toISOString().slice(0, 10),
      toDate: toDate.toISOString().slice(0, 10),
    };
  }

  // ---------------------------------------------------------------------------
  // FCC drop-rate timeline (daily buckets)
  //
  // drop_rate denominator: SUM(s.human_answered) per D04 PLAN §8.2
  // ---------------------------------------------------------------------------
  async getFccTimeline(
    tenantId: bigint,
    campaignId: string,
    days: number,
  ): Promise<FccTimelineBucket[]> {
    const rows = await this.prisma.$queryRawUnsafe<FccTimelineRawRow[]>(
      `SELECT
           DATE(cl.call_started)                          AS bucket_date,
           SUM(s.human_answered)                          AS human_answered,
           SUM(s.human_answered AND cl.is_drop = 1)       AS drops,
           COUNT(*)                                       AS total_calls
       FROM call_log cl
       JOIN statuses s
         ON s.tenant_id = cl.tenant_id
        AND s.campaign_id = '__SYS__'
        AND s.status = cl.status
       WHERE cl.tenant_id = ?
         AND cl.campaign_id = ?
         AND cl.call_started >= NOW() - INTERVAL ? DAY
       GROUP BY DATE(cl.call_started)
       ORDER BY bucket_date ASC`,
      tenantId,
      campaignId,
      days,
    );

    return rows.map((r: FccTimelineRawRow) => {
      const humanAnswered = Number(r.human_answered ?? 0);
      const drops = Number(r.drops ?? 0);
      return {
        date: String(r.bucket_date).slice(0, 10),
        totalCalls: Number(r.total_calls ?? 0),
        humanAnswered,
        drops,
        dropRatePct:
          humanAnswered > 0
            ? Math.round((drops / humanAnswered) * 10000) / 100
            : null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // TCPA evidence pack: all compliance tables for a single call_uuid.
  // ---------------------------------------------------------------------------
  async getEvidencePack(tenantId: bigint, callUuid: string): Promise<EvidencePack | null> {
    // 1. originate_audit — gate decisions at originate time
    const originateAudit = await this.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM originate_audit
        WHERE call_uuid = ?
        ORDER BY originated_at ASC`,
      callUuid,
    );

    if ((originateAudit as unknown[]).length === 0) {
      return null;
    }

    // 2. call_window_audit — TCPA time-window checks
    const callWindowAudit = await this.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM call_window_audit
        WHERE tenant_id = ? AND call_uuid = ?
        ORDER BY created_at ASC`,
      tenantId,
      callUuid,
    );

    // 3. consent_log — recording consent decisions
    const consentLog = await this.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM consent_log
        WHERE tenant_id = ? AND call_uuid = ?
        ORDER BY recorded_at ASC`,
      tenantId,
      callUuid,
    );

    // 4. audit_log — disposition + compliance action rows for this call
    const auditLog = await this.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM audit_log
        WHERE tenant_id = ?
          AND (entity_id = ? OR (action LIKE 'lead.status%' AND entity_id IN (
              SELECT CAST(lead_id AS CHAR) FROM call_log WHERE uuid = ? AND tenant_id = ?
          )))
        ORDER BY created_at ASC
        LIMIT 200`,
      tenantId,
      callUuid,
      callUuid,
      tenantId,
    );

    // 5. dnc_sync_log — most recent sync run per source (contextual evidence)
    const dncSyncLogContext = await this.prisma.$queryRawUnsafe<unknown[]>(
      `SELECT * FROM dnc_sync_log
        WHERE started_at >= (NOW() - INTERVAL 7 DAY)
        ORDER BY started_at DESC
        LIMIT 20`,
    );

    return {
      callUuid,
      originateAudit,
      callWindowAudit,
      consentLog,
      auditLog,
      dncSyncLogContext,
    };
  }

  // ---------------------------------------------------------------------------
  // DNC sync history: per-tenant federal/state/internal sync runs.
  // ---------------------------------------------------------------------------
  async getDncSyncHistory(
    source: string | undefined,
    limit: number,
  ): Promise<DncSyncHistoryRow[]> {
    const rows = await this.prisma.$queryRawUnsafe<DncSyncHistoryRow[]>(
      source
        ? `SELECT id, source, kind, outcome, added, removed, error_count AS errorCount,
                  started_at AS startedAt, completed_at AS completedAt,
                  duration_ms AS durationMs, notes, prev_hash AS prevHash, row_hash AS rowHash
             FROM dnc_sync_log
            WHERE source = ?
            ORDER BY started_at DESC
            LIMIT ?`
        : `SELECT id, source, kind, outcome, added, removed, error_count AS errorCount,
                  started_at AS startedAt, completed_at AS completedAt,
                  duration_ms AS durationMs, notes, prev_hash AS prevHash, row_hash AS rowHash
             FROM dnc_sync_log
            ORDER BY started_at DESC
            LIMIT ?`,
      ...(source ? [source, limit] : [limit]),
    );

    return rows;
  }

  // ---------------------------------------------------------------------------
  // C03 attestation registry: list audit_attestation rows.
  // ---------------------------------------------------------------------------
  async getAttestations(
    tenantId: bigint,
    tableName: string | undefined,
    fromDate: Date | undefined,
    toDate: Date | undefined,
    limit: number,
  ): Promise<AttestationRow[]> {
    let sql = `SELECT id, tenant_id AS tenantId, table_name AS tableName,
                      window_date AS windowDate, row_count AS rowCount,
                      merkle_root AS merkleRoot, key_id AS keyId,
                      signature_b64 AS signatureB64, s3_key AS s3Key,
                      computed_at AS computedAt
                 FROM audit_attestation
                WHERE tenant_id = ?`;
    const params: unknown[] = [tenantId];

    if (tableName) {
      sql += " AND table_name = ?";
      params.push(tableName);
    }
    if (fromDate) {
      sql += " AND window_date >= ?";
      params.push(fromDate);
    }
    if (toDate) {
      sql += " AND window_date <= ?";
      params.push(toDate);
    }
    sql += " ORDER BY computed_at DESC LIMIT ?";
    params.push(limit);

    return this.prisma.$queryRawUnsafe<AttestationRow[]>(sql, ...params);
  }
}
