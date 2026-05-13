import { describe, expect, it } from "vitest";

import {
  hasPermission,
  isRole,
  permissionsFor,
  permsAsSet,
  ROLE_PERMISSIONS,
  roleAtLeast,
  ROLES,
} from "../../src/auth/rbac.js";

describe("rbac", () => {
  it("includes all roles in the matrix", () => {
    for (const r of ROLES) {
      expect(ROLE_PERMISSIONS[r]).toBeDefined();
      expect(Array.isArray(ROLE_PERMISSIONS[r])).toBe(true);
    }
  });

  it("super_admin > admin > supervisor > agent in hierarchy", () => {
    expect(roleAtLeast("super_admin", "admin")).toBe(true);
    expect(roleAtLeast("admin", "supervisor")).toBe(true);
    expect(roleAtLeast("supervisor", "agent")).toBe(true);
    expect(roleAtLeast("agent", "supervisor")).toBe(false);
    expect(roleAtLeast("agent", "admin")).toBe(false);
  });

  it("integrator is orthogonal — never satisfies a hierarchical role check", () => {
    expect(roleAtLeast("integrator", "agent")).toBe(false);
    expect(roleAtLeast("integrator", "admin")).toBe(false);
    expect(roleAtLeast("integrator", "integrator")).toBe(true);
    expect(roleAtLeast("admin", "integrator")).toBe(false);
  });

  it("agent has call:dial but not call:listen", () => {
    expect(hasPermission("agent", "call:dial")).toBe(true);
    expect(hasPermission("agent", "call:listen")).toBe(false);
  });

  it("supervisor has call:listen and call:whisper", () => {
    expect(hasPermission("supervisor", "call:listen")).toBe(true);
    expect(hasPermission("supervisor", "call:whisper")).toBe(true);
    expect(hasPermission("supervisor", "call:barge")).toBe(true);
    // call:eavesdrop removed in M02 (renamed — call:listen covers it)
    expect(hasPermission("supervisor", "call:eavesdrop" as never)).toBe(false);
  });

  it("viewer role exists and has read-only grants", () => {
    expect(hasPermission("viewer", "lead:read")).toBe(true);
    expect(hasPermission("viewer", "audit:view")).toBe(true);
    expect(hasPermission("viewer", "lead:edit")).toBe(false);
    expect(hasPermission("viewer", "call:dial")).toBe(false);
  });

  it("admin can manage users but not bypass DNC", () => {
    expect(hasPermission("admin", "user:create")).toBe(true);
    expect(hasPermission("admin", "user:delete")).toBe(true);
    expect(hasPermission("admin", "dnc:bypass")).toBe(false);
  });

  it("super_admin holds all sensitive verbs", () => {
    expect(hasPermission("super_admin", "dnc:bypass")).toBe(true);
    expect(hasPermission("super_admin", "kek:rotate")).toBe(true);
    expect(hasPermission("super_admin", "sip:credentials:view")).toBe(true);
    expect(hasPermission("super_admin", "audit:view")).toBe(true);
    expect(hasPermission("super_admin", "tenant:edit")).toBe(true);
  });

  it("permsAsSet returns the right size for each role", () => {
    expect(permsAsSet("agent").size).toBe(permissionsFor("agent").length);
    expect(permsAsSet("admin").size).toBeGreaterThan(permsAsSet("agent").size);
    expect(permsAsSet("super_admin").size).toBeGreaterThan(permsAsSet("admin").size);
  });

  it("isRole guard accepts known roles and rejects others", () => {
    expect(isRole("admin")).toBe(true);
    expect(isRole("agent")).toBe(true);
    expect(isRole("foobar")).toBe(false);
  });
});
