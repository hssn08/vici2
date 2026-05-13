// M01 — Admin user schema unit tests.

import { describe, it, expect } from "vitest";
import {
  UserCreateSchema,
  UserUpdateSchema,
  UserListQuerySchema,
  RoleAssignSchema,
} from "../../src/routes/admin/users/schema.js";

// ---------------------------------------------------------------------------
// UserCreateSchema
// ---------------------------------------------------------------------------

describe("UserCreateSchema", () => {
  const base = {
    username: "jsmith",
    password: "SuperSecret123",
    role: "agent",
  };

  it("accepts a valid minimal create request", () => {
    const r = UserCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
  });

  it("accepts all optional fields", () => {
    const r = UserCreateSchema.safeParse({
      ...base,
      email: "jsmith@example.com",
      fullName: "Jane Smith",
      userGroupId: "42",
      active: false,
      hotkeysActive: false,
      totpRequired: true,
    });
    expect(r.success).toBe(true);
  });

  it("rejects username with invalid characters", () => {
    const r = UserCreateSchema.safeParse({ ...base, username: "Jane Smith" });
    expect(r.success).toBe(false);
  });

  it("rejects username shorter than 2 chars", () => {
    const r = UserCreateSchema.safeParse({ ...base, username: "j" });
    expect(r.success).toBe(false);
  });

  it("rejects password shorter than 12 chars", () => {
    const r = UserCreateSchema.safeParse({ ...base, password: "Short1" });
    expect(r.success).toBe(false);
  });

  it("rejects password without uppercase", () => {
    const r = UserCreateSchema.safeParse({ ...base, password: "allowercase123456" });
    expect(r.success).toBe(false);
  });

  it("rejects password without digit", () => {
    const r = UserCreateSchema.safeParse({ ...base, password: "AllLowerCaseNoDigit" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid email", () => {
    const r = UserCreateSchema.safeParse({ ...base, email: "not-an-email" });
    expect(r.success).toBe(false);
  });

  it("rejects invalid role", () => {
    const r = UserCreateSchema.safeParse({ ...base, role: "god" });
    expect(r.success).toBe(false);
  });

  it("defaults active to true when not provided", () => {
    const r = UserCreateSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.active).toBe(true);
  });

  it("defaults role to agent when not provided", () => {
    const { role: _, ...noRole } = base;
    void _;
    const r = UserCreateSchema.safeParse(noRole);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.role).toBe("agent");
  });
});

// ---------------------------------------------------------------------------
// UserUpdateSchema
// ---------------------------------------------------------------------------

describe("UserUpdateSchema", () => {
  it("accepts empty object (no-op update)", () => {
    const r = UserUpdateSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("accepts partial update", () => {
    const r = UserUpdateSchema.safeParse({ active: false, role: "supervisor" });
    expect(r.success).toBe(true);
  });

  it("rejects unknown fields (strict)", () => {
    const r = UserUpdateSchema.safeParse({ username: "new-name" });
    expect(r.success).toBe(false);
  });

  it("accepts null userGroupId (detach from group)", () => {
    const r = UserUpdateSchema.safeParse({ userGroupId: null });
    expect(r.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UserListQuerySchema
// ---------------------------------------------------------------------------

describe("UserListQuerySchema", () => {
  it("applies defaults", () => {
    const r = UserListQuerySchema.safeParse({});
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(1);
      expect(r.data.pageSize).toBe(50);
      expect(r.data.sort).toBe("username");
      expect(r.data.dir).toBe("asc");
    }
  });

  it("caps pageSize at 200", () => {
    const r = UserListQuerySchema.safeParse({ pageSize: "999" });
    expect(r.success).toBe(false);
  });

  it("coerces string numbers", () => {
    const r = UserListQuerySchema.safeParse({ page: "2", pageSize: "25" });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.page).toBe(2);
      expect(r.data.pageSize).toBe(25);
    }
  });

  it("accepts role filter", () => {
    const r = UserListQuerySchema.safeParse({ role: "admin" });
    expect(r.success).toBe(true);
  });

  it("rejects invalid role filter", () => {
    const r = UserListQuerySchema.safeParse({ role: "root" });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RoleAssignSchema
// ---------------------------------------------------------------------------

describe("RoleAssignSchema", () => {
  it("accepts valid role", () => {
    const r = RoleAssignSchema.safeParse({ role: "supervisor" });
    expect(r.success).toBe(true);
  });

  it("rejects invalid role", () => {
    const r = RoleAssignSchema.safeParse({ role: "moderator" });
    expect(r.success).toBe(false);
  });

  it("rejects missing role", () => {
    const r = RoleAssignSchema.safeParse({});
    expect(r.success).toBe(false);
  });
});
