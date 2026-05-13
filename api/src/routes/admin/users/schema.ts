// M01 — Admin user-management schemas (Zod validators).
//
// Covers CRUD for the User model: create, read, list (paged), update, delete,
// and role assignment.  These schemas are the single source of truth shared
// by the Fastify route handlers and (once @vici2/api-client lands) the admin
// UI via zodResolver.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Re-export role enum to keep imports local
// ---------------------------------------------------------------------------

export const RoleEnum = z.enum([
  "super_admin",
  "admin",
  "supervisor",
  "agent",
  "integrator",
]);

// ---------------------------------------------------------------------------
// User create
// ---------------------------------------------------------------------------

export const UserCreateSchema = z.object({
  username: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z0-9_.-]+$/, "lowercase alphanum / _ . - only"),
  email: z.string().email().max(128).optional(),
  password: z
    .string()
    .min(12)
    .max(128)
    .regex(/[A-Z]/, "must contain uppercase")
    .regex(/[0-9]/, "must contain digit"),
  fullName: z.string().max(128).optional(),
  role: RoleEnum.default("agent"),
  userGroupId: z.coerce.bigint().positive().optional(),
  active: z.boolean().default(true),
  hotkeysActive: z.boolean().default(true),
  totpRequired: z.boolean().default(false),
});

export type UserCreateInput = z.infer<typeof UserCreateSchema>;

// ---------------------------------------------------------------------------
// User update (all fields optional; password requires current for self)
// ---------------------------------------------------------------------------

export const UserUpdateSchema = z
  .object({
    email: z.string().email().max(128).optional(),
    fullName: z.string().max(128).optional(),
    role: RoleEnum.optional(),
    userGroupId: z.coerce.bigint().positive().nullable().optional(),
    active: z.boolean().optional(),
    hotkeysActive: z.boolean().optional(),
    totpRequired: z.boolean().optional(),
  })
  .strict();

export type UserUpdateInput = z.infer<typeof UserUpdateSchema>;

// ---------------------------------------------------------------------------
// Role assignment (standalone endpoint for clarity)
// ---------------------------------------------------------------------------

export const RoleAssignSchema = z.object({
  role: RoleEnum,
});

// ---------------------------------------------------------------------------
// List query
// ---------------------------------------------------------------------------

export const UserListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z
    .enum(["username", "email", "role", "active", "createdAt", "lastLoginAt"])
    .default("username"),
  dir: z.enum(["asc", "desc"]).default("asc"),
  role: RoleEnum.optional(),
  active: z
    .string()
    .transform((v) => (v === "true" ? true : v === "false" ? false : undefined))
    .optional(),
  search: z.string().max(64).optional(),
});

export type UserListQuery = z.infer<typeof UserListQuerySchema>;

// ---------------------------------------------------------------------------
// Response shape (what the routes return — no password_hash)
// ---------------------------------------------------------------------------

export interface UserResponse {
  id: string;
  tenantId: string;
  username: string;
  email: string | null;
  fullName: string | null;
  role: string;
  userGroupId: string | null;
  active: boolean;
  hotkeysActive: boolean;
  totpRequired: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserListResponse {
  data: UserResponse[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}
