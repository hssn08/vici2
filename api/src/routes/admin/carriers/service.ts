// M06 — Carrier + Gateway service layer.
//
// Business logic for CRUD on carriers and gateways tables.
// Credential fields are AES-GCM-256 encrypted (inline, no F05 package dep).
// All mutations emit audit events via the existing audit() helper.

import crypto from "node:crypto";
import { getPrisma } from "../../../lib/prisma.js";
import { audit } from "../../../auth/audit.js";
import type {
  CarrierCreateInput,
  CarrierUpdateInput,
  CarrierListQuery,
  CarrierResponse,
  CarrierListResponse,
  GatewayCreateInput,
  GatewayUpdateInput,
  GatewayResponse,
  CarrierHealthResponse,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Encryption helpers (Phase-1 inline AES-GCM-256 per F05 §4.6 Path A)
// ---------------------------------------------------------------------------

const ALG = "aes-256-gcm";
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function getKekBuf(): Buffer {
  const hex = process.env.KEK_HEX ?? "";
  if (hex.length === 64) return Buffer.from(hex, "hex");
  // Development fallback — deterministic but NOT secure; prod must set KEK_HEX.
  return Buffer.alloc(KEY_LENGTH, 0x42);
}

function getKekVersion(): number {
  return Number(process.env.KEK_VERSION ?? 1);
}

export function encryptCredential(plaintext: string): Buffer {
  const kek = getKekBuf();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALG, kek, iv) as crypto.CipherGCM;
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Layout: iv(12) | tag(16) | body
  return Buffer.concat([iv, tag, body]);
}

export function decryptCredential(ct: Buffer): string {
  const kek = getKekBuf();
  const iv = ct.subarray(0, IV_LENGTH);
  const tag = ct.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const body = ct.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALG, kek, iv) as crypto.DecipherGCM;
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

// ---------------------------------------------------------------------------
// Response mapper — strips credential bytes, adds credentialStatus
// ---------------------------------------------------------------------------

