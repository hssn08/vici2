// M06 — DID number service layer.
//
// Business logic for CRUD + bulk CSV import of did_numbers.
// All mutations emit audit events via the existing audit() helper.
//
// Note: defaultLang / ivrTimeoutSec are I02 amendments in schema.prisma
// but not yet in the generated Prisma client; we cast via `as never` until
// `prisma generate` runs on the updated schema.

import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type {
  DidCreateInput,
  DidUpdateInput,
  DidListQuery,
  DidResponse,
  DidListResponse,
  DidBulkRow,
  BulkImportResult,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Response mapper
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toDidResponse(row: any): DidResponse {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    e164: row.e164,
    carrierId: String(row.carrierId),
    routeKind: row.routeKind,
    routeTarget: row.routeTarget,
    callerIdName: row.callerIdName ?? null,
    active: row.active,
    defaultLang: row.defaultLang ?? "en",
    ivrTimeoutSec: row.ivrTimeoutSec ?? 300,
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// DID CRUD
// ---------------------------------------------------------------------------

export async function listDids(tenantId: number, query: DidListQuery): Promise<DidListResponse> {
  const db = getPrisma();
  const { page, pageSize, carrierId, routeKind, active, search } = query;
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { tenantId: BigInt(tenantId) };
  if (carrierId) where.carrierId = carrierId;
  if (routeKind) where.routeKind = routeKind;
  if (active !== "all") where.active = active === "true";
  if (search) where.e164 = { contains: search };

  const [rows, totalCount] = await Promise.all([
    db.didNumber.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { e164: "asc" },
    }),
    db.didNumber.count({ where }),
  ]);

  return {
    data: rows.map(toDidResponse),
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

export async function getDid(tenantId: number, didId: bigint): Promise<DidResponse | null> {
  const db = getPrisma();
  const row = await db.didNumber.findFirst({
    where: { id: didId, tenantId: BigInt(tenantId) },
  });
  return row ? toDidResponse(row) : null;
}

export async function createDid(
  tenantId: number,
  actorUserId: number,
  input: DidCreateInput,
): Promise<DidResponse> {
  const db = getPrisma();

  const row = await db.$transaction(async (tx) => {
    const created = await tx.didNumber.create({
      // Cast to never: defaultLang / ivrTimeoutSec are I02 amendments not yet
      // reflected in the generated Prisma client — remove cast after `prisma generate`
      data: {
        tenantId: BigInt(tenantId),
        e164: input.e164,
        carrierId: input.carrierId,
        routeKind: input.routeKind as never,
        routeTarget: input.routeTarget,
        callerIdName: input.callerIdName ?? null,
        active: input.active,
        defaultLang: input.defaultLang,
        ivrTimeoutSec: input.ivrTimeoutSec,
      } as never,
    });

    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "did.created",
      tenantId,
      entityType: "did_number",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entityId: String((created as any).id),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      afterJson: { e164: (created as any).e164, routeKind: (created as any).routeKind, routeTarget: (created as any).routeTarget },
    });

    return created;
  });

  return toDidResponse(row);
}

export async function updateDid(
  tenantId: number,
  actorUserId: number,
  didId: bigint,
  input: DidUpdateInput,
): Promise<DidResponse | null> {
  const db = getPrisma();

  const existing = await db.didNumber.findFirst({
    where: { id: didId, tenantId: BigInt(tenantId) },
  });
  if (!existing) return null;

  const row = await db.$transaction(async (tx) => {
    const updated = await tx.didNumber.update({
      where: { id: didId },
      // Cast to never: same I02 amendment issue
      data: {
        ...(input.e164 !== undefined && { e164: input.e164 }),
        ...(input.carrierId !== undefined && { carrierId: input.carrierId }),
        ...(input.routeKind !== undefined && { routeKind: input.routeKind as never }),
        ...(input.routeTarget !== undefined && { routeTarget: input.routeTarget }),
        ...(input.callerIdName !== undefined && { callerIdName: input.callerIdName ?? null }),
        ...(input.active !== undefined && { active: input.active }),
        ...(input.defaultLang !== undefined && { defaultLang: input.defaultLang }),
        ...(input.ivrTimeoutSec !== undefined && { ivrTimeoutSec: input.ivrTimeoutSec }),
      } as never,
    });

    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "did.updated",
      tenantId,
      entityType: "did_number",
      entityId: String(didId),
      beforeJson: { e164: existing.e164, routeKind: existing.routeKind },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      afterJson: { e164: (updated as any).e164, routeKind: (updated as any).routeKind, routeTarget: (updated as any).routeTarget },
    });

    return updated;
  });

  return toDidResponse(row);
}

