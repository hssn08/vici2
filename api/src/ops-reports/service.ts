// M03 — OpsReportService: campaign daily performance, agent productivity, list health.
//
// CRITICAL INVARIANT (D04 PLAN §8.2 / check-drop-rate-denominator.sh):
//   The FCC 3% drop-rate denominator is ALWAYS SUM(s.human_answered).
//   Never COUNT(*) alone. CI grep enforces this.
//
// All reads use per-tenant scoping (tenant_id = ?). Per-campaign / per-agent / per-list
// filters are optional. Date range is bounded to 365 days max.

import type { PrismaClient } from "@prisma/client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CampaignDailyRow {
  campaignId: string;
  reportDate: string;          // YYYY-MM-DD
  callsAttempted: number;
  callsConnected: number;
  contacts: number;            // SUM(s.human_answered) — FCC denominator
  sales: number;
  drops: number;
  dropRatePct: number | null;  // drops / NULLIF(contacts, 0) * 100
  avgCallDurationSec: number | null;
  abandonRatePct: number | null;
}

export interface AgentProductivityRow {
  userId: string;
  username: string;
  reportDate: string;
  callsHandled: number;
  timeReadySec: number;
  timePausedSec: number;
  timeTalkingSec: number;
  timeAcwSec: number;
  sales: number;
  salesPerHour: number | null;
}

export interface ListHealthRow {
  listId: string;
  listName: string;
  campaignId: string | null;
  leadsTotal: number;
  leadsCallable: number;
  leadsDnc: number;
  leadsTzBlocked: number;
  leadsNoAttempts: number;
  leadsExhausted: number;   // status with recycle_delay_seconds = -1
  lastDialAt: string | null; // ISO 8601
}

// ── Raw SQL row shapes ────────────────────────────────────────────────────────

interface CampaignDailyRaw {
  campaign_id: string;
  report_date: string | Date;
  calls_attempted: string | number | bigint;
  calls_connected: string | number | bigint;
  // FCC drop-rate denominator: SUM(s.human_answered) — canonical per D04 PLAN §8.2
  contacts: string | number | bigint;
  sales: string | number | bigint;
  drops: string | number | bigint;
  avg_call_duration_sec: string | number | null;
  abandon_rate_pct: string | number | null;
}

interface AgentProductivityRaw {
  user_id: string | bigint;
  username: string;
  report_date: string | Date;
  calls_handled: string | number | bigint;
  time_ready_sec: string | number | bigint;
  time_paused_sec: string | number | bigint;
  time_talking_sec: string | number | bigint;
  time_acw_sec: string | number | bigint;
  sales: string | number | bigint;
}

interface ListHealthRaw {
  list_id: string | bigint;
  list_name: string;
  campaign_id: string | null;
  leads_total: string | number | bigint;
  leads_callable: string | number | bigint;
  leads_dnc: string | number | bigint;
  leads_tz_blocked: string | number | bigint;
  leads_no_attempts: string | number | bigint;
  leads_exhausted: string | number | bigint;
  last_dial_at: string | Date | null;
}

// ── Helper ────────────────────────────────────────────────────────────────────

function num(v: string | number | bigint | null | undefined): number {
  if (v == null) return 0;
  return Number(v);
}

function dateStr(v: string | Date | null | undefined): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.slice(0, 10);
  return v.toISOString().slice(0, 10);
}

// ── OpsReportService ──────────────────────────────────────────────────────────

