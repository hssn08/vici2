// D07 — List management service (business logic layer).
//
// All DB interactions separated from route handlers for testability.

import type { PrismaClient } from "@prisma/client";
import type { ListCreateInput, ListUpdateInput, ListQuery, CampaignLinkInput, CampaignLinkUpdateInput, CloneInput } from "./schema.js";
import { DEFAULT_LIST_SETTINGS, type ListSettings } from "./schema.js";
import { auditList } from "./audit.js";
import { invalidateStatsCache } from "./stats.js";

const SYNC_THRESHOLD = 10_000;
const BATCH_SIZE = 1_000;

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeList(l: any): Record<string, unknown> {
  return {
    id: Number(l.id),
    tenant_id: Number(l.tenantId),
    name: l.name,
    description: l.description ?? null,
    active: l.active,
    owner_user_id: l.ownerUserId ? Number(l.ownerUserId) : null,
    caller_id_override: l.callerIdOverride ?? null,
    caller_id_name: l.callerIdName ?? null,
    settings: l.settings ?? DEFAULT_LIST_SETTINGS,
    source: l.source ?? null,
    reset_time: l.resetTime ?? null,
    expiration: l.expiration ?? null,
    created_at: l.createdAt,
    updated_at: l.updatedAt,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function serializeCampaignLink(cl: any): Record<string, unknown> {
  return {
    tenant_id: Number(cl.tenantId),
    campaign_id: cl.campaignId,
    list_id: Number(cl.listId),
    priority: cl.priority,
    active: cl.active,
    created_at: cl.createdAt,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function listLists(
  prisma: PrismaClient,
  tenantId: number,
  query: ListQuery,
): Promise<{ data: Record<string, unknown>[]; total: number }> {
  const tid = BigInt(tenantId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { tenantId: tid };

  if (query.active !== undefined) where["active"] = query.active;
  if (query.owner_user_id) where["ownerUserId"] = query.owner_user_id;
  if (query.search) {
    where["name"] = { contains: query.search };
  }

  const skip = (query.page - 1) * query.page_size;
  const take = query.page_size;

  const [rows, total] = await Promise.all([
    prisma.list.findMany({ where, skip, take, orderBy: { name: "asc" } }),
    prisma.list.count({ where }),
  ]);

  return { data: rows.map(serializeList), total };
}

export async function getList(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
): Promise<Record<string, unknown> | null> {
  const row = await prisma.list.findFirst({
    where: { id: BigInt(listId), tenantId: BigInt(tenantId) },
  });
  return row ? serializeList(row) : null;
}

export async function createList(
  prisma: PrismaClient,
  tenantId: number,
  input: ListCreateInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown>> {
  const result = await prisma.$transaction(async (tx) => {
    const list = await (tx as PrismaClient).list.create({
      data: {
        tenantId: BigInt(tenantId),
        name: input.name,
        description: input.description ?? null,
        active: input.active,
        ownerUserId: input.owner_user_id ?? null,
        callerIdOverride: input.caller_id_override ?? null,
        callerIdName: input.caller_id_name ?? null,
        settings: (input.settings ?? DEFAULT_LIST_SETTINGS) as object,
      },
    });

    await auditList({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "list.created",
      tenantId,
      entityId: String(list.id),
      afterJson: serializeList(list),
      requestId,
      ip,
      userAgent: ua,
    });

    return list;
  });

  return serializeList(result);
}

export async function updateList(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
  input: ListUpdateInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown> | null> {
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);

  const existing = await prisma.list.findFirst({ where: { id: lid, tenantId: tid } });
  if (!existing) return null;

  // Merge settings if partial
  let settings: object = existing.settings as object ?? DEFAULT_LIST_SETTINGS;
  if (input.settings) {
    settings = { ...settings, ...input.settings };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = { settings };
  if (input.name !== undefined) data["name"] = input.name;
  if (input.description !== undefined) data["description"] = input.description;
  if (input.active !== undefined) data["active"] = input.active;
  if (input.owner_user_id !== undefined) data["ownerUserId"] = input.owner_user_id;
  if (input.caller_id_override !== undefined) data["callerIdOverride"] = input.caller_id_override;
  if (input.caller_id_name !== undefined) data["callerIdName"] = input.caller_id_name;

  const result = await prisma.$transaction(async (tx) => {
    const updated = await (tx as PrismaClient).list.update({
      where: { id: lid },
      data,
    });

    await auditList({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "list.updated",
      tenantId,
      entityId: String(listId),
      beforeJson: serializeList(existing),
      afterJson: serializeList(updated),
      requestId,
      ip,
      userAgent: ua,
    });

    return updated;
  });

  return serializeList(result);
}

export async function deleteList(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<boolean> {
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);

  const existing = await prisma.list.findFirst({ where: { id: lid, tenantId: tid } });
  if (!existing) return false;

  await prisma.$transaction(async (tx) => {
    await (tx as PrismaClient).list.delete({ where: { id: lid } });

    await auditList({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "list.deleted",
      tenantId,
      entityId: String(listId),
      beforeJson: serializeList(existing),
      requestId,
      ip,
      userAgent: ua,
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Campaign assignments
// ---------------------------------------------------------------------------

export async function listCampaignAssignments(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
): Promise<Record<string, unknown>[]> {
  const rows = await prisma.campaignList.findMany({
    where: { tenantId: BigInt(tenantId), listId: BigInt(listId) },
    orderBy: { priority: "asc" },
  });
  return rows.map(serializeCampaignLink);
}

export async function linkCampaign(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
  input: CampaignLinkInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown>> {
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);

  // Verify list exists in this tenant
  const list = await prisma.list.findFirst({ where: { id: lid, tenantId: tid } });
  if (!list) throw new Error("LIST_NOT_FOUND");

  const result = await prisma.$transaction(async (tx) => {
    const link = await (tx as PrismaClient).campaignList.upsert({
      where: {
        tenantId_campaignId_listId: {
          tenantId: tid,
          campaignId: input.campaign_id,
          listId: lid,
        },
      },
      create: {
        tenantId: tid,
        campaignId: input.campaign_id,
        listId: lid,
        priority: input.priority,
        active: input.active,
      },
      update: {
        priority: input.priority,
        active: input.active,
      },
    });

    await auditList({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "list.campaign.linked",
      tenantId,
      entityId: String(listId),
      afterJson: { campaign_id: input.campaign_id, priority: input.priority, active: input.active },
      requestId,
      ip,
      userAgent: ua,
    });

    return link;
  });

  return serializeCampaignLink(result);
}

export async function updateCampaignLink(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
  campaignId: string,
  input: CampaignLinkUpdateInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<Record<string, unknown> | null> {
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);

  const existing = await prisma.campaignList.findFirst({
    where: { tenantId: tid, listId: lid, campaignId },
  });
  if (!existing) return null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: Record<string, any> = {};
  if (input.priority !== undefined) data["priority"] = input.priority;
  if (input.active !== undefined) data["active"] = input.active;

  const result = await prisma.$transaction(async (tx) => {
    const updated = await (tx as PrismaClient).campaignList.update({
      where: {
        tenantId_campaignId_listId: { tenantId: tid, campaignId, listId: lid },
      },
      data,
    });

    await auditList({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "list.campaign.updated",
      tenantId,
      entityId: String(listId),
      beforeJson: serializeCampaignLink(existing),
      afterJson: serializeCampaignLink(updated),
      requestId,
      ip,
      userAgent: ua,
    });

    return updated;
  });

  return serializeCampaignLink(result);
}

export async function unlinkCampaign(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
  campaignId: string,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<boolean> {
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);

  const existing = await prisma.campaignList.findFirst({
    where: { tenantId: tid, listId: lid, campaignId },
  });
  if (!existing) return false;

  await prisma.$transaction(async (tx) => {
    await (tx as PrismaClient).campaignList.delete({
      where: {
        tenantId_campaignId_listId: { tenantId: tid, campaignId, listId: lid },
      },
    });

    await auditList({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "list.campaign.unlinked",
      tenantId,
      entityId: String(listId),
      beforeJson: serializeCampaignLink(existing),
      requestId,
      ip,
      userAgent: ua,
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Inline reset (sync, ≤SYNC_THRESHOLD)
// ---------------------------------------------------------------------------

export async function resetListSync(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<{ affected: number; duration_ms: number }> {
  const start = Date.now();
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);
  let affected = 0;
  let cursor = BigInt(0);

  while (true) {
    const result = await prisma.$executeRaw`
      UPDATE leads
      SET status = 'NEW',
          called_count = 0,
          last_called_at = NULL
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
        AND id > ${cursor}
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE}
    `;

    const batchAffected = Number(result);
    affected += batchAffected;
    if (batchAffected < BATCH_SIZE) break;

    // Get new cursor from last row
    const lastRow = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT MAX(id) AS id FROM leads
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
        AND status = 'NEW'
        AND id > ${cursor}
      LIMIT ${BATCH_SIZE}
    `;
    cursor = lastRow[0]?.id ?? BigInt(0);
    if (cursor === BigInt(0)) break;
  }

  const duration_ms = Date.now() - start;

  // Audit completion
  await auditList({
    tx: prisma,
    actorUserId,
    actorKind: "user",
    action: "list.reset.completed",
    tenantId,
    entityId: String(listId),
    afterJson: { affected, duration_ms, mode: "sync" },
    requestId,
    ip,
    userAgent: ua,
  });

  // Invalidate stats cache
  await invalidateStatsCache(tenantId, listId);

  return { affected, duration_ms };
}

// ---------------------------------------------------------------------------
// Inline purge (sync, ≤SYNC_THRESHOLD)
// ---------------------------------------------------------------------------

export async function purgeListSync(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<{ affected: number; duration_ms: number }> {
  const start = Date.now();
  const tid = BigInt(tenantId);
  const lid = BigInt(listId);
  let affected = 0;
  const now = new Date();

  let cursor = BigInt(0);
  while (true) {
    const result = await prisma.$executeRaw`
      UPDATE leads
      SET status = 'DELETED',
          deleted_at = ${now}
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at IS NULL
        AND id > ${cursor}
      ORDER BY id ASC
      LIMIT ${BATCH_SIZE}
    `;

    const batchAffected = Number(result);
    affected += batchAffected;
    if (batchAffected < BATCH_SIZE) break;

    const lastRow = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT MAX(id) AS id FROM leads
      WHERE tenant_id = ${tid}
        AND list_id = ${lid}
        AND deleted_at = ${now}
        AND id > ${cursor}
      LIMIT ${BATCH_SIZE}
    `;
    cursor = lastRow[0]?.id ?? BigInt(0);
    if (cursor === BigInt(0)) break;
  }

  const duration_ms = Date.now() - start;

  await auditList({
    tx: prisma,
    actorUserId,
    actorKind: "user",
    action: "list.purge.completed",
    tenantId,
    entityId: String(listId),
    afterJson: { affected, duration_ms, mode: "sync" },
    requestId,
    ip,
    userAgent: ua,
  });

  await invalidateStatsCache(tenantId, listId);

  return { affected, duration_ms };
}

// ---------------------------------------------------------------------------
// Count leads in a list (to decide sync vs async)
// ---------------------------------------------------------------------------

export async function countActiveLeads(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
): Promise<number> {
  // Cap at SYNC_THRESHOLD + 1 for fast overflow detection
  const rows = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*) AS n FROM (
      SELECT 1 FROM leads
      WHERE tenant_id = ${BigInt(tenantId)}
        AND list_id = ${BigInt(listId)}
        AND deleted_at IS NULL
      LIMIT ${SYNC_THRESHOLD + 1}
    ) sub
  `;
  return Number(rows[0]?.n ?? 0);
}

export const SYNC_LEAD_THRESHOLD = SYNC_THRESHOLD;

// ---------------------------------------------------------------------------
// Clone
// ---------------------------------------------------------------------------

export async function cloneList(
  prisma: PrismaClient,
  tenantId: number,
  sourceListId: number,
  input: CloneInput,
  actorUserId: number,
  requestId?: string,
  ip?: string,
  ua?: string,
): Promise<{ list: Record<string, unknown>; cloned_leads: number; duration_ms: number }> {
  const start = Date.now();
  const tid = BigInt(tenantId);
  const slid = BigInt(sourceListId);

  // Verify source exists
  const source = await prisma.list.findFirst({ where: { id: slid, tenantId: tid } });
  if (!source) throw new Error("LIST_NOT_FOUND");

  // Create new list
  const newList = await prisma.$transaction(async (tx) => {
    const created = await (tx as PrismaClient).list.create({
      data: {
        tenantId: tid,
        name: input.name,
        description: input.description ?? source.description,
        active: source.active,
        ownerUserId: source.ownerUserId,
        callerIdOverride: source.callerIdOverride,
        callerIdName: source.callerIdName,
        settings: source.settings as object,
        source: source.source,
      },
    });

    await auditList({
      tx: tx as PrismaClient,
      actorUserId,
      actorKind: "user",
      action: "list.cloned",
      tenantId,
      entityId: String(created.id),
      afterJson: { source_list_id: sourceListId, new_list_id: Number(created.id) },
      requestId,
      ip,
      userAgent: ua,
    });

    return created;
  });

  const newListId = newList.id;
  let cloned_leads = 0;
  let cursor = BigInt(0);

  // Clone leads in batches using raw INSERT INTO ... SELECT
  while (true) {
    const result = input.include_deleted
      ? await prisma.$executeRaw`
          INSERT INTO leads (
            tenant_id, list_id, status, phone_e164, phone_alt, phone_alt2,
            country_code, title, first_name, middle_initial, last_name,
            address1, address2, city, state, postal_code, email,
            date_of_birth, gender, comments, rank, owner_user_id,
            vendor_lead_code, source_id, custom_data, is_business,
            called_count, entry_at, modify_at, created_at, updated_at
          )
          SELECT
            tenant_id, ${newListId}, 'NEW', phone_e164, phone_alt, phone_alt2,
            country_code, title, first_name, middle_initial, last_name,
            address1, address2, city, state, postal_code, email,
            date_of_birth, gender, comments, rank, owner_user_id,
            vendor_lead_code, source_id, custom_data, is_business,
            0, NOW(6), NOW(6), NOW(6), NOW(6)
          FROM leads
          WHERE tenant_id = ${tid}
            AND list_id = ${slid}
            AND id > ${cursor}
          ORDER BY id ASC
          LIMIT ${BATCH_SIZE}
        `
      : await prisma.$executeRaw`
          INSERT INTO leads (
            tenant_id, list_id, status, phone_e164, phone_alt, phone_alt2,
            country_code, title, first_name, middle_initial, last_name,
            address1, address2, city, state, postal_code, email,
            date_of_birth, gender, comments, rank, owner_user_id,
            vendor_lead_code, source_id, custom_data, is_business,
            called_count, entry_at, modify_at, created_at, updated_at
          )
          SELECT
            tenant_id, ${newListId}, 'NEW', phone_e164, phone_alt, phone_alt2,
            country_code, title, first_name, middle_initial, last_name,
            address1, address2, city, state, postal_code, email,
            date_of_birth, gender, comments, rank, owner_user_id,
            vendor_lead_code, source_id, custom_data, is_business,
            0, NOW(6), NOW(6), NOW(6), NOW(6)
          FROM leads
          WHERE tenant_id = ${tid}
            AND list_id = ${slid}
            AND deleted_at IS NULL
            AND id > ${cursor}
          ORDER BY id ASC
          LIMIT ${BATCH_SIZE}
        `;

    const batchAffected = Number(result);
    cloned_leads += batchAffected;
    if (batchAffected < BATCH_SIZE) break;

    // Advance cursor
    const lastRow = await prisma.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM leads
      WHERE tenant_id = ${tid}
        AND list_id = ${slid}
        AND id > ${cursor}
      ORDER BY id ASC
      LIMIT 1
      OFFSET ${BATCH_SIZE - 1}
    `;
    if (!lastRow[0]) break;
    cursor = lastRow[0].id;
  }

  const duration_ms = Date.now() - start;

  return {
    list: serializeList(newList),
    cloned_leads,
    duration_ms,
  };
}

// ---------------------------------------------------------------------------
// Get list settings (for stats endpoint)
// ---------------------------------------------------------------------------

export async function getListSettings(
  prisma: PrismaClient,
  tenantId: number,
  listId: number,
): Promise<ListSettings | null> {
  const row = await prisma.list.findFirst({
    where: { id: BigInt(listId), tenantId: BigInt(tenantId) },
    select: { settings: true },
  });
  if (!row) return null;
  return (row.settings as ListSettings) ?? DEFAULT_LIST_SETTINGS;
}
