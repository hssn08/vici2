// X04 — Number Pool DID membership + quarantine service.

import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type {
  AddDidInput,
  DidMemberListQuery,
  DidMemberListResponse,
  DidMemberResponse,
  QuarantineDidInput,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Live Valkey counter stubs
// (real counters come from dialer; API reads them for display only)
// ---------------------------------------------------------------------------

async function getLiveCounters(
  _tenantId: number,
  _didId: bigint,
): Promise<{ dailyCalls: number; concurrent: number }> {
  // Phase 3.5: Valkey read of t:{tid}:did:{did_id}:daily_calls and
  // t:{tid}:did:{did_id}:concurrent — stubbed to 0 until dialer wires them.
  return { dailyCalls: 0, concurrent: 0 };
}

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDidMemberResponse(row: any, dailyCalls: number, concurrent: number): DidMemberResponse {
  const callCount7d = row.callCount7d ?? 0;
  const answerCount7d = row.answerCount7d ?? 0;
  const answerRate7d = callCount7d > 0 ? answerCount7d / callCount7d : 0;

  return {
    id: String(row.id),
    poolId: String(row.poolId),
    didId: String(row.didId),
    e164: row.did?.e164 ?? "",
    areaCode: row.areaCode ?? "",
    quarantined: row.quarantined,
    quarantinedAt: row.quarantinedAt instanceof Date ? row.quarantinedAt.toISOString() : row.quarantinedAt ?? null,
    quarantineReason: row.quarantineReason ?? null,
    firstUsedAt: row.firstUsedAt instanceof Date ? row.firstUsedAt.toISOString() : row.firstUsedAt ?? null,
    lastUsedAt: row.lastUsedAt instanceof Date ? row.lastUsedAt.toISOString() : row.lastUsedAt ?? null,
    callCount7d,
    answerCount7d,
    answerRate7d,
    callCount30d: row.callCount30d ?? 0,
    shortCallCount30d: row.shortCallCount30d ?? 0,
    complaintCount30d: row.complaintCount30d ?? 0,
    healthScore: row.healthScore ?? 100,
    attestLevel: row.attestLevel ?? "unknown",
    dailyCallCount: dailyCalls,
    concurrentCalls: concurrent,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------
// List pool DIDs
// ---------------------------------------------------------------------------

export async function listPoolDids(
  tenantId: number,
  poolId: bigint,
  query: DidMemberListQuery,
): Promise<DidMemberListResponse> {
  const db = getPrisma();
  const { page, pageSize, quarantined } = query;
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { poolId, tenantId: BigInt(tenantId) };
  if (quarantined !== "all") where.quarantined = quarantined === "true";

  const [rows, totalCount] = await Promise.all([
    db.numberPoolDid.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { createdAt: "asc" },
      include: { did: { select: { e164: true } } },
    }),
    db.numberPoolDid.count({ where }),
  ]);

  const members = await Promise.all(
    rows.map(async (r) => {
      const { dailyCalls, concurrent } = await getLiveCounters(tenantId, r.didId);
      return toDidMemberResponse(r, dailyCalls, concurrent);
    }),
  );

  return {
    data: members,
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

// ---------------------------------------------------------------------------
// Add DID to pool
// ---------------------------------------------------------------------------

export async function addDidToPool(
  tenantId: number,
  actorId: number,
  poolId: bigint,
  input: AddDidInput,
): Promise<DidMemberResponse | { error: string; status: number }> {
  const db = getPrisma();
  const didId = BigInt(input.didId);

  // Verify pool exists and belongs to tenant
  const pool = await db.numberPool.findFirst({
    where: { id: poolId, tenantId: BigInt(tenantId) },
  });
  if (!pool) return { error: "Pool not found", status: 404 };

  // Verify DID belongs to tenant
  const did = await db.didNumber.findFirst({
    where: { id: didId, tenantId: BigInt(tenantId) },
  });
  if (!did) return { error: "DID not found or belongs to different tenant", status: 404 };

  // Extract area code from E.164 (US format: +1NXX...)
  const areaCode = did.e164.length >= 5 ? did.e164.slice(2, 5) : "";

  let membership;
  try {
    membership = await db.numberPoolDid.create({
      data: {
        poolId,
        didId,
        tenantId: BigInt(tenantId),
        areaCode,
        attestLevel: input.attestLevel as "A" | "B" | "C" | "unknown",
      },
      include: { did: { select: { e164: true } } },
    });
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "P2002") {
      return { error: "DID is already a member of this pool", status: 409 };
    }
    throw err;
  }

  await audit({
    tx: db,
    actorUserId: actorId,
    actorKind: "user",
    action: "number_pool.did.added",
    tenantId,
    entityType: "number_pool",
    entityId: String(poolId),
    afterJson: { didId: String(didId), e164: did.e164 },
  });

  return toDidMemberResponse(membership, 0, 0);
}

// ---------------------------------------------------------------------------
// Remove DID from pool
// ---------------------------------------------------------------------------

export async function removeDidFromPool(
  tenantId: number,
  actorId: number,
  poolId: bigint,
  didId: bigint,
): Promise<{ removed: boolean }> {
  const db = getPrisma();

  const membership = await db.numberPoolDid.findFirst({
    where: { poolId, didId, tenantId: BigInt(tenantId) },
    include: { did: { select: { e164: true } } },
  });
  if (!membership) return { removed: false };

  await db.numberPoolDid.delete({ where: { id: membership.id } });

  await audit({
    tx: db,
    actorUserId: actorId,
    actorKind: "user",
    action: "number_pool.did.removed",
    tenantId,
    entityType: "number_pool",
    entityId: String(poolId),
    afterJson: { didId: String(didId), e164: membership.did.e164 },
  });

  return { removed: true };
}

// ---------------------------------------------------------------------------
// Get single DID stats
// ---------------------------------------------------------------------------

export async function getDidStats(
  tenantId: number,
  poolId: bigint,
  didId: bigint,
): Promise<DidMemberResponse | null> {
  const db = getPrisma();

  const membership = await db.numberPoolDid.findFirst({
    where: { poolId, didId, tenantId: BigInt(tenantId) },
    include: { did: { select: { e164: true } } },
  });
  if (!membership) return null;

  const { dailyCalls, concurrent } = await getLiveCounters(tenantId, didId);
  return toDidMemberResponse(membership, dailyCalls, concurrent);
}

// ---------------------------------------------------------------------------
// Quarantine DID
// ---------------------------------------------------------------------------

export async function quarantineDid(
  tenantId: number,
  actorId: number,
  poolId: bigint,
  didId: bigint,
  input: QuarantineDidInput,
): Promise<{ ok: boolean }> {
  const db = getPrisma();

  const membership = await db.numberPoolDid.findFirst({
    where: { poolId, didId, tenantId: BigInt(tenantId) },
    include: { did: { select: { e164: true } } },
  });
  if (!membership) return { ok: false };

  await db.numberPoolDid.update({
    where: { id: membership.id },
    data: {
      quarantined: true,
      quarantinedAt: new Date(),
      quarantineReason: (input.reason ?? "manual") as "low_answer_rate" | "high_complaint_rate" | "manual" | "label_detected",
      quarantineMeta: input.meta ?? null,
    },
  });

  await audit({
    tx: db,
    actorUserId: actorId,
    actorKind: "user",
    action: "number_pool.did.quarantined",
    tenantId,
    entityType: "number_pool",
    entityId: String(poolId),
    afterJson: { didId: String(didId), reason: input.reason ?? "manual", meta: input.meta },
  });

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Unquarantine DID
// ---------------------------------------------------------------------------

export async function unquarantineDid(
  tenantId: number,
  actorId: number,
  poolId: bigint,
  didId: bigint,
): Promise<{ ok: boolean }> {
  const db = getPrisma();

  const membership = await db.numberPoolDid.findFirst({
    where: { poolId, didId, tenantId: BigInt(tenantId) },
    include: { did: { select: { e164: true } } },
  });
  if (!membership) return { ok: false };

  await db.numberPoolDid.update({
    where: { id: membership.id },
    data: {
      quarantined: false,
      quarantinedAt: null,
      quarantineReason: null,
      quarantineMeta: null,
    },
  });

  await audit({
    tx: db,
    actorUserId: actorId,
    actorKind: "user",
    action: "number_pool.did.unquarantined",
    tenantId,
    entityType: "number_pool",
    entityId: String(poolId),
    afterJson: { didId: String(didId), e164: membership.did.e164 },
  });

  return { ok: true };
}
