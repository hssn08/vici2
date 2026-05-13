// D04 — StatusService: 3-layer override resolution, status management.
//
// Three-layer COALESCE resolution per PLAN §3:
//   (a) Full per-campaign shadow row  → wins all columns
//   (b) campaign_status_overrides     → wins recycle_delay_seconds + max_calls only
//   (c) statuses(campaign_id='__SYS__') → system default

import type { PrismaClient } from "@prisma/client";
import type { EffectiveStatus, StatusDef, TransitionResult } from "@vici2/types";
import { cacheGet, cacheSet, publishInvalidation } from "./cache.js";
import { resolveFromHangupCause } from "./hangup-map.js";
import { illegalTransitionTotal } from "./metrics.js";
import pino from "pino";

const logger = pino({ level: "info" });

// ── Illegal transition table ───────────────────────────────────────────────────
// Per PLAN §7.3: 7 illegal transitions enforced at service layer.
const ILLEGAL_TRANSITIONS: Array<{ from: string | null; to: string | null; errorCode: string; reason: string }> = [
  { from: null,    to: "INCALL",  errorCode: "illegal_to_incall",      reason: "INCALL is set by T01 CHANNEL_BRIDGE only" },
  { from: null,    to: "QUEUE",   errorCode: "illegal_to_queue",       reason: "QUEUE is set by E01 filler only" },
  { from: null,    to: "NEW",     errorCode: "illegal_to_new",         reason: "Cannot un-call a lead" },
  { from: "SALE",  to: null,      errorCode: "sale_immutable",         reason: "Sales are immutable without admin force-recycle" },
  { from: null,    to: "INVALID", errorCode: "illegal_to_invalid",     reason: "INVALID is set by T04 hangup-map only" },
  { from: "DNC",   to: null,      errorCode: "dnc_immutable",          reason: "DNC is sticky by FTC TSR; use M06 admin path" },
];

/** Per-campaign terminal-status guard (recycleDelaySeconds = -1). */
const TERMINAL_GUARD_CODE = "terminal_status";

// ── Raw SQL merge query ───────────────────────────────────────────────────────
// Canonical 3-layer merge per PLAN §3.2. Using $queryRawUnsafe with positional params.

const MERGE_SQL = `
SELECT
    s.status,
    COALESCE(c.description,     sys.description)     AS description,
    COALESCE(c.selectable,      sys.selectable)      AS selectable,
    COALESCE(c.human_answered,  sys.human_answered)  AS human_answered,
    COALESCE(c.sale,            sys.sale)            AS sale,
    COALESCE(c.dnc,             sys.dnc)             AS dnc,
    COALESCE(c.callback,        sys.callback)        AS callback,
    COALESCE(c.not_interested,  sys.not_interested)  AS not_interested,
    COALESCE(c.hotkey,          sys.hotkey)          AS hotkey,
    COALESCE(c.recycle_delay_seconds,
             o.recycle_delay_seconds,
             sys.recycle_delay_seconds)              AS recycle_delay_seconds,
    COALESCE(o.max_calls,       sys.max_calls)       AS max_calls,
    COALESCE(c.category,        sys.category)        AS category,
    COALESCE(c.system_owner,    sys.system_owner)    AS system_owner,
    CASE
      WHEN c.campaign_id IS NOT NULL THEN 'shadow'
      WHEN o.status_code IS NOT NULL THEN 'override'
      ELSE 'system'
    END AS source
FROM (
    SELECT DISTINCT status
      FROM statuses
     WHERE tenant_id = ?
       AND campaign_id IN (?, '__SYS__')
) s
LEFT JOIN statuses c
       ON c.tenant_id = ? AND c.campaign_id = ? AND c.status = s.status
LEFT JOIN statuses sys
       ON sys.tenant_id = ? AND sys.campaign_id = '__SYS__' AND sys.status = s.status
LEFT JOIN campaign_status_overrides o
       ON o.tenant_id = ? AND o.campaign_id = ? AND o.status_code = s.status
ORDER BY (sys.system_owner = '__AGT__') DESC, sys.hotkey, s.status
`;

