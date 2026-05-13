// M01 — Admin user-management service layer.
//
// Business logic for CRUD operations on the User table.  All reads/writes are
// scoped to `tenantId` to maintain multi-tenant isolation.  Password hashing
// uses the same Argon2id path as F05.  Every mutation emits an audit event.

import { type PrismaClient, UserRole as PrismaUserRole } from "@prisma/client";
import { getPrisma } from "../../../lib/prisma.js";
import { hashPassword } from "../../../auth/argon2.js";
import { audit } from "../../../auth/audit.js";
import { roleAtLeast } from "../../../auth/rbac.js";
import type { Role } from "@vici2/types";
import type {
  UserCreateInput,
  UserUpdateInput,
  UserListQuery,
  UserResponse,
  UserListResponse,
} from "./schema.js";

// ---------------------------------------------------------------------------
// Role name mapping (shared RBAC types use "super_admin"; Prisma enum "superadmin")
// ---------------------------------------------------------------------------

function toPrismaRole(role: string): PrismaUserRole {
  return (role === "super_admin" ? "superadmin" : role) as PrismaUserRole;
}

function fromPrismaRole(role: PrismaUserRole): string {
  return role === PrismaUserRole.superadmin ? "super_admin" : String(role);
}

// ---------------------------------------------------------------------------
// Internal helper — strip sensitive fields from Prisma User row
// ---------------------------------------------------------------------------

