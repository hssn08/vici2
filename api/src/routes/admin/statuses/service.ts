// M07 — Status service layer.

import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type {
  StatusCreateInput,
  StatusUpdateInput,
  StatusListQuery,
  StatusResponse,
  StatusListResponse,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toStatusResponse(row: any): StatusResponse {
  return {
    tenantId: String(row.tenantId),
    campaignId: row.campaignId,
    status: row.status,
    description: row.description,
    selectable: row.selectable,
    humanAnswered: row.humanAnswered,
    sale: row.sale,
    dnc: row.dnc,
    callback: row.callback,
    notInterested: row.notInterested,
    hotkey: row.hotkey ?? null,
    recycleDelaySeconds: row.recycleDelaySeconds ?? null,
    category: row.category ?? null,
    systemOwner: row.systemOwner ?? null,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listStatuses(
  tenantId: number,
  query: StatusListQuery,
): Promise<StatusListResponse> {
  const db = getPrisma();
  const { page, pageSize, campaignId, search, category, selectable } = query;
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { tenantId: BigInt(tenantId) };

  if (campaignId) where.campaignId = campaignId;
  if (category) where.category = category;
  if (selectable !== "all") where.selectable = selectable === "true";
  if (search) {
    where.OR = [
      { status: { contains: search } },
      { description: { contains: search } },
    ];
  }

  const [rows, totalCount] = await Promise.all([
    db.status.findMany({ where, skip, take: pageSize, orderBy: [{ campaignId: "asc" }, { status: "asc" }] }),
    db.status.count({ where }),
  ]);

  return {
    data: rows.map(toStatusResponse),
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Get one by composite key
// ---------------------------------------------------------------------------

export async function getStatus(
  tenantId: number,
  campaignId: string,
  statusCode: string,
): Promise<StatusResponse | null> {
  const db = getPrisma();
  const row = await db.status.findUnique({
    where: {
      tenantId_campaignId_status: {
        tenantId: BigInt(tenantId),
        campaignId,
        status: statusCode,
      },
    },
  });
  return row ? toStatusResponse(row) : null;
}

// ---------------------------------------------------------------------------
// Hotkey conflict check helper
// ---------------------------------------------------------------------------

async function checkHotkeyConflict(
  tenantId: number,
  campaignId: string,
  hotkey: string,
  excludeStatus?: string,
): Promise<string | null> {
  const db = getPrisma();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = {
    tenantId: BigInt(tenantId),
    campaignId,
    hotkey,
  };
  if (excludeStatus) {
    where.status = { not: excludeStatus };
  }
  const conflict = await db.status.findFirst({ where });
  return conflict ? conflict.status : null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createStatus(
  tenantId: number,
  actorUserId: number,
  data: StatusCreateInput,
): Promise<{ result?: StatusResponse; hotkeyConflict?: string }> {
  const db = getPrisma();

  // Hotkey conflict check
  if (data.hotkey) {
    const conflictCode = await checkHotkeyConflict(tenantId, data.campaignId, data.hotkey);
    if (conflictCode) {
      return { hotkeyConflict: conflictCode };
    }
  }

  const row = await db.$transaction(async (tx) => {
    const created = await tx.status.create({
      data: {
        tenantId: BigInt(tenantId),
        campaignId: data.campaignId,
        status: data.status,
        description: data.description,
        selectable: data.selectable,
        humanAnswered: data.humanAnswered,
        sale: data.sale,
        dnc: data.dnc,
        callback: data.callback,
        notInterested: data.notInterested,
        hotkey: data.hotkey,
        recycleDelaySeconds: data.recycleDelaySeconds,
        category: data.category,
      },
    });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "status.created",
      tenantId: BigInt(tenantId),
      entityType: "status",
      entityId: `${data.campaignId}:${data.status}`,
      afterJson: { status: created.status, campaignId: created.campaignId },
    });
    return created;
  });
  return { result: toStatusResponse(row) };
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateStatus(
  tenantId: number,
  actorUserId: number,
  campaignId: string,
  statusCode: string,
  data: StatusUpdateInput,
): Promise<{ result?: StatusResponse | null; hotkeyConflict?: string }> {
  const db = getPrisma();

  const existing = await db.status.findUnique({
    where: {
      tenantId_campaignId_status: {
        tenantId: BigInt(tenantId),
        campaignId,
        status: statusCode,
      },
    },
  });
  if (!existing) return { result: null };

  // Hotkey conflict check (exclude current status)
  if (data.hotkey) {
    const conflictCode = await checkHotkeyConflict(tenantId, campaignId, data.hotkey, statusCode);
    if (conflictCode) {
      return { hotkeyConflict: conflictCode };
    }
  }

  const row = await db.$transaction(async (tx) => {
    const updated = await tx.status.update({
      where: {
        tenantId_campaignId_status: {
          tenantId: BigInt(tenantId),
          campaignId,
          status: statusCode,
        },
      },
      data: {
        ...(data.description !== undefined && { description: data.description }),
        ...(data.selectable !== undefined && { selectable: data.selectable }),
        ...(data.humanAnswered !== undefined && { humanAnswered: data.humanAnswered }),
        ...(data.sale !== undefined && { sale: data.sale }),
        ...(data.dnc !== undefined && { dnc: data.dnc }),
        ...(data.callback !== undefined && { callback: data.callback }),
        ...(data.notInterested !== undefined && { notInterested: data.notInterested }),
        ...(data.hotkey !== undefined && { hotkey: data.hotkey }),
        ...(data.recycleDelaySeconds !== undefined && { recycleDelaySeconds: data.recycleDelaySeconds }),
        ...(data.category !== undefined && { category: data.category }),
      },
    });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "status.updated",
      tenantId: BigInt(tenantId),
      entityType: "status",
      entityId: `${campaignId}:${statusCode}`,
      beforeJson: { status: existing.status, campaignId: existing.campaignId },
      afterJson: { status: updated.status, campaignId: updated.campaignId },
    });
    return updated;
  });
  return { result: toStatusResponse(row) };
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export type DeleteStatusResult =
  | { ok: true }
  | { notFound: true }
  | { systemProtected: string };

export async function deleteStatus(
  tenantId: number,
  actorUserId: number,
  campaignId: string,
  statusCode: string,
): Promise<DeleteStatusResult> {
  const db = getPrisma();

  const existing = await db.status.findUnique({
    where: {
      tenantId_campaignId_status: {
        tenantId: BigInt(tenantId),
        campaignId,
        status: statusCode,
      },
    },
  });
  if (!existing) return { notFound: true };
  if (existing.systemOwner !== null) {
    return { systemProtected: existing.systemOwner };
  }

  await db.$transaction(async (tx) => {
    await tx.status.delete({
      where: {
        tenantId_campaignId_status: {
          tenantId: BigInt(tenantId),
          campaignId,
          status: statusCode,
        },
      },
    });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "status.deleted",
      tenantId: BigInt(tenantId),
      entityType: "status",
      entityId: `${campaignId}:${statusCode}`,
      beforeJson: { status: existing.status, campaignId: existing.campaignId },
    });
  });
  return { ok: true };
}
