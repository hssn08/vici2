// M07 — Pause code service layer.

import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type {
  PauseCodeCreateInput,
  PauseCodeUpdateInput,
  PauseCodeListQuery,
  PauseCodeResponse,
  PauseCodeListResponse,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPauseCodeResponse(row: any): PauseCodeResponse {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    campaignId: row.campaignId ?? null,
    code: row.code,
    name: row.name,
    billable: row.billable,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listPauseCodes(
  tenantId: number,
  query: PauseCodeListQuery,
): Promise<PauseCodeListResponse> {
  const db = getPrisma();
  const { page, pageSize, campaignId, search } = query;
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { tenantId: BigInt(tenantId) };

  if (campaignId === "__GLOBAL__") {
    where.campaignId = null;
  } else if (campaignId) {
    where.campaignId = campaignId;
  }

  if (search) {
    where.OR = [
      { code: { contains: search } },
      { name: { contains: search } },
    ];
  }

  const [rows, totalCount] = await Promise.all([
    db.pauseCode.findMany({ where, skip, take: pageSize, orderBy: { code: "asc" } }),
    db.pauseCode.count({ where }),
  ]);

  return {
    data: rows.map(toPauseCodeResponse),
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

export async function getPauseCode(
  tenantId: number,
  id: bigint,
): Promise<PauseCodeResponse | null> {
  const db = getPrisma();
  const row = await db.pauseCode.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  return row ? toPauseCodeResponse(row) : null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createPauseCode(
  tenantId: number,
  actorUserId: number,
  data: PauseCodeCreateInput,
): Promise<PauseCodeResponse> {
  const db = getPrisma();
  const row = await db.$transaction(async (tx) => {
    const created = await tx.pauseCode.create({
      data: {
        tenantId: BigInt(tenantId),
        campaignId: data.campaignId ?? null,
        code: data.code,
        name: data.name,
        billable: data.billable,
      },
    });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "pause_code.created",
      tenantId: BigInt(tenantId),
      entityType: "pause_code",
      entityId: String(created.id),
      afterJson: { code: created.code, name: created.name, billable: created.billable, campaignId: created.campaignId },
    });
    return created;
  });
  return toPauseCodeResponse(row);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updatePauseCode(
  tenantId: number,
  actorUserId: number,
  id: bigint,
  data: PauseCodeUpdateInput,
): Promise<PauseCodeResponse | null> {
  const db = getPrisma();
  const existing = await db.pauseCode.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  if (!existing) return null;

  const row = await db.$transaction(async (tx) => {
    const updated = await tx.pauseCode.update({
      where: { id },
      data: {
        ...(data.code !== undefined && { code: data.code }),
        ...(data.name !== undefined && { name: data.name }),
        ...(data.billable !== undefined && { billable: data.billable }),
        ...(data.campaignId !== undefined && { campaignId: data.campaignId }),
      },
    });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "pause_code.updated",
      tenantId: BigInt(tenantId),
      entityType: "pause_code",
      entityId: String(id),
      beforeJson: { code: existing.code, name: existing.name, billable: existing.billable, campaignId: existing.campaignId },
      afterJson: { code: updated.code, name: updated.name, billable: updated.billable, campaignId: updated.campaignId },
    });
    return updated;
  });
  return toPauseCodeResponse(row);
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

export async function deletePauseCode(
  tenantId: number,
  actorUserId: number,
  id: bigint,
): Promise<boolean> {
  const db = getPrisma();
  const existing = await db.pauseCode.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  if (!existing) return false;

  await db.$transaction(async (tx) => {
    await tx.pauseCode.delete({ where: { id } });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "pause_code.deleted",
      tenantId: BigInt(tenantId),
      entityType: "pause_code",
      entityId: String(id),
      beforeJson: { code: existing.code, name: existing.name },
    });
  });
  return true;
}