// ── Type for raw row returned by SQL ─────────────────────────────────────────

interface MergeRow {
  status: string;
  description: string;
  selectable: number | boolean;
  human_answered: number | boolean;
  sale: number | boolean;
  dnc: number | boolean;
  callback: number | boolean;
  not_interested: number | boolean;
  hotkey: string | null;
  recycle_delay_seconds: number | null;
  max_calls: number | null;
  category: string | null;
  system_owner: string | null;
  source: string;
}

function toBool(v: number | boolean | null | undefined): boolean {
  if (typeof v === "boolean") return v;
  return v === 1;
}

function rowToEffective(row: MergeRow): EffectiveStatus {
  return {
    code: row.status,
    description: row.description,
    selectable: toBool(row.selectable),
    humanAnswered: toBool(row.human_answered),
    sale: toBool(row.sale),
    dnc: toBool(row.dnc),
    callback: toBool(row.callback),
    notInterested: toBool(row.not_interested),
    hotkey: row.hotkey ?? null,
    recycleDelaySeconds: row.recycle_delay_seconds ?? null,
    maxCalls: row.max_calls ?? null,
    category: row.category ?? null,
    systemOwner: row.system_owner ?? null,
    source: (row.source as "shadow" | "override" | "system") ?? "system",
  };
}

// ── StatusService ─────────────────────────────────────────────────────────────