export class OpsReportService {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------------------------------------------------------------------------
  // Campaign daily performance
  // Canonical denominator: SUM(s.human_answered) per D04 PLAN §8.2
  // ---------------------------------------------------------------------------
  async getCampaignDaily(
    tenantId: bigint,
    fromDate: Date,
    toDate: Date,
    campaignId?: string,
  ): Promise<CampaignDailyRow[]> {
    const hasFilter = Boolean(campaignId);

    const sql = `
      SELECT
          cl.campaign_id,
          DATE(cl.call_started)                                         AS report_date,
          COUNT(*)                                                      AS calls_attempted,
          SUM(cl.call_answered IS NOT NULL)                             AS calls_connected,
          SUM(s.human_answered)                                         AS contacts,
          SUM(s.sale)                                                   AS sales,
          SUM(s.human_answered AND cl.is_drop = 1)                     AS drops,
          ROUND(AVG(NULLIF(cl.talk_seconds, 0)), 1)                     AS avg_call_duration_sec,
          ROUND(
            SUM(cl.call_answered IS NOT NULL AND s.human_answered = 0)
            / NULLIF(SUM(cl.call_answered IS NOT NULL), 0) * 100, 2
          )                                                             AS abandon_rate_pct
      FROM call_log cl
      JOIN statuses s
        ON s.tenant_id = cl.tenant_id
       AND s.campaign_id = '__SYS__'
       AND s.status = cl.status
      WHERE cl.tenant_id = ?
        AND cl.call_started BETWEEN ? AND ?
        ${hasFilter ? "AND cl.campaign_id = ?" : ""}
      GROUP BY cl.campaign_id, DATE(cl.call_started)
      ORDER BY report_date DESC, cl.campaign_id
    `;

    const params: unknown[] = hasFilter
      ? [tenantId, fromDate, toDate, campaignId]
      : [tenantId, fromDate, toDate];

    const rows = await this.prisma.$queryRawUnsafe<CampaignDailyRaw[]>(sql, ...params);

    return rows.map((r: CampaignDailyRaw): CampaignDailyRow => {
      const contacts = num(r.contacts);
      const drops = num(r.drops);
      const dropRatePct = contacts > 0 ? Math.round((drops / contacts) * 10000) / 100 : null;
      return {
        campaignId: r.campaign_id,
        reportDate: dateStr(r.report_date) ?? "",
        callsAttempted: num(r.calls_attempted),
        callsConnected: num(r.calls_connected),
        contacts, // FCC drop-rate denominator: SUM(s.human_answered)
        sales: num(r.sales),
        drops,
        dropRatePct,
        avgCallDurationSec:
          r.avg_call_duration_sec != null ? Math.round(num(r.avg_call_duration_sec) * 10) / 10 : null,
        abandonRatePct:
          r.abandon_rate_pct != null ? num(r.abandon_rate_pct) : null,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // Agent productivity
  // ---------------------------------------------------------------------------
  async getAgentProductivity(
    tenantId: bigint,
    fromDate: Date,
    toDate: Date,
    userId?: string,
  ): Promise<AgentProductivityRow[]> {
    const hasFilter = Boolean(userId);

    // Use a single JOIN query against agent_log + a lateral subquery for sales.
    // The agent_log duration_sec column stores the duration of each event segment.
    const sql = `
      SELECT
          al.user_id,
          u.username,
          DATE(al.event_at)                                                    AS report_date,
          COUNT(CASE WHEN al.event = 'call_end' THEN 1 END)                   AS calls_handled,
          COALESCE(SUM(CASE WHEN al.event = 'ready'    THEN al.duration_sec END), 0) AS time_ready_sec,
          COALESCE(SUM(CASE WHEN al.event = 'pause'    THEN al.duration_sec END), 0) AS time_paused_sec,
          COALESCE(SUM(CASE WHEN al.event = 'call_end' THEN al.duration_sec END), 0) AS time_talking_sec,
          COALESCE(SUM(CASE WHEN al.event = 'dispo'    THEN al.duration_sec END), 0) AS time_acw_sec,
          COALESCE(sal.sales_count, 0)                                         AS sales
      FROM agent_log al
      JOIN users u ON u.id = al.user_id AND u.tenant_id = al.tenant_id
      LEFT JOIN (
          SELECT
              cl.user_id,
              cl.tenant_id,
              DATE(cl.call_started)              AS sale_date,
              COUNT(*)                           AS sales_count
          FROM call_log cl
          JOIN statuses s2
            ON s2.tenant_id = cl.tenant_id
           AND s2.campaign_id = '__SYS__'
           AND s2.status = cl.status
           AND s2.sale = 1
          WHERE cl.tenant_id = ?
            AND cl.call_started BETWEEN ? AND ?
            ${hasFilter ? "AND cl.user_id = ?" : ""}
          GROUP BY cl.user_id, cl.tenant_id, DATE(cl.call_started)
      ) sal
        ON sal.user_id = al.user_id
       AND sal.tenant_id = al.tenant_id
       AND sal.sale_date = DATE(al.event_at)
      WHERE al.tenant_id = ?
        AND al.event_at BETWEEN ? AND ?
        ${hasFilter ? "AND al.user_id = ?" : ""}
      GROUP BY al.user_id, u.username, DATE(al.event_at)
      ORDER BY report_date DESC, al.user_id
    `;

    const params: unknown[] = hasFilter
      ? [tenantId, fromDate, toDate, userId, tenantId, fromDate, toDate, userId]
      : [tenantId, fromDate, toDate, tenantId, fromDate, toDate];

    const rows = await this.prisma.$queryRawUnsafe<AgentProductivityRaw[]>(sql, ...params);

    return rows.map((r: AgentProductivityRaw): AgentProductivityRow => {
      const timeTalkingSec = num(r.time_talking_sec);
      const sales = num(r.sales);
      const hoursWorked = timeTalkingSec / 3600;
      const salesPerHour = hoursWorked > 0 ? Math.round((sales / hoursWorked) * 100) / 100 : null;
      return {
        userId: String(r.user_id),
        username: r.username,
        reportDate: dateStr(r.report_date) ?? "",
        callsHandled: num(r.calls_handled),
        timeReadySec: num(r.time_ready_sec),
        timePausedSec: num(r.time_paused_sec),
        timeTalkingSec,
        timeAcwSec: num(r.time_acw_sec),
        sales,
        salesPerHour,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // List health
  // ---------------------------------------------------------------------------
  async getListHealth(
    tenantId: bigint,
    campaignId?: string,
  ): Promise<ListHealthRow[]> {
    const hasFilter = Boolean(campaignId);

    const sql = `
      SELECT
          l.id                                              AS list_id,
          l.name                                            AS list_name,
          cl2.campaign_id                                   AS campaign_id,
          COUNT(ld.id)                                      AS leads_total,
          SUM(
            ld.tz_blocked = 0
            AND s.recycle_delay_seconds IS NOT DISTINCT FROM NULL
               OR (s.recycle_delay_seconds IS NOT NULL AND s.recycle_delay_seconds != -1)
          )                                                 AS leads_callable,
          SUM(
            ld.status = 'DNC'
            OR EXISTS (
                SELECT 1 FROM dnc d
                 WHERE d.tenant_id = ld.tenant_id
                   AND d.phone_e164 = ld.phone_e164
            )
          )                                                 AS leads_dnc,
          SUM(ld.tz_blocked = 1)                            AS leads_tz_blocked,
          SUM(ld.called_count = 0)                          AS leads_no_attempts,
          SUM(s.recycle_delay_seconds = -1)                 AS leads_exhausted,
          MAX(ld.last_called_at)                            AS last_dial_at
      FROM lists l
      JOIN campaign_lists cl2 ON cl2.list_id = l.id AND cl2.tenant_id = l.tenant_id
      LEFT JOIN leads ld
             ON ld.list_id = l.id
            AND ld.tenant_id = l.tenant_id
            AND ld.deleted_at IS NULL
      LEFT JOIN statuses s
             ON s.tenant_id = ld.tenant_id
            AND s.campaign_id = '__SYS__'
            AND s.status = ld.status
      WHERE l.tenant_id = ?
        ${hasFilter ? "AND cl2.campaign_id = ?" : ""}
      GROUP BY l.id, l.name, cl2.campaign_id
      ORDER BY l.name
    `;

    const params: unknown[] = hasFilter ? [tenantId, campaignId] : [tenantId];

    const rows = await this.prisma.$queryRawUnsafe<ListHealthRaw[]>(sql, ...params);

    return rows.map((r: ListHealthRaw): ListHealthRow => ({
      listId: String(r.list_id),
      listName: r.list_name,
      campaignId: r.campaign_id ?? null,
      leadsTotal: num(r.leads_total),
      leadsCallable: num(r.leads_callable),
      leadsDnc: num(r.leads_dnc),
      leadsTzBlocked: num(r.leads_tz_blocked),
      leadsNoAttempts: num(r.leads_no_attempts),
      leadsExhausted: num(r.leads_exhausted),
      lastDialAt:
        r.last_dial_at != null
          ? typeof r.last_dial_at === "string"
            ? r.last_dial_at
            : (r.last_dial_at as Date).toISOString()
          : null,
    }));
  }
}