function toCarrierResponse(
  row: {
    id: bigint;
    tenantId: bigint;
    name: string;
    kind: string;
    proxy: string;
    usernameCt: Buffer | null;
    passwordCt: Buffer | null;
    kekVersion: number;
    register: boolean;
    callerIdE164: string | null;
    active: boolean;
    ipAllowlist: unknown;
    configJson: unknown;
    sendPai: boolean;
    isEmergency: boolean;
    maxConcurrent: number | null;
    notes: unknown;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    _count?: { gateways: number };
  },
): CarrierResponse {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    name: row.name,
    kind: row.kind,
    proxy: row.proxy,
    credentialStatus: row.usernameCt || row.passwordCt ? "set" : "unset",
    kekVersion: row.kekVersion,
    register: row.register,
    callerIdE164: row.callerIdE164,
    active: row.active,
    ipAllowlist: row.ipAllowlist,
    configJson: row.configJson,
    sendPai: row.sendPai,
    isEmergency: row.isEmergency,
    maxConcurrent: row.maxConcurrent,
    notes: row.notes,
    version: row.version,
    gatewayCount: row._count?.gateways,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toGatewayResponse(row: {
  id: bigint;
  tenantId: bigint;
  carrierId: bigint;
  name: string;
  proxy: string;
  realm: string | null;
  fromUser: string | null;
  fromDomain: string | null;
  extension: string | null;
  register: boolean;
  expireSeconds: number;
  retrySeconds: number;
  transport: string;
  priority: number;
  active: boolean;
  templateOverrides: unknown;
  weight: number;
  maxConcurrent: number | null;
  version: number;
  costPerMinCents: number | null;
  createdAt: Date;
  updatedAt: Date;
}): GatewayResponse {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    carrierId: String(row.carrierId),
    name: row.name,
    proxy: row.proxy,
    realm: row.realm,
    fromUser: row.fromUser,
    fromDomain: row.fromDomain,
    extension: row.extension,
    register: row.register,
    expireSeconds: row.expireSeconds,
    retrySeconds: row.retrySeconds,
    transport: row.transport,
    priority: row.priority,
    active: row.active,
    templateOverrides: row.templateOverrides,
    weight: row.weight,
    maxConcurrent: row.maxConcurrent,
    version: row.version,
    costPerMinCents: row.costPerMinCents,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Kind mapping (frontend uses "telnyx-creds" / "telnyx-ip"; Prisma enum uses
// underscores for those two variants)
// ---------------------------------------------------------------------------

function toPrismaKind(kind: string): string {
  if (kind === "telnyx-creds") return "telnyx_creds";
  if (kind === "telnyx-ip") return "telnyx_ip";
  return kind;
}

function fromPrismaKind(kind: string): string {
  if (kind === "telnyx_creds") return "telnyx-creds";
  if (kind === "telnyx_ip") return "telnyx-ip";
  return kind;
}

// ---------------------------------------------------------------------------
// Carrier CRUD
// ---------------------------------------------------------------------------

export async function listCarriers(
  tenantId: number,
  query: CarrierListQuery,
): Promise<CarrierListResponse> {
  const db = getPrisma();
  const { page, pageSize, active, kind, search } = query;
  const skip = (page - 1) * pageSize;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const where: Record<string, any> = { tenantId: BigInt(tenantId) };
  if (active !== "all") where.active = active === "true";
  if (kind) where.kind = toPrismaKind(kind);
  if (search) where.name = { contains: search };

  const [rows, totalCount] = await Promise.all([
    db.carrier.findMany({
      where,
      skip,
      take: pageSize,
      orderBy: { name: "asc" },
      include: { _count: { select: { gateways: true } } },
    }),
    db.carrier.count({ where }),
  ]);

  return {
    data: rows.map((r) => toCarrierResponse({ ...r, kind: fromPrismaKind(r.kind) })),
    page,
    pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / pageSize),
  };
}

export async function getCarrier(tenantId: number, carrierId: bigint): Promise<CarrierResponse | null> {
  const db = getPrisma();
  const row = await db.carrier.findFirst({
    where: { id: carrierId, tenantId: BigInt(tenantId) },
    include: { _count: { select: { gateways: true } } },
  });
  if (!row) return null;
  return toCarrierResponse({ ...row, kind: fromPrismaKind(row.kind) });
}

export async function createCarrier(
  tenantId: number,
  actorUserId: number,
  input: CarrierCreateInput,
): Promise<CarrierResponse> {
  const db = getPrisma();

  const usernameCt = input.username ? encryptCredential(input.username) : null;
  const passwordCt = input.password ? encryptCredential(input.password) : null;

  const row = await db.$transaction(async (tx) => {
    const created = await tx.carrier.create({
      data: {
        tenantId: BigInt(tenantId),
        name: input.name,
        kind: toPrismaKind(input.kind) as never,
        proxy: input.proxy,
        usernameCt: usernameCt ? usernameCt : undefined,
        passwordCt: passwordCt ? passwordCt : undefined,
        kekVersion: getKekVersion(),
        register: input.register,
        callerIdE164: input.callerIdE164 ?? null,
        active: input.active,
        ipAllowlist: input.ipAllowlist as never,
        configJson: input.configJson as never,
        sendPai: input.sendPai,
        isEmergency: input.isEmergency,
        maxConcurrent: input.maxConcurrent ?? null,
        notes: input.notes as never,
      },
      include: { _count: { select: { gateways: true } } },
    });

    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "carrier.created",
      tenantId,
      entityType: "carrier",
      entityId: String(created.id),
      afterJson: { name: created.name, kind: created.kind },
    });

    return created;
  });

  return toCarrierResponse({ ...row, kind: fromPrismaKind(row.kind) });
}

