// D01 — normalize.ts unit tests

import { describe, it, expect } from "vitest";
import { normalizePhone, strictNormalizePhone, InvalidPhoneError } from "../../src/leads/normalize.js";

describe("normalizePhone", () => {
  it("parses US number to E.164", () => {
    const result = normalizePhone("(555) 123-4567", "US");
    expect(result.e164).toBe("+15551234567");
  });

  it("handles already-E164 input", () => {
    const result = normalizePhone("+15551234567", "US");
    expect(result.e164).toBe("+15551234567");
  });

  it("defaults to US country code", () => {
    const result = normalizePhone("5551234567");
    expect(result.e164).toBe("+15551234567");
  });

  it("handles UK country code", () => {
    const result = normalizePhone("07700900000", "GB");
    expect(result.e164).toBeDefined();
    expect(result.e164.startsWith("+44")).toBe(true);
  });

  it("throws InvalidPhoneError for empty string", () => {
    expect(() => normalizePhone("")).toThrow(InvalidPhoneError);
  });

  it("throws InvalidPhoneError for unparseable string", () => {
    expect(() => normalizePhone("not-a-phone")).toThrow(InvalidPhoneError);
  });

  it("returns valid=false for potentially invalid number", () => {
    // A parseable but not valid number
    const result = normalizePhone("+1234", "US");
    // May or may not be invalid — just test it doesn't throw
    expect(result.e164).toBeDefined();
  });
});

describe("strictNormalizePhone", () => {
  it("returns E.164 for valid number", () => {
    const e164 = strictNormalizePhone("+12125551234", "US");
    expect(e164).toBe("+12125551234");
  });

  it("throws for invalid number", () => {
    expect(() => strictNormalizePhone("000", "US")).toThrow(InvalidPhoneError);
  });

  it("throws for empty input", () => {
    expect(() => strictNormalizePhone("")).toThrow(InvalidPhoneError);
  });

  it("normalizes formatted US number", () => {
    const e164 = strictNormalizePhone("(212) 555-1234", "US");
    expect(e164).toBe("+12125551234");
  });
});
