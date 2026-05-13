// I04 — Unit tests for phone normalisation and schema helpers.
// I04 PLAN §10.1 (TypeScript tests).

import { describe, it, expect } from "vitest";
import { normalizePhone } from "../../src/inbound-callbacks/schemas.js";

describe("normalizePhone", () => {
  it("normalises NANP 10-digit", () => {
    expect(normalizePhone("5551234567")).toBe("5551234567");
  });

  it("strips leading +1 from NANP", () => {
    expect(normalizePhone("+15551234567")).toBe("5551234567");
  });

  it("strips leading 1 from NANP", () => {
    expect(normalizePhone("15551234567")).toBe("5551234567");
  });

  it("preserves E.164 international", () => {
    expect(normalizePhone("+447700123456")).toBe("+447700123456");
  });

  it("preserves E.164 with + prefix", () => {
    expect(normalizePhone("+33612345678")).toBe("+33612345678");
  });

  it("returns null for too-short number", () => {
    expect(normalizePhone("555")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizePhone("")).toBeNull();
  });

  it("returns null for whitespace-only", () => {
    expect(normalizePhone("   ")).toBeNull();
  });

  it("strips spaces and dashes from NANP", () => {
    expect(normalizePhone("555 123-4567")).toBe("5551234567");
  });

  it("strips parentheses from NANP", () => {
    expect(normalizePhone("(555) 123-4567")).toBe("5551234567");
  });

  it("returns null for too-long number", () => {
    // More than 15 significant digits
    expect(normalizePhone("+12345678901234567")).toBeNull();
  });
});

describe("phone masking (inlined)", () => {
  function maskPhone(phone: string): string {
    if (phone.length <= 3) return "***";
    return phone.slice(0, -3) + "***";
  }

  it("masks last 3 digits of NANP", () => {
    expect(maskPhone("5551234567")).toBe("5551234***");
  });

  it("masks last 3 digits of E.164", () => {
    // "+447700123456" → 13 chars; slice(0,-3) = "+447700123" then + "***"
    expect(maskPhone("+447700123456")).toBe("+447700123***");
  });

  it("returns *** for very short input", () => {
    expect(maskPhone("12")).toBe("***");
  });
});