export async function updateCarrier(
  tenantId: number,
  actorUserId: number,
  carrierId: bigint,
  input: CarrierUpdateInput,
): Promise<CarrierResponse | null> {
  const db = getPrisma();

  const existing = await db.carrier.findFirst({
    where: { id: carrierId, tenantId: BigInt(tenantId) },
  });
  if (!existing) return null;

  const oldKekVersion = existing.kekVersion;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateData: Record<string, any> = {};
  if (input.name !== undefined) updateData.name = input.name;
  if (input.kind !== undefined) updateData.kind = toPrismaKind(input.kind);
  if (input.proxy !== undefined) updateData.proxy = input.proxy;
  if (input.register !== undefined) updateData.register = input.register;
  if (input.callerIdE164 !== undefined) updateData.callerIdE164 = input.callerIdE164 ?? null;
  if (input.active !== undefined) updateData.active = input.active;
  if (input.ipAllowlist !== undefined) updateData.ipAllowlist = input.ipAllowlist;
  if (input.configJson !== undefined) updateData.configJson = input.configJson;
  if (input.sendPai !== undefined) updateData.sendPai = input.sendPai;
  if (input.isEmergency !== undefined) updateData.isEmergency = input.isEmergency;
  if (input.maxConcurrent !== undefined) updateData.maxConcurrent = input.maxConcurrent ?? null;
  if (input.notes !== undefined) updateData.notes = input.notes;

  const credentialRotated = input.username !== undefined || input.password !== undefined;
  if (input.username !== undefined) {
    updateData.usernameCt = input.username ? encryptCredential(input.username) : null;
    updateData.kekVersion = getKekVersion();
  }
  if (input.password !== undefined) {
    updateData.passwordCt = input.password ? encryptCredential(input.password) : null;
    updateData.kekVersion = getKekVersion();
  }

  const row = await db.$transaction(async (tx) => {
    const updated = await tx.carrier.update({
      where: { id: carrierId },
      data: updateData as never,
      include: { _count: { select: { gateways: true } } },
    });

    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: credentialRotated ? "carrier.credential.rotated" : "carrier.updated",
      tenantId,
      entityType: "carrier",
      entityId: String(carrierId),
      beforeJson: { name: existing.name, active: existing.active },
      afterJson: credentialRotated
        ? { old_kek_version: oldKekVersion, new_kek_version: getKekVersion() }
        : { name: updated.name, active: updated.active },
    });

    return updated;
  });

  return toCarrierResponse({ ...row, kind: fromPrismaKind(row.kind) });
}

export async function deleteCarrier(
  tenantId: number,
  actorUserId: number,
  carrierId: bigint,
): Promise<boolean> {
  const db = getPrisma();

  const existing = await db.carrier.findFirst({
    where: { id: carrierId, tenantId: BigInt(tenantId) },
  });
  if (!existing) return false;

  await db.$transaction(async (tx) => {
    await tx.carrier.delete({ where: { id: carrierId } });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "carrier.deleted",
      tenantId,
      entityType: "carrier",
      entityId: String(carrierId),
      beforeJson: { name: existing.name },
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Gateway CRUD
// ---------------------------------------------------------------------------

export async function listGateways(tenantId: number, carrierId: bigint): Promise<GatewayResponse[]> {
  const db = getPrisma();
  const rows = await db.gateway.findMany({
    where: { tenantId: BigInt(tenantId), carrierId },
    orderBy: [{ priority: "asc" }, { name: "asc" }],
  });
  return rows.map(toGatewayResponse);
}

export async function getGateway(
  tenantId: number,
  carrierId: bigint,
  gatewayId: bigint,
): Promise<GatewayResponse | null> {
  const db = getPrisma();
  const row = await db.gateway.findFirst({
    where: { id: gatewayId, carrierId, tenantId: BigInt(tenantId) },
  });
  return row ? toGatewayResponse(row) : null;
}

export async function createGateway(
  tenantId: number,
  actorUserId: number,
  carrierId: bigint,
  input: GatewayCreateInput,
): Promise<GatewayResponse> {
  const db = getPrisma();

  const row = await db.$transaction(async (tx) => {
    const created = await tx.gateway.create({
      data: {
        tenantId: BigInt(tenantId),
        carrierId,
        name: input.name,
        proxy: input.proxy,
        realm: input.realm ?? null,
        fromUser: input.fromUser ?? null,
        fromDomain: input.fromDomain ?? null,
        extension: input.extension ?? null,
        register: input.register,
        expireSeconds: input.expireSeconds,
        retrySeconds: input.retrySeconds,
        transport: input.transport as never,
        priority: input.priority,
        active: input.active,
        templateOverrides: input.templateOverrides as never,
        weight: input.weight,
        maxConcurrent: input.maxConcurrent ?? null,
        costPerMinCents: input.costPerMinCents ?? null,
      },
    });

    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "carrier.gateway.created",
      tenantId,
      entityType: "gateway",
      entityId: String(created.id),
      afterJson: { name: created.name, carrierId: String(carrierId) },
    });

    return created;
  });

  return toGatewayResponse(row);
}

export async function updateGateway(
  tenantId: number,
  actorUserId: number,
  carrierId: bigint,
  gatewayId: bigint,
  input: GatewayUpdateInput,
): Promise<GatewayResponse | null> {
  const db = getPrisma();

  const existing = await db.gateway.findFirst({
    where: { id: gatewayId, carrierId, tenantId: BigInt(tenantId) },
  });
  if (!existing) return null;

  const row = await db.$transaction(async (tx) => {
    const updated = await tx.gateway.update({
      where: { id: gatewayId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.proxy !== undefined && { proxy: input.proxy }),
        ...(input.realm !== undefined && { realm: input.realm ?? null }),
        ...(input.fromUser !== undefined && { fromUser: input.fromUser ?? null }),
        ...(input.fromDomain !== undefined && { fromDomain: input.fromDomain ?? null }),
        ...(input.extension !== undefined && { extension: input.extension ?? null }),
        ...(input.register !== undefined && { register: input.register }),
        ...(input.expireSeconds !== undefined && { expireSeconds: input.expireSeconds }),
        ...(input.retrySeconds !== undefined && { retrySeconds: input.retrySeconds }),
        ...(input.transport !== undefined && { transport: input.transport as never }),
        ...(input.priority !== undefined && { priority: input.priority }),
        ...(input.active !== undefined && { active: input.active }),
        ...(input.templateOverrides !== undefined && { templateOverrides: input.templateOverrides as never }),
        ...(input.weight !== undefined && { weight: input.weight }),
        ...(input.maxConcurrent !== undefined && { maxConcurrent: input.maxConcurrent ?? null }),
        ...(input.costPerMinCents !== undefined && { costPerMinCents: input.costPerMinCents ?? null }),
      } as never,
    });

    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "carrier.gateway.updated",
      tenantId,
      entityType: "gateway",
      entityId: String(gatewayId),
      beforeJson: { name: existing.name, active: existing.active },
      afterJson: { name: updated.name, active: updated.active },
    });

    return updated;
  });

  return toGatewayResponse(row);
}

