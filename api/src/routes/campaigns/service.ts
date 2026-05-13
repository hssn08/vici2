// E01 — Campaign service (business logic layer).
//
// All DB interactions for campaigns, separated from route handlers
// to keep routes thin and service functions testable.

import type { PrismaClient, Prisma as PrismaNamespace } from "@prisma/client";
import type { CampaignCreateInput, CampaignUpdateInput, StatusOverrideUpsertInput, CampaignListLinkInput } from "./schema.js";
import { auditCampaign } from "./audit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toDecimal(v: number): string {
  return v.toFixed(2);
}

// Build the Prisma data shape for campaign create/update.
function buildCampaignData(input: CampaignCreateInput | CampaignUpdateInput) {
  const d: Record<string, unknown> = {};
  if ("name" in input && input.name !== undefined) d.name = input.name;
  if (input.active !== undefined) d.active = input.active;
  if (input.dial_method !== undefined) d.dialMethod = input.dial_method;
  if (input.auto_dial_level !== undefined) d.autoDialLevel = toDecimal(input.auto_dial_level);
  if (input.adaptive_max_level !== undefined) d.adaptiveMaxLevel = toDecimal(input.adaptive_max_level);
  if (input.adaptive_drop_pct !== undefined) d.adaptiveDropPct = toDecimal(input.adaptive_drop_pct);
  if (input.dial_timeout_sec !== undefined) d.dialTimeoutSec = input.dial_timeout_sec;
  if (input.wrapup_seconds !== undefined) d.wrapupSeconds = input.wrapup_seconds;
  if (input.next_agent_call !== undefined) d.nextAgentCall = input.next_agent_call;
  if (input.available_only_tally !== undefined) d.availableOnlyTally = input.available_only_tally;
  if (input.hopper_size_target !== undefined) d.hopperSizeTarget = input.hopper_size_target;
  if (input.hopper_multiplier !== undefined) d.hopperMultiplier = toDecimal(input.hopper_multiplier);
  if (input.caller_id_carrier_id !== undefined)
    d.callerIdCarrierId = input.caller_id_carrier_id === null ? null : BigInt(input.caller_id_carrier_id);
  if (input.caller_id_override !== undefined) d.callerIdOverride = input.caller_id_override;
  if (input.recording_mode !== undefined) d.recordingMode = input.recording_mode;
  if (input.amd_enabled !== undefined) d.amdEnabled = input.amd_enabled;
  if (input.amd_action !== undefined) d.amdAction = input.amd_action;
  if (input.vmdrop_audio !== undefined) d.vmdropAudio = input.vmdrop_audio;
  if (input.safe_harbor_audio !== undefined) d.safeHarborAudio = input.safe_harbor_audio;
  if (input.script_id !== undefined)
    d.scriptId = input.script_id === null ? null : BigInt(input.script_id);
  if (input.webform_url !== undefined) d.webformUrl = input.webform_url;
  if (input.dial_status_filter !== undefined) d.dialStatusFilter = input.dial_status_filter;
  if (input.call_time_id !== undefined)
    d.callTimeId = input.call_time_id === null ? null : BigInt(input.call_time_id);
  if (input.use_internal_dnc !== undefined) d.useInternalDnc = input.use_internal_dnc;
  if (input.use_federal_dnc !== undefined) d.useFederalDnc = input.use_federal_dnc;
  if (input.use_state_dnc !== undefined) d.useStateDnc = input.use_state_dnc;
  if (input.pause_codes_required !== undefined) d.pauseCodesRequired = input.pause_codes_required;
  if (input.hot_keys_active !== undefined) d.hotKeysActive = input.hot_keys_active;
  if (input.closer_ingroups !== undefined) d.closerIngroups = input.closer_ingroups;
  if (input.unknown_tz_policy !== undefined) d.unknownTzPolicy = input.unknown_tz_policy;
  // E01 amendments
  if (input.dial_level !== undefined) d.dialLevel = toDecimal(input.dial_level);
  if (input.lock_ttl_sec !== undefined) d.lockTtlSec = input.lock_ttl_sec;
  if (input.min_hopper_level !== undefined) d.minHopperLevel = input.min_hopper_level;
  if (input.max_hopper_level !== undefined) d.maxHopperLevel = input.max_hopper_level;
  if (input.hopper_buffer_multiplier !== undefined) d.hopperBufferMultiplier = toDecimal(input.hopper_buffer_multiplier);
  if (input.recycle_delay_seconds !== undefined) d.recycleDelaySeconds = input.recycle_delay_seconds;
  if (input.max_calls_per_lead !== undefined) d.maxCallsPerLead = input.max_calls_per_lead;
  if (input.dial_statuses !== undefined) d.dialStatuses = input.dial_statuses;
  if (input.low_water_pct !== undefined) d.lowWaterPct = input.low_water_pct;
  if (input.high_water_pct !== undefined) d.highWaterPct = input.high_water_pct;
  if (input.over_fetch_ratio !== undefined) d.overFetchRatio = toDecimal(input.over_fetch_ratio);
  if (input.machine_terminal !== undefined) d.machineTerminal = input.machine_terminal;
  if (input.lead_filter_sql !== undefined) d.leadFilterSql = input.lead_filter_sql;
  if (input.multi_list_mix !== undefined) d.multiListMix = input.multi_list_mix;
  return d;
}

