// X04 — Number Pool CRUD service.

import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type {
  PoolCreateInput,
  PoolUpdateInput,
  PoolListQuery,
  PoolResponse,
  PoolListResponse,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toPoolResponse(row: any, activeDids: number, quarantinedDids: number): PoolResponse {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    name: row.name,
    description: row.description ?? null,
    strategy: row.strategy,
    arFloor: Number(row.arFloor),
    arMinSample: row.arMinSample,
    crCeil: Number(row.crCeil),
    crMinSample: row.crMinSample,
    dailyCap: row.dailyCap,
    minActiveSize: row.minActiveSize,
    maxConcurrent: row.maxConcurrent,
    active: row.active,
    activeDids,
    quarantinedDids,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// List pools
// ---------------------------------------------------------------------------

export async function listPools(tenantId: number, query: PoolListQuery): Promise<PoolListResponse> {
  const db = getPrisma();
  const { page, pageSize, active, search } = query;
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { tenantId: BigInt(tenantId) };
  if (active !== "all") where.active = active === "true";
  if (search) where.name = { contains: search };

  const [rows, totalCount] = await Promise.all([
    db.numberPool.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
      include: {
        _count: { select: { dids: true } },
      },
    }),
    db.numberPool.count({ where }),
  ]);

  const poolIds = rows.map((r) => r.id);
  let quarantinedMap: Map<bigint, number> = new Map();

  if (poolIds.length > 0) {
    const qCounts = await db.numberPoolDid.groupBy({
      by: ["poolId"],
      where: { poolId: { in: poolIds }, quarantined: true },
      _count: { id: true },
    });
    quarantinedMap = new Map(qCounts.map((q) => [q.poolId, q._count.id]));
  }

  return {
    data: rows.map((r) => {
      const totalInPool = (r as { _count: { dids: number } })._count.dids;
      const qCount = quarantinedMap.get(r.id) ?? 0;
      const activeCount = totalInPool - qCount;
      return toPoolResponse(r, activeCount, qCount);
    }),
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Get pool
// ---------------------------------------------------------------------------

export async function getPool(tenantId: number, id: bigint): Promise<PoolResponse | null> {
  const db = getPrisma();
  const pool = await db.numberPool.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  if (!pool) return null;

  const [activeCount, quarantinedCount] = await Promise.all([
    db.numberPoolDid.count({ where: { poolId: id, quarantined: false } }),
    db.numberPoolDid.count({ where: { poolId: id, quarantined: true } }),
  ]);

  return toPoolResponse(pool, activeCount, quarantinedCount);
}

// ---------------------------------------------------------------------------
// Create pool
// ---------------------------------------------------------------------------

export async function createPool(
  tenantId: number,
  actorId: number,
  input: PoolCreateInput,
): Promise<PoolResponse> {
  const db = getPrisma();

  const pool = await db.numberPool.create({
    data: {
      tenantId: BigInt(tenantId),
      name: input.name,
      description: input.description ?? null,
      strategy: input.strategy as "health_weighted_lru" | "round_robin" | "random" | "least_recently_used",
      arFloor: input.arFloor,
      arMinSample: input.arMinSample,
      crCeil: input.crCeil,
      crMinSample: input.crMinSample,
      dailyCap: input.dailyCap,
      minActiveSize: input.minActiveSize,
      maxConcurrent: input.maxConcurrent,
    },
  });

  await audit({
    tx: db,
    actorUserId: actorId,
    actorKind: "user",
    action: "number_pool.created",
    tenantId,
    entityType: "number_pool",
    entityId: String(pool.id),
    afterJson: { name: pool.name, strategy: pool.strategy },
  });

  return toPoolResponse(pool, 0, 0);
}

// ---------------------------------------------------------------------------
// Update pool
// ---------------------------------------------------------------------------

export async function updatePool(
  tenantId: number,
  actorId: number,
  id: bigint,
  input: PoolUpdateInput,
): Promise<PoolResponse | null> {
  const db = getPrisma();

  const existing = await db.numberPool.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  if (!existing) return null;

  const updated = await db.numberPool.update({
    where: { id },
    data: {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.strategy !== undefined && { strategy: input.strategy as "health_weighted_lru" | "round_robin" | "random" | "least_recently_used" }),
      ...(input.arFloor !== undefined && { arFloor: input.arFloor }),
      ...(input.arMinSample !== undefined && { arMinSample: input.arMinSample }),
      ...(input.crCeil !== undefined && { crCeil: input.crCeil }),
      ...(input.crMinSample !== undefined && { crMinSample: input.crMinSample }),
      ...(input.dailyCap !== undefined && { dailyCap: input.dailyCap }),
      ...(input.minActiveSize !== undefined && { minActiveSize: input.minActiveSize }),
      ...(input.maxConcurrent !== undefined && { maxConcurrent: input.maxConcurrent }),
    },
  });

  await audit({
    tx: db,
    actorUserId: actorId,
    actorKind: "user",
    action: "number_pool.updated",
    tenantId,
    entityType: "number_pool",
    entityId: String(id),
    beforeJson: { name: existing.name, strategy: existing.strategy },
    afterJson: { name: updated.name, strategy: updated.strategy },
  });

  const [activeCount, quarantinedCount] = await Promise.all([
    db.numberPoolDid.count({ where: { poolId: id, quarantined: false } }),
    db.numberPoolDid.count({ where: { poolId: id, quarantined: true } }),
  ]);

  return toPoolResponse(updated, activeCount, quarantinedCount);
}

// ---------------------------------------------------------------------------
// Delete pool (soft: active = false)
// ---------------------------------------------------------------------------

export async function deletePool(
  tenantId: number,
  actorId: number,
  id: bigint,
): Promise<{ deleted: boolean; conflict?: boolean }> {
  const db = getPrisma();

  const existing = await db.numberPool.findFirst({
    where: { id, tenantId: BigInt(tenantId) },
  });
  if (!existing) return { deleted: false };

  // Check if any campaign references this pool
  const campaignRef = await db.campaign.findFirst({
    where: { numberPoolId: id },
    select: { id: true },
  });
  if (campaignRef) {
    return { deleted: false, conflict: true };
  }

  await db.numberPool.update({
    where: { id },
    data: { active: false },
  });

  await audit({
    tx: db,
    actorUserId: actorId,
    actorKind: "user",
    action: "number_pool.deleted",
    tenantId,
    entityType: "number_pool",
    entityId: String(id),
    beforeJson: { name: existing.name },
  });

  return { deleted: true };
}