export async function deleteGateway(
  tenantId: number,
  actorUserId: number,
  carrierId: bigint,
  gatewayId: bigint,
): Promise<boolean> {
  const db = getPrisma();

  const existing = await db.gateway.findFirst({
    where: { id: gatewayId, carrierId, tenantId: BigInt(tenantId) },
  });
  if (!existing) return false;

  await db.$transaction(async (tx) => {
    await tx.gateway.delete({ where: { id: gatewayId } });
    await audit({
      tx,
      actorUserId: BigInt(actorUserId),
      actorKind: "user",
      action: "carrier.gateway.deleted",
      tenantId,
      entityType: "gateway",
      entityId: String(gatewayId),
      beforeJson: { name: existing.name },
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Gateway health (reads T02 health cache from Redis)
// ---------------------------------------------------------------------------

export async function getCarrierHealth(
  tenantId: number,
  carrierId: bigint,
): Promise<CarrierHealthResponse> {
  const db = getPrisma();
  const gateways = await db.gateway.findMany({
    where: { tenantId: BigInt(tenantId), carrierId, active: true },
    orderBy: { priority: "asc" },
  });

  let rdb: { get: (key: string) => Promise<string | null> } | null = null;
  try {
    const { getRedis } = await import("../../../lib/redis.js");
    rdb = getRedis();
  } catch {
    // Redis not available in some test envs
  }

  const entries = await Promise.all(
    gateways.map(async (gw) => {
      const cacheKey = `t:${tenantId}:carrier:gw_status:${gw.id}`;
      let cached: { state?: string; status?: string; ping_ms?: number; polled_at?: string } | null = null;
      if (rdb) {
        try {
          const raw = await rdb.get(cacheKey);
          if (raw) cached = JSON.parse(raw) as typeof cached;
        } catch {
          // ignore
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const c = cached as any;
      return {
        gatewayId: String(gw.id),
        gatewayName: gw.name,
        state: (c?.state as string | undefined) ?? "UNKNOWN",
        status: (c?.status as string | undefined) ?? "UNKNOWN",
        pingMs: (c?.ping_ms as number | undefined) ?? null,
        polledAt: (c?.polled_at as string | undefined) ?? null,
      };
    }),
  );

  return { carrierId: String(carrierId), gateways: entries };
}