// Serialize a Campaign row for the HTTP response (BigInt → number).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeCampaign(c: any): Record<string, unknown> {
  return {
    tenant_id: Number(c.tenantId),
    id: c.id,
    name: c.name,
    active: c.active,
    dial_method: c.dialMethod,
    auto_dial_level: Number(c.autoDialLevel),
    adaptive_max_level: Number(c.adaptiveMaxLevel),
    adaptive_drop_pct: Number(c.adaptiveDropPct),
    dial_timeout_sec: c.dialTimeoutSec,
    wrapup_seconds: c.wrapupSeconds,
    next_agent_call: c.nextAgentCall,
    available_only_tally: c.availableOnlyTally,
    hopper_size_target: c.hopperSizeTarget,
    hopper_multiplier: Number(c.hopperMultiplier),
    caller_id_carrier_id: c.callerIdCarrierId ? Number(c.callerIdCarrierId) : null,
    caller_id_override: c.callerIdOverride,
    recording_mode: c.recordingMode,
    amd_enabled: c.amdEnabled,
    amd_action: c.amdAction,
    vmdrop_audio: c.vmdropAudio,
    safe_harbor_audio: c.safeHarborAudio,
    script_id: c.scriptId ? Number(c.scriptId) : null,
    webform_url: c.webformUrl,
    dial_status_filter: c.dialStatusFilter,
    call_time_id: c.callTimeId ? Number(c.callTimeId) : null,
    use_internal_dnc: c.useInternalDnc,
    use_federal_dnc: c.useFederalDnc,
    use_state_dnc: c.useStateDnc,
    pause_codes_required: c.pauseCodesRequired,
    hot_keys_active: c.hotKeysActive,
    closer_ingroups: c.closerIngroups,
    unknown_tz_policy: c.unknownTzPolicy,
    dial_level: Number(c.dialLevel),
    lock_ttl_sec: c.lockTtlSec,
    min_hopper_level: c.minHopperLevel,
    max_hopper_level: c.maxHopperLevel,
    hopper_buffer_multiplier: Number(c.hopperBufferMultiplier),
    recycle_delay_seconds: c.recycleDelaySeconds,
    max_calls_per_lead: c.maxCallsPerLead,
    dial_statuses: c.dialStatuses,
    low_water_pct: c.lowWaterPct,
    high_water_pct: c.highWaterPct,
    over_fetch_ratio: Number(c.overFetchRatio),
    machine_terminal: c.machineTerminal,
    lead_filter_sql: c.leadFilterSql,
    multi_list_mix: c.multiListMix,
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    // include relations if they were loaded
    campaign_lists: c.campaignLists
      ? c.campaignLists.map((cl: Record<string, unknown>) => ({
          list_id: Number(cl.listId),
          priority: cl.priority,
        }))
      : undefined,
    status_overrides: c.statusOverrides
      ? c.statusOverrides.map((so: Record<string, unknown>) => ({
          status_code: so.statusCode,
          recycle_delay_seconds: so.recycleDelaySeconds,
          max_calls: so.maxCalls,
          notes: so.notes,
        }))
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Campaign CRUD
// ---------------------------------------------------------------------------

export interface ListCampaignsOpts {
  tenantId: number;
  active?: boolean;
  dialMethod?: string;
  limit: number;
  offset: number;
}

export async function listCampaigns(
  prisma: PrismaClient,
  opts: ListCampaignsOpts,
) {
  const where: Record<string, unknown> = { tenantId: BigInt(opts.tenantId) };
  if (opts.active !== undefined) where.active = opts.active;
  if (opts.dialMethod !== undefined) where.dialMethod = opts.dialMethod;

  const [rows, total] = await prisma.$transaction([
    prisma.campaign.findMany({
      where,
      include: { campaignLists: true, statusOverrides: true },
      orderBy: [{ name: "asc" }],
      take: opts.limit,
      skip: opts.offset,
    }),
    prisma.campaign.count({ where }),
  ]);

  return { items: rows.map(serializeCampaign), total };
}

export async function getCampaign(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
) {
  const row = await prisma.campaign.findUnique({
    where: { tenantId_id: { tenantId: BigInt(tenantId), id: campaignId } },
    include: { campaignLists: true, statusOverrides: true },
  });
  return row ? serializeCampaign(row) : null;
}

export async function createCampaign(
  prisma: PrismaClient,
  tenantId: number,
  input: CampaignCreateInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown>> {
  const data = {
    tenantId: BigInt(tenantId),
    id: input.id,
    ...buildCampaignData(input),
  };

  const campaign = await prisma.$transaction(async (tx) => {
    const row = await (tx as PrismaClient).campaign.create({
      data: data as PrismaNamespace.CampaignUncheckedCreateInput,
      include: { campaignLists: true, statusOverrides: true },
    });

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "campaign.created",
      tenantId,
      entityId: input.id,
      afterJson: serializeCampaign(row),
      requestId,
      ip,
      userAgent: ua,
    });

    return row;
  });

  return serializeCampaign(campaign);
}