export async function deleteDid(
  tenantId: number,
  actorUserId: number,
  didId: bigint,
): Promise<boolean> {
  const db = getPrisma();

  const existing = await db.didNumber.findFirst({
    where: { id: didId, tenantId: BigInt(tenantId) },
  });
  if (!existing) return false;

  await db.$transaction(async (tx) => {
    await tx.didNumber.delete({ where: { id: didId } });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "did.deleted",
      tenantId,
      entityType: "did_number",
      entityId: String(didId),
      beforeJson: { e164: existing.e164 },
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Bulk CSV import
// ---------------------------------------------------------------------------

/**
 * Parse raw CSV text into rows.
 * Expects header row: e164,carrier_id,route_kind,route_target[,active][,default_lang]
 */
export function parseCsvRows(csvText: string): Array<Record<string, string>> {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const headerLine = lines[0] ?? "";
  const headers = headerLine.split(",").map((h) => h.trim().toLowerCase());
  const rows: Array<Record<string, string>> = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const vals = line.split(",").map((v) => v.trim());
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h] = vals[idx] ?? "";
    });
    rows.push(row);
  }

  return rows;
}

export async function bulkImportDids(
  tenantId: number,
  actorUserId: number,
  rows: DidBulkRow[],
): Promise<BulkImportResult> {
  const db = getPrisma();
  let inserted = 0;
  let updated = 0;
  const errors: BulkImportResult["errors"] = [];

  let rowIndex = 0;
  for (const row of rows) {
    const i = rowIndex++;
    try {
      const existing = await db.didNumber.findFirst({
        where: { tenantId: BigInt(tenantId), e164: row.e164 },
      });

      if (existing) {
        await db.$transaction(async (tx) => {
          await tx.didNumber.update({
            where: { id: existing.id },
            data: {
              carrierId: row.carrier_id,
              routeKind: row.route_kind as never,
              routeTarget: row.route_target,
              active: row.active as unknown as boolean,
              defaultLang: row.default_lang ?? "en",
            } as never,
          });
          await audit({
            tx,
            actorUserId: BigInt(actorUserId),
            actorKind: "user",
            action: "did.updated",
            tenantId,
            entityType: "did_number",
            entityId: String(existing.id),
            beforeJson: { e164: existing.e164, routeKind: existing.routeKind },
            afterJson: { e164: row.e164, source: "bulk_import" },
          });
        });
        updated++;
      } else {
        await db.$transaction(async (tx) => {
          const created = await tx.didNumber.create({
            data: {
              tenantId: BigInt(tenantId),
              e164: row.e164,
              carrierId: row.carrier_id,
              routeKind: row.route_kind as never,
              routeTarget: row.route_target,
              active: row.active as unknown as boolean,
              defaultLang: row.default_lang ?? "en",
            } as never,
          });
          await audit({
            tx,
            actorUserId: BigInt(actorUserId),
            actorKind: "user",
            action: "did.created",
            tenantId,
            entityType: "did_number",
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            entityId: String((created as any).id),
            afterJson: { e164: row.e164, source: "bulk_import" },
          });
        });
        inserted++;
      }
    } catch (err) {
      errors.push({ row: i + 2, message: (err as Error).message });
    }
  }

  // Single audit entry for the bulk operation summary
  try {
    await audit({
      tx: db,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "did.bulk_imported",
      tenantId,
      entityType: "did_number",
      entityId: null,
      afterJson: { inserted, updated, errors_count: errors.length },
    });
  } catch {
    // Non-fatal
  }

  return { inserted, updated, errors };
}