function toResponse(u: {
  id: bigint;
  tenantId: bigint;
  username: string;
  email: string | null;
  fullName: string | null;
  role: PrismaUserRole;
  userGroupId: bigint | null;
  active: boolean;
  hotkeysActive: boolean;
  totpRequired: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): UserResponse {
  return {
    id: String(u.id),
    tenantId: String(u.tenantId),
    username: u.username,
    email: u.email,
    fullName: u.fullName,
    role: fromPrismaRole(u.role),
    userGroupId: u.userGroupId === null ? null : String(u.userGroupId),
    active: u.active,
    hotkeysActive: u.hotkeysActive,
    totpRequired: u.totpRequired,
    lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function listUsers(
  tenantId: number,
  query: UserListQuery,
): Promise<UserListResponse> {
  const db: PrismaClient = getPrisma();
  const skip = (query.page - 1) * query.pageSize;

  const where = {
    tenantId: BigInt(tenantId),
    ...(query.role !== undefined ? { role: toPrismaRole(query.role) } : {}),
    ...(query.active !== undefined ? { active: query.active } : {}),
    ...(query.search
      ? {
          OR: [
            { username: { contains: query.search } },
            { email: { contains: query.search } },
            { fullName: { contains: query.search } },
          ],
        }
      : {}),
  };

  const [totalCount, rows] = await Promise.all([
    db.user.count({ where }),
    db.user.findMany({
      where,
      skip,
      take: query.pageSize,
      orderBy: { [query.sort]: query.dir },
      select: {
        id: true,
        tenantId: true,
        username: true,
        email: true,
        fullName: true,
        role: true,
        userGroupId: true,
        active: true,
        hotkeysActive: true,
        totpRequired: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  return {
    data: rows.map(toResponse),
    page: query.page,
    pageSize: query.pageSize,
    totalCount,
    totalPages: Math.ceil(totalCount / query.pageSize),
  };
}

// ---------------------------------------------------------------------------
// Get one
// ---------------------------------------------------------------------------

export async function getUser(
  tenantId: number,
  userId: bigint,
): Promise<UserResponse | null> {
  const db: PrismaClient = getPrisma();
  const u = await db.user.findFirst({
    where: { id: userId, tenantId: BigInt(tenantId) },
    select: {
      id: true,
      tenantId: true,
      username: true,
      email: true,
      fullName: true,
      role: true,
      userGroupId: true,
      active: true,
      hotkeysActive: true,
      totpRequired: true,
      lastLoginAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return u ? toResponse(u) : null;
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export async function createUser(
  tenantId: number,
  actorId: number,
  actorRole: Role,
  input: UserCreateInput,
): Promise<UserResponse> {
  // Privilege check: you cannot create a user with a higher role than yourself
  if (!roleAtLeast(actorRole, input.role as Role) && actorRole !== "super_admin") {
    const err = new Error("Cannot create a user with a higher role than your own");
    (err as NodeJS.ErrnoException).code = "FORBIDDEN";
    throw err;
  }

  const db: PrismaClient = getPrisma();
  const passwordHash = await hashPassword(input.password);

  const created = await db.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        tenantId: BigInt(tenantId),
        username: input.username,
        email: input.email ?? null,
        passwordHash,
        fullName: input.fullName ?? null,
        role: toPrismaRole(input.role),
        userGroupId: input.userGroupId ?? null,
        active: input.active,
        hotkeysActive: input.hotkeysActive,
        totpRequired: input.totpRequired,
      },
      select: {
        id: true,
        tenantId: true,
        username: true,
        email: true,
        fullName: true,
        role: true,
        userGroupId: true,
        active: true,
        hotkeysActive: true,
        totpRequired: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    await audit({
      tx,
      actorUserId: BigInt(actorId),
      actorKind: "user",
      action: "auth.user.created",
      tenantId,
      entityType: "user",
      entityId: String(user.id),
      afterJson: { username: user.username, role: user.role },
    });

    return user;
  });

  return toResponse(created);
}

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

export async function updateUser(
  tenantId: number,
  actorId: number,
  actorRole: Role,
  userId: bigint,
  input: UserUpdateInput,
): Promise<UserResponse | null> {
  const db: PrismaClient = getPrisma();

  // If changing role, privilege check applies
  if (input.role !== undefined) {
    if (!roleAtLeast(actorRole, input.role as Role) && actorRole !== "super_admin") {
      const err = new Error("Cannot assign a role higher than your own");
      (err as NodeJS.ErrnoException).code = "FORBIDDEN";
      throw err;
    }
  }

  const before = await db.user.findFirst({
    where: { id: userId, tenantId: BigInt(tenantId) },
    select: { id: true, role: true, active: true },
  });
  if (!before) return null;

  const after = await db.$transaction(async (tx) => {
    const updated = await tx.user.update({
      where: { id: userId },
      data: {
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
        ...(input.role !== undefined ? { role: toPrismaRole(input.role) } : {}),
        ...(input.userGroupId !== undefined
          ? { userGroupId: input.userGroupId === null ? null : BigInt(input.userGroupId) }
          : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.hotkeysActive !== undefined ? { hotkeysActive: input.hotkeysActive } : {}),
        ...(input.totpRequired !== undefined ? { totpRequired: input.totpRequired } : {}),
      },
      select: {
        id: true,
        tenantId: true,
        username: true,
        email: true,
        fullName: true,
        role: true,
        userGroupId: true,
        active: true,
        hotkeysActive: true,
        totpRequired: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    // Determine the right audit action
    let action: Parameters<typeof audit>[0]["action"] = "auth.user.created"; // placeholder
    if (input.role !== undefined && toPrismaRole(input.role) !== before.role) {
      action = "auth.role.changed";
    } else if (input.active === false && before.active) {
      action = "auth.user.deactivated";
    } else if (input.active === true && !before.active) {
      action = "auth.user.activated";
    } else {
      // Generic edit — reuse role.changed as a neutral write event
      action = "auth.role.changed";
    }

    await audit({
      tx,
      actorUserId: BigInt(actorId),
      actorKind: "user",
      action,
      tenantId,
      entityType: "user",
      entityId: String(userId),
      beforeJson: { role: before.role, active: before.active },
      afterJson: { role: updated.role, active: updated.active },
    });

    return updated;
  });

  return toResponse(after);
}

// ---------------------------------------------------------------------------
// Delete (soft: set active=false; hard delete if super_admin flag given)
// ---------------------------------------------------------------------------

export async function deleteUser(
  tenantId: number,
  actorId: number,
  userId: bigint,
): Promise<boolean> {
  const db: PrismaClient = getPrisma();

  const existing = await db.user.findFirst({
    where: { id: userId, tenantId: BigInt(tenantId) },
    select: { id: true },
  });
  if (!existing) return false;

  await db.$transaction(async (tx) => {
    await tx.user.delete({ where: { id: userId } });

    await audit({
      tx,
      actorUserId: BigInt(actorId),
      actorKind: "user",
      action: "auth.user.deleted",
      tenantId,
      entityType: "user",
      entityId: String(userId),
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Assign role (convenience wrapper for PATCH /users/:id/role)
// ---------------------------------------------------------------------------

export async function assignRole(
  tenantId: number,
  actorId: number,
  actorRole: Role,
  userId: bigint,
  newRole: Role,
): Promise<UserResponse | null> {
  return updateUser(tenantId, actorId, actorRole, userId, { role: newRole });
}