export async function updateCampaign(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
  input: CampaignUpdateInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown> | null> {
  const existing = await prisma.campaign.findUnique({
    where: { tenantId_id: { tenantId: BigInt(tenantId), id: campaignId } },
  });
  if (!existing) return null;

  const data = buildCampaignData(input);

  const updated = await prisma.$transaction(async (tx) => {
    const row = await (tx as PrismaClient).campaign.update({
      where: { tenantId_id: { tenantId: BigInt(tenantId), id: campaignId } },
      data: data as PrismaNamespace.CampaignUncheckedUpdateInput,
      include: { campaignLists: true, statusOverrides: true },
    });

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "campaign.updated",
      tenantId,
      entityId: campaignId,
      beforeJson: serializeCampaign(existing),
      afterJson: serializeCampaign(row),
      requestId,
      ip,
      userAgent: ua,
    });

    return row;
  });

  return serializeCampaign(updated);
}

export async function deleteCampaign(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<boolean> {
  const existing = await prisma.campaign.findUnique({
    where: { tenantId_id: { tenantId: BigInt(tenantId), id: campaignId } },
  });
  if (!existing) return false;

  await prisma.$transaction(async (tx) => {
    await (tx as PrismaClient).campaign.delete({
      where: { tenantId_id: { tenantId: BigInt(tenantId), id: campaignId } },
    });

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "campaign.deleted",
      tenantId,
      entityId: campaignId,
      beforeJson: serializeCampaign(existing),
      requestId,
      ip,
      userAgent: ua,
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export async function cloneCampaign(
  prisma: PrismaClient,
  tenantId: number,
  sourceCampaignId: string,
  newId: string,
  newName: string,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown> | null> {
  const source = await prisma.campaign.findUnique({
    where: { tenantId_id: { tenantId: BigInt(tenantId), id: sourceCampaignId } },
    include: { campaignLists: true, statusOverrides: true },
  });
  if (!source) return null;

  const cloned = await prisma.$transaction(async (tx) => {
    const { tenantId: _tid, id: _id, createdAt: _ca, updatedAt: _ua, campaignLists: _cl, statusOverrides: _so, ...rest } = source as Record<string, unknown> & { tenantId: bigint; id: string; createdAt: Date; updatedAt: Date; campaignLists: unknown[]; statusOverrides: unknown[] };

    const newRow = await (tx as PrismaClient).campaign.create({
      data: {
        tenantId: BigInt(tenantId),
        id: newId,
        ...rest,
        name: newName,
        active: false, // clones start inactive
      } as PrismaNamespace.CampaignUncheckedCreateInput,
      include: { campaignLists: true, statusOverrides: true },
    });

    // Clone campaign lists
    if (source.campaignLists.length > 0) {
      await (tx as PrismaClient).campaignList.createMany({
        data: source.campaignLists.map((cl) => ({
          tenantId: BigInt(tenantId),
          campaignId: newId,
          listId: cl.listId,
          priority: cl.priority,
        })),
      });
    }

    // Clone status overrides
    if (source.statusOverrides.length > 0) {
      await (tx as PrismaClient).campaignStatusOverride.createMany({
        data: source.statusOverrides.map((so) => ({
          tenantId: BigInt(tenantId),
          campaignId: newId,
          statusCode: so.statusCode,
          recycleDelaySeconds: so.recycleDelaySeconds,
          maxCalls: so.maxCalls,
          notes: so.notes,
        })),
      });
    }

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "campaign.cloned",
      tenantId,
      entityId: newId,
      afterJson: { source_id: sourceCampaignId, new_id: newId, name: newName },
      requestId,
      ip,
      userAgent: ua,
    });

    return newRow;
  });

  return serializeCampaign(cloned);
}

// ---------------------------------------------------------------------------
// State machine (start / pause / stop)
// Maps to the `active` flag — dialer processes watch Valkey for their own
// running state; the DB active column is the source of truth.
// ---------------------------------------------------------------------------

export type CampaignAction = "start" | "pause" | "stop";

export async function applyCampaignAction(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
  action: CampaignAction,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown> | null> {
  const existing = await prisma.campaign.findUnique({
    where: { tenantId_id: { tenantId: BigInt(tenantId), id: campaignId } },
  });
  if (!existing) return null;

  // State machine transitions:
  // start  → active = true
  // pause  → active = false (preserves hopper; dialer stops claiming new leads)
  // stop   → active = false (same as pause at DB level; dialer flushes hopper)
  const active = action === "start";
  const auditAction =
    action === "start"
      ? "campaign.started"
      : action === "pause"
        ? "campaign.paused"
        : "campaign.stopped";

  const updated = await prisma.$transaction(async (tx) => {
    const row = await (tx as PrismaClient).campaign.update({
      where: { tenantId_id: { tenantId: BigInt(tenantId), id: campaignId } },
      data: { active },
      include: { campaignLists: true, statusOverrides: true },
    });

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: auditAction,
      tenantId,
      entityId: campaignId,
      beforeJson: { active: existing.active },
      afterJson: { active },
      requestId,
      ip,
      userAgent: ua,
    });

    return row;
  });

  return serializeCampaign(updated);
}

// ---------------------------------------------------------------------------
// Campaign-list linkage
// ---------------------------------------------------------------------------

export async function linkList(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
  input: CampaignListLinkInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await (tx as PrismaClient).campaignList.upsert({
      where: {
        tenantId_campaignId_listId: {
          tenantId: BigInt(tenantId),
          campaignId,
          listId: BigInt(input.list_id),
        },
      },
      create: {
        tenantId: BigInt(tenantId),
        campaignId,
        listId: BigInt(input.list_id),
        priority: input.priority,
      },
      update: { priority: input.priority },
    });

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "campaign.list.linked",
      tenantId,
      entityId: campaignId,
      afterJson: { list_id: input.list_id, priority: input.priority },
      requestId,
      ip,
      userAgent: ua,
    });
  });
}

