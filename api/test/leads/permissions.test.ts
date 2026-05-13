// D01 — permissions.ts unit tests

import { describe, it, expect } from "vitest";
import { isAdmin, isSuperAdmin, canAccessAllLeads, ownerFilter } from "../../src/leads/permissions.js";
import type { FastifyRequest } from "fastify";

function makeReq(role: string, uid = 42): Partial<FastifyRequest> {
  return {
    auth: {
      uid,
      tenantId: 1,
      role: role as never,
      perms: new Set(),
      jti: "test",
      totpVerified: false,
      rawClaims: {} as never,
    },
  };
}

describe("isAdmin", () => {
  it("returns true for admin", () => {
    expect(isAdmin(makeReq("admin") as FastifyRequest)).toBe(true);
  });

  it("returns true for super_admin", () => {
    expect(isAdmin(makeReq("super_admin") as FastifyRequest)).toBe(true);
  });

  it("returns false for supervisor", () => {
    expect(isAdmin(makeReq("supervisor") as FastifyRequest)).toBe(false);
  });

  it("returns false for agent", () => {
    expect(isAdmin(makeReq("agent") as FastifyRequest)).toBe(false);
  });

  it("returns false if no auth", () => {
    expect(isAdmin({ auth: undefined } as FastifyRequest)).toBe(false);
  });
});

describe("isSuperAdmin", () => {
  it("returns true only for super_admin", () => {
    expect(isSuperAdmin(makeReq("super_admin") as FastifyRequest)).toBe(true);
    expect(isSuperAdmin(makeReq("admin") as FastifyRequest)).toBe(false);
  });
});

describe("canAccessAllLeads", () => {
  it("returns true for supervisor+", () => {
    expect(canAccessAllLeads(makeReq("supervisor") as FastifyRequest)).toBe(true);
    expect(canAccessAllLeads(makeReq("admin") as FastifyRequest)).toBe(true);
    expect(canAccessAllLeads(makeReq("super_admin") as FastifyRequest)).toBe(true);
  });

  it("returns false for agent", () => {
    expect(canAccessAllLeads(makeReq("agent") as FastifyRequest)).toBe(false);
  });
});

describe("ownerFilter", () => {
  it("returns undefined for supervisor (no filter)", () => {
    expect(ownerFilter(makeReq("supervisor", 7) as FastifyRequest)).toBeUndefined();
  });

  it("returns uid as BigInt for agent", () => {
    expect(ownerFilter(makeReq("agent", 7) as FastifyRequest)).toBe(7n);
  });

  it("returns undefined if no auth", () => {
    expect(ownerFilter({ auth: undefined } as FastifyRequest)).toBeUndefined();
  });
});
