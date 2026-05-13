// O03 — alert-receivers service layer.

import type { PrismaClient, AlertReceiverKind } from "@prisma/client";
import { getPrisma } from "../../../lib/prisma.js";
import {
  maskConfig,
  type AlertReceiverResponse,
} from "./schema.js";

function toResponse(row: {
  id: bigint;
  tenantId: bigint;
  name: string;
  kind: AlertReceiverKind;
  config: unknown;
  active: boolean;
  severityFilter: string;
  createdAt: Date;
  updatedAt: Date;
}): AlertReceiverResponse {
  const cfg = (row.config ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    name: row.name,
    kind: row.kind,
    config: maskConfig(row.kind, cfg),
    active: row.active,
    severityFilter: row.severityFilter,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listReceivers(
  tenantId: bigint,
  opts: {
    kind?: AlertReceiverKind;
    active?: boolean;
    limit?: number;
    offset?: number;
  },
): Promise<AlertReceiverResponse[]> {
  const db: PrismaClient = getPrisma();
  const rows = await db.alertReceiver.findMany({
    where: {
      tenantId,
      ...(opts.kind !== undefined ? { kind: opts.kind } : {}),
      ...(opts.active !== undefined ? { active: opts.active } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: opts.limit ?? 50,
    skip: opts.offset ?? 0,
  });
  return rows.map(toResponse);
}

export async function getReceiver(
  tenantId: bigint,
  id: bigint,
): Promise<AlertReceiverResponse | null> {
  const db: PrismaClient = getPrisma();
  const row = await db.alertReceiver.findFirst({
    where: { id, tenantId },
  });
  if (!row) return null;
  return toResponse(row);
}

export async function createReceiver(
  tenantId: bigint,
  input: {
    name: string;
    kind: AlertReceiverKind;
    config: Record<string, unknown>;
    active?: boolean;
    severityFilter?: string;
  },
): Promise<AlertReceiverResponse> {
  const db: PrismaClient = getPrisma();
  const row = await db.alertReceiver.create({
    data: {
      tenantId,
      name: input.name,
      kind: input.kind,
      config: input.config,
      active: input.active ?? true,
      severityFilter: input.severityFilter ?? "page,warn,info",
    },
  });
  return toResponse(row);
}

export async function updateReceiver(
  tenantId: bigint,
  id: bigint,
  patch: {
    name?: string;
    config?: Record<string, unknown>;
    active?: boolean;
    severityFilter?: string;
  },
): Promise<AlertReceiverResponse | null> {
  const db: PrismaClient = getPrisma();
  const existing = await db.alertReceiver.findFirst({ where: { id, tenantId } });
  if (!existing) return null;

  const row = await db.alertReceiver.update({
    where: { id },
    data: {
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.config !== undefined ? { config: patch.config } : {}),
      ...(patch.active !== undefined ? { active: patch.active } : {}),
      ...(patch.severityFilter !== undefined ? { severityFilter: patch.severityFilter } : {}),
    },
  });
  return toResponse(row);
}

export async function deleteReceiver(
  tenantId: bigint,
  id: bigint,
): Promise<boolean> {
  const db: PrismaClient = getPrisma();
  const existing = await db.alertReceiver.findFirst({ where: { id, tenantId } });
  if (!existing) return false;
  // Soft delete: set active=false
  await db.alertReceiver.update({ where: { id }, data: { active: false } });
  return true;
}