export async function unlinkList(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
  listId: number,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<boolean> {
  const existing = await prisma.campaignList.findUnique({
    where: {
      tenantId_campaignId_listId: {
        tenantId: BigInt(tenantId),
        campaignId,
        listId: BigInt(listId),
      },
    },
  });
  if (!existing) return false;

  await prisma.$transaction(async (tx) => {
    await (tx as PrismaClient).campaignList.delete({
      where: {
        tenantId_campaignId_listId: {
          tenantId: BigInt(tenantId),
          campaignId,
          listId: BigInt(listId),
        },
      },
    });

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "campaign.list.unlinked",
      tenantId,
      entityId: campaignId,
      afterJson: { list_id: listId },
      requestId,
      ip,
      userAgent: ua,
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Campaign-status overrides
// ---------------------------------------------------------------------------

export async function upsertStatusOverride(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
  input: StatusOverrideUpsertInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown>> {
  const result = await prisma.$transaction(async (tx) => {
    const row = await (tx as PrismaClient).campaignStatusOverride.upsert({
      where: {
        tenantId_campaignId_statusCode: {
          tenantId: BigInt(tenantId),
          campaignId,
          statusCode: input.status_code,
        },
      },
      create: {
        tenantId: BigInt(tenantId),
        campaignId,
        statusCode: input.status_code,
        recycleDelaySeconds: input.recycle_delay_seconds ?? null,
        maxCalls: input.max_calls ?? null,
        notes: input.notes ?? null,
      },
      update: {
        recycleDelaySeconds: input.recycle_delay_seconds ?? null,
        maxCalls: input.max_calls ?? null,
        notes: input.notes ?? null,
      },
    });

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "campaign.status_override.upserted",
      tenantId,
      entityId: `${campaignId}:${input.status_code}`,
      afterJson: input,
      requestId,
      ip,
      userAgent: ua,
    });

    return row;
  });

  return {
    status_code: result.statusCode,
    recycle_delay_seconds: result.recycleDelaySeconds,
    max_calls: result.maxCalls,
    notes: result.notes,
    created_at: result.createdAt,
    updated_at: result.updatedAt,
  };
}

export async function deleteStatusOverride(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
  statusCode: string,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<boolean> {
  const existing = await prisma.campaignStatusOverride.findUnique({
    where: {
      tenantId_campaignId_statusCode: {
        tenantId: BigInt(tenantId),
        campaignId,
        statusCode,
      },
    },
  });
  if (!existing) return false;

  await prisma.$transaction(async (tx) => {
    await (tx as PrismaClient).campaignStatusOverride.delete({
      where: {
        tenantId_campaignId_statusCode: {
          tenantId: BigInt(tenantId),
          campaignId,
          statusCode,
        },
      },
    });

    await auditCampaign({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "campaign.status_override.deleted",
      tenantId,
      entityId: `${campaignId}:${statusCode}`,
      beforeJson: {
        status_code: statusCode,
        recycle_delay_seconds: existing.recycleDelaySeconds,
        max_calls: existing.maxCalls,
      },
      requestId,
      ip,
      userAgent: ua,
    });
  });

  return true;
}

export async function listStatusOverrides(
  prisma: PrismaClient,
  tenantId: number,
  campaignId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await prisma.campaignStatusOverride.findMany({
    where: { tenantId: BigInt(tenantId), campaignId },
    orderBy: { statusCode: "asc" },
  });

  return rows.map((r) => ({
    status_code: r.statusCode,
    recycle_delay_seconds: r.recycleDelaySeconds,
    max_calls: r.maxCalls,
    notes: r.notes,
    created_at: r.createdAt,
    updated_at: r.updatedAt,
  }));
}