export class StatusService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * List all effective statuses for a campaign (3-layer merge, cached 60s).
   */
  async list(tenantId: bigint, campaignId: string): Promise<EffectiveStatus[]> {
    const cached = cacheGet(tenantId, campaignId);
    if (cached) return cached;

    const rows = await this.prisma.$queryRawUnsafe<MergeRow[]>(
      MERGE_SQL,
      tenantId, campaignId,
      tenantId, campaignId,
      tenantId,
      tenantId, campaignId,
    );

    const result = rows.map(rowToEffective);
    cacheSet(tenantId, campaignId, result);
    return result;
  }

  /**
   * Resolve a single status code for a campaign (uses list cache).
   */
  async resolve(tenantId: bigint, campaignId: string, code: string): Promise<EffectiveStatus | null> {
    const all = await this.list(tenantId, campaignId);
    return all.find((s) => s.code === code) ?? null;
  }

  /**
   * Check if a status code is agent-selectable for a campaign.
   */
  async isSelectable(tenantId: bigint, campaignId: string, code: string): Promise<boolean> {
    const status = await this.resolve(tenantId, campaignId, code);
    return status?.selectable ?? false;
  }

  /**
   * Return hotkey → status code map for a campaign.
   * Keys are single-digit strings; only statuses with non-null hotkeys included.
   */
  async hotkeyMap(tenantId: bigint, campaignId: string): Promise<Record<string, string>> {
    const all = await this.list(tenantId, campaignId);
    const result: Record<string, string> = {};
    for (const s of all) {
      if (s.hotkey) result[s.hotkey] = s.code;
    }
    return result;
  }

  /**
   * Validate a status transition. Returns { allowed, errorCode, reason }.
   * Enforces 7 illegal transitions per PLAN §7.3.
   * Also blocks transition out of terminal statuses.
   */
  async validateTransition(
    tenantId: bigint,
    from: string,
    to: string,
     
    _campaignId?: string,
  ): Promise<TransitionResult> {
    // Check global illegal transitions (null from/to = applies to any)
    for (const rule of ILLEGAL_TRANSITIONS) {
      if (rule.from === null && rule.to === to) {
        illegalTransitionTotal.inc({ from, to });
        return { allowed: false, errorCode: rule.errorCode, reason: rule.reason };
      }
      if (rule.from === from && rule.to === null) {
        illegalTransitionTotal.inc({ from, to });
        return { allowed: false, errorCode: rule.errorCode, reason: rule.reason };
      }
      if (rule.from === from && rule.to === to) {
        illegalTransitionTotal.inc({ from, to });
        return { allowed: false, errorCode: rule.errorCode, reason: rule.reason };
      }
    }

    // Check terminal status guard: once a lead is in a terminal status, it
    // cannot be transitioned without manager force-recycle (M03/D06).
    // We check the SYS row for the source status.
    const sysRow = await this.prisma.status.findUnique({
      where: {
        tenantId_campaignId_status: {
          tenantId,
          campaignId: "__SYS__",
          status: from,
        },
      },
      select: { recycleDelaySeconds: true },
    });

    if (sysRow && sysRow.recycleDelaySeconds === -1) {
      illegalTransitionTotal.inc({ from, to });
      return {
        allowed: false,
        errorCode: TERMINAL_GUARD_CODE,
        reason: `Status ${from} is terminal (recycleDelaySeconds=-1); use force-recycle endpoint`,
      };
    }

    return { allowed: true };
  }

  /**
   * Resolve a FreeSWITCH hangup_cause to a D04 status code.
   * Pure function backed by hangup-cause-map.json.
   */
   
  async resolveFromHangup(_tenantId: bigint, _campaignId: string, hangupCause: string): Promise<string> {
    return resolveFromHangupCause(hangupCause);
  }

  /**
   * Upsert a per-campaign status override.
   * - If campaignId === '__SYS__' → 403 (handled by route handler).
   * - If only recycleDelaySeconds or maxCalls change → write to campaign_status_overrides.
   * - Any other column change → write shadow row in statuses.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async upsert(redis: any, tenantId: bigint, campaignId: string, code: string, def: StatusDef): Promise<EffectiveStatus> {
    const hasOnlyDelayOrMaxCalls =
      def.recycleDelaySeconds !== undefined || def.maxCalls !== undefined;
    const hasOtherColumns =
      def.description !== undefined ||
      def.selectable !== undefined ||
      def.humanAnswered !== undefined ||
      def.sale !== undefined ||
      def.dnc !== undefined ||
      def.callback !== undefined ||
      def.notInterested !== undefined ||
      def.hotkey !== undefined ||
      def.category !== undefined;

    if (hasOtherColumns) {
      // Write / update shadow row in statuses
      const existing = await this.prisma.status.findUnique({
        where: { tenantId_campaignId_status: { tenantId, campaignId, status: code } },
      });
      if (existing) {
        await this.prisma.status.update({
          where: { tenantId_campaignId_status: { tenantId, campaignId, status: code } },
          data: {
            ...(def.description !== undefined && { description: def.description }),
            ...(def.selectable !== undefined && { selectable: def.selectable }),
            ...(def.humanAnswered !== undefined && { humanAnswered: def.humanAnswered }),
            ...(def.sale !== undefined && { sale: def.sale }),
            ...(def.dnc !== undefined && { dnc: def.dnc }),
            ...(def.callback !== undefined && { callback: def.callback }),
            ...(def.notInterested !== undefined && { notInterested: def.notInterested }),
            ...(def.hotkey !== undefined && { hotkey: def.hotkey }),
            ...(def.recycleDelaySeconds !== undefined && { recycleDelaySeconds: def.recycleDelaySeconds }),
            ...(def.category !== undefined && { category: def.category }),
          },
        });
      } else {
        // Get system row to fill in missing fields
        const sys = await this.prisma.status.findUnique({
          where: { tenantId_campaignId_status: { tenantId, campaignId: "__SYS__", status: code } },
        });
        if (!sys) throw Object.assign(new Error("status_not_found"), { statusCode: 404 });
        await this.prisma.status.create({
          data: {
            tenantId,
            campaignId,
            status: code,
            description: def.description ?? sys.description,
            selectable: def.selectable ?? sys.selectable,
            humanAnswered: def.humanAnswered ?? sys.humanAnswered,
            sale: def.sale ?? sys.sale,
            dnc: def.dnc ?? sys.dnc,
            callback: def.callback ?? sys.callback,
            notInterested: def.notInterested ?? sys.notInterested,
            hotkey: def.hotkey !== undefined ? def.hotkey : sys.hotkey,
            recycleDelaySeconds: def.recycleDelaySeconds !== undefined ? def.recycleDelaySeconds : sys.recycleDelaySeconds,
            category: def.category !== undefined ? def.category : sys.category,
            systemOwner: sys.systemOwner,
          },
        });
      }
    } else if (hasOnlyDelayOrMaxCalls) {
      // Write / update campaign_status_overrides (lighter path)
      await this.prisma.campaignStatusOverride.upsert({
        where: { tenantId_campaignId_statusCode: { tenantId, campaignId, statusCode: code } },
        update: {
          ...(def.recycleDelaySeconds !== undefined && { recycleDelaySeconds: def.recycleDelaySeconds }),
          ...(def.maxCalls !== undefined && { maxCalls: def.maxCalls }),
        },
        create: {
          tenantId,
          campaignId,
          statusCode: code,
          recycleDelaySeconds: def.recycleDelaySeconds ?? null,
          maxCalls: def.maxCalls ?? null,
        },
      });
    }

    // Invalidate cache
    await publishInvalidation(redis, tenantId, campaignId);

    const updated = await this.resolve(tenantId, campaignId, code);
    if (!updated) throw Object.assign(new Error("status_not_found"), { statusCode: 404 });
    return updated;
  }

  /**
   * Create a new per-campaign custom status (rejected if code exists in __SYS__).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async create(redis: any, tenantId: bigint, campaignId: string, code: string, def: StatusDef & { description: string }): Promise<EffectiveStatus> {
    // Check if code exists in __SYS__
    const sys = await this.prisma.status.findUnique({
      where: { tenantId_campaignId_status: { tenantId, campaignId: "__SYS__", status: code } },
    });
    if (sys) throw Object.assign(new Error("code_exists_in_system"), { statusCode: 409 });

    // Check hotkey uniqueness
    if (def.hotkey) {
      await this.assertHotkeyUnique(tenantId, campaignId, code, def.hotkey);
    }

    await this.prisma.status.create({
      data: {
        tenantId,
        campaignId,
        status: code,
        description: def.description,
        selectable: def.selectable ?? true,
        humanAnswered: def.humanAnswered ?? false,
        sale: def.sale ?? false,
        dnc: def.dnc ?? false,
        callback: def.callback ?? false,
        notInterested: def.notInterested ?? false,
        hotkey: def.hotkey ?? null,
        recycleDelaySeconds: def.recycleDelaySeconds ?? null,
        category: def.category ?? null,
        systemOwner: null,
      },
    });

    await publishInvalidation(redis, tenantId, campaignId);

    const created = await this.resolve(tenantId, campaignId, code);
    if (!created) throw Object.assign(new Error("status_not_found"), { statusCode: 404 });
    return created;
  }

  /**
   * Soft-delete a shadow row (never deletes __SYS__ rows).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async delete(redis: any, tenantId: bigint, campaignId: string, code: string): Promise<boolean> {
    try {
      await this.prisma.status.delete({
        where: { tenantId_campaignId_status: { tenantId, campaignId, status: code } },
      });
      await publishInvalidation(redis, tenantId, campaignId);
      return true;
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e?.code === "P2025") return false; // not found
      throw err;
    }
  }

  /** Assert hotkey is not already used in this campaign. */
  private async assertHotkeyUnique(tenantId: bigint, campaignId: string, excludeCode: string, hotkey: string): Promise<void> {
    const conflict = await this.prisma.status.findFirst({
      where: {
        tenantId,
        campaignId,
        hotkey,
        NOT: { status: excludeCode },
      },
    });
    if (conflict) {
      throw Object.assign(new Error("hotkey_conflict"), { statusCode: 409 });
    }
  }
}

// Factory
let _service: StatusService | null = null;
export function getStatusService(prisma: PrismaClient): StatusService {
  if (!_service) _service = new StatusService(prisma);
  return _service;
}

// For testing — allow resetting singleton
export function resetStatusService(): void {
  _service = null;
}
