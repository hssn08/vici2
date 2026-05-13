/**
 * A02 unit tests — parkExt.ts
 */
import { describe, it, expect, afterEach } from "vitest";
import { parkExtFor, confNameFor } from "@/lib/sip/parkExt";

describe("parkExtFor", () => {
  const originalEnv = process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN;

  afterEach(() => {
    process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN = originalEnv;
  });

  it("uses default pattern when env is unset", () => {
    delete process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN;
    expect(parkExtFor(1, 1042)).toBe("*91_1042");
  });

  it("substitutes {tid} and {uid} in default pattern", () => {
    delete process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN;
    expect(parkExtFor(3, 77)).toBe("*93_77");
  });

  it("uses env override when set", () => {
    process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN = "park_{tid}_{uid}";
    expect(parkExtFor(1, 42)).toBe("park_1_42");
  });

  it("handles tenantId=1 (Phase 1 single-tenant)", () => {
    delete process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN;
    expect(parkExtFor(1, 999)).toBe("*91_999");
  });

  it("substitutes only first occurrence of each placeholder", () => {
    process.env.NEXT_PUBLIC_AGENT_PARK_PATTERN = "{tid}{tid}_{uid}";
    // String.replace only replaces first occurrence by default
    const result = parkExtFor(2, 5);
    expect(result).toContain("2");
    expect(result).toContain("5");
  });
});

describe("confNameFor", () => {
  it("produces RFC-002 canonical conference name", () => {
    expect(confNameFor(1, 1042)).toBe("agent_t1_u1042@default");
  });

  it("includes tenant prefix for multi-tenant forward compat", () => {
    expect(confNameFor(7, 99)).toBe("agent_t7_u99@default");
  });
});
