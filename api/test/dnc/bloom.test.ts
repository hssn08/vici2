// D05 — Bloom unit tests

import { describe, it, expect } from "vitest";
import { bloomKey, BLOOM_CAPS, BLOOM_FPR } from "../../src/dnc/types.js";

describe("bloomKey", () => {
  it("returns correct global key for federal", () => {
    expect(bloomKey("federal")).toBe("bf:dnc:federal");
  });

  it("returns correct global key for litigator", () => {
    expect(bloomKey("litigator")).toBe("bf:dnc:litigator");
  });

  it("returns per-tenant key for internal", () => {
    expect(bloomKey("internal", 42)).toBe("t:42:dnc:internal:bloom");
  });

  it("returns per-tenant key for state", () => {
    expect(bloomKey("state", 7)).toBe("t:7:dnc:state:bloom");
  });
});

describe("BLOOM_CAPS", () => {
  it("federal has 300M capacity", () => {
    expect(BLOOM_CAPS.federal).toBe(300_000_000);
  });

  it("internal has 200K capacity", () => {
    expect(BLOOM_CAPS.internal).toBe(200_000);
  });
});

describe("BLOOM_FPR", () => {
  it("is 0.001", () => {
    expect(BLOOM_FPR).toBe(0.001);
  });
});
