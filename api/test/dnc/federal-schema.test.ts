// D05 — Federal SOAP schema / parse tests

import { describe, it, expect } from "vitest";
import { parseDeltaLine } from "../../src/dnc/sync/federal-soap-schema.js";

describe("parseDeltaLine", () => {
  it("parses a valid add line", () => {
    const result = parseDeltaLine("4155551212 2026-01-15 A");
    expect(result).not.toBeNull();
    expect(result!.phone10).toBe("4155551212");
    expect(result!.date).toBe("2026-01-15");
    expect(result!.action).toBe("A");
  });

  it("parses a valid delete line", () => {
    const result = parseDeltaLine("2125559999 2026-03-01 D");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("D");
  });

  it("returns null for blank line", () => {
    expect(parseDeltaLine("")).toBeNull();
  });

  it("returns null for malformed line", () => {
    expect(parseDeltaLine("123456789 bad-date X")).toBeNull();
  });

  it("returns null for too-short phone", () => {
    expect(parseDeltaLine("123456789 2026-01-01 A")).toBeNull(); // 9 digits only
  });

  it("handles trailing whitespace", () => {
    const result = parseDeltaLine("4155551212 2026-01-15 A  ");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("A");
  });
});
